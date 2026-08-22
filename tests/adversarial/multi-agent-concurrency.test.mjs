import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  analyzeTaskPair,
  patternsMayOverlap,
  validateTaskConcurrency,
} from '../../scripts/control-plane-concurrency.mjs'
import { evaluateMergeGate } from '../../scripts/merge-gate.mjs'
import { projectContext } from '../../scripts/project-context.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const mergeGatePath = path.join(repoRoot, 'scripts', 'merge-gate.mjs')

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-concurrency-'))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'spec-suite@example.invalid'])
  git(root, ['config', 'user.name', 'spec-suite test'])
  fs.mkdirSync(path.join(root, 'src', 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'backend'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'frontend', 'index.js'), 'export const ui = 1\n')
  fs.writeFileSync(path.join(root, 'src', 'backend', 'index.js'), 'export const api = 1\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'base'])
  const base = git(root, ['rev-parse', 'HEAD'])
  return { root, base }
}

function commitFile(root, relative, content, message) {
  const absolute = path.join(root, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  git(root, ['add', relative])
  git(root, ['commit', '-q', '-m', message])
}

function task(base, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task:frontend',
    subject: 'agent:frontend-1',
    role: 'frontend-implementer',
    baseRevision: `git:${base}`,
    readSet: ['src/**'],
    writeSet: ['src/frontend/**'],
    ...overrides,
  }
}

test('concurrency declaration is strict and canonical', () => {
  const valid = validateTaskConcurrency(task('a'.repeat(40)))
  assert.equal(valid.baseRevision, `git:${'a'.repeat(40)}`)
  assert.deepEqual(valid.writeSet, ['src/frontend/**'])
  assert.throws(
    () => validateTaskConcurrency({ taskId: 'task:broken', readSet: ['src/**'] }),
    /readSet and task\.writeSet must be declared together/,
  )
  assert.throws(
    () => validateTaskConcurrency(task('a'.repeat(40), { writeSet: ['../secrets/**'] })),
    /ambiguous workspace pattern|non-canonical workspace pattern/,
  )
  assert.throws(
    () => validateTaskConcurrency(task('not-a-revision')),
    /canonical git/,
  )
})

test('write-set overlap is conservative, while disjoint top-level roots stay parallel', () => {
  assert.equal(patternsMayOverlap('src/frontend/**', 'src/backend/**'), false)
  assert.equal(patternsMayOverlap('src/frontend/**', 'src/**'), true)
  assert.equal(patternsMayOverlap('src/frontend/**', 'src/frontend/components/**'), true)
  assert.equal(patternsMayOverlap('src/a.js', 'src/b.js'), false)
  assert.equal(patternsMayOverlap('src/foo**bar', 'src/foo/x/bar'), true)

  const relation = analyzeTaskPair(
    task('a'.repeat(40)),
    task('b'.repeat(40), {
      taskId: 'task:backend',
      subject: 'agent:backend-1',
      role: 'backend-implementer',
      readSet: ['src/frontend/**'],
      writeSet: ['src/backend/**'],
    }),
  )
  assert.equal(relation.mayRunInParallel, true)
  assert.equal(relation.revalidateAfterMerge, true)
  assert.deepEqual(relation.overlaps['write-write'], [])
})

test('a new concurrency declaration is carried into projection without changing legacy projection shape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-projection-'))
  try {
    fs.cpSync(path.join(repoRoot, 'control-plane'), path.join(root, 'control-plane'), { recursive: true })
    const taskPath = path.join(root, 'control-plane', 'example', 'task.json')
    const legacyProjection = projectContext({
      specsRoot: root,
      graph: 'control-plane/example/context-graph.json',
      task: 'control-plane/example/task.json',
      state: 'control-plane/example/canonical-state.json',
      policy: 'control-plane/example/issuer-policy.json',
    })
    assert.equal(Object.hasOwn(legacyProjection, 'baseRevision'), false)
    const taskDocument = JSON.parse(fs.readFileSync(taskPath, 'utf8'))
    Object.assign(taskDocument, {
      baseRevision: `git:${'c'.repeat(40)}`,
      readSet: ['src/**'],
      role: 'frontend-implementer',
      subject: 'agent:frontend-1',
      writeSet: ['src/frontend/**'],
    })
    fs.writeFileSync(taskPath, `${JSON.stringify(taskDocument, null, 2)}\n`)
    const projection = projectContext({
      specsRoot: root,
      graph: 'control-plane/example/context-graph.json',
      task: 'control-plane/example/task.json',
      state: 'control-plane/example/canonical-state.json',
      policy: 'control-plane/example/issuer-policy.json',
    })
    assert.equal(projection.baseRevision, `git:${'c'.repeat(40)}`)
    assert.deepEqual(projection.readSet, ['src/**'])
    assert.deepEqual(projection.writeSet, ['src/frontend/**'])
    assert.equal(projection.subject, 'agent:frontend-1')
    assert.equal(projection.role, 'frontend-implementer')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate accepts an unchanged target and a result inside its write set', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-frontend'])
    commitFile(root, 'src/frontend/button.js', 'export const button = 1\n', 'frontend change')
    const result = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'agent-frontend',
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.safeToMerge, true)
    assert.deepEqual(result.changedFiles, ['src/frontend/button.js'])
    assert.equal(result.resultDigest.startsWith('sha256:'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate refuses stale targets and reports actual write collisions', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-frontend'])
    commitFile(root, 'src/frontend/button.js', 'export const button = 1\n', 'frontend change')
    git(root, ['switch', '-q', 'main'])
    commitFile(root, 'src/frontend/button.js', 'export const button = 2\n', 'integrator change')
    const result = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'agent-frontend',
    })
    assert.equal(result.status, 'write-conflict')
    assert.equal(result.safeToMerge, false)
    assert.deepEqual(result.collisions, ['src/frontend/button.js'])
    assert.equal(result.checks.requiresRebase, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate does not silently accept a stale but disjoint target', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-frontend'])
    commitFile(root, 'src/frontend/button.js', 'export const button = 1\n', 'frontend change')
    git(root, ['switch', '-q', 'main'])
    commitFile(root, 'README.md', '# integrator note\n', 'unrelated integration change')
    const result = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'agent-frontend',
    })
    assert.equal(result.status, 'revalidation-required')
    assert.deepEqual(result.collisions, [])
    assert.equal(result.safeToMerge, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate never treats declared disjointness as completed revalidation', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-frontend'])
    commitFile(root, 'src/frontend/button.js', 'export const button = 1\n', 'frontend change')
    git(root, ['switch', '-q', 'main'])
    commitFile(root, 'README.md', '# integrator note\n', 'unrelated integration change')
    const result = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'agent-frontend',
      allowValidatedDisjoint: true,
    })
    assert.equal(result.status, 'revalidation-required')
    assert.equal(result.safeToMerge, false)
    assert.equal(result.checks.requiresRevalidation, true)
    assert.equal(result.checks.requiresRebase, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate rejects refs whose history does not descend from the task base', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-frontend'])
    commitFile(root, 'src/frontend/button.js', 'export const button = 1\n', 'frontend change')
    git(root, ['switch', '-q', '--orphan', 'unrelated-target'])
    for (const entry of fs.readdirSync(root)) {
      if (entry !== '.git') fs.rmSync(path.join(root, entry), { recursive: true, force: true })
    }
    fs.writeFileSync(path.join(root, 'README.md'), '# unrelated target\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'unrelated target'])

    const invalidTarget = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'unrelated-target',
      headRef: 'agent-frontend',
    })
    assert.equal(invalidTarget.status, 'invalid-ancestry')
    assert.equal(invalidTarget.safeToMerge, false)
    assert.equal(invalidTarget.checks.baseIsAncestorOfTarget, false)
    assert.equal(invalidTarget.checks.baseIsAncestorOfHead, true)

    git(root, ['switch', '-q', '--orphan', 'unrelated-head'])
    for (const entry of fs.readdirSync(root)) {
      if (entry !== '.git') fs.rmSync(path.join(root, entry), { recursive: true, force: true })
    }
    fs.writeFileSync(path.join(root, 'README.md'), '# unrelated head\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'unrelated head'])

    const invalidHead = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'unrelated-head',
    })
    assert.equal(invalidHead.status, 'invalid-ancestry')
    assert.equal(invalidHead.safeToMerge, false)
    assert.equal(invalidHead.checks.baseIsAncestorOfTarget, true)
    assert.equal(invalidHead.checks.baseIsAncestorOfHead, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate refuses a result that writes outside its declared scope', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-frontend'])
    commitFile(root, 'README.md', '# changed by the wrong agent\n', 'out of scope')
    const taskFile = path.join(root, 'task.json')
    fs.writeFileSync(taskFile, `${JSON.stringify(task(base), null, 2)}\n`)
    const run = spawnSync(process.execPath, [
      mergeGatePath,
      '--repo-root', root,
      '--task', 'task.json',
      '--target-ref', 'main',
      '--head-ref', 'agent-frontend',
      '--output', 'gate-result.json',
    ], { encoding: 'utf8' })
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`)
    const result = JSON.parse(fs.readFileSync(path.join(root, 'gate-result.json'), 'utf8'))
    assert.equal(result.status, 'out-of-scope')
    assert.deepEqual(result.scopeViolations, ['README.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate checks the complete Agent history, not only the final tree', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-history'])
    commitFile(root, 'README.md', '# transient forbidden content\n', 'transient forbidden write')
    commitFile(root, 'README.md', '# test\n', 'remove transient forbidden write')
    commitFile(root, 'src/frontend/button.js', 'export const button = 1\n', 'allowed final change')

    const result = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'agent-history',
    })
    assert.equal(result.status, 'out-of-scope')
    assert.deepEqual(result.changedFiles, ['src/frontend/button.js'])
    assert.deepEqual(result.historyChangedFiles, ['README.md', 'src/frontend/button.js'])
    assert.deepEqual(result.scopeViolations, ['README.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate treats both sides of an out-of-scope rename as touched history', () => {
  const { root, base } = makeRepo()
  try {
    git(root, ['switch', '-q', '-c', 'agent-rename'])
    git(root, ['mv', 'README.md', 'src/frontend/renamed.md'])
    git(root, ['commit', '-q', '-m', 'rename out of scope file'])

    const result = evaluateMergeGate({
      repoRoot: root,
      task: task(base),
      targetRef: 'main',
      headRef: 'agent-rename',
    })
    assert.equal(result.status, 'out-of-scope')
    assert.deepEqual(result.historyChangedFiles, ['README.md', 'src/frontend/renamed.md'])
    assert.deepEqual(result.scopeViolations, ['README.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('merge gate fails closed when the task has no concurrency contract', () => {
  const { root, base } = makeRepo()
  try {
    assert.throws(
      () => evaluateMergeGate({
        repoRoot: root,
        task: { schemaVersion: 1, taskId: 'task:legacy' },
        targetRef: 'main',
        headRef: 'main',
      }),
      /baseRevision is required|readSet and task\.writeSet are required/,
    )
    assert.ok(base)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
