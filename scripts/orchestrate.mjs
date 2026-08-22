#!/usr/bin/env node

/**
 * Deterministic coordinator for completed Agent branches.
 *
 * This is intentionally an integration coordinator, not an Agent launcher:
 * the external harness owns identities, worktrees, and process lifecycles;
 * this script owns conflict planning, merge-gate decisions, and safe target
 * integration.
 *
 * Without --apply the command is read-only and emits a conflict DAG plus
 * deterministic execution batches. With --apply it requires a clean target
 * worktree, re-runs the gate before every merge, and structurally revalidates
 * stale-but-declared-disjoint results in a temporary worktree. Blocked results
 * are recorded and later independent tasks are still inspected.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { MESSAGES_EN, parseFlagsOrThrow } from '../src/shared/argv.mjs'
import { writeFileAtomic } from '../src/shared/atomic-write.mjs'
import {
  jsonDigest,
  resolveInside,
  stableJson,
} from './control-plane-common.mjs'
import {
  analyzeTaskPair,
  validateTaskConcurrency,
} from './control-plane-concurrency.mjs'
import { evaluateMergeGate } from './control-plane-merge.mjs'

const SPEC = {
  '--repo-root': { key: 'repoRoot' },
  '--tasks': { key: 'tasks' },
  '--target-ref': { key: 'targetRef' },
  '--output': { key: 'output' },
  '--apply': { key: 'apply', flag: true },
  '--allow-declared-disjoint': { key: 'allowDeclaredDisjoint', flag: true },
  '--no-auto-revalidate': { key: 'noAutoRevalidate', flag: true },
  '--help': { key: 'help', flag: true },
}

const HELP = `Usage: node scripts/orchestrate.mjs [options]

  --repo-root <path>              git repository root (default: current directory)
  --tasks <relative path>         JSON manifest with {"tasks": [...]} or a task array
  --target-ref <ref>              integration target (default: main)
  --output <relative path>        optional result JSON inside repo-root
  --apply                         merge completed task headRefs into target
  --allow-declared-disjoint       deprecated compatibility flag; never bypasses revalidation
  --no-auto-revalidate            leave revalidation-required results blocked
  --help                          show this help

Without --apply the command only plans. Exit 0 = plan/integration complete;
exit 2 = valid work is blocked; exit 1 = malformed input or repository state.
`

function parseArgs(argv) {
  return parseFlagsOrThrow(argv, SPEC, MESSAGES_EN)
}

function git(repoRoot, args, label) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    throw new Error(`${label}: ${detail}`)
  }
}

function resolveCommit(repoRoot, ref, label) {
  const value = ref.startsWith('git:') ? ref.slice('git:'.length) : ref
  const sha = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], label)
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`${label} did not resolve to a commit`)
  return `git:${sha.toLowerCase()}`
}

function revisionSha(revision) {
  return revision.startsWith('git:') ? revision.slice('git:'.length) : revision
}

function integrationLockPath(repoRoot) {
  const commonDirectory = git(
    repoRoot,
    ['rev-parse', '--git-common-dir'],
    'integration common directory',
  )
  const absoluteCommonDirectory = path.isAbsolute(commonDirectory)
    ? commonDirectory
    : path.resolve(repoRoot, commonDirectory)
  return path.join(absoluteCommonDirectory, 'spec-suite-orchestrate.lock')
}

/**
 * Serialize apply-mode coordinators for the repository's shared target.
 *
 * The lock lives under Git's common directory rather than in a worktree, so
 * linked worktrees and separate coordinator processes observe the same guard.
 * Existing locks are never guessed to be stale: a crashed process therefore
 * fails closed and leaves an explicit recovery point for an operator.
 */
function acquireIntegrationLock(repoRoot, targetRef) {
  const lockPath = integrationLockPath(repoRoot)
  const token = randomUUID()
  let fd = null
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600)
    fs.writeFileSync(fd, `${stableJson({
      schemaVersion: 1,
      type: 'spec-suite-orchestration-lock',
      pid: process.pid,
      targetRef,
      token,
      createdAt: new Date().toISOString(),
    }, 2)}\n`)
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* best effort */ }
      try { fs.unlinkSync(lockPath) } catch { /* best effort */ }
    }
    if (error.code === 'EEXIST') {
      throw new Error(`target integration lock is already held: ${lockPath}`)
    }
    throw new Error(`cannot acquire target integration lock: ${error.message}`)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try { fs.closeSync(fd) } catch { /* already closed */ }
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (current?.token !== token) {
        throw new Error('lock owner changed before release')
      }
      fs.unlinkSync(lockPath)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw new Error(`cannot release target integration lock: ${error.message}`)
    }
  }
}

function readManifest(repoRoot, candidate) {
  const file = resolveInside(repoRoot, candidate, '--tasks')
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`task manifest is unavailable or invalid JSON: ${error.message}`)
  }
  const tasks = Array.isArray(value) ? value : value?.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('task manifest must contain a non-empty tasks array')
  }
  return tasks
}

function normalizeTasks(tasks) {
  const seen = new Set()
  return tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`tasks[${index}] must be an object`)
    }
    if (typeof task.taskId !== 'string' || task.taskId.trim() === '') {
      throw new Error(`tasks[${index}].taskId must be non-empty`)
    }
    if (seen.has(task.taskId)) throw new Error(`duplicate taskId: ${task.taskId}`)
    seen.add(task.taskId)
    const concurrency = validateTaskConcurrency(task, { requireBaseRevision: true, requireSets: true })
    if (concurrency.subject === null) throw new Error(`${task.taskId} must declare subject for orchestration`)
    return { ...task, _concurrency: concurrency }
  }).sort((left, right) => left.taskId.localeCompare(right.taskId))
}

function pairKey(left, right) {
  return `${left.taskId}\0${right.taskId}`
}

/**
 * Build a deterministic conflict DAG and greedy batches. The only edges that
 * constrain a batch are write-write edges; read/write edges are retained as
 * revalidation obligations for the integration phase.
 */
export function planTaskBatches(inputTasks) {
  const tasks = normalizeTasks(inputTasks)
  const relations = new Map()
  const edges = []
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const left = tasks[i]
      const right = tasks[j]
      const relation = analyzeTaskPair(left, right)
      relations.set(pairKey(left, right), relation)
      if (relation.overlaps['write-write'].length > 0) {
        edges.push({
          from: left.taskId,
          to: right.taskId,
          kind: 'write-write',
          overlaps: relation.overlaps['write-write'],
        })
      } else if (relation.revalidateAfterMerge) {
        edges.push({
          from: left.taskId,
          to: right.taskId,
          kind: 'revalidate-after-merge',
          overlaps: {
            'read-write': relation.overlaps['read-write'],
            'write-read': relation.overlaps['write-read'],
          },
        })
      }
    }
  }

  const batches = []
  for (const task of tasks) {
    let placed = false
    for (const batch of batches) {
      const conflicts = batch.some((other) => {
        const left = tasks.indexOf(other) < tasks.indexOf(task) ? other : task
        const right = left === other ? task : other
        return relations.get(pairKey(left, right))?.mayRunInParallel === false
      })
      if (!conflicts) {
        batch.push(task)
        placed = true
        break
      }
    }
    if (!placed) batches.push([task])
  }

  const normalizedBatches = batches.map((batch) => batch.map((task) => task.taskId))
  const result = {
    schemaVersion: 1,
    type: 'multi-agent-execution-plan',
    tasks: tasks.map(({ _concurrency, ...task }) => task.taskId),
    edges,
    batches: normalizedBatches,
  }
  result.planDigest = jsonDigest(result)
  return result
}

function taskHeadRef(task) {
  const ref = task.headRef ?? task.resultRef
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error(`${task.taskId} must declare headRef (or resultRef) for integration`)
  }
  return ref
}

function assertApplyWorktree(repoRoot, targetRef) {
  const branch = git(repoRoot, ['branch', '--show-current'], 'target branch')
  if (branch !== targetRef) {
    throw new Error(`--apply requires the target branch checked out: expected ${targetRef}, found ${branch || 'detached HEAD'}`)
  }
  if (git(repoRoot, ['status', '--porcelain'], 'worktree status') !== '') {
    throw new Error('--apply requires a clean target worktree')
  }
}

function mergeHead(repoRoot, headRef) {
  try {
    git(repoRoot, ['merge', '--ff-only', revisionSha(headRef)], `fast-forward ${headRef}`)
  } catch (error) {
    try { git(repoRoot, ['merge', '--abort'], 'abort conflicted merge') } catch { /* no merge in progress */ }
    throw error
  }
}

/**
 * Replay an Agent's commit range onto the current target without touching the
 * Agent branch. The returned gate is evaluated against the new target
 * revision, so a successful result is a real fast-path candidate rather than
 * an exception for the original stale gate.
 *
 * This is intentionally structural revalidation first. It proves that the
 * commit range can be replayed and still satisfies writeSet. A caller-supplied
 * validator may add semantic checks, but neither path can prove an unobserved
 * read that the Agent omitted from readSet.
 */
function semanticValidationResult({ validator, validatorName, repoRoot, integrationRepoRoot, task, candidateTask, targetRevision, candidateHead }) {
  if (validator === null) {
    return {
      status: 'not-run',
      reason: 'no runtime read trace or caller-supplied semantic validation hook',
    }
  }

  const before = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'revalidation worktree status before validator')
  if (before !== '') throw new Error('revalidation worktree is dirty before semantic validation')

  let outcome
  try {
    outcome = validator({
      repoRoot,
      integrationRepoRoot,
      task: candidateTask,
      originalTask: task,
      targetRevision,
      candidateHead,
    })
  } catch (error) {
    return {
      status: 'failed',
      validator: validatorName,
      reason: `validator threw: ${error.message}`,
    }
  }
  if (outcome && typeof outcome.then === 'function') {
    return {
      status: 'failed',
      validator: validatorName,
      reason: 'validator must be synchronous',
    }
  }

  const after = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'revalidation worktree status after validator')
  if (after !== '') {
    return {
      status: 'failed',
      validator: validatorName,
      reason: 'validator modified the revalidation worktree',
    }
  }
  if (outcome && typeof outcome === 'object' && outcome.status === 'passed') {
    return { status: 'passed', validator: validatorName }
  }
  const reason = outcome && typeof outcome === 'object' && typeof outcome.reason === 'string'
    ? outcome.reason
    : 'validator did not return { status: "passed" }'
  return { status: 'failed', validator: validatorName, reason }
}

function structurallyRevalidateTask({
  repoRoot,
  task,
  targetRef,
  headRef,
  validator = null,
  validatorName = 'caller-supplied',
}) {
  const baseRevision = resolveCommit(repoRoot, task.baseRevision, 'task base revision')
  const targetRevision = resolveCommit(repoRoot, targetRef, 'current target ref')
  const temporaryWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-revalidate-'))
  let worktreeAdded = false
  try {
    git(repoRoot, ['worktree', 'add', '--detach', temporaryWorktree, revisionSha(headRef)], `create revalidation worktree for ${task.taskId}`)
    worktreeAdded = true
    git(temporaryWorktree, [
      '-c',
      'rebase.updateRefs=false',
      'rebase',
      '--no-update-refs',
      '--onto',
      revisionSha(targetRevision),
      revisionSha(baseRevision),
      'HEAD',
    ], `rebase ${task.taskId} onto current target`)
    const candidateHead = resolveCommit(temporaryWorktree, 'HEAD', 'rebased Agent head')
    const candidateTask = {
      ...task,
      baseRevision: targetRevision,
    }
    const gate = evaluateMergeGate({
      repoRoot,
      task: candidateTask,
      targetRef,
      headRef: candidateHead,
    })
    const semanticValidation = gate.safeToMerge
      ? semanticValidationResult({
        validator,
        validatorName,
        repoRoot: temporaryWorktree,
        integrationRepoRoot: repoRoot,
        task,
        candidateTask,
        targetRevision,
        candidateHead,
      })
      : {
        status: 'not-run',
        reason: 'structural merge gate failed before semantic validation',
      }
    return {
      status: gate.safeToMerge && semanticValidation.status !== 'failed' ? 'passed' : 'failed',
      method: 'temporary-worktree-rebase',
      originalBaseRevision: baseRevision,
      targetRevision,
      candidateHead,
      gate,
      semanticValidation,
    }
  } finally {
    if (worktreeAdded) {
      try {
        git(repoRoot, ['worktree', 'remove', '--force', temporaryWorktree], 'remove revalidation worktree')
      } catch {
        // The final fs cleanup below is limited to the unique temp directory.
      }
    }
    fs.rmSync(temporaryWorktree, { recursive: true, force: true })
  }
}

export function integrateCompletedTasks({
  repoRoot,
  tasks: inputTasks,
  targetRef = 'main',
  allowDeclaredDisjoint = false,
  autoRevalidate = true,
  validateRevalidation = null,
  validatorName = 'caller-supplied',
  apply = false,
} = {}) {
  if (validateRevalidation !== null && typeof validateRevalidation !== 'function') {
    throw new Error('validateRevalidation must be a function or null')
  }
  if (typeof validatorName !== 'string' || validatorName.trim() === '' || validatorName !== validatorName.trim()) {
    throw new Error('validatorName must be a non-empty trimmed string')
  }
  const tasks = normalizeTasks(inputTasks)
  const plan = planTaskBatches(tasks)
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const result = {
    ...plan,
    targetRef,
    apply,
    allowDeclaredDisjoint,
    autoRevalidate,
    semanticValidator: validateRevalidation === null ? null : validatorName,
    initialTargetRevision: resolveCommit(repoRoot, targetRef, 'target ref'),
    integrations: [],
    blocked: [],
  }

  // A scheduler can be used before Agents have been launched. In that mode a
  // manifest may contain only task contracts; headRef is required only for
  // gate evaluation and integration of completed work.
  if (!apply && tasks.some((task) => task.headRef === undefined && task.resultRef === undefined)) {
    result.finalTargetRevision = result.initialTargetRevision
    result.status = 'planned'
    result.resultDigest = jsonDigest(result)
    return result
  }

  let releaseLock = null
  try {
    if (apply) {
      releaseLock = acquireIntegrationLock(repoRoot, targetRef)
      assertApplyWorktree(repoRoot, targetRef)
    }

    for (const batch of plan.batches) {
      for (const taskId of batch) {
        const task = byId.get(taskId)
        const headRef = taskHeadRef(task)
        const gate = evaluateMergeGate({
          repoRoot,
          task,
          targetRef,
          headRef,
          allowValidatedDisjoint: allowDeclaredDisjoint,
        })
        const entry = { taskId, headRef, gate }
        if (!gate.safeToMerge) {
          const canAutoRevalidate = apply && autoRevalidate && (
            gate.status === 'revalidation-required'
            || (
              gate.status === 'stale-base'
              && gate.collisions.length === 0
              && validateRevalidation !== null
            )
          )
          if (canAutoRevalidate) {
            try {
              const revalidation = structurallyRevalidateTask({
                repoRoot,
                task,
                targetRef,
                headRef,
                validator: validateRevalidation,
                validatorName,
              })
              entry.revalidation = revalidation
              if (revalidation.status === 'passed' && revalidation.gate.safeToMerge) {
                mergeHead(repoRoot, revalidation.candidateHead)
                entry.targetRevisionAfterMerge = resolveCommit(repoRoot, targetRef, 'target after revalidation merge')
                result.integrations.push(entry)
                continue
              }
              result.blocked.push({
                taskId,
                reason: revalidation.semanticValidation.status === 'failed'
                  ? 'semantic-validation-failed'
                  : 'revalidation-failed',
                requiresRebase: revalidation.gate.checks.requiresRebase,
                requiresRevalidation: revalidation.gate.checks.requiresRevalidation,
                requiresSemanticValidation: revalidation.semanticValidation.status === 'failed',
              })
              result.integrations.push(entry)
              continue
            } catch (error) {
              entry.revalidation = {
                status: 'failed',
                method: 'temporary-worktree-rebase',
                error: error.message,
                semanticValidation: {
                  status: 'not-run',
                  reason: 'structural replay failed before semantic validation',
                },
              }
              result.blocked.push({
                taskId,
                reason: 'revalidation-failed',
                requiresRebase: true,
                requiresRevalidation: true,
              })
              result.integrations.push(entry)
              continue
            }
          }
          result.blocked.push({
            taskId,
            reason: gate.status,
            requiresRebase: gate.checks.requiresRebase,
            requiresRevalidation: gate.checks.requiresRevalidation,
          })
          result.integrations.push(entry)
          continue
        }
        if (apply) {
          mergeHead(repoRoot, headRef)
          entry.targetRevisionAfterMerge = resolveCommit(repoRoot, targetRef, 'target after merge')
        }
        result.integrations.push(entry)
      }
    }

    result.finalTargetRevision = resolveCommit(repoRoot, targetRef, 'final target ref')
    result.status = result.blocked.length === 0 ? 'completed' : 'blocked'
    result.resultDigest = jsonDigest(result)
    return result
  } finally {
    if (releaseLock !== null) releaseLock()
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(HELP)
      return 0
    }
    const repoRoot = path.resolve(options.repoRoot ?? '.')
    if (!options.tasks) throw new Error('missing --tasks')
    const tasks = readManifest(repoRoot, options.tasks)
    const result = integrateCompletedTasks({
      repoRoot,
      tasks,
      targetRef: options.targetRef ?? 'main',
      allowDeclaredDisjoint: options.allowDeclaredDisjoint === true,
      autoRevalidate: options.noAutoRevalidate !== true,
      apply: options.apply === true,
    })
    const bytes = `${stableJson(result, 2)}\n`
    if (options.output) writeFileAtomic(resolveInside(repoRoot, options.output, '--output'), bytes, { mode: 0o600 })
    else process.stdout.write(bytes)
    return result.status === 'completed' ? 0 : 2
  } catch (error) {
    process.stderr.write(`orchestrator failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) process.exit(main())
