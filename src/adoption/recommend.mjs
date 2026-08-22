// 根据 observation + 用户明确回答选择 adoption mode。
//
// 这里不做关键词分类。所有 high-risk / shared / governance 判断都必须来自
// 用户回答；unknown 会停在 needs-input，而不是暗中走 lightweight。

import {
  ANSWER_FIELDS,
  MODE,
  assertObserved,
  normalizeAnswers,
} from './model.mjs'

const TRIGGER_DETAILS = Object.freeze({
  sharedContract: '一个 contract 由多个 agent 或多个 repository 共享。',
  highRiskBoundary: '未决工作控制 money、permissions 或不可逆外部副作用。',
  explicitGovernance: '用户明确要求 specification/contract governance。',
})

const UNKNOWN_DETAILS = Object.freeze({
  sharedContract: '是否存在跨 agent / 跨 repository 的 shared contract 仍未知。',
  highRiskBoundary: '未决工作是否触及 money、permissions 或不可逆副作用仍未知。',
  explicitGovernance: '用户是否有意采用 specification/contract governance 仍未知。',
})

function reason(code, message) {
  return { code, message }
}

/**
 * @param {{fullAdoption:boolean, lightweightState:boolean}} observed
 * @param {object} answers
 * @returns {{mode:string, reasons:Array<{code:string,message:string}>, nextAction:string}}
 */
export function recommendMode(observed, answers = {}) {
  assertObserved(observed)
  const normalized = normalizeAnswers(answers)

  if (observed.fullAdoption) {
    return {
      mode: MODE.NO_OP,
      reasons: [reason('full-adoption-detected', '已观察到 full-mode 的 config 与 canonical agent entry。')],
      nextAction: '继续使用现有 full suite；adopt 不修改文件。',
    }
  }

  const confirmedTriggers = ANSWER_FIELDS.filter((field) => normalized[field] === 'yes')
  if (confirmedTriggers.length > 0) {
    return {
      mode: MODE.FULL,
      reasons: confirmedTriggers.map((field) => reason(`${field}-confirmed`, TRIGGER_DETAILS[field])),
      nextAction: '先生成并审阅 L0 adoption plan；adopt 本身不创建文件。',
    }
  }

  const unknownFields = ANSWER_FIELDS.filter((field) => normalized[field] === 'unknown')
  if (unknownFields.length > 0) {
    return {
      mode: MODE.NEEDS_INPUT,
      reasons: unknownFields.map((field) => reason(`${field}-unknown`, UNKNOWN_DETAILS[field])),
      nextAction: '回答这些 adoption 问题；不要把 unknown 当成 no。',
    }
  }

  if (observed.lightweightState) {
    return {
      mode: MODE.NO_OP,
      reasons: [reason('lightweight-state-detected', '已观察到 .spec-suite/unresolved.yaml。')],
      nextAction: '继续使用 lightweight unresolved protocol；需要升级时再明确回答 full trigger。',
    }
  }

  return {
    mode: MODE.LIGHTWEIGHT,
    reasons: [
      reason('no-full-trigger-confirmed', 'shared contract、high-risk boundary 与显式 governance 均被回答为 no。'),
      reason('no-adoption-artifact-detected', '仓库中未观察到已有 full-mode 或 lightweight adoption artifact。'),
    ],
    nextAction: '记录具体 unsupported fact 到 .spec-suite/unresolved.yaml；adopt 本身不创建文件。',
  }
}
