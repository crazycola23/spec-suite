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
import { pathToFileURL } from 'node:url'

import { MESSAGES_EN, parseFlagsOrThrow } from '../src/shared/argv.mjs'
import { writeFileAtomic } from '../src/shared/atomic-write.mjs'
import {
  readJson,
  resolveInside,
  stableJson,
} from './control-plane-common.mjs'
import { evaluateMergeGate } from './control-plane-merge.mjs'

export { evaluateMergeGate }

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
