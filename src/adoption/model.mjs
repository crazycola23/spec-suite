// Adoption assessment 的稳定数据模型。
//
// 这里刻意只放值域与归一化，不放文件系统访问或 CLI 文案。adopt 的输出会被
// 人、CI 和未来的编辑器消费；未知值不能因为调用方漏传就静默变成 false。

export const ADOPTION_SCHEMA_VERSION = 1

export const MODE = Object.freeze({
  NO_OP: 'no-op',
  LIGHTWEIGHT: 'lightweight',
  FULL: 'full',
  NEEDS_INPUT: 'needs-input',
})

export const ANSWER_FIELDS = Object.freeze([
  'sharedContract',
  'highRiskBoundary',
  'explicitGovernance',
])

export const ANSWER_VALUES = Object.freeze(['yes', 'no', 'unknown'])

export function blankAnswers() {
  return Object.fromEntries(ANSWER_FIELDS.map((field) => [field, 'unknown']))
}

/**
 * 只接受显式的 yes/no/unknown。
 *
 * @param {object|undefined} answers
 * @returns {Record<string, 'yes'|'no'|'unknown'>}
 */
export function normalizeAnswers(answers = {}) {
  const normalized = {}
  for (const field of ANSWER_FIELDS) {
    const value = answers[field] ?? 'unknown'
    if (!ANSWER_VALUES.includes(value)) {
      throw new TypeError(`${field} 必须是 yes、no 或 unknown，实际是 ${JSON.stringify(value)}`)
    }
    normalized[field] = value
  }
  return normalized
}

/**
 * Adoption recommendation 输入的最小结构校验。
 *
 * 缺少 observable 字段不是“没有发现”，而是调用方 bug；在这里抛错比给它
 * 一个宽松默认更安全。
 */
export function assertObserved(observed) {
  if (!observed || typeof observed !== 'object') {
    throw new TypeError('observed 必须是对象')
  }
  for (const field of ['fullAdoption', 'lightweightState']) {
    if (typeof observed[field] !== 'boolean') {
      throw new TypeError(`observed.${field} 必须是 boolean`)
    }
  }
}
