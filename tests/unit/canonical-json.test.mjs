// src/shared/canonical-json.mjs 的行为测试。
//
// 存在理由与 atomic-write.test.mjs / argv.test.mjs 同源：canonical-json.mjs 的
// 文件头写下了承诺 ——「两条都由 canonical-json.test.mjs 钉住，免得"不保证"随
// 实现漂移成"碰巧保证"」。未被测试的承诺就是未被证明的承诺。
//
// 但这个文件比另外两个更需要存在，因为**它的输出是线格式（wire format）**：
//
//   * V2 的 lease 签名就是 `crypto.sign(null, Buffer.from(stableJson(payload)))`
//     的字节。签发在一个进程、验证在另一个进程、中间隔着时间。
//   * V1 的 `contract-bundle.json` 被 `manifest.json` 的 digest 钉住，下游
//     consumer 逐字节校验。
//
// 也就是说：这个函数的输出**改一个字节，既有的 lease 全部失效、既有的 bundle
// 全部校验失败**。而它看起来只是个"格式化工具"—— 下一个人完全可能为了可读性
// 把缺省缩进从 0 改成 2。合并 D4 时我逐字搬移而不是重写，正是因为这一点；
// 而"逐字"这件事本身也需要被钉住，否则下次搬移就没有基准了。
//
// 三类断言：
//   1. **严格语义**：非 JSON 值一律抛错（合并时 V1 那份是静默放行的）。
//   2. **线格式**：缺省紧凑、键序、数组序、幂等。
//   3. **刻意不保证的两条**（NaN/Infinity、Date/Map/Set）。它们被钉住不是为了
//      冻结，而是为了让将来的收紧成为一次**有意的**改动：测试变红 ⇒ 有人必须
//      读到旁边的注释 ⇒ 先去 registry 登记 invariant。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { canonicalize, stableJson } from '../../src/shared/canonical-json.mjs'
import { ROOTS } from '../../scripts/check-architecture.mjs'
import * as controlPlaneCommon from '../../scripts/control-plane-common.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')

/** 取 message 而不是用 assert.throws(fn, /re/) —— 后者匹配的是带 `Error: ` 前缀的 String(err)。 */
const msg = (fn) => { try { fn(); return null } catch (e) { return e.message } }

// ---------------------------------------------------------------------------
// 严格语义：合并时从 V2 继承、V1 那份没有的部分
// ---------------------------------------------------------------------------

test('非 JSON 值一律抛错，文案逐字带上 typeof', () => {
  // 这是 D4 收紧的**全部**内容。合并前 V1 那份对这些值静默放行，然后
  // `JSON.stringify` 把它们悄悄丢掉（在对象里字段整个消失，在数组里变成 null）。
  // 后果不是崩溃而是**一个字段安静地从权威 artifact 里不见了**，而 digest 照样
  // 自洽、校验照样通过、没有任何人收到报错。
  //
  // 文案逐字钉住的理由：它是从 V2 搬来的原文，一个字没改。全仓库只有这里断言它，
  // 所以这条测试同时是「搬移是逐字的」这件事的唯一证据。
  assert.equal(msg(() => canonicalize(undefined)), 'value is not JSON-serializable: undefined')
  assert.equal(msg(() => canonicalize(() => {})), 'value is not JSON-serializable: function')
  assert.equal(msg(() => canonicalize(Symbol('x'))), 'value is not JSON-serializable: symbol')
  assert.equal(msg(() => canonicalize(1n)), 'value is not JSON-serializable: bigint')

  // 嵌套位置同样抛错 —— 递归的每一层都过同一道判定，没有"只检查顶层"这种半吊子。
  assert.equal(msg(() => canonicalize({ a: { b: undefined } })), 'value is not JSON-serializable: undefined')
  assert.equal(msg(() => canonicalize([1, [2, () => {}]])), 'value is not JSON-serializable: function')

  // stableJson 必须继承同一套拒绝 —— 它今天是 canonicalize 的薄包装，但"薄"这件事
  // 需要被证明：若有人为了性能给 stableJson 加一条 JSON.stringify 快路径，
  // 严格语义会**只在 canonicalize 上**保留，而线格式恰恰走的是 stableJson。
  assert.equal(msg(() => stableJson({ a: undefined })), 'value is not JSON-serializable: undefined')
})

test('`0n` 与 `1n` 走不同的判定分支，但给出同一条文案', () => {
  // 实现里的 `if (!value || typeof value !== 'object')` 看起来有一半是冗余的
  // （`null` 已在上一行返回），文件头也这么写了。这条测试证明那句注释是准确的：
  // `!value` 实际只捕获 `undefined` **和** `0n`（0n 是假值！），其余非 JSON 值
  // 走后半句。两条分支必须给出同一条文案，否则错误信息会随输入的真假值抖动。
  assert.equal(msg(() => canonicalize(0n)), msg(() => canonicalize(1n)))
  assert.equal(msg(() => canonicalize(0n)), 'value is not JSON-serializable: bigint')
})

test('已知缺口：错误文案不含路径 —— 深处的一个 undefined 只报 typeof', () => {
  // 记在这里而不是"修掉"：加路径要改文案，而文案是 V2 的原文（见上一条测试
  // 为什么这件事重要）。真实代价是调试成本 —— 一个 200 字段的 lease payload
  // 里有一个 undefined，报错只说"有个 undefined"，不说是谁。
  //
  // 要补路径应当连同 V2 一起改，并且明确它是一次文案变更，而不是在某次无关的
  // 重构里顺手加上。
  assert.equal(
    msg(() => canonicalize({ lease: { payload: { effects: [{ resource: undefined }] } } })),
    'value is not JSON-serializable: undefined',
  )
})

// ---------------------------------------------------------------------------
// 线格式：改一个字节 ⇒ 既有 lease 全废
// ---------------------------------------------------------------------------

test('stableJson 缺省紧凑 —— 这是线格式，不是排版偏好', () => {
  // 若有人把缺省 space 改成 2（"这样打印出来好看"），后果是：
  //   * V2 既有的每一份 lease 签名都验证失败（签名的字节就是这个字符串）；
  //   * jsonDigest / computeCanonicalRevision 的每一个既有 digest 都变化。
  // 而这两处都不会说"格式变了"，只会说"签名无效 / digest 不匹配"。
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableJson([1, 2]), '[1,2]')
  assert.equal(stableJson({}), '{}')

  // 显式传 space 才缩进 —— V1 的 bundle 走的是这条（`stableJson(x, 2)` 的等价形式）。
  assert.equal(stableJson({ b: 1, a: 2 }, 2), '{\n  "a": 2,\n  "b": 1\n}')
})

test('对象按键名排序、递归到每一层；数组保序', () => {
  // 排序是 digest 稳定的**全部**来源：同一份语义数据无论构造顺序如何，字节相同。
  // 数组不排序同样是语义要求 —— `effects[]` 的顺序、`gaps[].blocks[]` 的顺序都
  // 是数据本身，排序会改变含义。
  assert.deepEqual(Object.keys(canonicalize({ c: 1, a: 2, b: 3 })), ['a', 'b', 'c'])
  assert.equal(stableJson({ z: { y: 1, x: 2 }, a: [{ n: 1, m: 2 }] }), '{"a":[{"m":2,"n":1}],"z":{"x":2,"y":1}}')
  assert.equal(stableJson(['c', 'a', 'b']), '["c","a","b"]')
  // 构造顺序不同、语义相同 ⇒ 字节相同。这就是 digest 能当身份用的原因。
  assert.equal(stableJson({ a: 1, b: 2 }), stableJson({ b: 2, a: 1 }))
})

test('幂等：canonicalize 两次与一次的输出相同', () => {
  // 迁移与重签名路径会对已经 canonical 的数据再跑一遍。不幂等意味着"跑两次"
  // 与"跑一次"产出不同字节，而调用方无法知道自己拿到的是第几手。
  const input = { z: [3, { b: 1, a: 2 }], a: 'x' }
  const once = canonicalize(input)
  assert.deepEqual(canonicalize(once), once)
  assert.equal(stableJson(once), stableJson(input))
})

test('纯函数：不改入参', () => {
  const input = { c: 1, a: { b: 2 } }
  const snapshot = JSON.stringify(input)
  canonicalize(input)
  assert.equal(JSON.stringify(input), snapshot, '入参被就地改动了')
  // 返回的是新对象，不是同一引用 —— 否则调用方改返回值会污染 canonical 输入。
  assert.notEqual(canonicalize(input), input)
  assert.notEqual(canonicalize(input).a, input.a)
})

// ---------------------------------------------------------------------------
// 刻意不保证的两条（文件头承诺钉住的就是这两条）
// ---------------------------------------------------------------------------

test('已知缺口 1：NaN / Infinity 静默变成 null', () => {
  // 与 `undefined` 同类的静默丢失：typeof 是 'number'，原样通过，然后被
  // JSON.stringify 变成 null。也就是说一个坏数字会安静地变成一个**合法的** null。
  //
  // 为什么不在 D4 里一起收紧：两份原实现都放行它，拒绝它属于**第三种**语义，
  // 不在这次合并的授权范围内。要收紧请先在 registry/invariants.mjs 里登记一条
  // invariant（连同它的 severity 与 residualRisk），再改这里 —— 那样它就是一次
  // 有记录的语义变更，而不是某次重构的副作用。
  assert.equal(stableJson({ a: NaN }), '{"a":null}')
  assert.equal(stableJson({ a: Infinity, b: -Infinity }), '{"a":null,"b":null}')
  assert.equal(stableJson([NaN]), '[null]')
})

test('已知缺口 2：Date / Map / Set / 类实例被摊平，不等价于 JSON.stringify', () => {
  // typeof 是 'object' ⇒ 被 Object.keys 摊平。`new Date()` 变成 `{}`，而
  // JSON.stringify 单独用时会给出 ISO 字符串（它调 toJSON）。
  //
  // 所以本函数只承诺「**纯 JSON 形状**的输入被保序保真」。任何往 payload 里塞
  // Date 的调用方都会静默丢掉那个时间 —— 这也是 V2 的 payload 里所有时间都是
  // 字符串或数字的原因。
  assert.equal(stableJson({ d: new Date(0) }), '{"d":{}}')
  assert.equal(stableJson({ m: new Map([['a', 1]]) }), '{"m":{}}')
  assert.equal(stableJson({ s: new Set([1, 2]) }), '{"s":{}}')
  assert.equal(stableJson({ n: new Number(5) }), '{"n":{}}')

  // 与 JSON.stringify 的差异是**可观测的**，这条断言把"不等价"本身钉住 ——
  // 免得有人看到两者在纯 JSON 输入上一致，就以为可以互换使用。
  assert.notEqual(stableJson({ d: new Date(0) }), JSON.stringify({ d: new Date(0) }))
})

// ---------------------------------------------------------------------------
// 源级锁：合并的价值全在"以后不会再长出第三份"
// ---------------------------------------------------------------------------

/** 全仓库的非测试 .mjs（测试文件自己不算实现）。 */
function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (!e.isFile() || !e.name.endsWith('.mjs') || e.name.endsWith('.test.mjs')) continue
      out.push({ rel: path.relative(REPO, abs).split(path.sep).join('/'), abs })
    }
  }
  // 非空性守卫：靠这个 helper 的几条 sweep，结论都是「offenders 为空」，而一个
  // 扫不到任何文件的 walker 同样给出空 —— 那种绿灯什么也没证明。测试文件从
  // scripts/ 搬进 tests/ 时 REPO 的层级正好变过一次，所以这不是假想风险。
  //
  // 两条断言各管一种失效：逐根 `> 0` 抓「某个根不再有文件」；总量下限抓「进了
  // 根目录却没递归进子目录」—— src/ 顶层只有 layers.mjs，光看逐根会漏过后者。
  //
  // 根清单单一来源在 check-architecture.mjs，与架构检查同一片范围。
  for (const root of ROOTS) {
    const abs = path.join(REPO, root)
    const before = out.length
    if (fs.existsSync(abs)) walk(abs)
    // tests/ 目前全是 `.test.mjs`，被上面的过滤器排掉，一个都不贡献 —— 预期如此。
    if (root === 'tests') continue
    assert.ok(out.length > before, `${root}/ 下一个非测试 .mjs 都没扫到 —— REPO 层级算错了，或这个根已改名/被删`)
  }
  assert.ok(out.length >= 30, `全仓库只扫到 ${out.length} 个非测试 .mjs —— 递归可能断了，源级锁正在空过`)
  return out
}

test('全仓库只有一份 canonicalize / stableJson 的定义', () => {
  // D4 合并前有两份近乎逐字重复的实现，语义**不同**（一份 throw、一份静默放行），
  // 而没有任何东西阻止它们分叉 —— 事实上它们已经分叉了。这条测试是那件事不再
  // 发生的唯一保障：re-export 不算定义，第三份实现算。
  const offenders = []
  for (const f of sourceFiles()) {
    if (f.rel === 'src/shared/canonical-json.mjs') continue
    const src = fs.readFileSync(f.abs, 'utf8')
    for (const name of ['canonicalize', 'stableJson']) {
      const defines = new RegExp(`function\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=`)
      if (defines.test(src)) offenders.push(`${f.rel}：定义了 ${name}`)
    }
  }
  assert.deepEqual(
    offenders, [],
    `canonicalize / stableJson 只能定义在 src/shared/canonical-json.mjs：\n${offenders.join('\n')}\n`
    + '需要不同语义时请改那一份并更新本文件的测试，不要再开一份 —— 分叉出来的第二份'
    + '不会有人发现，因为两份都"能用"。',
  )
})

test('control-plane-common 导出的是同一个函数对象，不是第二份实现', () => {
  // V2 的 5 个模块（enforce-effect / lease-issuer / project-context /
  // control-plane-ipc）与 v2-control-plane.test.mjs 都按
  // `./control-plane-common.mjs` import 这两个名字。D4 只搬走实现、不动导入路径，
  // 否则这次合并会变成一次 V2 改动 —— 而 V2 的每一处改动都要重新论证签名兼容性。
  //
  // 断言 `===` 而不是 typeof：身份相等才能证明它是 re-export。若哪天有人在
  // control-plane-common 里写了一个包装（比如加一层缓存），这里会红 —— 那正是
  // 需要有人重新论证"lease 签名的字节没变"的时刻。
  assert.equal(controlPlaneCommon.canonicalize, canonicalize)
  assert.equal(controlPlaneCommon.stableJson, stableJson)
})

test('canonical-json.mjs 不依赖任何东西 —— 它是 shared 层的叶子', () => {
  // 线格式的实现必须没有依赖：任何 import 都是一条能改变输出字节的路径，
  // 而输出字节就是签名。零依赖让"输出只由入参决定"成为可以目视确认的事实。
  const src = fs.readFileSync(path.join(REPO, 'src/shared/canonical-json.mjs'), 'utf8')
  const specs = [...src.matchAll(/^\s*import\s.*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(specs, [], 'canonical-json.mjs 必须零依赖')
})
