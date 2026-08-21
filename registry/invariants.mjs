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
//   3. 它对代码的**断言本身被测试校验**（scripts/registry.test.mjs）：
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
    errorMeaning: 'canonical 与 Markdown 投影不一致',
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
 *   schemaVersions 适用的 dictionary schema 版本。目前全是 [1]
 *   enforcement   ENFORCEMENT 之一
 *   checks        强制它的 V1 check id；非 MACHINE 的规则必须为空数组
 *   evidence      不属于 V1 七类检查、但确实有机器强制时，列出强制它的文件。
 *                 machine-enforced 必须至少有 checks 或 evidence 之一非空，
 *                 否则"机器强制"就成了不可证伪的断言 —— 那正是本 registry
 *                 要消灭的东西。路径存在性由 registry.test.mjs 校验
 *   docRefs       描述它的文档位置，供人类回查
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
    docRefs: ['SCHEMA.md §6', 'migrations/README.md'],
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
    docRefs: ['SCHEMA.md §1'],
  },
  {
    id: 'REC-COUNTS-DERIVED',
    kind: 'record-rule',
    title: '计数是派生值，不作为断言',
    statement: '记录条数等计数由工具派生并只用于报告，不写进 canonical 当断言。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [1],
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
    docRefs: ['README.md 设计边界'],
  },
  {
    id: 'BND-PROJECTION-KNOWLEDGE',
    kind: 'boundary',
    title: 'Context projection 只增加知识，不授予权限',
    statement: 'Context projection 只增加知识，不授予权限；dependency uncertainty 增加时 privilege 只能保持或下降。',
    severity: 'error',
    schemaVersions: [1],
    enforcement: ENFORCEMENT.MACHINE,
    checks: [],
    // 由 V2 projector 强制，不属于 V1 checker 的七类 —— 所以证据走 evidence。
    evidence: ['scripts/project-context.mjs', 'scripts/v2-control-plane.test.mjs'],
    docRefs: ['README.md 设计边界', 'control-plane/README.md Projection 的准确边界'],
  },
  {
    id: 'BND-GRAPH-COMPLETE',
    kind: 'boundary',
    title: '`complete: true` 是受信声明',
    statement: '`complete: true` 是受信声明；同步修改 graph 与 digest 不等于证明依赖图语义完备。',
    severity: null,
    schemaVersions: [1],
    enforcement: ENFORCEMENT.TRUSTED,
    checks: [],
    docRefs: ['README.md 设计边界', 'control-plane/README.md Projection 的准确边界'],
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
