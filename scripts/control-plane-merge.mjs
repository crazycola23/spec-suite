/**
 * Pure Git inspection used by both the merge-gate CLI and the orchestrator.
 * The module does not merge, rebase, or write the repository.
 */

import { execFileSync } from 'node:child_process'

import { jsonDigest } from './control-plane-common.mjs'
import {
  findScopeViolations,
  readSetCoversPath,
  writeSetCoversPath,
  validateTaskConcurrency,
} from './control-plane-concurrency.mjs'

function git(repoRoot, args, label) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    throw new Error(`${label}: ${detail}`)
  }
}

function resolveCommit(repoRoot, ref, label) {
  const value = ref.startsWith('git:') ? ref.slice('git:'.length) : ref
  if (value.trim() === '') throw new Error(`${label} must be non-empty`)
  const sha = git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], label).trim()
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`${label} did not resolve to a commit`)
  return { ref, id: `git:${sha.toLowerCase()}`, sha: sha.toLowerCase() }
}

function changedFiles(repoRoot, baseSha, headSha, label) {
  if (baseSha === headSha) return []
  const output = git(repoRoot, [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACDMRTUXB',
    `${baseSha}..${headSha}`,
  ], label)
  return [...new Set(output.split('\0').filter(Boolean))].sort()
}

function intersection(left, right) {
  const values = new Set(right)
  return [...new Set(left)].filter((value) => values.has(value)).sort()
}

export function evaluateMergeGate({
  repoRoot,
  task,
  targetRef = 'HEAD',
  headRef = 'HEAD',
  allowValidatedDisjoint = false,
}) {
  const concurrency = validateTaskConcurrency(task, {
    requireBaseRevision: true,
    requireSets: true,
  })
  if (typeof task.taskId !== 'string' || task.taskId.trim() === '') {
    throw new Error('task.taskId must be non-empty')
  }

  const base = resolveCommit(repoRoot, concurrency.baseRevision, 'task.baseRevision')
  const target = resolveCommit(repoRoot, targetRef, 'target ref')
  const head = resolveCommit(repoRoot, headRef, 'head ref')
  const agentChangedFiles = changedFiles(repoRoot, base.sha, head.sha, 'Agent diff')
  const targetChangedFiles = changedFiles(repoRoot, base.sha, target.sha, 'target diff')
  const collisions = intersection(agentChangedFiles, targetChangedFiles)
  const scopeViolations = findScopeViolations(agentChangedFiles, concurrency.writeSet)
  const targetReadSetOverlaps = targetChangedFiles.filter((file) => readSetCoversPath(file, concurrency.readSet))
  const targetWriteSetOverlaps = targetChangedFiles.filter((file) => writeSetCoversPath(file, concurrency.writeSet))

  let status = 'ready'
  if (scopeViolations.length > 0) status = 'out-of-scope'
  else if (collisions.length > 0) status = 'write-conflict'
  else if (target.id !== base.id) {
    const disjoint = targetReadSetOverlaps.length === 0 && targetWriteSetOverlaps.length === 0
    status = allowValidatedDisjoint && disjoint ? 'validated-disjoint' : 'stale-base'
  }

  const result = {
    schemaVersion: 1,
    type: 'merge-gate-result',
    taskId: task.taskId,
    subject: concurrency.subject,
    role: concurrency.role,
    baseRevision: base.id,
    targetRevision: target.id,
    headRevision: head.id,
    targetRef,
    headRef,
    readSet: concurrency.readSet,
    writeSet: concurrency.writeSet,
    changedFiles: agentChangedFiles,
    targetChangedFiles,
    targetReadSetOverlaps,
    targetWriteSetOverlaps,
    collisions,
    scopeViolations,
    checks: {
      baseRevisionResolved: true,
      targetAtBase: target.id === base.id,
      headHasChanges: agentChangedFiles.length > 0,
      targetChangedFilesDisjoint: collisions.length === 0,
      targetDisjointFromDeclaredSets: targetReadSetOverlaps.length === 0 && targetWriteSetOverlaps.length === 0,
      writeSetCoversChanges: scopeViolations.length === 0,
      requiresRebase: target.id !== base.id && status !== 'validated-disjoint',
      requiresRevalidation: status === 'validated-disjoint',
    },
    status,
    safeToMerge: status === 'ready' || status === 'validated-disjoint',
  }
  result.resultDigest = jsonDigest(result)
  return result
}
