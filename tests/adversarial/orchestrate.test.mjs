import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  integrateCompletedTasks,
  planTaskBatches,
} from '../../scripts/orchestrate.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-orchestrate-'))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'spec-suite@example.invalid'])
  git(root, ['config', 'user.name', 'spec-suite test'])
  fs.mkdirSync(path.join(root, 'src', 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'backend'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'frontend', 'index.js'), 'export const ui = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'backend', 'index.js'), 'export const api = 1\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'base'])
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

function task(base, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task:frontend',
    subject: 'agent:frontend-1',
    role: 'frontend-implementer',
    baseRevision: `git:${base}`,
    readSet: ['src/frontend/**'],
    writeSet: ['src/frontend/**'],
    ...overrides,
  }
}

function branchFromBase(root, base, branch, file, content) {
  git(root, ['switch', '-q', '-c', branch, base])
  const absolute = path.join(root, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  git(root, ['add', file])
  git(root, ['commit', '-q', '-m', branch])
  const head = git(root, ['rev-parse', branch])
  git(root, ['switch', '-q', 'main'])
  return head
}

test('orchestrator plans deterministic batches and preserves revalidation edges', () => {
  const base = 'a'.repeat(40)
  const frontend = task(base)
  const backend = task(base, {
    taskId: 'task:backend',
    subject: 'agent:backend-1',
    role: 'backend-implementer',
    readSet: ['src/backend/**'],
    writeSet: ['src/backend/**'],
  })
  const consumer = task(base, {
    taskId: 'task:consumer',
    subject: 'agent:consumer-1',
    role: 'consumer-implementer',
    readSet: ['src/frontend/**'],
    writeSet: ['src/backend/**'],
  })

  const plan = planTaskBatches([consumer, backend, frontend])
  assert.deepEqual(plan.batches, [
    ['task:backend', 'task:frontend'],
    ['task:consumer'],
  ])
  assert.deepEqual(plan.edges.map((edge) => edge.kind), ['write-write', 'revalidate-after-merge'])
  assert.equal(plan.planDigest.startsWith('sha256:'), true)
})

test('plan-only orchestration does not require completed Agent refs', () => {
  const { root, base } = makeRepo()
  try {
    const result = integrateCompletedTasks({
      repoRoot: root,
      tasks: [task(base)],
      targetRef: 'main',
    })
    assert.equal(result.status, 'planned')
    assert.deepEqual(result.batches, [['task:frontend']])
    assert.deepEqual(result.integrations, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('apply structurally revalidates disjoint completed branches without rewriting Agent refs', () => {
  const { root, base } = makeRepo()
  try {
    const frontendHead = branchFromBase(root, base, 'agent/frontend', 'src/frontend/button.js', 'export const button = 1\n')
    const backendHead = branchFromBase(root, base, 'agent/backend', 'src/backend/route.js', 'export const route = 1\n')
    const result = integrateCompletedTasks({
      repoRoot: root,
      tasks: [
        task(base, { headRef: frontendHead }),
        task(base, {
          taskId: 'task:backend',
          subject: 'agent:backend-1',
          role: 'backend-implementer',
          readSet: ['src/backend/**'],
          writeSet: ['src/backend/**'],
          headRef: backendHead,
        }),
      ],
      targetRef: 'main',
      apply: true,
      allowDeclaredDisjoint: true,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.integrations.length, 2)
    assert.deepEqual(result.blocked, [])
    const revalidated = result.integrations.find((entry) => entry.gate.status === 'revalidation-required')
    assert.ok(revalidated)
    assert.equal(revalidated.revalidation.status, 'passed')
    assert.equal(revalidated.revalidation.method, 'temporary-worktree-rebase')
    assert.equal(revalidated.revalidation.gate.status, 'ready')
    assert.equal(git(root, ['rev-parse', 'agent/frontend']), frontendHead)
    assert.equal(git(root, ['rev-parse', 'agent/backend']), backendHead)
    assert.equal(fs.existsSync(path.join(root, 'src', 'frontend', 'button.js')), true)
    assert.equal(fs.existsSync(path.join(root, 'src', 'backend', 'route.js')), true)
    assert.equal(git(root, ['status', '--porcelain']), '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('apply can opt out of automatic structural revalidation', () => {
  const { root, base } = makeRepo()
  try {
    const frontendHead = branchFromBase(root, base, 'agent/frontend', 'src/frontend/button.js', 'export const button = 1\n')
    const backendHead = branchFromBase(root, base, 'agent/backend', 'src/backend/route.js', 'export const route = 1\n')
    const result = integrateCompletedTasks({
      repoRoot: root,
      tasks: [
        task(base, { headRef: frontendHead }),
        task(base, {
          taskId: 'task:backend',
          subject: 'agent:backend-1',
          role: 'backend-implementer',
          readSet: ['src/backend/**'],
          writeSet: ['src/backend/**'],
          headRef: backendHead,
        }),
      ],
      targetRef: 'main',
      apply: true,
      autoRevalidate: false,
    })
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.blocked.map((entry) => entry.reason), ['revalidation-required'])
    assert.equal(fs.existsSync(path.join(root, 'src', 'frontend', 'button.js')), false)
    assert.equal(fs.existsSync(path.join(root, 'src', 'backend', 'route.js')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('automatic structural revalidation leaves same-file conflicts blocked', () => {
  const { root, base } = makeRepo()
  try {
    const frontendHead = branchFromBase(root, base, 'agent/frontend', 'src/frontend/index.js', 'export const ui = 2\n')
    git(root, ['switch', '-q', 'main'])
    fs.writeFileSync(path.join(root, 'src', 'frontend', 'index.js'), 'export const ui = 3\n')
    git(root, ['add', 'src/frontend/index.js'])
    git(root, ['commit', '-q', '-m', 'integrator change'])

    const result = integrateCompletedTasks({
      repoRoot: root,
      tasks: [task(base, { headRef: frontendHead })],
      targetRef: 'main',
      apply: true,
    })
    assert.equal(result.status, 'blocked')
    assert.deepEqual(result.blocked.map((entry) => entry.reason), ['write-conflict'])
    assert.equal(result.integrations[0].revalidation, undefined)
    assert.equal(fs.readFileSync(path.join(root, 'src', 'frontend', 'index.js'), 'utf8'), 'export const ui = 3\n')
    assert.equal(git(root, ['status', '--porcelain']), '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
