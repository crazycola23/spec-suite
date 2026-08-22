import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { inspectRepository } from '../../src/adoption/inspect.mjs'
import { MODE } from '../../src/adoption/model.mjs'
import { recommendMode } from '../../src/adoption/recommend.mjs'
import { assessRepository, main } from '../../scripts/adopt.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-adopt-'))
}

function write(root, rel, content = '') {
  const target = path.join(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

function capture() {
  let value = ''
  return {
    write(chunk) { value += chunk },
    get value() { return value },
  }
}

function noFilesChanged(root, before) {
  assert.deepEqual(fs.readdirSync(root).sort(), before)
}

test('空仓库只报告可观察事实，不凭目录名字猜 full mode', () => {
  const root = tempRepo()
  try {
    const observed = inspectRepository(root)
    assert.equal(observed.fullAdoption, false)
    assert.equal(observed.lightweightState, false)
    assert.deepEqual(observed.agentAdapters, [])
    assert.deepEqual(observed.issues, [])
    assert.equal(observed.artifacts.canonicalAgentEntry.path, null)
    assert.equal(observed.artifacts.canonicalAgentEntry.declared, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('常见路径上的未声明 agent entry 只是候选，不会把半完成 adoption 洗成 full', () => {
  const root = tempRepo()
  try {
    write(root, 'spec-suite.config.json', JSON.stringify({ schemaVersion: 1 }))
    write(root, 'contracts/agent-entry.yaml', 'schemaVersion: 1\n')
    const observed = inspectRepository(root)
    assert.equal(observed.artifacts.canonicalAgentEntry.path, 'contracts/agent-entry.yaml')
    assert.equal(observed.artifacts.canonicalAgentEntry.declared, false)
    assert.equal(observed.fullAdoption, false)
    assert.ok(observed.issues.some((issue) => issue.code === 'canonical-agent-entry-not-declared'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('现有 config + canonical agent entry 才算可观察的 full adoption', () => {
  const root = tempRepo()
  try {
    write(root, 'spec-suite.config.json', JSON.stringify({
      schemaVersion: 1,
      dictionaries: ['contracts/dictionary.yaml'],
      agentEntry: { source: 'contracts/agent-entry.yaml' },
    }))
    write(root, 'contracts/agent-entry.yaml', 'schemaVersion: 1\n')
    write(root, 'contracts/dictionary.yaml', 'schemaVersion: 1\n')
    write(root, 'CLAUDE.md', '# adapter\n')
    const observed = inspectRepository(root)
    assert.equal(observed.fullAdoption, true)
    assert.equal(observed.lightweightState, false)
    assert.deepEqual(observed.agentAdapters, ['CLAUDE.md'])
    assert.deepEqual(observed.artifacts.dictionaries, {
      declared: ['contracts/dictionary.yaml'],
      present: ['contracts/dictionary.yaml'],
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('配置路径越界与坏 JSON 都是 inspection note，不会被当成 canonical 证据', () => {
  const root = tempRepo()
  try {
    write(root, 'spec-suite.config.json', '{ broken')
    let observed = inspectRepository(root)
    assert.equal(observed.fullAdoption, false)
    assert.ok(observed.issues.some((issue) => issue.code === 'config-not-parseable'))

    write(root, 'spec-suite.config.json', JSON.stringify({
      agentEntry: { source: '../outside.yaml' },
      dictionaries: ['../outside-dictionary.yaml'],
    }))
    observed = inspectRepository(root)
    assert.equal(observed.fullAdoption, false)
    assert.ok(observed.issues.some((issue) => issue.code === 'agentEntry.source-path-escapes-root'))
    assert.ok(observed.issues.some((issue) => issue.code === 'dictionaries-path-escapes-root'))

    write(root, 'spec-suite.config.json', JSON.stringify({ agentEntry: { source: '.' } }))
    observed = inspectRepository(root)
    assert.equal(observed.fullAdoption, false)
    assert.equal(observed.artifacts.canonicalAgentEntry.path, null)

    write(root, 'contracts/agent-entry.yaml', 'schemaVersion: 1\n')
    write(root, 'spec-suite.config.json', JSON.stringify({ agentEntry: { source: 'missing.yaml' } }))
    observed = inspectRepository(root)
    assert.equal(observed.fullAdoption, false, '显式缺失 source 不能 fallback 到 convention')
    assert.equal(observed.artifacts.canonicalAgentEntry.path, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('recommendation 的四种结果由显式答案决定，unknown 不会静默变成 no', () => {
  const none = { fullAdoption: false, lightweightState: false }
  assert.equal(recommendMode(none).mode, MODE.NEEDS_INPUT)
  assert.equal(recommendMode(none, {
    sharedContract: 'no', highRiskBoundary: 'no', explicitGovernance: 'no',
  }).mode, MODE.LIGHTWEIGHT)
  assert.equal(recommendMode(none, {
    sharedContract: 'yes', highRiskBoundary: 'no', explicitGovernance: 'no',
  }).mode, MODE.FULL)
  assert.equal(recommendMode({ ...none, lightweightState: true }, {
    sharedContract: 'no', highRiskBoundary: 'no', explicitGovernance: 'no',
  }).mode, MODE.NO_OP)
  assert.equal(recommendMode({ ...none, fullAdoption: true }).mode, MODE.NO_OP)
  assert.throws(
    () => recommendMode(none, { sharedContract: false }),
    /sharedContract 必须是 yes、no 或 unknown/,
  )
})

test('adopt JSON CLI 是只读的，并在没有回答时返回 needs-input', async () => {
  const root = tempRepo()
  try {
    write(root, 'AGENTS.md', '# existing adapter\n')
    const before = fs.readdirSync(root).sort()
    const stdout = capture()
    const stderr = capture()
    const code = await main(['--repo-root', '.', '--format', 'json', '--no-input'], {
      cwd: root,
      stdout,
      stderr,
      stdin: { isTTY: false },
      interactive: false,
    })
    assert.equal(code, 0)
    assert.equal(stderr.value, '')
    const result = JSON.parse(stdout.value)
    assert.equal(result.schemaVersion, 1)
    assert.equal(result.observed.fullAdoption, false)
    assert.equal(result.observed.agentAdapters[0], 'AGENTS.md')
    assert.equal(result.answers.sharedContract, 'unknown')
    assert.equal(result.recommendation.mode, MODE.NEEDS_INPUT)
    noFilesChanged(root, before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('adopt 在已有 full fixture 上返回 no-op', () => {
  const result = assessRepository(path.join(repoRoot, 'fixtures', 'v1'))
  assert.equal(result.observed.fullAdoption, true)
  assert.equal(result.recommendation.mode, MODE.NO_OP)
})

test('交互模式已能决策时不多问：full adoption 不提问，首个 yes 后停止', async () => {
  const fullRoot = path.join(repoRoot, 'fixtures', 'v1')
  const fullStdout = capture()
  const fullStderr = capture()
  const fullCode = await main([], {
    cwd: fullRoot,
    stdout: fullStdout,
    stderr: fullStderr,
    stdin: { isTTY: true },
    interactive: true,
  })
  assert.equal(fullCode, 0)
  assert.equal(fullStderr.value, '')
  assert.doesNotMatch(fullStdout.value, /请输入 yes、no 或 unknown/)
  assert.match(fullStdout.value, /NO-OP/)

  const root = tempRepo()
  try {
    const input = new PassThrough()
    input.end('yes\n')
    const stdout = capture()
    const stderr = capture()
    const code = await main([], {
      cwd: root,
      stdout,
      stderr,
      stdin: input,
      interactive: true,
    })
    assert.equal(code, 0)
    assert.equal(stderr.value, '')
    assert.match(stdout.value, /Recommendation[\s\S]*FULL/)
    assert.doesNotMatch(stdout.value, /未决工作是否控制 money/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
