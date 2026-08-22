// src/shared/paths.mjs 的行为测试。
//
// paths.mjs 的文件头写下了几条**具体**的承诺，其中最关键的一条是：
//
//   「`parent` 自身算在内」这条**行为**同时服务两个相反的语义 ——
//     解析型调用要它为真（`generatedDir: "."` 合法），
//     assertOutside 要它为真（root 自身必须被拒）。
//
// 这种句子必须有测试，否则它只是注释里的一句断言。仓库的规矩是同一条：
// 未被测试的承诺就是未被证明的承诺。它比没有承诺更糟 —— 下一个人会依赖它。
//
// 这个文件头本身就有一次前车之鉴：它最初写的是「`rel === ''` **这一项**删掉会在
// 一个方向上放宽、另一个方向上收紧」。变异测试直接否掉了这句话（见下表），于是
// paths.mjs 的文件头与这里都改成了现在的说法。断言写在注释里就是这样 ——
// 不跑一遍，写得再具体也可能是错的。
//
// ## 为什么这一个 6 行的函数值得一个测试文件
//
// 合并前它散在 8 处逐字重复，而其中 **2 处用的是反方向**（在内 ⇒ 抛错）。
// 也就是说仓库同时依赖 `isInside` 为真和为假：
//
//   * 「不许逃出规格库」—— 6 处解析器，判为在外则抛错；
//   * 「私钥 / trust root 必须落在 agent 可读范围之外」—— 2 处 assertOutside，
//     判为在内则抛错。
//
// 抄歪一份，两个方向会**不对称地**失效：一边仍然拦得住，另一边悄悄放行，
// 而两边各自的测试照旧全绿 —— 因为每一份抄写都只被自己那侧的测试覆盖。
// 合并成一个定义之后，这种不对称在结构上不可能再发生；这个文件负责证明那**一份**
// 定义的每一个 clause 都是有意的。
//
// ## 四个 clause，以及一条「不是字符串前缀判定」
//
// `rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))`
//
// 下表的两栏「后果」是**实测**的（变异测试：破坏实现，跑 paths.test.mjs 之外的
// 11 个测试文件当既有 oracle，再跑本文件），不是读代码推理出来的：
//
//   | 变异                       | 单独挡住的输入          | 既有     | 本文件   |
//   |----------------------------|-------------------------|----------|----------|
//   | 删 `rel === ''`            | （无 —— 见下）          | 全绿     | 全绿     |
//   | 删 `!startsWith('../')`    | `root/../x`             | 16 红    | 4 红     |
//   | 删 `rel !== '..'`          | `root/..`（父目录本身） | **全绿** | **3 红** |
//   | 删 `!isAbsolute(rel)`      | 跨盘符（Windows）       | —        | —        |
//   | 换成 `child.startsWith()`  | 兄弟 `root` / `rootx`   | **全绿** | **1 红** |
//
// 三行值得停下来看：
//
//   * **`rel !== '..'` 那一行**：改动前的整套测试对它完全无感，而它漏掉的正是
//     「上一级目录被判为在规格库之内」。`'..'` **不**以 `'..' + sep` 开头，所以
//     前一项挡不住它。这条测试是仓库里唯一挡住这件事的东西。
//   * **朴素前缀那一行**：同样只有本文件挡得住。它是这个判定最常见的错写法，
//     而它答错的形状（共享前缀的兄弟目录）此前不在任何测试的用例里 ——
//     包括本文件最初的 12 条。是变异测试逼出了那一条断言，不是review。
//   * **`rel === ''` 那一行**：它是**冗余**的。空串同样满足其余三项，所以删掉它
//     行为不变。paths.mjs 的文件头一度声称这一项"删掉会在一个方向上放宽、
//     另一个方向上收紧"，变异测试证明那句话是错的 —— 已改。下面 clause 1 那条
//     测试因此钉的是**行为**（root 自身算在内、两个方向相反地依赖它），
//     而不是那一行代码。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { isInside } from '../../src/shared/paths.mjs'
import { ROOTS, blankComments } from '../../scripts/check-architecture.mjs'
import { resolveInside as resolveInsideV2 } from '../../scripts/control-plane-common.mjs'
import { inspectUnresolvedFact } from '../../scripts/guard-unresolved-fact.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')

/** 取 message 而不是用 assert.throws(fn, /re/) —— 后者匹配的是带 `Error: ` 前缀的 String(err)。 */
const msg = (fn) => { try { fn(); return null } catch (e) { return e.message } }
const msgAsync = async (fn) => { try { await fn(); return null } catch (e) { return e.message } }

/** 造一个本机形态的绝对路径，且**刻意不存在** —— 用来证明本函数不碰文件系统。 */
const ABS = (...segments) => path.resolve(path.sep === '\\' ? 'C:\\nope' : '/nope', ...segments)

// ---------------------------------------------------------------------------
// 四个 clause，以及实现形态本身
// ---------------------------------------------------------------------------

test('基本语义：真子孙在内，兄弟与父级在外', () => {
  const root = ABS('root')
  assert.equal(isInside(root, path.join(root, 'a')), true)
  assert.equal(isInside(root, path.join(root, 'a', 'b', 'c.json')), true)
  assert.equal(isInside(root, ABS('other')), false)
  assert.equal(isInside(root, path.dirname(root)), false)
})

test('clause 1 的**行为**：root 自身算「在内」，两个相反方向都依赖这一点', () => {
  // `rel === ''` 这个 **clause 本身是冗余的**（空串同样满足其余三项，见 paths.mjs
  // 文件头与上面的表格）。这条测试钉的是**行为**（root 自身 ⇒ true），不是那一行。
  const root = ABS('root')
  assert.equal(isInside(root, root), true)
  // 尾随分隔符不改变判定（path.relative 已经归一）。
  assert.equal(isInside(root, root + path.sep), true)

  // 方向 A —— 解析型调用（在外 ⇒ 抛错）：`generatedDir: "."` 是合法配置，
  // 它 resolve 出来恰好是 root 自身，**不能**抛错。
  assert.equal(resolveInsideV2(root, '.'), root)

  // 方向 B —— assertOutside（在内 ⇒ 抛错）：同一个 `true` 在那一侧的含义是
  // 「不在外面」⇒ 必须拒绝。把 trust root 或私钥目录设成 workspace 根目录本身，
  // 靠的就是这一项挡住。
  //
  // 两处 assertOutside 都不是导出符号，所以这里断言的是谓词本身：`isInside(root, root)`
  // 为 `true` ⇒ `if (isInside(...)) throw` 一定触发。运行时覆盖在别处：
  // lease-issuer 那处由 v2-control-plane.test.mjs 的「私钥落在 workspace 内」用例
  // 实跑（断言 stderr 含 `outside the agent-readable specs root`）；
  // control-plane-trust 那处只经 daemon 配置加载可达，因此在缺 POSIX 身份的机器上
  // 随该组测试一起 skip，在 CI（ubuntu）上实跑。
  //
  // 这条**行为**一旦被改动，会在一个方向上放宽、另一个方向上收紧 —— 而收紧的
  // 那一边会吵闹地立刻暴露（合法的 `.` 开始被拒），放宽的那一边是安静的。
})

test('clause 2：`root/../x` 逃逸必须被判为在外', () => {
  const root = ABS('root')
  assert.equal(isInside(root, path.join(root, '..', 'sibling')), false)
  assert.equal(isInside(root, path.join(root, 'a', '..', '..', 'sibling')), false)
  // 深处的 `..` 只要最终没走出 root 就仍算在内 —— 判定看的是解析后的位置，不是字面量。
  assert.equal(isInside(root, path.join(root, 'a', '..', 'b')), true)
})

test('clause 3：恰好等于 ".." 的相对路径 —— 前一项挡不住它', () => {
  // 这是四项里最容易被"顺手简化"掉的一项，因为它看起来是 clause 2 的子集。
  // 它不是：`'..'` 不以 `'..' + sep` 开头。
  const root = ABS('root')
  const parent = path.dirname(root)
  assert.equal(path.relative(root, parent), '..', '前提变了：本条测试假定 rel 恰好是 ".."')
  assert.equal(isInside(root, parent), false)
  // 绕一圈回到父目录，同样只得到 `'..'`。
  assert.equal(isInside(root, path.join(root, 'a', '..', '..')), false)

  // 真实后果：少了这一项，`--unresolved ..` 会被当成项目内路径接受。
  // 用真实调用点证明这条链是接通的，而不只是谓词自己正确。
  assert.equal(msg(() => resolveInsideV2(root, '..')), `path escapes the configured root: ..`)
})

test('clause 4：`path.relative` 返回绝对路径时（跨盘符）必须判为在外', () => {
  // 这一项只在 Windows 上有输入可命中：POSIX 的 path.relative 永远返回相对路径，
  // 而 win32 在跨盘符时无法表达相对关系，直接把目标原样返回。
  // 先把这个前提本身钉住 —— 它是 clause 4 存在的**唯一**理由，且可以在任何平台上验证。
  assert.equal(path.win32.relative('C:\\a', 'D:\\b'), 'D:\\b')
  assert.equal(path.win32.isAbsolute(path.win32.relative('C:\\a', 'D:\\b')), true)
  assert.equal(path.posix.isAbsolute(path.posix.relative('/a', '/b')), false)

  // 本机可命中时再断言 isInside 本身。在 POSIX 上这一项是无输入可达的防御，
  // 不是未被测试的分支 —— 上面三条断言正是它的说明。
  if (path.sep === '\\') {
    assert.equal(isInside('C:\\a', 'D:\\b'), false)
    assert.equal(isInside('C:\\a', 'D:\\a\\b'), false, '同名子路径跨盘符仍然在外')
  }
})

test('它不是字符串前缀判定：兄弟目录 `root` / `rootx` 不能被误判为在内', () => {
  // 这条测试是变异测试逼出来的：把实现换成 `String(child).startsWith(String(parent))`
  // 之后，既有 200 条与本文件当时的 12 条**同时全绿** —— 因为那时每一对被断言的
  // 路径在两种实现下的答案恰好一致。共享前缀的兄弟目录是唯一能分开它们的输入。
  const root = ABS('root')
  const sibling = ABS('rootx')

  // 前提：这确实是 `startsWith` 会答错的形状（不然这条测试什么都没证明）。
  assert.equal(sibling.startsWith(root), true, '前提：兄弟目录的字符串确实以 root 为前缀')
  assert.equal(isInside(root, sibling), false, '兄弟目录不能被误判为在内')

  // path.relative 天然没有这个问题 —— 两个平台的形态都钉一下，
  // 这是 paths.mjs 文件头「这里走 path.relative 就没有这个问题（得到 ../ab）」那句话的证据。
  assert.equal(path.win32.relative('C:\\root', 'C:\\rootx'), '..\\rootx')
  assert.equal(path.posix.relative('/a', '/ab'), '../ab')

  // 真实后果：少了这条性质，`--graph ../rootx` 这类逃逸会被解析型调用接受
  // （resolve 出来的绝对路径以 root 为字符串前缀）。用真实调用点证明链路接通。
  assert.equal(msg(() => resolveInsideV2(root, '../rootx')), 'path escapes the configured root: ../rootx')
})

// ---------------------------------------------------------------------------
// 刻意不保证的部分（文件头逐条声明过的）
// ---------------------------------------------------------------------------

test('已知缺口：纯词法判定，不解析 symlink —— 证据是它对不存在的路径也照样工作', () => {
  // 无法在 Windows 上直接构造符号链接（EPERM），但缺口的机制可以被正面证明：
  // 本函数对**完全不存在**的路径给出确定答案 ⇒ 它从不查文件系统 ⇒ 它不可能
  // 知道某一段是符号链接、指向哪里。
  const root = ABS('root')
  assert.equal(fs.existsSync(root), false, '前提：这条路径不该存在')
  assert.equal(isInside(root, path.join(root, 'link', 'target')), true)

  // 于是：`root/link` 若是指向 root 之外的符号链接，本函数照样答「在内」。
  // V2 因此在 control-plane-trust.mjs 里**另外**用 assertNotSymlink 挡这件事；
  // V1 全仓库没有 realpath，容纳判定对符号链接是敞开的 —— 这条缺口登记在
  // registry/invariants.mjs 的 CP-PATH-CONTAINMENT.residualRisk 里，
  // 不是 import 了这个函数就拿到的保证。
  //
  // 用 blankComments 先去掉注释，再找**调用**形态：paths.mjs 的文件头和
  // 那条 residualRisk 都写着 "realpath" 这个词，按词匹配只会匹配到文档本身。
  const realpathUsers = sourceFiles()
    .filter((f) => /\brealpath(Sync)?\s*\(/.test(blankComments(fs.readFileSync(f.abs, 'utf8'))))
    .map((f) => f.rel)
  assert.deepEqual(
    realpathUsers, [],
    '有人引入了 realpath 调用。这未必是坏事，但容纳判定的 symlink 缺口是登记在\n'
    + 'registry/invariants.mjs 的 CP-PATH-CONTAINMENT.residualRisk 里的事项，收紧它应当先\n'
    + '更新那条登记（以及 paths.mjs 的文件头），而不是在某个调用点单独 realpath 一下 ——\n'
    + '那样只有那一处被覆盖，其余 5 个调用点的缺口仍然在。',
  )
})

test('已知缺口：大小写敏感性完全委托给 OS binding，本函数不承诺', () => {
  // 同一对路径，win32 判在内、posix 判在外。isInside 用的是宿主 `path` 绑定，
  // 所以它的答案随平台变化 —— 这不是缺陷，是有意的"跟随 OS"。钉住它是为了让
  // 「同一份 config 在两个平台上判定不同」成为已知事实，而不是某天的意外发现。
  assert.equal(path.win32.relative('C:\\a', 'c:\\a\\b'), 'b')
  assert.equal(path.posix.relative('/A', '/a/b'), '../a/b')
})

// ---------------------------------------------------------------------------
// 真实调用点：两侧的错误文案没有被合并掉
// ---------------------------------------------------------------------------

test('合并的是谓词，不是文案 —— V1 说中文、V2 说英文，各自照旧', async () => {
  // 这是本次合并**刻意没做**的那一半：4 个解析器共用谓词，但保留各自的
  // 消息集与「是否接受绝对路径」的策略差异（V1 拒绝绝对路径，V2 接受并 resolve）。
  // 统一文案会改变 v1-vertical-slice.test.mjs 按正则断言的 stderr，
  // 也会把仓库里「V1 讲中文、V2 讲英文」这条既有事实抹掉。
  const root = ABS('root')
  assert.equal(msg(() => resolveInsideV2(root, '..')), 'path escapes the configured root: ..')
  assert.equal(msg(() => resolveInsideV2(root, '..', '--graph')), '--graph escapes the configured root: ..')

  // V1 侧走真实 CLI 入口（resolveRegistry 不是导出符号）。
  assert.equal(
    await msgAsync(() => inspectUnresolvedFact({ fact: 'x', specsRoot: root, unresolved: '../out.yaml' })),
    '--unresolved 越出项目根目录',
  )
  // V1 还多一条 V2 没有的策略：绝对路径直接拒，不 resolve。
  assert.equal(
    await msgAsync(() => inspectUnresolvedFact({ fact: 'x', specsRoot: root, unresolved: ABS('out.yaml') })),
    '--unresolved 必须是项目内相对路径',
  )
})

// ---------------------------------------------------------------------------
// 源级锁：合并的价值全在"以后不会再长出第九份"
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
  // 非空性守卫：靠这个 helper 的三条 sweep 里有两条结论是「offenders 为空」，而
  // 一个扫不到任何文件的 walker 同样给出空 —— 那种绿灯什么也没证明。测试文件从
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

test('全仓库只有一处写出这个谓词', () => {
  // 正向锁：判定式的字面形态只允许出现在 paths.mjs 一处。合并前它有 8 份，
  // 而没有任何东西阻止第 9 份出现 —— 抄一遍比 import 一下更省事，这是默认的
  // 熵增方向。这条测试是唯一的反向压力。
  const fragment = /rel\s*!==\s*'\.\.'|relative\s*!==\s*'\.\.'|!==\s*'\.\.'\s*&&/
  const offenders = []
  for (const f of sourceFiles()) {
    if (f.rel === 'src/shared/paths.mjs') continue
    if (fragment.test(fs.readFileSync(f.abs, 'utf8'))) offenders.push(f.rel)
  }
  assert.deepEqual(
    offenders, [],
    `路径容纳判定只能定义在 src/shared/paths.mjs：\n${offenders.join('\n')}\n`
    + '需要不同语义时请改那一份并更新本文件的 clause 测试。第 9 份不会有人发现，\n'
    + '因为它"能用"—— 而两个方向里悄悄放行的那一边同样"能用"。',
  )
})

test('导入方恰好是这 7 个文件', () => {
  // 反向锁。数量本身不是目的 —— 它是"有人新写了一处容纳判定"与"有人复用了
  // 这一处"的区分器：前者会让上一条测试变红，后者会让这一条变红。两条都红说明
  // 有人抄了一份**并且**没有复用；只有这一条红说明扩散是正当的，改这里的清单即可。
  const importers = sourceFiles()
    .filter((f) => /from\s*['"][^'"]*shared\/paths\.mjs['"]/.test(fs.readFileSync(f.abs, 'utf8')))
    .map((f) => f.rel)
    .sort()
  assert.deepEqual(importers, [
    'scripts/control-plane-common.mjs',
    'scripts/control-plane-trust.mjs',
    'scripts/generate-contract-bundle.mjs',
    'scripts/guard-unresolved-fact.mjs',
    'scripts/lease-issuer.mjs',
    'scripts/verify-consumer-contracts.mjs',
    'src/truth/adapters/zones.mjs',
  ])
})

test('刻意排除的三处仍然各自保留自己的检查', () => {
  // enforce-effect.mjs 的两处输入域不同（posix.normalize 的输出、decodeURI 之后的
  // 字符串），且额外拒绝 `'.'` —— 而 `'.'` 在 isInside 这里是合法的「就是 root」。
  // 把它们并进来需要 if/else 分叉出特例，正是本次重构明令禁止的形状。
  //
  // 断言"没有 import"而不是断言源码片段：前者不随行号与措辞漂移，后者会。
  const enforce = fs.readFileSync(path.join(REPO, 'scripts/enforce-effect.mjs'), 'utf8')
  assert.equal(
    /from\s*['"][^'"]*shared\/paths\.mjs['"]/.test(enforce), false,
    'enforce-effect.mjs 的两处检查作用在 posix / URI 域上，语义与 isInside 不同\n'
    + '（尤其：它必须拒绝 `.`，而 isInside 必须接受 `.`）。要合并请先读 paths.mjs\n'
    + '文件头「刻意没有并进来的三处」那一节。',
  )
  // verify-consumer-contracts.mjs 用 isInside 处理 OS 路径，但 :73 那处 posix
  // 相对路径检查（`'../'`，与 path.sep 无关）保持独立。
  const verify = fs.readFileSync(path.join(REPO, 'scripts/verify-consumer-contracts.mjs'), 'utf8')
  assert.ok(verify.includes(`startsWith('../')`), 'verify-consumer-contracts 的 posix 域检查被误删了')
})

test('paths.mjs 只依赖 node:path', () => {
  // 容纳判定是安全边界的一部分：它多一条 import 就多一条能改变判定结果的路径。
  // 只依赖 node:path 让「答案只由两个入参和 OS 分隔符决定」成为可目视确认的事实。
  const src = fs.readFileSync(path.join(REPO, 'src/shared/paths.mjs'), 'utf8')
  const specs = [...src.matchAll(/^\s*import\s.*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(specs, ['node:path'])
})
