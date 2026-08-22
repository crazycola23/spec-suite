#!/usr/bin/env node

/**
 * 只读 adoption assessment。
 *
 * v0 只做 inspect + ask + recommend：不创建 L0、不修改 CLAUDE.md/AGENTS.md、
 * 不写 unresolved registry。`--dry-run` 作为显式的 UX 入口保留，但当前命令
 * 的所有路径本来就只读。
 */

import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'

import { MESSAGES_ZH, parseFlags } from '../src/shared/argv.mjs'
import {
  ADOPTION_SCHEMA_VERSION,
  ANSWER_FIELDS,
  ANSWER_VALUES,
  MODE,
  blankAnswers,
  normalizeAnswers,
} from '../src/adoption/model.mjs'
import { inspectRepository } from '../src/adoption/inspect.mjs'
import { recommendMode } from '../src/adoption/recommend.mjs'

const answerError = (flag, value) => ANSWER_VALUES.includes(value)
  ? null
  : `${flag} 只接受 yes、no 或 unknown，收到：${value ?? '(缺失)'}`

export const SPEC = {
  '-h': { key: 'help', flag: true },
  '--help': { key: 'help', flag: true },
  '--repo-root': { key: 'repoRoot' },
  '--format': {
    key: 'format',
    validate: (value) => value === 'text' || value === 'json'
      ? null
      : `--format 只接受 text 或 json，收到：${value ?? '(缺失)'}`,
  },
  '--shared-contract': {
    key: 'sharedContract',
    validate: (value) => answerError('--shared-contract', value),
  },
  '--high-risk-boundary': {
    key: 'highRiskBoundary',
    validate: (value) => answerError('--high-risk-boundary', value),
  },
  '--explicit-governance': {
    key: 'explicitGovernance',
    validate: (value) => answerError('--explicit-governance', value),
  },
  '--dry-run': { key: 'dryRun', flag: true },
  '--no-input': { key: 'noInput', flag: true },
}

const HELP = `用法：node scripts/adopt.mjs [选项]

只读检查陌生仓库，并推荐 no-op / lightweight / full / needs-input。
当前版本永不创建或修改文件；--dry-run 只是显式表达这一点。

  --repo-root <路径>                 要评估的项目根目录（默认当前目录）
  --format text|json                 输出格式（默认 text）
  --shared-contract yes|no|unknown   是否由多个 agent / repository 共享 contract
  --high-risk-boundary yes|no|unknown 未决工作是否控制 money、permissions 或不可逆副作用
  --explicit-governance yes|no|unknown 是否明确要求 specification/contract governance
  --dry-run                          保持只读（当前版本的默认行为）
  --no-input                         不在交互终端询问未知问题
  -h, --help                         显示本帮助

退出码：0 = assessment 完成（包括 needs-input）；1 = 无法检查项目；2 = 参数错误。
`

const QUESTIONS = Object.freeze({
  sharedContract: '是否有一个 contract 由多个 agent 或多个 repository 共享？',
  highRiskBoundary: '未决工作是否控制 money、permissions 或不可逆外部副作用？',
  explicitGovernance: '是否明确要求在这里采用 specification/contract governance？',
})

export function parseArgv(argv) {
  const { options, error } = parseFlags(argv, SPEC, MESSAGES_ZH)
  if (error) return { error }
  return {
    opts: {
      repoRoot: '.',
      format: 'text',
      ...blankAnswers(),
      dryRun: false,
      noInput: false,
      help: false,
      ...options,
    },
  }
}

/**
 * 纯组合：observation + answers → 机器可读 assessment。
 * 不包含 repoRoot，避免 JSON 结果带入绝对路径。
 */
export function buildAssessment(observed, answers = {}) {
  const normalized = normalizeAnswers(answers)
  return {
    schemaVersion: ADOPTION_SCHEMA_VERSION,
    observed,
    answers: normalized,
    recommendation: recommendMode(observed, normalized),
  }
}

export function assessRepository(repoRoot = '.', answers = {}) {
  return buildAssessment(inspectRepository(repoRoot), answers)
}

function present(value) {
  return value ? 'yes' : 'no'
}

function answerDisplay(value) {
  return value === 'unknown' ? '?' : value
}

function listOrDash(values) {
  return values.length > 0 ? values.join(', ') : '——'
}

function renderObserved(lines, observed) {
  const a = observed.artifacts
  lines.push(
    'Observed',
    '--------',
    `spec-suite.config.json           ${present(a.config.present)}${a.config.present && !a.config.parseable ? ' (not parseable)' : ''}`,
    `.spec-suite/unresolved.yaml      ${present(a.unresolvedRegistry.present)}`,
    `canonical agent entry            ${a.canonicalAgentEntry.path ?? '——'}`,
    `agent entry declared by config   ${present(a.canonicalAgentEntry.declared)}`,
    `generated/manifest.json          ${present(a.generatedManifest.present)}`,
    `agent adapters                   ${listOrDash(observed.agentAdapters)}`,
    `declared dictionaries            ${listOrDash(a.dictionaries.declared)}`,
    `present dictionaries             ${listOrDash(a.dictionaries.present)}`,
    '',
    'Repository adoption',
    '---------------------',
    `full mode detected               ${present(observed.fullAdoption)}`,
    `lightweight state detected       ${present(observed.lightweightState)}`,
    '',
  )
}

/** Deterministic human renderer. */
export function renderHuman(assessment) {
  const { observed, answers, recommendation } = assessment
  const lines = ['Spec Suite Adoption Assessment', '==============================', '']
  renderObserved(lines, observed)
  lines.push(
    'Adoption questions',
    '------------------',
    `shared contract across agents/repos      ${answerDisplay(answers.sharedContract)}`,
    `money/permission/irreversible boundary  ${answerDisplay(answers.highRiskBoundary)}`,
    `explicit specification governance        ${answerDisplay(answers.explicitGovernance)}`,
    '',
    'Recommendation',
    '--------------',
    recommendation.mode.toUpperCase(),
    '',
    'Why:',
  )
  for (const item of recommendation.reasons) lines.push(`- ${item.message}`)
  if (observed.issues.length > 0) {
    lines.push('', 'Inspection notes:')
    for (const issue of observed.issues) lines.push(`- ${issue.message}`)
  }
  lines.push(
    '',
    'Suggested next action:',
    recommendation.nextAction,
    '',
    'No files changed.',
    '',
  )
  return lines.join('\n')
}

export function renderJson(assessment) {
  return `${JSON.stringify({
    schemaVersion: ADOPTION_SCHEMA_VERSION,
    observed: assessment.observed,
    answers: assessment.answers,
    recommendation: assessment.recommendation,
  }, null, 2)}\n`
}

function isInteractiveDefault(input, output) {
  return Boolean(input?.isTTY && output?.isTTY)
}

/**
 * 只询问当前仍为 unknown 的字段。空输入保持 unknown；没有默认成 no。
 */
export async function promptForAnswers(
  answers,
  {
    input = process.stdin,
    output = process.stdout,
    shouldContinue = () => true,
  } = {},
) {
  const next = { ...normalizeAnswers(answers) }
  const readline = createInterface({ input, output })
  try {
    output.write('spec-suite 无法从仓库内容证明以下事实；请输入 yes、no 或 unknown。\n\n')
    for (const field of ANSWER_FIELDS) {
      if (!shouldContinue(next)) break
      if (next[field] !== 'unknown') continue
      while (true) {
        const raw = await readline.question(`${QUESTIONS[field]} [yes/no/unknown] `)
        const value = raw.trim().toLowerCase() || 'unknown'
        if (ANSWER_VALUES.includes(value)) {
          next[field] = value
          break
        }
        output.write(`请输入 yes、no 或 unknown；不会替你猜测 ${field}。\n`)
      }
    }
  } finally {
    readline.close()
  }
  return next
}

/**
 * CLI 主体。默认只在真正的 TTY 中提问；JSON 输出和管道调用保持纯 JSON。
 */
export async function main(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    cwd = process.cwd(),
    interactive = isInteractiveDefault(stdin, stdout),
  } = {},
) {
  const parsed = parseArgv(argv)
  if (parsed.error) {
    stderr.write(`${parsed.error}\n\n${HELP}`)
    return 2
  }
  if (parsed.opts.help) {
    stdout.write(HELP)
    return 0
  }

  try {
    const repoRoot = path.resolve(cwd, parsed.opts.repoRoot)
    const observed = inspectRepository(repoRoot)
    let answers = normalizeAnswers(parsed.opts)
    // --dry-run 的存在是 UX 说明；当前实现所有路径都只读。
    void parsed.opts.dryRun
    let assessment = buildAssessment(observed, answers)
    if (
      parsed.opts.format === 'text'
      && interactive
      && !parsed.opts.noInput
      && assessment.recommendation.mode === MODE.NEEDS_INPUT
    ) {
      answers = await promptForAnswers(answers, {
        input: stdin,
        output: stdout,
        // 任一 yes 已足以决定 full；已有 full adoption 也在进入 prompt 前就会
        // 决定 no-op。其余问题继续保持 unknown，不为了填满报告而多问。
        shouldContinue: (current) => recommendMode(observed, current).mode === MODE.NEEDS_INPUT,
      })
      assessment = buildAssessment(observed, answers)
    }
    stdout.write(parsed.opts.format === 'json' ? renderJson(assessment) : renderHuman(assessment))
    return 0
  } catch (error) {
    stderr.write(`adoption assessment 失败：${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main(process.argv.slice(2)).then((code) => process.exit(code))
