// Invariant registry —— 规则的机器可读单一真相源。
//
// 要解决的问题：同一条 invariant 现在同时写在 SKILL.md、SCHEMA.md、
// DISCIPLINES.md、checker 代码、测试、README 里。六份副本没有主从关系，
// 漂移只是时间问题，而漂移的典型形态最难发现：**README 说 B、checker 强制 A、
// 测试证明 A**。三者各自自洽，谁都不报错，读文档的人得到错误结论。
//
// 本文件的定位：
//   1. `CHECK_NAMES` 由它派生（src/truth/diagnostics/report.mjs），
//      不再各自维护一份。
//   2. 可表格化的文档段由它渲染（scripts/render-docs.mjs 写进
//      BEGIN/END GENERATED 区），文档不再手抄。
//   3. 它对代码的**断言本身被测试校验**（tests/unit/registry.test.mjs）：
//      声称 machine-enforced 的规则必须指向真实存在、且真的发出那个 check id
//      的模块。没有这一条，registry 只会变成第七份副本。
//
// 边界（重要）：registry **不执行**任何检查，也无法让 checker 强制什么。
// 强制发生在 checker 代码里。所以本文件里的 `enforcement` 是**分类**，
// 不是保证 —— 分类的可信度由第 3 条那组测试兜底，而不是由这段注释兜底。
//
// 本模块是叶子：只有数据与纯查询函数，不 import 任何模块，因此不可能参与环。

/**
 * 强制程度的四分法。取值封闭 —— 新增取值必须同时改 trust-report 的分组，
 * 否则新类别会从报告里消失（registry.test.mjs 锁住这个集合）。
 *
 * 为什么必须四分而不是"检查通过/未通过"两分：本仓库最危险的误读是把
 * 「机器检查通过」当成「语义真相已证明」。举例：checker 能证明
 * `source: BR-REFUND-001` 这个 ID 可解析，但**读不懂**那份文档是否真的
 * 规定了该数字。前者是 machine-enforced，后者是 trusted-assertion，
 * 混为一谈就会让人以为绿灯等于事实正确。
 */
export const ENFORCEMENT = {
  /** 有 checker 每次运行都验证；违规必然被拦。 */
  MACHINE: 'machine-enforced',
  /** 由人或文档声明为真，工具接受但不验证内容。绿灯 ≠ 已证明。 */
  TRUSTED: 'trusted-assertion',
  /** 依赖工具之外的东西成立：OS 隔离、部署形态、supervisor 配置。 */
  EXTERNAL: 'external-assumption',
  /** 已知没人验证。登记在案，不假装已覆盖。 */
  NOT_PROVEN: 'not-proven',
}

const ALL_ENFORCEMENT = new Set(Object.values(ENFORCEMENT))

/**
 * checker 的七类检查 —— 实现清册。
 *
 * `id` 就是 `col.add(id, …)` 里的数字，也是报告里的小节号；两者必须一致，
 * 否则报告会把发现归到错误的小节。`modules` 是**真的会发出该 id** 的文件，
 * 由 registry.test.mjs 静态扫描核对（曾经的手写猜测把 check 1 只记成
 * records.mjs，实际有三个模块在发它）。
 *
 * `errorMeaning` 是 SCHEMA.md §7 表格的第三列，由 render-docs 渲染。
 */
export const CHECKS = [
  {
    id: 1,
    name: 'schema 符合性',
    errorMeaning: '记录形状、必填 source、占位符或 Agent Entry Contract 无效',
    modules: ['src/truth/pipeline.mjs', 'src/truth/schema/records.mjs', 'src/truth/schema/idempotency.mjs'],
  },
  {
    id: 2,
    name: '状态机闭合',
    errorMeaning: '出边悬空，或 terminal 与 transitions 矛盾',
    modules: ['src/truth/schema/state-machines.mjs'],
  },
  {
    id: 3,
    name: 'ID 引用完整性',
    errorMeaning: 'source/引用没有定义，或命名空间有歧义',
    modules: ['src/truth/refs/check.mjs'],
  },
  {
    id: 4,
    name: '两区制比对',
    errorMeaning: '声明的 adapter 缺失/无唯一生成区，或 canonical 与 Markdown 投影不一致',
    modules: ['src/truth/adapters/zones.mjs'],
  },
  {
    id: 5,
    name: 'N-xx 禁令覆盖',
    errorMeaning: '禁令没有可信三态断言行',
    modules: ['src/truth/rules/ban-coverage.mjs'],
  },
  {
    id: 6,
    name: '禁止复制中文标签',
    errorMeaning: '结构化字段完整复制 canonical label',
    modules: ['src/truth/rules/label-copy.mjs'],
  },
  {
    id: 7,
    name: '覆盖矩阵完整性',
    errorMeaning: '配置要求的 ID 没出现在指定文件',
    modules: ['src/truth/rules/coverage-matrix.mjs'],
  },
]

/**
 * 规则本体。
 *
 * 与计划里的字段清单（`id / title / statement / severity / schemaVersions[] /
 * enforcement / checker / location / docRefs[]`）有一处**有意的偏离**：
 * `checker` + `location` 合并成 `checks: number[]`，指向 CHECKS 的 id。
 * 原因是规则与检查是**多对多**的：INV-UNKNOWN-STRUCTURAL 由 check 1 和 3
 * 共同强制，而 check 1 同时服务好几条规则。单个 `checker` 字段遇到"多"
 * 就只能写一个、丢掉其余 —— 那是在 registry 里写半真。位置信息不再重复，
 * 统一从 CHECKS[].modules 取，避免同一路径两处维护。
 *
 * 字段语义：
 *   kind          分组，决定渲染到哪个文档区
 *   statement     规范句。**这句话是权威文本**，文档区从它渲染
 *   severity      违规时的最高严重度；无机器强制则为 null（不编造严重度）
 *   schemaVersions 适用的 schema 版本。目前全是 [1]
 *   schemaKind    schemaVersions 针对哪一类 artifact，缺省 'dictionary'；
 *                 V2 记录用 'control-plane-document'。取值是否真的在
 *                 SCHEMA_POLICY 里，由 registry.test.mjs 交叉核对（本模块是
 *                 叶子，不 import schema-version.mjs，换取"不可能参与环"）
 *   enforcement   ENFORCEMENT 之一
 *   checks        强制它的 V1 check id；非 MACHINE 的规则必须为空数组
 *   evidence      不属于 V1 七类检查、但确实有机器强制时，列出强制它的文件。
 *                 machine-enforced 必须至少有 checks 或 evidence 之一非空，
 *                 否则"机器强制"就成了不可证伪的断言 —— 那正是本 registry
 *                 要消灭的东西。路径存在性由 registry.test.mjs 校验
 *   residualRisk  **必填**：这条规则**没有**证明什么。见下
 *   docRefs       描述它的文档位置，供人类回查
 *
 * 关于 `residualRisk` 为什么必填：一份只复述规则的 registry 是第七份副本，
 * 它的存在只会让人更确信"都覆盖了"。真正有价值的信息是每条规则的**边界** ——
 * 强制点在哪、漏掉什么、绿灯不能推出什么。这些信息在别处不存在（代码只说它
 * 做了什么，不说它没做什么），所以由 registry 承载，并且必填：写不出残余风险
 * 的记录，通常意味着还没核对过强制点，而不是意味着风险为零。
 * trust-report 直接输出这一列 —— 那份报告的全部目的就是让"机器检查通过 ≠
 * 语义真相已证明"这句话有具体内容，而不只是一句免责声明。
 *
 * 关于**拆分**：好几条规则同时含"结构可验证"与"语义靠受信"两面。
 * 它们被拆成两条记录（…-STRUCTURAL / …-SEMANTIC），而不是压成一条标
 * machine-enforced —— 后者正是本 registry 要防的那种误读。
 */
export const INVARIANTS = [
  // ---- 三条核心 invariant（SKILL.md §2）--------------------------------
  {
    id: 'INV-UNKNOWN-STRUCTURAL',
    kind: 'invariant',
    title: 'Unknown stays unknown（结构面）',
    statement: '没有非空 source、或 source 解析不到唯一权威 ID 的事实，不得进入 canonical contract；`G-*`、`mayLackDefinition`、`generated/` 都不算权威。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1, 3],
    evidence: ['scripts/generate-contract-bundle.mjs'],
    residualRisk: 'checker 验证的是 source 语法合法、非空、不悬空、命名空间不歧义；'
      + '「恰好一个 authoritative ID」这一条其实在**生成器**里（generate-contract-bundle.mjs:77,88），不在七类检查里。'
      + '所以只跑 check-spec-suite 通过，不等于 source 资格已验证 —— 那一步要跑 generator 才发生。'
      + '而两者都不打开那份文档：ID 有效的假 source 全程绿灯（见 INV-UNKNOWN-SEMANTIC）。',
    docRefs: ['SKILL.md §2', 'SCHEMA.md §1', 'DISCIPLINES.md §3 N-01'],
  },
  {
    id: 'INV-UNKNOWN-SEMANTIC',
    kind: 'invariant',
    title: 'Unknown stays unknown（语义面）',
    statement: 'source 指向的文档内容确实支持该事实 —— checker 只验证 ID 可解析，读不懂文档说了什么。ID 有效不等于事实为真。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.TRUSTED,
    checks: [],
    residualRisk: '这一面没有任何机器检查。source 指向一份真实存在、但根本没规定该事实的文档时，'
      + 'checker、generator、CI 全绿。本仓库最容易被误读的就是这一处：绿灯只说明出处可解析。',
    docRefs: ['SKILL.md §2', 'README.md 设计边界'],
  },
  {
    id: 'INV-CANONICAL',
    kind: 'invariant',
    title: 'Canonical stays canonical',
    statement: '生成区的字节由 canonical source 决定；手改生成区、或让下游副本反向成为真相源，都必须被拦下。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [4, 6],
    residualRisk: '检查 4 比对的是当前树上 canonical 与生成区是否一致，看不出这次一致是**朝哪个方向**改出来的。'
      + '手改生成区、再把 canonical 改成与之匹配，两份重新一致、检查通过 —— 而真相源实际上已经是那份派生副本。'
      + '防这一步靠 review 与 N-02，不靠 checker。',
    docRefs: ['SKILL.md §2', 'SCHEMA.md §4', 'DISCIPLINES.md §3 N-02'],
  },
  {
    id: 'INV-DERIVED',
    kind: 'invariant',
    title: 'Derived stays reproducible',
    statement: '同一份 canonical 重新生成必须得到逐字节相同的派生物；派生物不带时间戳等不可复现字段。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [4],
    residualRisk: '证明的是「同一棵树上重复运行得到相同字节」。CI 矩阵跑 node 22 与 24'
      + '（.github/workflows/test.yml），所以"跨 Node 大版本字节一致"这一条现在确实被验证了。'
      + '仍未验证的是跨 OS、locale 与文件系统大小写敏感性 —— 矩阵只有 ubuntu-latest 一种运行环境，'
      + '而唯一跑过的非 Linux 机器（Windows）上有 3 个 POSIX 隔离测试因缺能力而跳过，'
      + '连"该平台能跑完整测试"都还没成立。',
    docRefs: ['SKILL.md §2', 'SCHEMA.md §5'],
  },

  // ---- 三条禁止的状态转移（SKILL.md §2）--------------------------------
  {
    id: 'TR-INVENT',
    kind: 'transition',
    title: 'unknown → invented canonical fact',
    statement: '不得把未知值补成 canonical 事实。未知的正确形态是 unresolved 记录，不是一个看起来合理的默认值。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1, 3],
    residualRisk: '拦得住"字段缺失"与"引用悬空"两种编造。拦不住**看起来合法的编造**：'
      + '给一个凭空捏的数字配上一个真实存在的 BR-* ID，形状与引用都成立，检查全过。'
      + 'unresolved 路线是否被正确选择，是人的判断，不是机器结论。',
    docRefs: ['SKILL.md §2', 'DISCIPLINES.md §4'],
  },
  {
    id: 'TR-GENERATE-BROKEN',
    kind: 'transition',
    title: 'broken canonical → successful generation',
    statement: 'canonical 有缺陷时生成器必须失败并且不留下半份产物，而不是生成一个"尽力而为"的 bundle。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1],
    evidence: ['scripts/generate-contract-bundle.mjs', 'src/shared/atomic-write.mjs', 'tests/unit/atomic-write.test.mjs'],
    residualRisk: '"不留下半份产物"由 src/shared/atomic-write.mjs 的两阶段写保证（全部 temp 写完才开始 rename，'
      + 'rename 阶段失败按阶段零的快照回滚），且**回滚路径本身有测试** —— 合并前四处写策略的回滚分支一条都没被测过，'
      + 'v1-vertical-slice 那几条"失败时不覆盖旧 bundle"验的是校验阶段就 throw，写函数根本没被调用。'
      + '仍未覆盖四件事：① 不做 fsync，"rename 成功后立刻掉电"仍可能丢字节（有意选择，四处原实现同样如此）；'
      + '② 进程在两次 rename 之间被 SIGKILL 的行为没有测试；③ temp 的 0o600 权限位没有任何断言；'
      + '④ 非 POSIX 文件系统上 rename 的原子性属于外部假设。',
    docRefs: ['SKILL.md §2', 'SCHEMA.md §5'],
  },
  {
    id: 'TR-DERIVED-AUTHORITY',
    kind: 'transition',
    title: 'derived artifact → authoritative source',
    statement: '派生物永远不能成为权威来源；`generated/` 下的 ID 不得被当作 source 引用。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [3],
    evidence: ['scripts/generate-contract-bundle.mjs'],
    residualRisk: '拦的是 source 字符串**落在 generatedDir 里**这一形态。'
      + '把派生内容复制进一份手写文档、再引用那份文档，机器看不出这是派生物的转世 —— '
      + '那正是 INV-CANONICAL 里描述的反向漂移。',
    docRefs: ['SKILL.md §2', 'DISCIPLINES.md §3 N-02'],
  },

  // ---- 未来未知 schema（Phase 2 落地）----------------------------------
  {
    id: 'INV-FUTURE-SCHEMA',
    kind: 'invariant',
    title: '未来未知 schema 版本必须被拒绝，不得猜测',
    statement: 'artifact 的 schemaVersion 高于本工具支持的版本时，工具拒绝执行并说明需要升级工具；不猜测其含义，也不写出任何产物。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1],
    evidence: ['src/shared/schema-version.mjs', 'tests/compatibility/compatibility.test.mjs'],
    residualRisk: '只对**带 schemaVersion 字段**的 artifact 成立。dictionary 与 spec-suite.config.json '
      + '目前 requiredNow: false —— 字段缺失只 warn，见 GAP-SCHEMA-OPTIONAL。'
      + '未来 schema 的"拒绝"也只覆盖已登记的 7 个 kind；新增一类 artifact 而忘了登记，就没有版本闸门。',
    docRefs: ['SCHEMA.md §6', 'migrations/README.md', 'fixtures/README.md'],
  },

  // ---- 通用禁令 N-01～N-04（DISCIPLINES.md §3）-------------------------
  {
    id: 'N-01',
    kind: 'ban',
    title: '无权威 source 的事实不得进入 canonical contract',
    statement: '无权威 source 的事实不得进入 canonical contract。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1, 3],
    residualRisk: '与 INV-UNKNOWN-STRUCTURAL 同源，残余风险相同：source **存在且可解析**被验证，'
      + 'source **确实规定了该事实**没有被验证。',
    docRefs: ['DISCIPLINES.md §3'],
  },
  {
    id: 'N-02',
    kind: 'ban',
    title: '派生物不得手改或反向成为 source',
    statement: 'generated region、bundle、manifest 与 consumer copy 不得手改或反向成为 source。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [4],
    evidence: ['scripts/verify-consumer-contracts.mjs'],
    residualRisk: '检查 4 与 consumer verifier 都只能发现"派生物与 canonical 不一致"。'
      + '两边被同步改成一致时，机器无法判断哪边是源 —— 见 INV-CANONICAL。',
    docRefs: ['DISCIPLINES.md §3'],
  },
  {
    id: 'N-03',
    kind: 'ban',
    title: '下游引用稳定 ID，不复制 canonical 描述',
    statement: '下游引用稳定 ID，不复制 canonical 描述。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [6],
    residualRisk: '只在**结构化字段的值与 label 完整相等**时报错。改写、截断、翻译过的复制检测不到。'
      + '这是有意的取舍：子串匹配在真实语料上产生 224 条误报（src/truth/rules/label-copy.mjs:88-98），'
      + '几乎全是恰好含两字 label 的普通中文。',
    docRefs: ['DISCIPLINES.md §3'],
  },
  {
    id: 'N-04',
    kind: 'ban',
    title: '实现选择不得隐式改变业务口径',
    statement: '实现选择不得隐式改变业务口径。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.TRUSTED,
    checks: [],
    residualRisk: '检查 5 只验证这条禁令在 CLAUDE.md 里有一行可信三态断言，**不验证断言为真**。'
      + '禁令本身是语义判断，机器无从核对 —— 它靠 review。',
    docRefs: ['DISCIPLINES.md §3'],
  },

  // ---- canonical 记录规则（SCHEMA.md §1）------------------------------
  {
    id: 'REC-OBJECT-ARRAY',
    kind: 'record-rule',
    title: '记录集合是对象数组，每条带 code',
    statement: '每个记录集合是对象数组，每条记录带稳定的 `code`。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1],
    residualRisk: '验证的是形状与必填键存在，不验证值的类型或语义。'
      + '`code` 只要求存在且非空，不校验命名风格与全局唯一性。',
    docRefs: ['SCHEMA.md §1'],
  },
  {
    id: 'REC-SOURCE-REQUIRED',
    kind: 'record-rule',
    title: 'source 非空',
    statement: '`source` 必填且非空 —— 空 source 等于没有出处。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1],
    residualRisk: '"非空"就是字面意思：`null` 与 `\'\'` 被拒。一个空格、一句"待补"、'
      + '一个不含任何 ID 的自然语言句子都能过这一关（后续由 check 3 与 generator 接手）。',
    docRefs: ['SCHEMA.md §1'],
  },
  {
    id: 'REC-SOURCE-RESOLVABLE',
    kind: 'record-rule',
    title: 'source 恰好指向一个可解析的权威 ID',
    statement: '`source` 恰好解析出一个权威 ID；`G-*`、`mayLackDefinition`、`generated/` 下的 ID 不具备权威性。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [3],
    evidence: ['scripts/generate-contract-bundle.mjs'],
    residualRisk: '**强制点分裂在两处，只跑 checker 不够**：check 3 管"引用不悬空、命名空间不歧义"；'
      + '"恰好一个"与"不是 gap / 未决 / 派生命名空间"由 generator 校验'
      + '（generate-contract-bundle.mjs:77 与 :88），只在生成 bundle 时运行。'
      + '所以 check-spec-suite 全绿的仓库仍可能有不合格 source —— 要跑 generator 才知道。',
    docRefs: ['SCHEMA.md §1'],
  },
  {
    id: 'REC-NO-LABEL-COPY',
    kind: 'record-rule',
    title: '下游不复制 canonical label',
    statement: '结构化字段不得完整复制 canonical 的中文 label；引用 ID 即可。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [6],
    residualRisk: '同 N-03：完整相等才报错，改写过的复制逃得掉；'
      + '注释里的复制降级为 warn；allowlist 一旦放宽就完全不查那个键。',
    docRefs: ['SCHEMA.md §1', 'DISCIPLINES.md §3 N-03'],
  },
  {
    id: 'REC-ONE-SHAPE',
    kind: 'record-rule',
    title: '每种记录类型只有一个形状',
    statement: '同一记录类型的必填键集合唯一；不允许同类型出现两种形状。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1],
    residualRisk: '实际强制的只有"必填键都在"这一半。`RECORD_RULES` 只声明 `required` 列表，'
      + '循环是 `for (const k of rule.required) if (!(k in item))` —— **额外键不被拒绝**，'
      + '所以同类型两条记录一条带额外字段、一条不带，仍然都过。见 GAP-RECORD-EXTRA-KEYS。',
    docRefs: ['SCHEMA.md §1'],
  },
  {
    id: 'REC-COUNTS-DERIVED',
    kind: 'record-rule',
    title: '计数是派生值，不作为断言',
    statement: '记录条数等计数由工具派生并只用于报告，不写进 canonical 当断言。',
    severity: null,
    schemaVersions: [1],
    // 曾经标 machine-enforced / checks: [1]。核对后发现那是**假声明**：
    // checker 唯一相关的机器行为是把自己报告里的计数标注成"派生计数（只报告，
    // 不作为断言）"；canonical 里写一个 `totalCount: 7` 不会被任何检查拒绝，
    // 因为 RECORD_RULES 不拒绝额外键。写成 machine-enforced 会让人以为这条
    // 已被守住 —— 那正是本 registry 要消灭的误读，所以降级为 trusted。
    enforcement: ENFORCEMENT.TRUSTED,
    checks: [],
    residualRisk: '没有检查会拒绝 canonical 里的手写计数。工具只保证**自己**输出的计数是派生的、'
      + '并在报告里如此标注。写进 canonical 的"共 N 项"只能靠 review 拦下。',
    docRefs: ['SCHEMA.md §1'],
  },

  // ---- 设计边界（README.md 设计边界 / control-plane/README.md）--------
  //
  // 这一组的 `statement` **逐字**取自 README.md「设计边界」的对应条目，
  // 不是转述。理由：这些句子的 canonical 文本在 README 里（它是人读的入口），
  // registry 只负责给它们上 id 与四分法分类。逐字保存让 registry.test.mjs
  // 能做一条真的锁 —— 断言 statement 的首段确实出现在 docRefs 指的文件里。
  // 一旦有人只改 README 或只改 registry，那条锁就变红。若换成转述，就只能
  // 靠人肉比对两份措辞，也就回到了本 registry 要消灭的状态。
  {
    id: 'BND-SOURCE-SEARCH',
    kind: 'boundary',
    title: 'sourceSearch 是 provenance，不是不存在的证据',
    statement: '`sourceSearch` 是 provenance，不是“事实不存在”的证据。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.TRUSTED,
    checks: [],
    residualRisk: '`sourceSearch` 是自报的动作清单。没有任何机器检查它真的执行过、覆盖了正确的位置、'
      + '或者搜得够彻底。它的价值是让"我找过哪里"可审计，不是让"找不到"变成结论。',
    docRefs: ['README.md 设计边界'],
  },
  {
    id: 'BND-REGEX-CHECKER',
    kind: 'boundary',
    title: 'regex/heuristic checker 保持便宜和透明',
    statement: 'regex/heuristic checker 保持便宜和透明；只有真实误报/漏报案例足够多时才升级 parser。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '没有误报率/漏报率的度量，所以"够便宜、够透明"是判断，不是测量结果。'
      + '已知的具体后果：Markdown 与 YAML 都按行用正则读，注释、字符串字面量与围栏内的内容'
      + '在不同检查里被区别对待的程度并不一致。',
    docRefs: ['README.md 设计边界'],
  },
  {
    id: 'BND-ACTION-SHA',
    kind: 'boundary',
    title: 'Action SHA pinning 属于 hardening',
    statement: 'Action SHA pinning 属于 hardening，不冒充 V1 correctness。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.EXTERNAL,
    checks: [],
    residualRisk: '.github/workflows/test.yml 目前按 tag 引用（`actions/checkout@v4`、`actions/setup-node@v4`）。'
      + 'tag 可以被移动，所以 CI 里跑的第三方代码由 GitHub 与 action 作者决定，不由本仓库决定。'
      + '这不影响 V1 的判定正确性，但影响"CI 绿"这件事本身的可信度。',
    docRefs: ['README.md 设计边界'],
  },
  {
    id: 'BND-PROJECTION-KNOWLEDGE',
    kind: 'boundary',
    title: 'Context projection 只增加知识，不授予权限',
    statement: 'Context projection 只增加知识，不授予权限；dependency uncertainty 增加时 privilege 只能保持或下降。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    // 由 V2 projector 强制，不属于 V1 checker 的七类 —— 所以证据走 evidence。
    evidence: ['scripts/project-context.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '强制的是单调性：uncertainty 增加时 `leaseEligible` 变 false、`privilegeCeiling` 变 none，'
      + 'issuer 随之拒签。证明不了"多给知识本身无害" —— 投影范围扩大时输出的文档摘要更多，'
      + '这部分内容进入 Agent 上下文的后果不在本纵切的验证范围内。',
    docRefs: ['README.md 设计边界', 'control-plane/README.md Projection 的准确边界'],
  },
  {
    id: 'BND-GRAPH-COMPLETE',
    kind: 'boundary',
    title: '`complete: true` 是受信声明',
    statement: '`complete: true` 是受信声明；同步修改 graph 与 digest 不等于证明依赖图语义完备。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.TRUSTED,
    checks: [],
    residualRisk: '`complete` 是图文件里的自报布尔值，没有任何代码计算它。digest 绑定只证明图没漂移，'
      + '不证明图列全了依赖。仓库里有一条测试**明确证明这个盲点存在**'
      + '（v2-control-plane.test.mjs:541-558：删掉一条真实 edge、同步更新 digest 后，'
      + '`uncertainty.increased` 仍是 false、`leaseEligible` 仍是 true，一个 permission 静默消失）。',
    docRefs: ['README.md 设计边界', 'control-plane/README.md Projection 的准确边界'],
  },
  {
    id: 'BND-EFFECT-MORATORIUM',
    kind: 'boundary',
    title: 'Control Plane effect 类型暂停扩大',
    statement: 'Control Plane effect 类型暂停扩大；现有 3 类之外不加新类，直到授权判定从三处手写的 per-kind if 链变成数据驱动。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    // 由 v2-control-plane.test.mjs 的源码普查强制（三重锁：kind 集合恰好 3 个、
    // 分类链与执行链集合相等、只有 file.write 能免 lease）。不属于 V1 七类检查。
    evidence: ['scripts/enforce-effect.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '两处限制。其一，普查只认三个具名函数里的 `kind === \'…\'` 字面量：'
      + '若有人按 kind 之外的字段（例如 resource 前缀）另开一条授权分支，kind 集合看起来没变，'
      + '普查不会发现。其二，解除条件（授权判定数据驱动、新 kind 默认落在"必须持 lease"一侧、'
      + '三种对抗形状下均被拒、真实副作用可隔离）**没有任何机器强制** —— 改断言与改 if 链'
      + '可以在同一个 commit 里完成。这些锁买到的是"不可能悄悄发生"，不是"不可能发生"。',
    docRefs: ['README.md 设计边界', 'control-plane/README.md effect 类型暂停扩大'],
  },

  // ---- V2 控制面的机器强制点（control-plane/README.md）-----------------
  //
  // 这一组不属于 V1 的七类检查，所以全部走 evidence。它们与 V1 记录并存于
  // 同一份 registry，但**方向仍然是 Control Plane → Truth Integrity**：
  // 这些记录引用 V2 文件，V1 的记录不引用它们（Phase 3 的边界约束）。
  {
    id: 'CP-LEASE-SIGNATURE',
    kind: 'control-plane',
    title: 'Lease 必须通过 Ed25519 签名校验',
    statement: 'enforcer 对每个 Lease 无条件重验 Ed25519 签名；签名不符即拒绝执行，没有开关可以跳过。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/enforce-effect.mjs', 'scripts/lease-issuer.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '`keyId` 只与 `policy.keyId` 做字符串比较，**没有 keyId → 公钥的绑定**：'
      + '同时替换公钥文件与 policy.keyId 的攻击者可以让自造 Lease 通过校验。'
      + '公钥的可信度完全落在"trust root 不可被 Agent 写"这条外部假设上（见 CP-POSIX-IDENTITY）。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'CP-LEASE-FRESHNESS',
    kind: 'control-plane',
    title: 'Lease 的过期、policy epoch 与吊销都在执行前重验',
    statement: '过期、未生效、TTL 超过 policy 上限、policy epoch 过期、被吊销的 Lease 一律拒绝；吊销库读不到时 fail closed。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/enforce-effect.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '时间来自 `Date.now()`。**没有可信或单调时钟**（control-plane/README.md:86 已声明）：'
      + '能改系统时间的人可以让过期 Lease 复活，也可以让未生效 Lease 提前可用。'
      + '吊销是"读一次快照"，不是实时撤销 —— 吊销写入与下一次 enforcer 读取之间存在窗口。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'CP-BASELINE-DISJOINT',
    kind: 'control-plane',
    title: 'baseline ∩ protected = ∅ 在加载时强制',
    statement: 'policy 加载时验证 baseline 与 protected 前缀不重叠、protected 之间两两不重叠；任何重叠让 issuer 与 enforcer 同时 fail closed。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/control-plane-common.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '重叠判定是路径前缀的双向 `startsWith`，在 `path.posix.normalize` 之后进行 —— '
      + '不做 realpath。两个经由不同符号链接指向同一目录的前缀不会被判为重叠。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'CP-AUDIT-BEFORE-EFFECT',
    kind: 'control-plane',
    title: 'audit 写入成功是执行 effect 的前置条件',
    statement: 'audit 记录在执行 effect 之前写入；写入失败会把已经授权的决定降级为拒绝，且不执行任何 effect。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/enforce-effect.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '证明的是"没写下 audit 就不执行"。**没有证明 audit 不可篡改**：'
      + '见 GAP-AUDIT-APPEND-ONLY。也没有覆盖"audit 写成功但进程随即被杀"这一窗口 —— '
      + '那种情况下 audit 里会留下一条实际未发生的 effect。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'CP-DENIAL-PROVENANCE',
    kind: 'control-plane',
    title: '每个 denial 都带结构化 provenance',
    statement: '每个拒绝都带 `type / constraint / blockingRecord / authorityState` 四个必填机器字段，audit 与 IPC 都能不解析 reason 字符串就还原原因。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/control-plane-common.mjs', 'scripts/control-plane-ipc.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '形状与四种 type（unresolved / authorization / classification / infrastructure）被测，'
      + 'G-17 那条的字段值被逐字钉住。但**整条 denial record 的字节稳定性没有测试** —— '
      + '新增一个可选字段不会让任何测试变红，下游若按整条记录做比对会静默受影响。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'CP-EFFECT-CLASSIFIED',
    kind: 'control-plane',
    title: '未分类的 effect 一律拒绝',
    statement: 'effect kind 落不进已知分类时抛错拒绝；file protection 前缀命中多于一条时按"歧义"拒绝，不挑一条继续。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/enforce-effect.mjs', 'tests/adversarial/v2-control-plane.test.mjs'],
    residualRisk: '兜底靠两处 `throw`（分类器的 fall-through 与执行器的 `authorized effect lost its classifier`），'
      + '**不是构造上穷尽**：没有枚举或查表，分类链与执行链是两条独立的 if-chain。'
      + 'Phase 6 用源码普查锁住了两条链的 kind 集合（各 3 个、且必须相等），所以"只改一边"现在会变红；'
      + '但普查只认 `kind === \'…\'` 字面量 —— 若有人按 kind 之外的字段（如 resource 前缀）另开一条分支，'
      + '集合看起来没变，普查不会发现。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'CP-PATH-CONTAINMENT',
    kind: 'control-plane',
    title: '路径必须落在声明的根内',
    statement: 'trust root、workspace 与 file effect 的路径都必须落在声明的根内；file effect 的路径逐段拒绝符号链接。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: [
      'src/shared/paths.mjs',
      'tests/unit/paths.test.mjs',
      'scripts/enforce-effect.mjs',
      'scripts/control-plane-trust.mjs',
      'tests/adversarial/v2-control-plane.test.mjs',
    ],
    residualRisk: '全仓库**没有一处用 realpath**：包含性判定一律是 `path.resolve` + `path.relative` + 字符串比较。'
      + '其中作用在 OS 路径上的 8 份逐字重复实现已合并为 `src/shared/paths.mjs` 的 `isInside` 一份'
      + '（其行为由 tests/unit/paths.test.mjs 用变异测试逐项量过：`root/../x` 逃逸、`root/..` 父目录本身、'
      + '跨盘符、共享前缀的兄弟目录，以及"root 自身算在内"这一点被两个相反方向同时依赖的事实。'
      + '其中"父目录本身"与"兄弟目录"两项在合并前的整套测试里都是全绿的盲区）；'
      + '另有 3 处作用在 posix / URI 域上的检查刻意保持独立，因为它们的输入域与接受集不同。'
      + '合并消除的是"抄歪一份、两个方向不对称失效"的风险，**没有**消除 symlink 缺口：'
      + '`isInside` 是纯词法判定。只有 file effect 的 `normalizeFileResource` 逐段 lstat 拒绝符号链接，'
      + '而它是"拒绝"而非"解析"，且 lstat 与 write 之间存在 TOCTOU 窗口，代码没有关掉这个窗口。',
    docRefs: ['control-plane/README.md Isolated daemon boundary'],
  },
  {
    id: 'CP-CONSUMER-BYTES',
    kind: 'control-plane',
    title: 'consumer 副本按字节校验，不解释版本',
    statement: 'consumer verifier 只比对 manifest、文件集合与字节，不解释版本语义。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: ['scripts/verify-consumer-contracts.mjs'],
    residualRisk: '证明的是"副本与期望字节一致"。它无法判断期望本身是否正确 —— '
      + '若 expected 与 consumer 被同时替换，校验依旧通过（与 INV-CANONICAL 的反向漂移同形）。',
    docRefs: ['SCHEMA.md §5'],
  },
  {
    id: 'CP-CONCURRENCY-GATE',
    kind: 'control-plane',
    title: 'merge gate 绑定基线与写集',
    statement: 'merge gate 只在 baseRevision 同时是 target/head 的祖先、target revision 等于 baseRevision、实际改动全在 writeSet 且没有同文件碰撞时放行 fast path；声明式 disjoint 只能触发 revalidation-required，不能直接合并。',
    severity: 'error',
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    evidence: [
      'scripts/control-plane-concurrency.mjs',
      'scripts/merge-gate.mjs',
      'tests/adversarial/multi-agent-concurrency.test.mjs',
    ],
    residualRisk: 'gate 只读取 Git commit 之间的文件集合，不能观测 Agent 尚未提交的工作树、'
      + '实际读取过哪些文件，或 rebase 之后业务语义是否仍然正确。'
      + '它也不执行 merge/rebase；目标分支推进后必须由外部 integrator 重新生成结果并再次运行 gate。',
    docRefs: ['README.md Multi-Agent 并发纵切', 'control-plane/README.md Multi-Agent task contract'],
  },

  // ---- 外部假设：工具之外必须成立的事（control-plane/README.md）--------
  {
    id: 'CP-POSIX-IDENTITY',
    kind: 'control-plane',
    title: 'POSIX identity 与 mode bit 隔离由 OS 保证',
    statement: 'daemon 与 Agent 运行在不同的非 root POSIX identity 下，且 OS 真的按 mode bit 执行访问控制。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.EXTERNAL,
    checks: [],
    residualRisk: '`requirePosixIdentity` 只确认 `process.getuid/getgid` 可调用，随后全部判断都基于 '
      + '`lstatSync` 的 mode/uid/gid 位，由一份手写的 POSIX 权限解析复现。工具无法验证：'
      + 'OS 真的执行这些位、daemon 真的跑在另一个 uid 下、config 里自报的 `agentIdentity.groups` '
      + '完整准确（全仓库没有 `process.getgroups()` 调用）、没有 ACL/capability/容器映射绕过。'
      + '真正的跨身份测试以 `getuid() === 0` 为前提，普通用户与 Windows 上不会运行。',
    docRefs: ['control-plane/README.md Isolated daemon boundary'],
  },
  {
    id: 'CP-ENFORCER-SOLE-EXIT',
    kind: 'control-plane',
    title: 'enforcer 是受保护 effect 的唯一出口',
    statement: '部署必须让 enforcer adapter 成为受保护写入/网络 effect 的唯一出口。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.EXTERNAL,
    checks: [],
    residualRisk: '这条完全在工具之外。Agent 只要能直接发起网络请求或写文件，就绕过了整条授权链，'
      + '而 enforcer 对此不可见、audit 里也不会留下痕迹。纵切验证的是"经过 enforcer 时会被正确裁决"，'
      + '不是"只能经过 enforcer"。',
    docRefs: ['control-plane/README.md Isolated daemon boundary'],
  },
  {
    id: 'CP-SUPERVISOR-CONFIG',
    kind: 'control-plane',
    title: 'supervisor 提供的 config 与 snapshot 正确',
    statement: 'supervisor 在 Agent 不可写的位置准备 snapshot、key、policy、revocation 与 audit sink，并以绝对路径传给 daemon。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.EXTERNAL,
    checks: [],
    residualRisk: 'daemon 会校验这些路径的位置与权限位，但**内容的正确性**是外部责任：'
      + 'policy 写错（比如漏标一个 protected 前缀）不会被任何检查发现，因为 policy 本身就是权威。'
      + 'snapshot 与真实 canonical 是否一致也由 supervisor 保证。',
    docRefs: ['control-plane/README.md Eval'],
  },

  // ---- 已知未覆盖：登记在案，不假装已证明 ------------------------------
  //
  // 这一组的全部意义是**让空白可见**。四分法里最容易被省略的就是这一类：
  // 不写，报告看起来更干净，覆盖率看起来更高 —— 而这恰好是本 registry
  // 要防的那种误导。凡是核对过程中发现"没人验证"的，都写进来。
  {
    id: 'GAP-SCHEMA-OPTIONAL',
    kind: 'coverage-gap',
    title: 'dictionary 与 config 的 schemaVersion 目前只是 warn',
    statement: '`contracts/dictionary.yaml` 与 `spec-suite.config.json` 的 schemaVersion 缺失时只 warn，不 error。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '这两类 artifact 的 `requiredNow: false`（src/shared/schema-version.mjs 的 SCHEMA_POLICY）。'
      + '后果：**没有版本字段的旧文件不会撞上 INV-FUTURE-SCHEMA 的闸门** —— 未来 schema 的拒绝机制'
      + '对它们无效，因为它们根本没有声明版本。这是刻意的过渡期设定（先 warn，下个大版本改 error），'
      + '但在此期间这两类文件的版本安全属于未证明。',
    docRefs: ['SCHEMA.md §6', 'migrations/README.md'],
  },
  {
    id: 'GAP-RECORD-EXTRA-KEYS',
    kind: 'coverage-gap',
    title: 'canonical 记录的额外键不被拒绝',
    statement: 'checker 只验证必填键存在，不拒绝记录上多出来的键。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '`RECORD_RULES` 只声明 `required` 列表，校验循环是"必填键是否都在"。'
      + '所以拼错的键名（`sourc:` 而不是 `source:`）会同时触发"缺 source"的 error —— 这一半是安全的；'
      + '但**额外的、看起来合理的键**（手写 `totalCount`、失效的 `deprecated` 标记）会被静默接受，'
      + '并按其所在集合原样进入 bundle。与 REC-ONE-SHAPE、REC-COUNTS-DERIVED 同源。',
    docRefs: ['SCHEMA.md §1'],
  },
  {
    id: 'GAP-CONFIG-UNKNOWN-KEYS',
    kind: 'coverage-gap',
    title: 'config 的未知键被静默忽略',
    statement: '`loadConfig` 只读已知键，写错键名的配置项被静默忽略，不报错。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '`markdownGlob`（漏了 s）这样的拼写错误不会有任何提示，该项默认值继续生效 —— '
      + '看起来配置了，其实没有。这与"unknown 版本变 default"不是一类问题：'
      + '每个默认值都是 SCHEMA.md §6 记录过的、有意的选择。但拼错键名不被发现是真实风险，'
      + '登记为未证明而不是立即改 strict（L0 模板本身就带 `_comment` 键，改 strict 会破坏现有 config）。',
    docRefs: ['SCHEMA.md §6'],
  },
  {
    id: 'GAP-BOM-DIVERGENCE',
    kind: 'coverage-gap',
    title: 'V1 剥 BOM、V2 不剥，两者对同一文件的判断不同',
    statement: 'V1 的 `readText` 会剥掉 BOM，V2 的 digest 路径按字节读；同一个带 BOM 的文件在两侧得到不同结论。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '这是**有意的不统一**：V1 要容忍编辑器加的 BOM，V2 的 digest 必须覆盖真实字节，'
      + '所以 BOM 理应改变 digest（compatibility.test.mjs 把这条钉成了 V2 的预期语义）。'
      + '未证明的部分是两种语义并存的后果 —— 没有测试覆盖"同一文件同时被 V1 检查与 V2 摘要"的场景。',
    docRefs: ['README.md 设计边界'],
  },
  {
    id: 'GAP-CANONICAL-FACTS-TRIPLE',
    kind: 'coverage-gap',
    title: '`canonical-facts.json` 一文三用',
    statement: '同一个 `canonical-facts.json` 同时是 canonical revision 的哈希输入、authority record 存储与 context graph 的节点文档。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '已核实三条读取路径彼此独立。后果：改动一个字节会同时作废所有在途 Lease、'
      + '改变 denial provenance、并改变 projection digest。这在示例纵切里是特性（三者本该联动），'
      + '但**没有任何测试或文档说明这三种角色必须由同一个文件承担** —— '
      + '后来的人拆开它时不会收到任何警告，而拆开会让三条链的失效时机分离。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'GAP-AUDIT-APPEND-ONLY',
    kind: 'coverage-gap',
    title: 'audit 只是普通文件，没有 append-only 保证',
    statement: 'audit sink 的不可篡改性没有任何机器保证：没有 append-only fd、没有文件属性、没有记录间哈希链。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '保护只有两层：`appendFileSync` 的 `mode: 0o600`，以及 sink 目录对 Agent 不可写。'
      + '能写这个文件的身份可以改写或删除历史记录，且不留痕迹 —— '
      + 'CP-AUDIT-BEFORE-EFFECT 证明的是"没写就不执行"，不是"写下的不会被改"。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'GAP-KEY-BINDING',
    kind: 'coverage-gap',
    title: 'keyId 与公钥之间没有绑定',
    statement: '`keyId` 只与 policy 里的 `keyId` 做字符串比较，没有从 keyId 到公钥的映射校验。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '同时替换公钥文件与 `policy.keyId` 的人可以让自造 Lease 通过全部校验。'
      + '密钥轮换与 keyId ↔ 公钥绑定在测试夹具之外没有被验证。'
      + '整条签名链的可信度因此实际落在 CP-POSIX-IDENTITY 那条外部假设上。',
    docRefs: ['control-plane/README.md 已闭合的机器链'],
  },
  {
    id: 'GAP-V2-CLI-EXIT',
    kind: 'coverage-gap',
    title: 'V2 的 CLI 与 domain 分层不如 V1 彻底',
    statement: 'V1 已把 exit code 收进 CLI 层；V2 的几个脚本仍在 domain 路径附近直接决定退出码。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: 'V2 的判定逻辑本身是纯的（`evaluateEffect` 返回决定对象，不退出），'
      + '但脚本入口把"决定 → 退出码"的映射与 IO 混在一处。这不影响正确性，'
      + '影响的是可测试性：想单测某个退出码映射就得走进程边界。'
      + '本次重构没有动 V2 的这一层（P2 要求先稳定边界、不重写）。',
    docRefs: ['control-plane/README.md Isolated daemon boundary'],
  },
  {
    id: 'GAP-CONCURRENCY-READSET',
    kind: 'coverage-gap',
    title: 'readSet 不是实际读取轨迹',
    statement: 'readSet 是 Agent 声明的读取意图，不是工具观测到的实际读操作轨迹。',
    severity: null,
    schemaVersions: [1],
    schemaKind: 'control-plane-document',
    enforcement: ENFORCEMENT.NOT_PROVEN,
    checks: [],
    residualRisk: '当前合同没有 syscall、文件系统审计或 Agent runtime instrumentation。'
      + 'Agent 漏报 readSet 时，write-read 依赖可能被低估；因此 writeSet collision 能被机器拦下，'
      + '但读依赖完整性仍是声明与 review 的责任。',
    docRefs: ['control-plane/README.md Multi-Agent task contract'],
  },
]

/** check id → 记录。 */
export function checkById(id) {
  return CHECKS.find((c) => c.id === id) ?? null
}

/** 报告与文档共用的 check 名字表：`{1: 'schema 符合性', …}`。 */
export function checkNames() {
  return Object.fromEntries(CHECKS.map((c) => [c.id, c.name]))
}

/** 报告小节的顺序 —— 升序的 check id。 */
export function checkIds() {
  return CHECKS.map((c) => c.id).sort((a, b) => a - b)
}

/** 按 kind 取规则，顺序即声明顺序（文档区的行序由它决定，必须稳定）。 */
export function invariantsOfKind(kind) {
  return INVARIANTS.filter((r) => r.kind === kind)
}

/** `schemaKind` 的缺省值：没写就是针对 dictionary schema。 */
export const DEFAULT_SCHEMA_KIND = 'dictionary'

/**
 * 按四分法分组，供 trust-report 使用。
 *
 * 返回 `{ groups, unclassified }`：`groups` 的键**恒定**是四分法的四个取值
 * （即使某类为空也在，空类别本身就是信息 —— "这一类没有任何记录"与"这一类
 * 被省略了"必须能区分）；落在四分法之外的记录进 `unclassified`。
 *
 * 为什么不直接丢掉未知取值：那会让新增第五类 enforcement 的记录从报告里静默
 * 消失，而报告读者无从察觉。调用方拿到非空 `unclassified` 应当 fail closed，
 * 而不是渲染一份缺了几行的报告。
 */
export function groupByEnforcement(records = INVARIANTS) {
  const groups = Object.fromEntries(Object.values(ENFORCEMENT).map((v) => [v, []]))
  const unclassified = []
  for (const r of records) {
    if (Object.hasOwn(groups, r.enforcement)) groups[r.enforcement].push(r)
    else unclassified.push(r)
  }
  return { groups, unclassified }
}

/**
 * registry 自身的结构校验。返回问题清单（空 = 通过）。
 *
 * 放在这里而不是只放在测试里，是为了让 render-docs 在**写文档之前**先自检 ——
 * 用坏掉的 registry 渲染文档，等于把错误固化进 canonical 文本。
 *
 * 参数可注入是为了让校验器本身**可被反证**：只能校验真 registry 的校验器，
 * 无法证明它真的会拦下坏数据（真 registry 是干净的，永远返回空清单，看起来
 * 与一个 `return []` 的空实现毫无区别）。测试用合成的坏记录喂它，确认每条
 * 规则都会响 —— 否则这个函数就是仪式，不是检查。
 */
export function validateRegistry(records = INVARIANTS, checks = CHECKS) {
  const problems = []
  const ids = new Set()

  for (const c of checks) {
    if (!Number.isInteger(c.id) || c.id < 1) problems.push(`CHECKS 里有非法 id：${c.id}`)
    if (!c.name || !c.errorMeaning) problems.push(`check ${c.id} 缺 name 或 errorMeaning`)
    if (!Array.isArray(c.modules) || c.modules.length === 0) problems.push(`check ${c.id} 没有列出实现模块`)
  }
  const checkIdSet = new Set(checks.map((c) => c.id))
  if (checkIdSet.size !== checks.length) problems.push('CHECKS 里 id 重复')

  for (const r of records) {
    if (!r.id) { problems.push('有记录缺 id'); continue }
    if (ids.has(r.id)) problems.push(`记录 id 重复：${r.id}`)
    ids.add(r.id)

    for (const field of ['kind', 'title', 'statement']) {
      if (typeof r[field] !== 'string' || r[field].trim() === '') problems.push(`${r.id} 的 ${field} 为空`)
    }
    // residualRisk 是必填的，理由见文件头：一份只复述规则的 registry 迟早变成
    // 第七份副本。逼每条记录写出"这条**没有**证明什么"，报告才携带 registry
    // 之外的信息 —— 也才可能纠正读者的过度信任。
    if (typeof r.residualRisk !== 'string' || r.residualRisk.trim() === '') {
      problems.push(
        `${r.id} 缺 residualRisk —— 每条记录都必须写明它没有证明什么。`
        + `写不出残余风险的记录通常意味着还没核对过强制点，而不是意味着风险为零`,
      )
    }
    // schemaKind 的取值是否在 SCHEMA_POLICY 里，由 registry.test.mjs 交叉核对：
    // 本模块是叶子（不 import 任何东西），换取"不可能参与环"这个性质。
    if ('schemaKind' in r && (typeof r.schemaKind !== 'string' || r.schemaKind.trim() === '')) {
      problems.push(`${r.id} 的 schemaKind 不是非空字符串`)
    }
    if (!ALL_ENFORCEMENT.has(r.enforcement)) problems.push(`${r.id} 的 enforcement 不在四分法里：${r.enforcement}`)
    if (!Array.isArray(r.schemaVersions) || r.schemaVersions.length === 0) {
      problems.push(`${r.id} 没有声明适用的 schemaVersions`)
    }
    if (!Array.isArray(r.checks)) { problems.push(`${r.id} 的 checks 不是数组`); continue }
    for (const id of r.checks) {
      if (!checkIdSet.has(id)) problems.push(`${r.id} 指向不存在的 check ${id}`)
    }
    const evidence = r.evidence ?? []
    if (!Array.isArray(evidence)) problems.push(`${r.id} 的 evidence 不是数组`)
    if (!Array.isArray(r.docRefs) || r.docRefs.length === 0) problems.push(`${r.id} 没有 docRefs`)

    // 核心的诚实性约束，两个方向都要堵：
    //
    // 1. 非 machine-enforced 却挂了 check —— 有机器强制就该标 machine-enforced。
    // 2. machine-enforced 却既无 check 也无 evidence —— "机器强制"成了不可
    //    证伪的断言。registry 的全部价值在于它的断言能被核对；一条谁都验不了
    //    的 machine-enforced 比不写更糟，因为它让人以为已经覆盖。
    if (r.enforcement !== ENFORCEMENT.MACHINE && r.checks.length > 0) {
      problems.push(`${r.id} 标为 ${r.enforcement} 却挂了 check ${r.checks.join(', ')} —— 有机器强制就该标 machine-enforced`)
    }
    if (r.enforcement === ENFORCEMENT.MACHINE && r.checks.length === 0 && evidence.length === 0) {
      problems.push(`${r.id} 声称 machine-enforced 却既没有 check 也没有 evidence —— 这是不可证伪的断言，请指出强制它的文件，或改标 trusted-assertion`)
    }
    if (r.enforcement === ENFORCEMENT.MACHINE && r.severity === null) {
      problems.push(`${r.id} 是 machine-enforced 却没有 severity`)
    }
    if (r.enforcement !== ENFORCEMENT.MACHINE && r.severity !== null) {
      problems.push(`${r.id} 不是 machine-enforced 却声明了 severity ${r.severity} —— 不编造严重度`)
    }
  }
  return problems
}
