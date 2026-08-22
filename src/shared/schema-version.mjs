// 版本策略：schemaVersion 的唯一判定点。
//
// 为什么需要一张表，而不是散落各处的 `!== 1`：
// 重构前有 4 处各自实现的 `!== 1` 检查，加 1 处隐藏 fallback
// （migrate-unresolved.mjs 的 `?? 1`）。重复本身不是问题 —— 问题是
// 没有任何一处能回答「遇到 schemaVersion 2 该怎么办」。每一处只会说
// 「不是 1」，于是升级 schema 时必须同时改 4 个地方，且没人知道
// 旧 artifact 还能不能读、迁移往哪个方向走。
//
// 三条硬规则（对应仓库自己的三条 invariant）：
//   1. 未知版本永不变成默认值。本模块任何路径都不允许 `?? default`。
//   2. 高于 current 的版本 = 未来未知 schema ⇒ 拒绝，并明确说明不猜测。
//   3. 缺失版本按 artifact 的 requiredNow 判 error 还是 warn，
//      绝不当作 current 处理。
//
// 本模块不 throw、不打印、不退出，只返回判定结果。让调用方决定是
// 收进 findings 还是抛异常 —— V1 用 collector，V2 用 throw，两边都不改
// 各自的错误语义。

/**
 * 版本策略表。每个 artifact kind 一行。
 *
 * current              当前工具写出的版本
 * supported            本工具能**读**的版本（含 current）
 * deprecated           仍可读但已宣告废弃，读到时 warn
 * requiredNow          缺失字段是否立即算 error。false = 本轮先 warn，
 *                      下个大版本转 error（迁移期）；这类 artifact 同时
 *                      会在 trust-report 里标为 not-proven
 * migrationDirection   'forward-only' = 只支持 v(n) → v(n+1)，不支持降级
 * versionPath          字段位置。dictionary 放在 meta 下（顶层非数组键
 *                      会被 buildModel 判 error），其余在顶层
 * legacyMessage        重构前既有的错误文案。测试按它断言，必须逐字保留。
 *                      null = 该 kind 没有历史文案，用生成文案
 */
export const SCHEMA_POLICY = {
  'agent-entry': {
    label: 'Agent Entry Contract',
    current: 1, supported: [1], deprecated: [], requiredNow: true,
    migrationDirection: 'forward-only', versionPath: ['schemaVersion'],
    legacyMessage: 'Agent Entry Contract 的 `schemaVersion` 必须是 1',
  },
  'unresolved-registry': {
    label: 'unresolved registry',
    current: 1, supported: [1], deprecated: [], requiredNow: true,
    migrationDirection: 'forward-only', versionPath: ['schemaVersion'],
    legacyMessage: 'unresolved registry 必须是 schemaVersion 1 且包含 facts 数组',
  },
  'generated-manifest': {
    label: 'generated manifest',
    current: 1, supported: [1], deprecated: [], requiredNow: true,
    migrationDirection: 'forward-only', versionPath: ['schemaVersion'],
    legacyMessage: 'generated manifest 必须是 schemaVersion 1 且包含 outputs 数组',
  },
  'contract-bundle': {
    label: 'contract bundle',
    current: 1, supported: [1], deprecated: [], requiredNow: true,
    migrationDirection: 'forward-only', versionPath: ['schemaVersion'],
    legacyMessage: null,
  },
  'control-plane-document': {
    label: 'control plane document',
    current: 1, supported: [1], deprecated: [], requiredNow: true,
    migrationDirection: 'forward-only', versionPath: ['schemaVersion'],
    // 文案由调用方的 label 参数化，见 formatLegacy()
    legacyMessage: '${label}.schemaVersion must be 1',
  },
  dictionary: {
    label: 'dictionary',
    current: 1, supported: [1], deprecated: [], requiredNow: false,
    migrationDirection: 'forward-only', versionPath: ['meta', 'schemaVersion'],
    legacyMessage: null,
  },
  'suite-config': {
    label: 'spec-suite config',
    current: 1, supported: [1], deprecated: [], requiredNow: false,
    migrationDirection: 'forward-only', versionPath: ['schemaVersion'],
    legacyMessage: null,
  },
}

/** 判定结果的 status 取值。导出以便测试穷举，避免拼写漂移。 */
export const VERDICT = {
  OK: 'ok',
  MISSING: 'missing',
  NOT_INTEGER: 'not-integer',
  DEPRECATED: 'deprecated',
  PAST_SUPPORTED: 'past-supported',
  UNSUPPORTED_PAST: 'unsupported-past',
  FUTURE: 'future',
}

function readPath(doc, keys) {
  let node = doc
  for (const k of keys) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[k]
  }
  return node
}

function formatLegacy(policy, label) {
  if (policy.legacyMessage === null) return null
  return policy.legacyMessage.replace('${label}', label ?? policy.label)
}

/**
 * 判定一份文档的 schemaVersion。
 *
 * 不 throw、不打印。返回：
 *   { kind, status, severity, version, expected, message, detail, migration }
 *
 * severity ∈ 'ok' | 'warn' | 'error' —— 与 collector 的取值一致。
 * message  给人看的一行话；有 legacyMessage 的 kind 逐字沿用历史文案。
 * detail   补充说明；`future` 的 detail 明确写「不猜测」。
 * migration 需要迁移时给出 { kind, from, to, direction }，否则 null。
 *
 * @param {string} kind SCHEMA_POLICY 的键
 * @param {unknown} doc 已解析的文档对象
 * @param {{label?: string}} [opts] label 用于参数化文案（V2 的 assertSchemaVersion）
 */
export function checkSchemaVersion(kind, doc, opts = {}) {
  const policy = SCHEMA_POLICY[kind]
  // 未注册的 kind 是调用方的编程错误，不是数据问题 —— 直接 throw，
  // 不能返回一个「看起来通过了」的判定。
  if (!policy) throw new Error(`未注册的 schema kind：${kind}。请先在 SCHEMA_POLICY 里声明`)

  const label = opts.label ?? policy.label
  const legacy = formatLegacy(policy, label)
  const expected = policy.current
  const raw = readPath(doc, policy.versionPath)
  const at = policy.versionPath.join('.')
  const base = { kind, expected, migration: null }

  if (raw === undefined || raw === null) {
    const severity = policy.requiredNow ? 'error' : 'warn'
    return {
      ...base, status: VERDICT.MISSING, severity, version: null,
      message: legacy ?? `${label} 缺少 \`${at}\``,
      detail: policy.requiredNow
        ? `${label} 必须声明 \`${at}\`。缺失不等于版本 ${expected} —— 不做这个假设。`
        : `${label} 尚未声明 \`${at}\`。本轮先告警；缺版本的 artifact 在 trust-report 里记为 not-proven，不会被当作版本 ${expected}。`,
    }
  }

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return {
      ...base, status: VERDICT.NOT_INTEGER, severity: 'error', version: raw,
      message: legacy ?? `${label} 的 \`${at}\` 必须是 ≥1 的整数，实际是 ${JSON.stringify(raw)}`,
      detail: `版本号只接受 ≥1 的整数。不做类型宽容转换。`,
    }
  }

  if (raw > expected) {
    return {
      ...base, status: VERDICT.FUTURE, severity: 'error', version: raw,
      message: legacy ?? `${label} 的 \`${at}\` 是 ${raw}，本工具只支持到 ${expected}`,
      detail: `${label} 声明的版本 ${raw} 高于本工具的 ${expected}，属于未来未知 schema。`
        + `本工具不支持，也不猜测其含义 —— 请升级工具，而不是降级文档。`,
    }
  }

  if (!policy.supported.includes(raw)) {
    return {
      ...base, status: VERDICT.UNSUPPORTED_PAST, severity: 'error', version: raw,
      message: legacy ?? `${label} 的 \`${at}\` 是 ${raw}，已不在支持范围 [${policy.supported.join(', ')}]`,
      detail: `版本 ${raw} 太旧，本工具已不再支持读取。请用支持该版本的旧工具先迁移到 ${policy.supported[0]}。`,
    }
  }

  if (raw === expected) {
    return { ...base, status: VERDICT.OK, severity: 'ok', version: raw, message: null, detail: null }
  }

  // raw < expected 且在 supported 内 —— 可读，但需要迁移
  const migration = { kind, from: raw, to: expected, direction: policy.migrationDirection }
  const deprecated = policy.deprecated.includes(raw)
  return {
    ...base,
    status: deprecated ? VERDICT.DEPRECATED : VERDICT.PAST_SUPPORTED,
    severity: deprecated ? 'warn' : 'ok',
    version: raw,
    migration,
    message: deprecated ? `${label} 的 \`${at}\` 是 ${raw}，已废弃（仍可读）` : null,
    detail: `${label} 处于版本 ${raw}，当前版本是 ${expected}。迁移方向 ${policy.migrationDirection}，`
      + `请走 migrations/ 里注册的 ${raw}→${expected} 迁移。`,
  }
}

/**
 * throw 版本。给 V2 与各 CLI 脚本用 —— 它们的既有语义是抛异常。
 *
 * `message` 逐字沿用历史 legacyMessage，且**故意保持单行、简短**，不把
 * detail 拼进去。原因不是怕改文案，而是这个字符串会流进结构化数据：
 * `control-plane-ipc.mjs:10` 把 `error.message` 放进 JSONL 的 error 字段，
 * 两个 daemon 把它写进 stderr 的 readiness 行，denial provenance 也依赖
 * 它保持稳定。往里塞一段解释会让 provenance 变成随文案漂移的自由文本。
 *
 * detail 挂在 `e.schemaVerdict.detail` 上，由 **CLI 层**决定要不要打印
 * （见三个脚本的 main()）。判定属于 domain，措辞属于 presentation。
 */
export function assertSchemaVersion(kind, doc, opts = {}) {
  const v = checkSchemaVersion(kind, doc, opts)
  if (v.severity === 'error') {
    const e = new Error(v.message)
    e.schemaVerdict = v
    throw e
  }
  return v
}

/**
 * 给 CLI 层用的补充说明格式化器。纯函数，不打印。
 *
 * 传入任意 error：带 `schemaVerdict.detail` 就返回缩进一行的提示，否则返回
 * 空串。调用方可以无条件拼接，不必先判断异常种类。
 *
 * 存在的意义：`未来未知版本`的历史文案是「必须是 schemaVersion 1」，它在字面上
 * 把使用者指向「把文档降级」，而正确的处置恰好相反 —— 升级工具。文案不能改
 * （测试与 provenance 依赖它），所以由这里补一句。
 */
export function schemaVersionHint(error) {
  const detail = error?.schemaVerdict?.detail
  return typeof detail === 'string' && detail.trim() !== '' ? `  ${detail}\n` : ''
}
