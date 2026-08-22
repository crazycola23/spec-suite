#!/usr/bin/env node

/**
 * Skill trigger evaluation runner。
 *
 * discovery 只把 name + description 交给 adapter；routing 才把完整 SKILL.md
 * 交给 adapter。adapter 是独立的 Node 进程，通过 stdin/stdout 传一个 JSON
 * request/response，因此 runner 不绑定 Claude、Codex 或任何供应商 SDK。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { MESSAGES_ZH, parseFlags } from '../src/shared/argv.mjs'

export const TRIGGER_SCHEMA_VERSION = 1
export const ADAPTER_PROTOCOL_VERSION = 1

const PHASES = Object.freeze(['discovery', 'routing'])
const CATEGORIES = Object.freeze(['no-trigger', 'lightweight', 'full'])
const SEVERITIES = Object.freeze(['critical', 'exploratory'])

const VALID_MODES = new Set(['lightweight', 'full'])

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value
}

function validateExpected(phase, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error('expected 必须是对象')
  }
  if (phase === 'discovery') {
    if (typeof expected.activate !== 'boolean') {
      throw new Error('discovery case 的 expected.activate 必须是 boolean')
    }
    return
  }
  if (!VALID_MODES.has(expected.mode)) {
    throw new Error('routing case 的 expected.mode 必须是 lightweight 或 full')
  }
}

function validateCategory(phase, category, expected) {
  if (!CATEGORIES.includes(category)) throw new Error(`category 必须是 ${CATEGORIES.join('、')}`)
  if (phase === 'discovery') {
    const expectedCategory = expected.activate ? null : 'no-trigger'
    if (expectedCategory === 'no-trigger' && category !== expectedCategory) {
      throw new Error('discovery 的 activate=false 必须标为 no-trigger')
    }
    if (expectedCategory === null && category === 'no-trigger') {
      throw new Error('discovery 的 activate=true 不能标为 no-trigger')
    }
    return
  }
  if (expected.mode !== category) {
    throw new Error(`routing 的 category 必须与 expected.mode 相同：${expected.mode}`)
  }
}

/** 验证并返回一条不含未知字段的稳定 case。 */
export function validateCase(raw, lineNumber = '?') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`第 ${lineNumber} 行必须是 JSON 对象`)
  }
  const id = nonEmptyString(raw.id, `第 ${lineNumber} 行的 id`)
  const phase = nonEmptyString(raw.phase, `${id} 的 phase`)
  if (!PHASES.includes(phase)) throw new Error(`${id} 的 phase 必须是 ${PHASES.join(' 或 ')}`)
  const prompt = nonEmptyString(raw.prompt, `${id} 的 prompt`)
  const severity = nonEmptyString(raw.severity, `${id} 的 severity`)
  if (!SEVERITIES.includes(severity)) throw new Error(`${id} 的 severity 必须是 ${SEVERITIES.join(' 或 ')}`)
  validateExpected(phase, raw.expected)
  validateCategory(phase, raw.category, raw.expected)
  const why = nonEmptyString(raw.why, `${id} 的 why`)
  return {
    id,
    phase,
    prompt,
    expected: phase === 'discovery'
      ? { activate: raw.expected.activate }
      : { mode: raw.expected.mode },
    category: raw.category,
    severity,
    why,
  }
}

/** 读取确定性 JSONL corpus；空行允许，重复 id 与任何形状错误都会失败。 */
export function loadCases(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const cases = []
  const ids = new Set()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是合法 JSON：${error.message}`)
    }
    const item = validateCase(raw, index + 1)
    if (ids.has(item.id)) throw new Error(`case id 重复：${item.id}`)
    ids.add(item.id)
    cases.push(item)
  }
  if (cases.length === 0) throw new Error(`${filePath} 没有任何 case`)
  return cases
}

function parseDescription(frontmatter) {
  const lines = frontmatter.split(/\r?\n/)
  const index = lines.findIndex((line) => /^description:\s*>-?\s*$/.test(line))
  if (index >= 0) {
    const values = []
    for (const line of lines.slice(index + 1)) {
      if (!/^\s{2}/.test(line)) break
      values.push(line.replace(/^\s{2}/, '').trim())
    }
    return values.join(' ').replace(/\s+/g, ' ').trim()
  }
  const scalar = lines.find((line) => /^description:\s+/.test(line))
  return scalar ? scalar.replace(/^description:\s+/, '').trim() : ''
}

/** 只解析 SKILL.md frontmatter，routing 的 content 仍保留完整原文。 */
export function loadSkill(skillPath) {
  const content = fs.readFileSync(skillPath, 'utf8')
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error(`${skillPath} 缺少 frontmatter`)
  const nameMatch = match[1].match(/^name:\s*(\S+)\s*$/m)
  const name = nameMatch?.[1]
  const description = parseDescription(match[1])
  nonEmptyString(name, 'SKILL.md 的 name')
  nonEmptyString(description, 'SKILL.md 的 description')
  return { name, description, content }
}

function requestFor(item, skill) {
  const shared = {
    protocolVersion: ADAPTER_PROTOCOL_VERSION,
    phase: item.phase,
    caseId: item.id,
    prompt: item.prompt,
  }
  if (item.phase === 'discovery') {
    return {
      ...shared,
      skill: { name: skill.name, description: skill.description },
    }
  }
  return {
    ...shared,
    skill: { name: skill.name, description: skill.description, content: skill.content },
  }
}

function validateAdapterResponse(phase, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('adapter response 必须是 JSON 对象')
  }
  if (phase === 'discovery') {
    if (typeof value.activate !== 'boolean') {
      throw new Error('discovery adapter response 必须包含 boolean activate')
    }
    return { activate: value.activate }
  }
  if (!VALID_MODES.has(value.mode)) {
    throw new Error('routing adapter response 必须包含 mode: lightweight 或 full')
  }
  return { mode: value.mode }
}

/**
 * 运行一套 cases。invokeAdapter 可注入纯函数，CLI 则传入外部进程 adapter。
 */
export function runTriggerEval(cases, invokeAdapter, skill) {
  if (typeof invokeAdapter !== 'function') throw new TypeError('invokeAdapter 必须是函数')
  if (!skill || typeof skill.name !== 'string' || typeof skill.description !== 'string') {
    throw new TypeError('skill 必须包含 name 与 description')
  }

  const results = []
  for (const item of cases) {
    let actual = null
    let error = null
    try {
      actual = validateAdapterResponse(item.phase, invokeAdapter(requestFor(item, skill)))
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const pass = error === null && (
      item.phase === 'discovery'
        ? actual.activate === item.expected.activate
        : actual.mode === item.expected.mode
    )
    results.push({
      id: item.id,
      phase: item.phase,
      severity: item.severity,
      category: item.category,
      prompt: item.prompt,
      why: item.why,
      expected: item.expected,
      actual,
      pass,
      error,
    })
  }
  return { results, summary: summarizeResults(results) }
}

function failureClass(result) {
  if (result.error) return 'adapter-error'
  if (result.phase === 'discovery') {
    return result.expected.activate ? 'false-negative' : 'false-positive'
  }
  if (result.expected.mode === 'lightweight' && result.actual?.mode === 'full') return 'over-escalation'
  if (result.expected.mode === 'full' && result.actual?.mode === 'lightweight') return 'under-escalation'
  return 'routing-mismatch'
}

function failureDetail(result) {
  return {
    id: result.id,
    phase: result.phase,
    severity: result.severity,
    category: result.category,
    prompt: result.prompt,
    why: result.why,
    expected: result.expected,
    actual: result.actual,
    class: failureClass(result),
    error: result.error,
  }
}

function summarizePhase(results, phase) {
  const subset = results.filter((result) => result.phase === phase)
  const failures = subset.filter((result) => !result.pass)
  const summary = {
    total: subset.length,
    pass: subset.filter((result) => result.pass).length,
    fail: failures.length,
    adapterErrors: failures.filter((result) => failureClass(result) === 'adapter-error').length,
  }
  if (phase === 'discovery') {
    summary.falsePositives = failures.filter((result) => failureClass(result) === 'false-positive').length
    summary.falseNegatives = failures.filter((result) => failureClass(result) === 'false-negative').length
  } else {
    summary.overEscalation = failures.filter((result) => failureClass(result) === 'over-escalation').length
    summary.underEscalation = failures.filter((result) => failureClass(result) === 'under-escalation').length
  }
  return summary
}

export function summarizeResults(results) {
  const failures = results.filter((result) => !result.pass)
  const critical = failures.filter((result) => result.severity === 'critical')
  const exploratory = failures.filter((result) => result.severity === 'exploratory')
  return {
    total: results.length,
    pass: results.filter((result) => result.pass).length,
    fail: failures.length,
    criticalFailures: critical.map(failureDetail),
    exploratoryFailures: exploratory.map(failureDetail),
    byPhase: {
      discovery: summarizePhase(results, 'discovery'),
      routing: summarizePhase(results, 'routing'),
    },
  }
}

export function makeProcessAdapter(adapterPath, { cwd = process.cwd() } = {}) {
  const absolute = path.resolve(cwd, adapterPath)
  return (request) => {
    const child = spawnSync(process.execPath, [absolute], {
      cwd,
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (child.error) throw child.error
    if (child.status !== 0) {
      const detail = child.stderr?.trim() || `exit ${child.status ?? 'unknown'}`
      throw new Error(`adapter 进程失败：${detail}`)
    }
    const output = child.stdout.trim()
    if (output === '') throw new Error('adapter 没有在 stdout 输出 JSON')
    try {
      return JSON.parse(output)
    } catch (error) {
      throw new Error(`adapter stdout 不是单个合法 JSON：${error.message}`)
    }
  }
}

function relativeLabel(cwd, absolute) {
  const rel = path.relative(cwd, absolute)
  return (rel === '' ? '.' : rel).split(path.sep).join('/')
}

export const SPEC = {
  '-h': { key: 'help', flag: true },
  '--help': { key: 'help', flag: true },
  '--cases': { key: 'cases' },
  '--adapter': { key: 'adapter' },
  '--skill': { key: 'skill' },
  '--format': {
    key: 'format',
    validate: (value) => value === 'text' || value === 'json'
      ? null
      : `--format 只接受 text 或 json，收到：${value ?? '(缺失)'}`,
  },
  '--validate': { key: 'validate', flag: true },
}

const HELP = `用法：node scripts/eval-trigger.mjs [选项]

分别评估 skill discovery（是否加载）与 routing（lightweight/full）。
adapter 是独立 Node 进程：stdin 收到一个 JSON request，stdout 必须只输出一个 JSON response。

  --cases <路径>       JSONL corpus（默认 evals/trigger/cases.jsonl）
  --adapter <路径>     外部 Node adapter；不与任何模型供应商绑定
  --skill <路径>       SKILL.md（默认 SKILL.md）
  --format text|json    输出格式（默认 text）
  --validate            只验证 corpus，不运行 adapter
  -h, --help            显示本帮助

退出码：0 = critical cases 全部通过；1 = 有 critical failure；2 = 参数或 corpus 错误。
exploratory failure 只报告，不阻断退出码。
`

function validationReport(cases) {
  return {
    schemaVersion: TRIGGER_SCHEMA_VERSION,
    eval: 'trigger',
    valid: true,
    totalCases: cases.length,
    phases: {
      discovery: cases.filter((item) => item.phase === 'discovery').length,
      routing: cases.filter((item) => item.phase === 'routing').length,
    },
  }
}

export function renderText(report) {
  const lines = ['Trigger Eval', '============', '']
  if (report.validOnly) {
    lines.push(
      `VALID corpus: ${report.totalCases} cases`,
      `discovery: ${report.phases.discovery}`,
      `routing: ${report.phases.routing}`,
      '',
    )
    return lines.join('\n')
  }
  for (const [name, summary] of Object.entries(report.summary.byPhase)) {
    lines.push(
      name[0].toUpperCase() + name.slice(1),
      '-'.repeat(name.length),
      `PASS ${summary.pass}`,
      `FAIL ${summary.fail}`,
      `adapter errors ${summary.adapterErrors}`,
    )
    if (name === 'discovery') {
      lines.push(`false positives ${summary.falsePositives}`, `false negatives ${summary.falseNegatives}`)
    } else {
      lines.push(`over-escalation ${summary.overEscalation}`, `under-escalation ${summary.underEscalation}`)
    }
    lines.push('')
  }
  lines.push(
    `Total: ${report.summary.pass}/${report.summary.total} pass`,
    `Critical failures: ${report.summary.criticalFailures.length}`,
    `Exploratory failures: ${report.summary.exploratoryFailures.length}`,
  )
  const failures = [...report.summary.criticalFailures, ...report.summary.exploratoryFailures]
  if (failures.length > 0) {
    lines.push('', 'Failures', '--------')
    for (const failure of failures) {
      lines.push(
        failure.id,
        `  prompt:   ${failure.prompt}`,
        `  why:      ${failure.why}`,
        `  expected: ${JSON.stringify(failure.expected)}`,
        `  actual:   ${JSON.stringify(failure.actual)}`,
        `  class:    ${failure.class}`,
      )
      if (failure.error) lines.push(`  error:    ${failure.error}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const parsed = parseFlags(argv, SPEC, MESSAGES_ZH)
  if (parsed.error) {
    stderr.write(`${parsed.error}\n\n${HELP}`)
    return 2
  }
  const options = {
    cases: 'evals/trigger/cases.jsonl',
    skill: 'SKILL.md',
    format: 'text',
    validate: false,
    help: false,
    ...parsed.options,
  }
  if (options.help) {
    stdout.write(HELP)
    return 0
  }

  let cases
  try {
    const casesPath = path.resolve(cwd, options.cases)
    cases = loadCases(casesPath)
    if (options.validate) {
      const report = validationReport(cases)
      if (options.format === 'json') stdout.write(renderJson(report))
      else stdout.write(renderText({ ...report, validOnly: true }))
      return 0
    }
    if (typeof options.adapter !== 'string' || options.adapter.trim() === '') {
      stderr.write(`缺少 --adapter；若只想验证 corpus，请使用 --validate。\n\n${HELP}`)
      return 2
    }
    const skillPath = path.resolve(cwd, options.skill)
    const skill = loadSkill(skillPath)
    const run = runTriggerEval(cases, makeProcessAdapter(options.adapter, { cwd }), skill)
    const report = {
      schemaVersion: TRIGGER_SCHEMA_VERSION,
      eval: 'trigger',
      corpus: relativeLabel(cwd, casesPath),
      skill: { name: skill.name },
      results: run.results,
      summary: run.summary,
    }
    stdout.write(options.format === 'json' ? renderJson(report) : renderText(report))
    return run.summary.criticalFailures.length > 0 ? 1 : 0
  } catch (error) {
    stderr.write(`trigger eval 失败：${error.message}\n`)
    return 2
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main(process.argv.slice(2)).then((code) => process.exit(code))
