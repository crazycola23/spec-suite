#!/usr/bin/env node

/**
 * Git-aware, fail-closed merge gate for one Agent task.
 *
 * The gate deliberately does not merge, rebase, or rewrite a worktree.  It
 * answers one narrower question: is this result still based on the target
 * revision, and did it stay inside the task's declared write set?
 *
 * Exit codes:
 *   0 = safe fast-path merge
 *   2 = a valid result needs rebase/serialization or is out of scope
 *   1 = malformed invocation or unreadable repository/task
 */

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { MESSAGES_EN, parseFlagsOrThrow } from '../src/shared/argv.mjs'
import { writeFileAtomic } from '../src/shared/atomic-write.mjs'
import {
  jsonDigest,
  readJson,
  resolveInside,
  stableJson,
} from './control-plane-common.mjs'
import {
  findScopeViolations,
  validateTaskConcurrency,
} from './control-plane-concurrency.mjs'

const SPEC = {
  '--repo-root': { key: 'repoRoot' },
  '--task': { key: 'task' },
  '--target-ref': { key: 'targetRef' },
  '--head-ref': { key: 'headRef' },
  '--output': { key: 'output' },
  '--help': { key: 'help', flag: true },
}

const HELP = `Usage: node scripts/merge-gate.mjs [options]

  --repo-root <path>        git repository root (default: current directory)
  --task <relative path>    task JSON with baseRevision/readSet/writeSet
  --target-ref <ref>        integration target (default: HEAD)
  --head-ref <ref>          Agent result commit/ref (default: HEAD)
  --output <relative path>  optional result JSON inside repo-root

Exit 0 = safe fast-path merge; 2 = stale/conflicting/out-of-scope; 1 = invalid input.
`

function parseArgs(argv) {
  return parseFlagsOrThrow(argv, SPEC, MESSAGES_EN)
}

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

export function evaluateMergeGate({ repoRoot, task, targetRef = 'HEAD', headRef = 'HEAD' }) {
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

  let status = 'ready'
  if (scopeViolations.length > 0) status = 'out-of-scope'
  else if (collisions.length > 0) status = 'write-conflict'
  else if (target.id !== base.id) status = 'stale-base'

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
    collisions,
    scopeViolations,
    checks: {
      baseRevisionResolved: true,
      targetAtBase: target.id === base.id,
      headHasChanges: agentChangedFiles.length > 0,
      targetChangedFilesDisjoint: collisions.length === 0,
      writeSetCoversChanges: scopeViolations.length === 0,
      requiresRebase: target.id !== base.id,
    },
    status,
    safeToMerge: status === 'ready',
  }
  result.resultDigest = jsonDigest(result)
  return result
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(HELP)
      return 0
    }
    const repoRoot = path.resolve(options.repoRoot ?? '.')
    if (!options.task) throw new Error('missing --task')
    const task = readJson(resolveInside(repoRoot, options.task, '--task'), 'task')
    const result = evaluateMergeGate({
      repoRoot,
      task,
      targetRef: options.targetRef ?? 'HEAD',
      headRef: options.headRef ?? 'HEAD',
    })
    const bytes = `${stableJson(result, 2)}\n`
    if (options.output) {
      writeFileAtomic(resolveInside(repoRoot, options.output, '--output'), bytes, { mode: 0o600 })
    } else {
      process.stdout.write(bytes)
    }
    return result.safeToMerge ? 0 : 2
  } catch (error) {
    process.stderr.write(`merge gate failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) process.exit(main())
