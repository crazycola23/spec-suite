/**
 * Pure Git inspection used by both the merge-gate CLI and the orchestrator.
 * The module does not merge, rebase, or write the repository.
 */

import { execFileSync, spawnSync } from 'node:child_process'

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

function isAncestor(repoRoot, ancestorSha, descendantSha, label) {
  const result = spawnSync('git', [
    '-C',
    repoRoot,
    'merge-base',
    '--is-ancestor',
    ancestorSha,
    descendantSha,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status === 0) return true
  if (result.status === 1) return false
  const detail = result.stderr?.trim() || `git exited with status ${result.status}`
  throw new Error(`${label}: ${detail}`)
}

function changedFiles(repoRoot, baseSha, headSha, label) {
  if (baseSha === headSha) return []
  const output = git(repoRoot, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--diff-filter=ACDMRTUXB',
    `${baseSha}..${headSha}`,
  ], label)
  return [...new Set(output.split('\0').filter(Boolean))].sort()
}

/**
 * Return every path touched by every commit in base..head.
 *
 * The ordinary base..head diff is a final-tree comparison.  That is useful
 * for merge conflicts, but it lets a branch briefly add a forbidden file and
 * delete it before the final commit.  Scope is a capability over the whole
 * submitted history, so the gate also inspects each reachable commit with
 * rename detection disabled; a rename is therefore checked as both a delete
 * and an add.
 */
function historyChangedFiles(repoRoot, baseSha, headSha, label) {
  if (baseSha === headSha) return []
  const commits = git(repoRoot, [
    'rev-list',
    '--topo-order',
    '--reverse',
    `${baseSha}..${headSha}`,
  ], `${label} commit range`).trim().split(/\s+/).filter(Boolean)
  const files = []
  for (const commit of commits) {
    const output = git(repoRoot, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      '--no-renames',
      '-z',
      '--diff-filter=ACDMRTUXB',
      commit,
    ], `${label} commit ${commit}`)
    files.push(...output.split('\0').filter(Boolean))
  }
  return [...new Set(files)].sort()
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
  const baseIsAncestorOfTarget = isAncestor(
    repoRoot,
    base.sha,
    target.sha,
    'baseRevision is not an ancestor of target ref',
  )
  const baseIsAncestorOfHead = isAncestor(
    repoRoot,
    base.sha,
    head.sha,
    'baseRevision is not an ancestor of head ref',
  )
  const agentChangedFiles = changedFiles(repoRoot, base.sha, head.sha, 'Agent diff')
  const agentHistoryChangedFiles = historyChangedFiles(repoRoot, base.sha, head.sha, 'Agent history')
  const targetChangedFiles = changedFiles(repoRoot, base.sha, target.sha, 'target diff')
  const collisions = intersection(agentChangedFiles, targetChangedFiles)
  const scopeViolations = findScopeViolations(agentHistoryChangedFiles, concurrency.writeSet)
  const targetReadSetOverlaps = targetChangedFiles.filter((file) => readSetCoversPath(file, concurrency.readSet))
  const targetWriteSetOverlaps = targetChangedFiles.filter((file) => writeSetCoversPath(file, concurrency.writeSet))

  let status = 'ready'
  if (!baseIsAncestorOfTarget || !baseIsAncestorOfHead) status = 'invalid-ancestry'
  else if (scopeViolations.length > 0) status = 'out-of-scope'
  else if (collisions.length > 0) status = 'write-conflict'
  else if (target.id !== base.id) {
    const disjoint = targetReadSetOverlaps.length === 0 && targetWriteSetOverlaps.length === 0
    status = disjoint ? 'revalidation-required' : 'stale-base'
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
    historyChangedFiles: agentHistoryChangedFiles,
    targetChangedFiles,
    targetReadSetOverlaps,
    targetWriteSetOverlaps,
    collisions,
    scopeViolations,
    checks: {
      baseRevisionResolved: true,
      baseIsAncestorOfTarget,
      baseIsAncestorOfHead,
      ancestryValid: baseIsAncestorOfTarget && baseIsAncestorOfHead,
      targetAtBase: target.id === base.id,
      headHasChanges: agentChangedFiles.length > 0,
      targetChangedFilesDisjoint: collisions.length === 0,
      targetDisjointFromDeclaredSets: targetReadSetOverlaps.length === 0 && targetWriteSetOverlaps.length === 0,
      writeSetCoversChanges: scopeViolations.length === 0,
      requiresRebase: status === 'stale-base' || status === 'write-conflict',
      requiresRevalidation: status === 'revalidation-required',
    },
    status,
    safeToMerge: status === 'ready',
  }
  result.resultDigest = jsonDigest(result)
  return result
}
