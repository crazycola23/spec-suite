// src/shared/atomic-write.mjs 的行为测试。
//
// 这个文件存在的理由：合并四套写策略时我声明了一组"并集语义"（两阶段、
// rename 阶段失败回滚、temp 必清、内容相同不重写）。**四处原实现里没有一处
// 的回滚路径被测过** —— v1-vertical-slice 那几条"失败时不覆盖旧 bundle"验的
// 是校验阶段就 throw，写函数根本没被调用。也就是说旧代码的回滚分支是纯防御
// 性的死代码，而我现在把它提升成了共享模块的**承诺**。
//
// 未被测试的承诺就是未被证明的承诺。它比没有承诺更糟：下一个人会依赖它。
//
// 两个失败注入用 monkeypatch 而不是文件系统花招，因为花招做不到：让 rename
// 失败最自然的办法是把 target 做成目录，但那样阶段零的 `readFileSync(target)`
// 就先抛 EISDIR 了 —— 失败点落在 try 之前，回滚分支照样跑不到。要精确打中
// 阶段二，只能替换 fs.renameSync。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeFileAtomic, writeFilesAtomic } from '../src/shared/atomic-write.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-atomic-'))

/** 目录里残留的 temp 文件。并集语义的第 5 条要求这个集合恒为空。 */
const leftovers = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))

/** 在第 n 次调用时抛错，其余照常。返回一个 restore 函数。 */
function failOnCall(target, method, n) {
  const real = target[method]
  let calls = 0
  target[method] = (...args) => {
    if (++calls === n) throw new Error(`boom: injected ${method} failure #${n}`)
    return real.apply(target, args)
  }
  return () => { target[method] = real }
}

test('成功路径：全部落盘，返回写入的 target，无 temp 残留', () => {
  const dir = tmp()
  const a = path.join(dir, 'a.json')
  const b = path.join(dir, 'nested', 'deep', 'b.json')

  const written = writeFilesAtomic([{ target: a, content: 'A' }, { target: b, content: 'B' }])

  assert.deepEqual(written, [a, b])
  assert.equal(fs.readFileSync(a, 'utf8'), 'A')
  assert.equal(fs.readFileSync(b, 'utf8'), 'B', '缺失的父目录应被递归创建')
  assert.deepEqual(leftovers(dir), [])
  assert.deepEqual(leftovers(path.dirname(b)), [])
})

test('阶段一失败：目标一个都没被动过 —— 这正是旧 generate-contract-bundle 不具备的性质', () => {
  // 旧实现直写目标：写第一个文件成功、第二个失败时，第一个已经落在目标位置，
  // 只能靠内存快照还原回去。新实现所有 temp 写完才开始 rename，所以这类失败
  // 发生时目标根本没被碰过 —— 回滚分支甚至不需要参与。
  const dir = tmp()
  const a = path.join(dir, 'a.json')
  const b = path.join(dir, 'b.json')
  fs.writeFileSync(a, 'ORIGINAL-A', 'utf8')

  const restore = failOnCall(fs, 'writeFileSync', 2)
  try {
    assert.throws(
      () => writeFilesAtomic([{ target: a, content: 'NEW-A' }, { target: b, content: 'NEW-B' }]),
      /injected writeFileSync failure/,
    )
  } finally {
    restore()
  }

  assert.equal(fs.readFileSync(a, 'utf8'), 'ORIGINAL-A', '阶段一失败后 a 必须还是原样')
  assert.equal(fs.existsSync(b), false, 'b 从未存在过，不该被创建')
  assert.deepEqual(leftovers(dir), [], '第一个文件的 temp 必须被 finally 清掉')
})

test('阶段二失败：已 rename 的按快照还原，新建的被删掉，temp 清空', () => {
  // 这条是四处原实现里**没有任何一处**测过的路径。
  const dir = tmp()
  const a = path.join(dir, 'a.json')
  const b = path.join(dir, 'b.json')
  fs.writeFileSync(a, 'ORIGINAL-A', 'utf8')

  const restore = failOnCall(fs, 'renameSync', 2)
  try {
    assert.throws(
      () => writeFilesAtomic([{ target: a, content: 'NEW-A' }, { target: b, content: 'NEW-B' }]),
      /injected renameSync failure/,
    )
  } finally {
    restore()
  }

  assert.equal(
    fs.readFileSync(a, 'utf8'), 'ORIGINAL-A',
    'a 的 rename 已经成功了，必须靠阶段零的快照还原回去 —— 这是回滚分支唯一的作用',
  )
  assert.equal(fs.existsSync(b), false, 'b 原本不存在，回滚后也不该存在')
  assert.deepEqual(leftovers(dir), [])
})

test('阶段二失败：原本不存在的文件被回滚删除，不留半份新文件', () => {
  // 与上一条互补：上一条验"存在 → 还原字节"，这条验"不存在 → 删掉"。
  // 两个分支是 if/else，分开验才能证明两边都对。
  const dir = tmp()
  const a = path.join(dir, 'a.json')
  const b = path.join(dir, 'b.json')

  const restore = failOnCall(fs, 'renameSync', 2)
  try {
    assert.throws(() => writeFilesAtomic([{ target: a, content: 'A' }, { target: b, content: 'B' }]), /injected/)
  } finally {
    restore()
  }

  assert.equal(fs.existsSync(a), false, 'a 是新建的，回滚必须把它删掉')
  assert.equal(fs.existsSync(b), false)
  assert.deepEqual(leftovers(dir), [])
})

test('skipUnchanged：字节相同的文件不重写，且不出现在返回值里', () => {
  const dir = tmp()
  const same = path.join(dir, 'same.json')
  const diff = path.join(dir, 'diff.json')
  fs.writeFileSync(same, 'IDENTICAL', 'utf8')
  fs.writeFileSync(diff, 'OLD', 'utf8')

  // 把 mtime 推到过去再比对，比"两次调用的 mtime 是否相同"可靠 —— 后者在
  // 同一毫秒内完成时会假通过。
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(same, past, past)
  const before = fs.statSync(same).mtimeMs

  const written = writeFilesAtomic(
    [{ target: same, content: 'IDENTICAL' }, { target: diff, content: 'NEW' }],
    { skipUnchanged: true },
  )

  assert.deepEqual(written, [diff], '跳过的文件不该出现在返回值里')
  assert.equal(fs.statSync(same).mtimeMs, before, '内容相同的文件不该被重写')
  assert.equal(fs.readFileSync(diff, 'utf8'), 'NEW')
  assert.deepEqual(leftovers(dir), [])
})

test('不带 skipUnchanged 时，字节相同的文件照样重写', () => {
  // 默认值必须是"写"。反过来会让 render-docs 这类调用方以为自己在写，
  // 实际被静默跳过。
  const dir = tmp()
  const target = path.join(dir, 'x.json')
  fs.writeFileSync(target, 'SAME', 'utf8')
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(target, past, past)
  const before = fs.statSync(target).mtimeMs

  assert.deepEqual(writeFilesAtomic([{ target, content: 'SAME' }]), [target])
  assert.notEqual(fs.statSync(target).mtimeMs, before)
})

test('writeFileAtomic 是退化情形，返回写入的内容', () => {
  const dir = tmp()
  const target = path.join(dir, 'one.txt')
  assert.equal(writeFileAtomic(target, 'ONE'), 'ONE')
  assert.equal(fs.readFileSync(target, 'utf8'), 'ONE')
  assert.deepEqual(leftovers(dir), [])
})

test('temp 名不是固定的 —— 锁住 applyDocPlan 那个并发覆盖回归', () => {
  // 原 render-docs 用的是固定名 `${abs}.tmp-render`，两个并发进程会写同一个
  // temp 再各自 rename，其中一个的输出静默变成另一个的。
  //
  // 这条断言故意很窄：它只证明实现没有再用**那一个**名字，不证明 temp 名
  // 真的抗并发（同步 API 没法在单进程里构造真并发）。抗并发靠的是名字里的
  // pid + randomUUID，那是构造性质，不是这条测试的结论。写窄一点也比不写好：
  // 若有人为了"可预测的 temp 名"改回固定名，这里会红。
  const dir = tmp()
  const target = path.join(dir, 'doc.md')
  const fixed = `${target}.tmp-render`
  fs.writeFileSync(fixed, 'SQUATTER', 'utf8')

  writeFilesAtomic([{ target, content: 'RENDERED' }])

  assert.equal(fs.readFileSync(target, 'utf8'), 'RENDERED')
  assert.equal(
    fs.readFileSync(fixed, 'utf8'), 'SQUATTER',
    '实现用了固定的 .tmp-render 名 —— 那正是被合并掉的并发覆盖缺陷',
  )
})
