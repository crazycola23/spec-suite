import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  loadCases,
  loadSkill,
  makeProcessAdapter,
  main,
  runTriggerEval,
} from '../../scripts/eval-trigger.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const corpusPath = path.join(repoRoot, 'evals', 'trigger', 'cases.jsonl')

function capture() {
  let value = ''
  return {
    write(chunk) { value += chunk },
    get value() { return value },
  }
}

test('trigger corpus 同时覆盖 discovery 与 routing，且每条 case id 唯一', () => {
  const cases = loadCases(corpusPath)
  assert.equal(cases.length, 17)
  assert.equal(cases.filter((item) => item.phase === 'discovery').length, 9)
  assert.equal(cases.filter((item) => item.phase === 'routing').length, 8)
  assert.ok(cases.some((item) => item.severity === 'critical'))
  assert.ok(cases.some((item) => item.severity === 'exploratory'))
})

test('discovery request 不泄漏完整 SKILL.md；routing request 才包含 content', () => {
  const cases = loadCases(corpusPath)
  const skill = loadSkill(path.join(repoRoot, 'SKILL.md'))
  const seen = []
  const run = runTriggerEval(cases.slice(0, 2), (request) => {
    seen.push(request)
    return request.phase === 'discovery' ? { activate: true } : { mode: 'lightweight' }
  }, skill)
  assert.equal(run.results.length, 2)
  assert.equal(Object.hasOwn(seen[0].skill, 'content'), false)
  assert.equal(Object.hasOwn(seen[1].skill, 'content'), false)

  const routing = cases.find((item) => item.phase === 'routing')
  runTriggerEval([routing], (request) => {
    seen.push(request)
    return { mode: routing.expected.mode }
  }, skill)
  assert.equal(Object.hasOwn(seen.at(-1).skill, 'content'), true)
  assert.match(seen.at(-1).skill.content, /Unknown stays unknown/)
})

test('SKILL.md frontmatter 在 CRLF checkout 中仍可读取', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-skill-crlf-'))
  try {
    const skillPath = path.join(root, 'SKILL.md')
    fs.writeFileSync(skillPath, [
      '---',
      'name: portable-skill',
      'description: >-',
      '  First line.',
      '  Second line.',
      '---',
      '# Body',
      '',
    ].join('\r\n'), 'utf8')
    const skill = loadSkill(skillPath)
    assert.equal(skill.name, 'portable-skill')
    assert.equal(skill.description, 'First line. Second line.')
    assert.match(skill.content, /# Body/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('注入一个按 expected 返回的 adapter 时，critical 与 exploratory 都可报告', () => {
  const cases = loadCases(corpusPath)
  const skill = loadSkill(path.join(repoRoot, 'SKILL.md'))
  const byId = new Map(cases.map((item) => [item.id, item]))
  const run = runTriggerEval(cases, (request) => byId.get(request.caseId).expected, skill)
  assert.equal(run.summary.total, 17)
  assert.equal(run.summary.pass, 17)
  assert.equal(run.summary.fail, 0)
  assert.deepEqual(run.summary.criticalFailures, [])
  assert.deepEqual(run.summary.exploratoryFailures, [])
})

test('错误路由会被分别标成 over-escalation 与 under-escalation', () => {
  const cases = loadCases(corpusPath).filter((item) => ['TR-R-001', 'TR-R-003'].includes(item.id))
  const skill = loadSkill(path.join(repoRoot, 'SKILL.md'))
  const run = runTriggerEval(cases, (request) => ({
    mode: request.caseId === 'TR-R-001' ? 'full' : 'lightweight',
  }), skill)
  assert.equal(run.summary.byPhase.routing.overEscalation, 1)
  assert.equal(run.summary.byPhase.routing.underEscalation, 1)
  assert.deepEqual(
    run.summary.criticalFailures.map((failure) => failure.class).sort(),
    ['over-escalation', 'under-escalation'],
  )
})

test('adapter 的非法输出不会被当成 pass', () => {
  const cases = loadCases(corpusPath).slice(0, 1)
  const skill = loadSkill(path.join(repoRoot, 'SKILL.md'))
  const run = runTriggerEval(cases, () => ({ markdown: 'not a protocol response' }), skill)
  assert.equal(run.summary.fail, 1)
  assert.equal(run.summary.byPhase.discovery.adapterErrors, 1)
  assert.equal(run.summary.criticalFailures[0].class, 'adapter-error')
  assert.equal(run.summary.criticalFailures[0].prompt, cases[0].prompt)
  assert.equal(run.summary.criticalFailures[0].why, cases[0].why)
  assert.match(run.summary.criticalFailures[0].error, /activate/)
})

test('process adapter 遵守 stdin/stdout 单 JSON 协议', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-trigger-'))
  try {
    const adapterPath = path.join(root, 'adapter.mjs')
    fs.writeFileSync(adapterPath, [
      "import fs from 'node:fs'",
      "const request = JSON.parse(fs.readFileSync(0, 'utf8'))",
      "process.stdout.write(request.phase === 'discovery' ? JSON.stringify({ activate: true }) : JSON.stringify({ mode: 'full' }))",
      '',
    ].join('\n'), 'utf8')
    const invoke = makeProcessAdapter(adapterPath, { cwd: root })
    assert.deepEqual(invoke({ phase: 'discovery' }), { activate: true })
    assert.deepEqual(invoke({ phase: 'routing' }), { mode: 'full' })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('eval-trigger CLI 能用外部 adapter 生成机器报告，并只以 critical failure 阻断', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-trigger-cli-'))
  try {
    const casesPath = path.join(root, 'cases.jsonl')
    fs.writeFileSync(casesPath, [
      JSON.stringify({
        id: 'CLI-D-001', phase: 'discovery', prompt: 'shared contract',
        expected: { activate: true }, category: 'full', severity: 'critical', why: 'shared',
      }),
      JSON.stringify({
        id: 'CLI-R-001', phase: 'routing', prompt: 'shared contract',
        expected: { mode: 'full' }, category: 'full', severity: 'exploratory', why: 'shared',
      }),
      '',
    ].join('\n'), 'utf8')
    const adapterPath = path.join(root, 'adapter.mjs')
    fs.writeFileSync(adapterPath, [
      "import fs from 'node:fs'",
      "const request = JSON.parse(fs.readFileSync(0, 'utf8'))",
      "process.stdout.write(request.phase === 'discovery' ? JSON.stringify({ activate: true }) : JSON.stringify({ mode: 'full' }))",
      '',
    ].join('\n'), 'utf8')
    const stdout = capture()
    const stderr = capture()
    const code = await main(['--cases', casesPath, '--adapter', adapterPath, '--format', 'json'], {
      cwd: repoRoot,
      stdout,
      stderr,
    })
    assert.equal(code, 0)
    assert.equal(stderr.value, '')
    const report = JSON.parse(stdout.value)
    assert.equal(report.summary.total, 2)
    assert.equal(report.summary.pass, 2)
    assert.equal(report.summary.criticalFailures.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
