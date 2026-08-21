// 分层策略：依赖方向的唯一声明点。
//
// 用户的约束原文是「依赖方向固定为 Control Plane → Truth Integrity」。
// 这个文件把那句话变成机器可判定的形式，因为口头约定挡不住"顺手 import"。
//
// 为什么必须机器强制而不是写进 README：
// V1 Truth Integrity 与 V2 Control Plane 目前**互不 import**，两侧的 gap
// 形状也互不兼容（V1 要 rollbackCost/owner；V2 要 authorityState/
// protectiveDefaultSource，且 blocks[] 是 {constraint, effect} 结构而不是
// 字符串）。也就是说边界现在是**事实上**成立的 —— 而事实上成立的边界最容易
// 退化：某天有人在 truth 里 import 一个 lease 概念，测试全绿，没人发现。
//
// 本模块是叶子：它不 import 任何东西（allow: []），所以它自己不可能参与环。

/**
 * 每层允许**指向**的层。列表里含自身 = 允许同层互相 import。
 *
 * 层序（由弱到强的依赖能力）：
 *   policy ────┐（叶子）
 *   registry ──┤（叶子）
 *   shared ────┼─→ truth ─→ truth-cli ─→ facade ─┐
 *              │      └───→ control ─────────────┼─→ cli
 *   migrations ┘                                 ┘
 *
 * 五条不对称是有意的：
 *
 * 1. `truth` **不能**指向 `control`。这是用户约束的核心：Truth Integrity
 *    不允许依赖 Lease / issuer / effect-policy 这些 V2 概念。反方向
 *    （control → truth）被允许，因为 Control Plane 建立在 Truth 之上。
 *    注意：这条允许边**目前一条都没用到**，见 architecture.test.mjs 的
 *    独立性断言 —— 允许它是为了将来不必改策略，不是因为现在需要它。
 *
 * 2. `cli` 的 allow 里**没有 `cli` 自己**。入口脚本不得互相 import。
 *    这条是"恰好一个 facade"的机器表达：四个 V1 脚本
 *    （generate-contract-bundle / guard-unresolved-fact / migrate-unresolved
 *    / verify-consumer-contracts）确实需要复用库函数，它们统一走
 *    `facade` 这一个点（D1 冻结了它的 30 个导出名），而不是各自去 import
 *    别的入口脚本。少了这条，任何入口都能悄悄变成别人的库。
 *
 * 3. `truth-cli` 与 `cli` 是两层，不是一层。`src/truth/cli/check.mjs` 渲染
 *    输出、解析 argv、**返回** exit code，但它不 process.exit()，也不能被
 *    直接执行 —— 它是库。唯一的 process.exit 在 facade 的 CLI guard 里
 *    （check-spec-suite.mjs:63）。把它归进 `cli` 会让"cli = 入口脚本"这个
 *    定义自我矛盾，边界检查也就失去判据。
 *
 * 4. `cli` **不能**指向 `truth-cli`：只有 facade 能。将来若有新入口需要
 *    `main()`，正确做法是让 facade 显式导出它（D1 的名单从 30 变 31，
 *    是一次可见的决定），而不是绕过门面各自接线。
 *
 * 5. `registry` 是叶子，且 `truth` 可以读它 —— 方向是 truth → registry，
 *    绝不反向。registry 里只有声明数据（invariant 清单、七类检查的名字），
 *    checker 从它派生报告小节；若 registry 反过来 import checker 去"自动
 *    发现"检查，就会成环，而且 registry 也不再是可独立阅读的真相源。
 */
export const LAYERS = {
  policy: { allow: [], role: '分层策略自身。叶子，不 import 任何模块' },
  registry: { allow: [], role: 'invariant/check registry：纯声明数据与纯查询函数。叶子' },
  shared: { allow: ['shared'], role: '与产品层无关的工具：文本、glob、遍历、版本策略' },
  migrations: { allow: ['shared'], role: 'schema 迁移注册表与实现' },
  truth: { allow: ['truth', 'shared', 'registry'], role: 'V1 Truth Integrity：字典、模型、检查规则、投影、两区制' },
  'truth-cli': { allow: ['truth', 'shared'], role: 'V1 的 argv 解析与输出渲染。是库：返回 exit code，不 process.exit' },
  control: { allow: ['control', 'truth', 'shared'], role: 'V2 Control Plane：lease、effect、context projection、IPC、trust' },
  facade: { allow: ['truth-cli', 'truth', 'shared'], role: '唯一的库门面 scripts/check-spec-suite.mjs（D1：30 个导出名已冻结）' },
  cli: { allow: ['facade', 'control', 'truth', 'shared', 'migrations', 'policy', 'registry'], role: '入口脚本：持有 exit code，互相之间不得 import' },
  test: { allow: ['test', 'cli', 'facade', 'control', 'truth-cli', 'truth', 'shared', 'migrations', 'policy', 'registry'], role: '测试。可以看任何层' },
}

/**
 * 文件 → 层。**最长前缀优先**，不是先匹配优先 —— 后者会让条目顺序变成隐藏
 * 语义，改动顺序就改动策略。
 *
 * `scripts/` 下逐文件列出，不用前缀通配：这个目录里同时住着 V2 库
 * （control-plane-*）、V2 入口（*-daemon）、V1 入口、和唯一的 facade，
 * 一条 `scripts/` 规则会把它们混成一层，边界检查也就失效了。
 * 逐文件列出的代价是新增脚本必须先归类 —— 这正是想要的 fail-closed：
 * 未归类的文件是违规，不是"默认放行"。
 */
export const FILE_LAYERS = [
  { match: 'src/layers.mjs', layer: 'policy' },
  { match: 'registry/', layer: 'registry' },
  { match: 'src/shared/', layer: 'shared' },
  // src/truth/cli/ 必须单独归类，且**不是** cli 层：它是库（返回 exit code，
  // 不 process.exit），只被 facade 消费。最长前缀优先保证它不会被
  // src/truth/ 这条更短的规则吃掉。
  { match: 'src/truth/cli/', layer: 'truth-cli' },
  { match: 'src/truth/', layer: 'truth' },
  { match: 'migrations/', layer: 'migrations' },

  { match: 'scripts/check-spec-suite.mjs', layer: 'facade' },

  // V2 库。注意这几个文件同时带 CLI main()：这是重构前既有的混合形态，
  // P2 明确不重构 V2，所以按"被当作库 import"的事实归为 control，
  // 并把这处偏离登记在 trust registry（Phase 5），而不是悄悄改掉它。
  { match: 'scripts/control-plane-common.mjs', layer: 'control' },
  { match: 'scripts/control-plane-ipc.mjs', layer: 'control' },
  { match: 'scripts/control-plane-trust.mjs', layer: 'control' },
  { match: 'scripts/enforce-effect.mjs', layer: 'control' },
  { match: 'scripts/lease-issuer.mjs', layer: 'control' },
  { match: 'scripts/project-context.mjs', layer: 'control' },

  // 入口脚本
  { match: 'scripts/effect-enforcer-daemon.mjs', layer: 'cli' },
  { match: 'scripts/lease-issuer-daemon.mjs', layer: 'cli' },
  { match: 'scripts/generate-contract-bundle.mjs', layer: 'cli' },
  { match: 'scripts/guard-unresolved-fact.mjs', layer: 'cli' },
  { match: 'scripts/migrate-unresolved.mjs', layer: 'cli' },
  { match: 'scripts/verify-consumer-contracts.mjs', layer: 'cli' },
  { match: 'scripts/check-architecture.mjs', layer: 'cli' },
  { match: 'scripts/render-docs.mjs', layer: 'cli' },
]

/** 测试文件按后缀归类，与目录无关。 */
export const TEST_SUFFIX = '.test.mjs'

/**
 * 判定一个仓库相对路径（POSIX 分隔符）属于哪一层。
 *
 * @returns {string|null} 层名；null = 未归类（调用方必须当作违规处理）
 */
export function layerOf(relPath) {
  if (relPath.endsWith(TEST_SUFFIX)) return 'test'
  let best = null
  for (const entry of FILE_LAYERS) {
    if (!relPath.startsWith(entry.match)) continue
    if (best === null || entry.match.length > best.match.length) best = entry
  }
  return best === null ? null : best.layer
}

/**
 * 这条边允许吗？
 *
 * @returns {{allowed: boolean, reason?: string}}
 */
export function edgeAllowed(fromLayer, toLayer) {
  const from = LAYERS[fromLayer]
  if (!from) return { allowed: false, reason: `未声明的层：${fromLayer}` }
  if (!LAYERS[toLayer]) return { allowed: false, reason: `未声明的层：${toLayer}` }
  if (from.allow.includes(toLayer)) return { allowed: true }
  return {
    allowed: false,
    reason: `${fromLayer} 不允许依赖 ${toLayer}（${fromLayer} 只能指向 ${from.allow.join(', ') || '（无）'}）`,
  }
}
