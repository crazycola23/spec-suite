// 发布模板派生物的**跨 commit** 字节稳定性 —— invariant #3
// 「derived stays reproducible」缺的那一半。
//
// 已经有的那一半在 tests/integration/v1-vertical-slice.test.mjs 的
// 「发布的 L0 example adapter 与 bundle 是 canonical inputs 的当前字节」：它证明
// **自洽** —— 签进仓库的派生物等于此刻重新派生出来的字节。那条断言抓两件事：
// 有人手改了派生物（派生结果与它不符），以及生成器单方面漂移（同理）。两件都
// 用变异测试量过，确实会红。
//
// 它抓不到第三件：生成器与派生物**一起**变。两边一起改，自洽照旧成立，绿灯，
// 而发布出去的模板字节已经不是任何人确认过的那一份了。这个文件补的是第三件。
//
// 写死的 sha256 不是为了禁止改动，是为了让改动必须被人**声明**一次 —— 与
// fixtures/ 的整树锁同一个思路（fixtures/README.md：「锁的作用不是禁止改动，
// 是让改动无法**悄悄**发生」）。
//
// 为什么锁的是 templates/L0/example：它是**发布物**，下游库把它抄走当起点。
// 它的字节静默移动是一件对外可见的事，值得每次都被确认。
//
// 顺带一个性质：这把锁没法空过。期望值是写死的十六进制，读不到文件会 ENOENT，
// 读错文件会 sha 不符 —— 两条路都是红的，没有「什么都没比较却通过」的形状。
//
// ## 更新流程（与 fixtures/ 那把锁一致）
//
// 1. 跑测试，失败信息里会打印实际 sha256；
// 2. **在 commit message 里写清为什么发布模板的派生字节需要变**；
// 3. 把实际值填回下面的常量。
//
// ## 故意**不**锁的两样东西
//
// - **`--report` 写出的 report.json / report.md。** report.json 的 `specsRoot` 是
//   绝对路径 —— 即使 `--specs-root` 传相对路径它也会被 resolve 成绝对路径（同一
//   份报告里的 `configPath` 反而保持相对，这处不对称是量出来的事实，登记在此，
//   不在这个 commit 里改：改它会动到报告的对外字节）。绝对路径含仓库位置与临时
//   目录名，换台机器就变，锁不住。至于「同一次运行里跑两遍字节相同」，那件事
//   由 v1-vertical-slice 的 determinism 断言覆盖，不重复。
// - **`trust-report --format md|json`。** 它字节确实稳定（两次运行同 sha，不含
//   日期、时钟或绝对路径 —— 量过），但故意不锁。它派生自 registry/invariants.mjs，
//   每加一条 invariant 都会让 sha 变；而「加 invariant 要便宜」正是本次重构的
//   P1 目标，拿一个 magic hex 给它上税是反目标的。它需要被锁住的是**语义**而不是
//   字节，那些锁在 tests/unit/trust-report.test.mjs 里，且不随措辞与行号漂移：
//   免责声明必须在前 15 行内、每条 residualRisk 逐字出现、无机器证据必须写「无」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = path.join(REPO_ROOT, 'scripts')
const EXAMPLE = path.join(REPO_ROOT, 'templates', 'L0', 'example')

// 四份派生物，键是 example 根下的相对路径。
//
// 两个不同的生成器各管一段：CLAUDE.md / AGENTS.md 的生成区由 check-spec-suite.mjs
// --write-generated-regions 重写，generated/ 下两份由 generate-contract-bundle.mjs
// 产出。所以这里是四个独立常量而不是一个整树摘要 —— 失败时要能直接看出是哪条
// 派生链动了。
const GOLDEN = {
  'CLAUDE.md':
    'sha256:321a99aaefefafebdaa4a41acf249421555cd68d3be6912b2f5bba9a9f1e4e6e',
  'AGENTS.md':
    'sha256:4ff595718a1351841ea69cb7db3deef0545e2fe0c5f82558e3a7eb70951242b8',
  'generated/contract-bundle.json':
    'sha256:19f841d175da342c868c4cbcc0be3ff8ebd73f59fee5d767e0778d89d0c62ae1',
  'generated/manifest.json':
    'sha256:3e6fdfab00d5ba88575d3924bdb7dfe128bc96c54ede7b479fba1df1500ba877',
}

// 对原始字节求摘要，不做任何文本归一化 —— CRLF 与 BOM 必须改变摘要。
// 与 compatibility.test.mjs 的 fileSha256 同一个语义，故意也同一个写法。
function fileSha256(absolute) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`
}

function report(actual) {
  return Object.entries(actual)
    .map(([rel, sha]) => `  ${sha}  ${rel}`)
    .join('\n')
}

test('签进仓库的发布模板派生物就是被确认过的那份字节', () => {
  const actual = {}
  for (const rel of Object.keys(GOLDEN)) actual[rel] = fileSha256(path.join(EXAMPLE, rel))

  if (JSON.stringify(actual) !== JSON.stringify(GOLDEN)) {
    assert.fail(
      'templates/L0/example 的派生物字节变了。\n'
      + '这是发布物 —— 下游库抄它当起点，所以它的字节不该悄悄移动。\n'
      + '若这次改动确实必要：在 commit message 里写清为什么，然后把下面的实际值\n'
      + `填回 ${path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/')} 的 GOLDEN。\n`
      + `实际：\n${report(actual)}\n`
      + `期望：\n${report(GOLDEN)}`,
    )
  }
})

test('从 canonical inputs 重新派生，得到的还是同一份字节', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-golden-'))
  try {
    fs.cpSync(EXAMPLE, root, { recursive: true })
    const config = path.join(root, 'spec-suite.config.json')

    // 先清空派生物，否则「工具没干活」也能让下面的比对通过。做法与
    // v1-vertical-slice 里那条一致：generated/ 整删，两个 adapter 只清生成区正文
    // （生成区寄生在手写文档里，删掉整份文件等于连宿主一起删）。
    const entries = [path.join(root, 'CLAUDE.md'), path.join(root, 'AGENTS.md')]
    const entriesBefore = entries.map((entry) => fs.readFileSync(entry))
    fs.rmSync(path.join(root, 'generated'), { recursive: true, force: true })
    const zoneBody = /(<!-- BEGIN GENERATED: agent-entry\.common -->\n)[\s\S]*?(<!-- END GENERATED: agent-entry\.common -->)/
    entries.forEach((entry) => {
      fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(zoneBody, '$1$2'), 'utf8')
    })
    assert.equal(fs.existsSync(path.join(root, 'generated')), false)
    entries.forEach((entry, index) => {
      assert.notDeepEqual(fs.readFileSync(entry), entriesBefore[index],
        `${path.basename(entry)} 生成区没被清空 —— 这条测试正在空过`)
    })

    for (const [script, args] of [
      ['check-spec-suite.mjs', ['--specs-root', root, '--config', config, '--write-generated-regions', '--quiet']],
      ['generate-contract-bundle.mjs', ['--specs-root', root, '--config', config]],
    ]) {
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, `${script} 失败：\n${r.stdout}\n${r.stderr}`)
    }

    const actual = {}
    for (const rel of Object.keys(GOLDEN)) actual[rel] = fileSha256(path.join(root, rel))
    assert.deepEqual(
      actual, GOLDEN,
      '重新派生出来的字节与被确认过的值不符 —— 生成器漂移了。\n'
      + `实际：\n${report(actual)}`,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
