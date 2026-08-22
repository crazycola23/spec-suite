/**
 * Small, fail-closed concurrency contract shared by the control-plane
 * projector and the merge gate.
 *
 * A task may opt into the contract by declaring:
 *   baseRevision: git:<hex revision>
 *   readSet:  [workspace-relative glob, ...]
 *   writeSet: [workspace-relative glob, ...]
 *   subject / role: optional identity metadata
 *
 * The old task shape remains valid.  Once one of the concurrency fields is
 * present, malformed declarations are errors rather than silently becoming an
 * empty scope.
 */

import path from 'node:path'

import { globToRegExp, matchesAny } from '../src/shared/glob.mjs'

const REVISION_RE = /^git:([0-9a-f]{7,64})$/i
const CONCURRENCY_KEYS = ['baseRevision', 'readSet', 'writeSet', 'subject', 'role']

export function hasConcurrencyDeclaration(task) {
  return Boolean(task && typeof task === 'object' && CONCURRENCY_KEYS.some((key) => (
    Object.prototype.hasOwnProperty.call(task, key)
  )))
}

export function canonicalGitRevision(value, label = 'baseRevision') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty git revision`)
  }
  if (value !== value.trim() || !REVISION_RE.test(value)) {
    throw new Error(`${label} must use the canonical git:<hex revision> form`)
  }
  return `git:${value.slice('git:'.length).toLowerCase()}`
}

function canonicalPathPattern(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must contain non-empty workspace-relative patterns`)
  }
  if (
    value !== value.trim()
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || value.endsWith('/')
  ) {
    throw new Error(`${label} contains a non-canonical workspace pattern: ${value}`)
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an ambiguous workspace pattern: ${value}`)
  }
  if (path.posix.normalize(value) !== value) {
    throw new Error(`${label} contains a non-canonical workspace pattern: ${value}`)
  }
  return value
}

export function canonicalPathSet(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const normalized = value.map((item) => canonicalPathPattern(item, label))
  const result = [...new Set(normalized)].sort()
  if (!allowEmpty && result.length === 0) throw new Error(`${label} must not be empty`)
  return result
}

export function validateTaskConcurrency(task, {
  requireBaseRevision = false,
  requireSets = false,
} = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task must be an object')
  }

  const declared = hasConcurrencyDeclaration(task)
  const hasReadSet = Object.prototype.hasOwnProperty.call(task, 'readSet')
  const hasWriteSet = Object.prototype.hasOwnProperty.call(task, 'writeSet')
  if (hasReadSet !== hasWriteSet) {
    throw new Error('task.readSet and task.writeSet must be declared together')
  }

  const baseRevision = task.baseRevision === undefined
    ? null
    : canonicalGitRevision(task.baseRevision, 'task.baseRevision')
  if (requireBaseRevision && baseRevision === null) {
    throw new Error('task.baseRevision is required for a merge gate')
  }

  const readSet = hasReadSet ? canonicalPathSet(task.readSet, 'task.readSet') : []
  const writeSet = hasWriteSet
    ? canonicalPathSet(task.writeSet, 'task.writeSet', { allowEmpty: false })
    : []
  if (requireSets && !hasReadSet) {
    throw new Error('task.readSet and task.writeSet are required for a merge gate')
  }

  const metadata = {}
  for (const key of ['subject', 'role']) {
    if (task[key] === undefined) {
      metadata[key] = null
    } else if (typeof task[key] !== 'string' || task[key].trim() === '' || task[key] !== task[key].trim()) {
      throw new Error(`task.${key} must be a non-empty string`)
    } else {
      metadata[key] = task[key]
    }
  }

  return {
    declared,
    hasReadWriteSet: hasReadSet,
    baseRevision,
    readSet,
    writeSet,
    ...metadata,
  }
}

/**
 * Return only the optional fields that should be carried by a new projection.
 * Keeping this conditional is important: the frozen V2 projection does not
 * gain null fields merely because this module exists.
 */
export function projectionConcurrencyFields(task) {
  if (!hasConcurrencyDeclaration(task)) return null
  const value = validateTaskConcurrency(task)
  return {
    baseRevision: value.baseRevision,
    readSet: value.readSet,
    role: value.role,
    subject: value.subject,
    writeSet: value.writeSet,
  }
}

function segmentMayOverlap(left, right) {
  const leftWild = /[*?]/.test(left)
  const rightWild = /[*?]/.test(right)
  if (!leftWild && !rightWild) return left === right
  if (!leftWild) return globToRegExp(right).test(left)
  if (!rightWild) return globToRegExp(left).test(right)
  // The segment language is deliberately conservative.  A false positive
  // serializes two tasks; a false negative can lose an update.
  return true
}

function allDoubleStars(segments, start) {
  return segments.slice(start).every((segment) => segment === '**')
}

/**
 * Conservative intersection for the small glob language used by read/write
 * sets.  It is exact for literal segments and for the `**` path operator; two
 * wildcard segments may report an overlap even when their character ranges
 * are disjoint.  That bias is intentional for a scheduler safety check.
 */
export function patternsMayOverlap(left, right) {
  const a = canonicalPathPattern(left, 'left pattern').split('/')
  const b = canonicalPathPattern(right, 'right pattern').split('/')
  const queue = [[0, 0]]
  const visited = new Set()
  while (queue.length > 0) {
    const [i, j] = queue.shift()
    const key = `${i}:${j}`
    if (visited.has(key)) continue
    visited.add(key)

    if (i === a.length) {
      if (j === b.length || allDoubleStars(b, j)) return true
      continue
    }
    if (j === b.length) {
      if (allDoubleStars(a, i)) return true
      continue
    }

    if (a[i] === '**') {
      queue.push([i + 1, j]) // `**` matches zero path segments.
      queue.push([i, j + 1]) // It consumes the segment matched by b[j].
      continue
    }
    if (b[j] === '**') {
      queue.push([i, j + 1])
      queue.push([i + 1, j])
      continue
    }
    if (segmentMayOverlap(a[i], b[j])) queue.push([i + 1, j + 1])
  }
  return false
}

export function writeSetCoversPath(file, writeSet) {
  if (typeof file !== 'string' || file.trim() === '') return false
  return matchesAny(file, writeSet)
}

export function readSetCoversPath(file, readSet) {
  if (typeof file !== 'string' || file.trim() === '') return false
  return matchesAny(file, readSet)
}

export function findScopeViolations(files, writeSet) {
  return [...new Set(files)]
    .filter((file) => !writeSetCoversPath(file, writeSet))
    .sort()
}

function pairOverlaps(leftSet, rightSet) {
  const overlaps = []
  for (const left of leftSet) {
    for (const right of rightSet) {
      if (patternsMayOverlap(left, right)) overlaps.push({ left, right })
    }
  }
  return overlaps.sort((a, b) => `${a.left}\0${a.right}`.localeCompare(`${b.left}\0${b.right}`))
}

/**
 * Compare two task declarations before scheduling them.
 *
 * `write-write` means serialize.  `write-read` / `read-write` may run in
 * parallel, but the reader must be revalidated after the writer merges.
 */
export function analyzeTaskPair(leftTask, rightTask) {
  const left = validateTaskConcurrency(leftTask, { requireSets: true })
  const right = validateTaskConcurrency(rightTask, { requireSets: true })
  const writeWrite = pairOverlaps(left.writeSet, right.writeSet)
  const writeRead = pairOverlaps(left.writeSet, right.readSet)
  const readWrite = pairOverlaps(left.readSet, right.writeSet)
  return {
    mayRunInParallel: writeWrite.length === 0,
    revalidateAfterMerge: writeRead.length > 0 || readWrite.length > 0,
    overlaps: {
      'read-write': readWrite,
      'write-read': writeRead,
      'write-write': writeWrite,
    },
  }
}

export function normalizeRevisionForComparison(value) {
  return canonicalGitRevision(value, 'revision')
}
