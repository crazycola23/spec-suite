import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { assertSchemaVersion as assertSchemaVersionPolicy } from '../src/shared/schema-version.mjs'

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (!value || typeof value !== 'object') throw new Error(`value is not JSON-serializable: ${typeof value}`)
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  )
}

export function stableJson(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space)
}

export function jsonDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`
}

export function contentDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

export function computeCanonicalRevision(root, inputs) {
  const paths = stringSet(inputs, 'canonical inputs', { allowEmpty: false })
  const manifest = paths.map((candidate) => {
    const absolute = resolveInside(root, candidate, 'canonical input')
    return {
      path: toPosix(path.relative(root, absolute)),
      sha256: contentDigest(fs.readFileSync(absolute)),
    }
  })
  return jsonDigest({ inputs: manifest })
}

export function readJson(file, label = file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain one JSON object`)
  }
  return parsed
}

export function resolveInside(root, candidate, label = 'path') {
  if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error(`${label} must be a non-empty path`)
  const absolute = path.resolve(root, candidate)
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the configured root: ${candidate}`)
  }
  return absolute
}

export function toPosix(value) {
  return value.split(path.sep).join('/')
}

export function stringSet(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const strings = value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`${label} must contain non-empty strings`)
    return item
  })
  const result = [...new Set(strings)].sort()
  if (!allowEmpty && result.length === 0) throw new Error(`${label} must not be empty`)
  return result
}

export function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((item, index) => item === b[index])
}

// 保留这个签名：control plane 的四个调用方按 (document, label) 调用它。
// 判定本身已经上移到中立层的策略表 —— V1 与 V2 现在共用同一个判定点，
// 但各自保留原有的错误语义（V1 收进 collector，V2 抛异常）。
export function assertSchemaVersion(document, label) {
  assertSchemaVersionPolicy('control-plane-document', document, { label })
}

export function canonicalEffectReference(effect, label = 'effect') {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) throw new Error(`${label} must be an object`)
  for (const key of ['kind', 'resource']) {
    if (typeof effect[key] !== 'string' || effect[key].trim() === '') throw new Error(`${label}.${key} must be a non-empty string`)
  }
  return { kind: effect.kind, resource: effect.resource }
}

export function canonicalAuthorizedEffect(effect, label = 'effect') {
  const reference = canonicalEffectReference(effect, label)
  if (typeof effect.permission !== 'string' || effect.permission.trim() === '') {
    throw new Error(`${label}.permission must be a non-empty string`)
  }
  return { ...reference, permission: effect.permission }
}

export function effectReferenceKey(effect) {
  const value = canonicalEffectReference(effect)
  return `${value.kind}\u0000${value.resource}`
}

export function authorizedEffectKey(effect) {
  const value = canonicalAuthorizedEffect(effect)
  return `${value.kind}\u0000${value.resource}\u0000${value.permission}`
}

export function parseInstant(value, label) {
  const milliseconds = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid instant`)
  return milliseconds
}

export function strictObject(value, label, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key)).sort()
  if (unexpected.length > 0) throw new Error(`${label} contains forbidden fields: ${unexpected.join(', ')}`)
  return value
}

export function denialCause({
  type,
  constraint,
  blockingRecord,
  authorityState,
  authoritativeSource = null,
  unresolvedSource = null,
  detail = null,
}) {
  for (const [key, value] of Object.entries({ type, constraint, blockingRecord, authorityState })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`denial cause ${key} must be non-empty`)
  }
  for (const [key, value] of Object.entries({ authoritativeSource, unresolvedSource, detail })) {
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      throw new Error(`denial cause ${key} must be null or non-empty`)
    }
  }
  return {
    type,
    constraint,
    blockingRecord,
    authorityState,
    authoritativeSource,
    unresolvedSource,
    detail,
  }
}

export class ControlPlaneDenial extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'ControlPlaneDenial'
    this.denialCause = cause
  }
}

export function loadAuthorityRecords(specsRoot, state) {
  if (typeof state.authorityRecords !== 'string' || state.authorityRecords.trim() === '') {
    throw new Error('canonical authority records are unavailable')
  }
  const records = readJson(resolveInside(specsRoot, state.authorityRecords, 'authority records path'), 'authority records')
  assertSchemaVersion(records, 'authority records')
  if (!Array.isArray(records.gaps)) throw new Error('authority records gaps are unavailable')
  const seen = new Set()
  for (const [index, gap] of records.gaps.entries()) {
    const label = `authority records gaps[${index}]`
    if (!gap || typeof gap !== 'object' || Array.isArray(gap)) throw new Error(`${label} must be an object`)
    for (const key of ['code', 'missing', 'status', 'authorityState', 'protectiveDefaultSource']) {
      if (typeof gap[key] !== 'string' || gap[key].trim() === '') throw new Error(`${label}.${key} must be non-empty`)
    }
    if (seen.has(gap.code)) throw new Error(`authority records contain duplicate gap: ${gap.code}`)
    seen.add(gap.code)
    if (!Array.isArray(gap.blocks)) throw new Error(`${label}.blocks must be an array`)
    for (const [blockIndex, block] of gap.blocks.entries()) {
      const blockLabel = `${label}.blocks[${blockIndex}]`
      strictObject(block, blockLabel, ['constraint', 'effect'])
      if (typeof block.constraint !== 'string' || block.constraint.trim() === '') {
        throw new Error(`${blockLabel}.constraint must be non-empty`)
      }
      canonicalEffectReference(block.effect, `${blockLabel}.effect`)
    }
  }
  for (const constraint of stringSet(state.activeConstraints ?? [], 'canonical active constraints')) {
    if (!constraint.startsWith('gap:')) continue
    const code = constraint.slice('gap:'.length)
    if (!seen.has(code)) throw new Error(`active unresolved record is unavailable: ${constraint}`)
  }
  return records
}

export function blockedEffectCause(state, authorityRecords, effect) {
  const active = new Set(stringSet(state.activeConstraints ?? [], 'canonical active constraints'))
  const reference = canonicalEffectReference(effect)
  const matches = []
  for (const gap of authorityRecords.gaps) {
    if (!active.has(`gap:${gap.code}`) || gap.status !== 'open' || gap.authorityState !== 'unresolved') continue
    for (const block of gap.blocks) {
      if (effectReferenceKey(block.effect) !== effectReferenceKey(reference)) continue
      matches.push(denialCause({
        type: 'unresolved',
        constraint: block.constraint,
        blockingRecord: gap.code,
        authorityState: gap.authorityState,
        authoritativeSource: null,
        unresolvedSource: gap.protectiveDefaultSource,
        detail: gap.missing,
      }))
    }
  }
  if (matches.length > 1) throw new Error('effect has ambiguous unresolved blockers')
  return matches[0] ?? null
}

function canonicalFilePrefix(prefix, label) {
  if (typeof prefix !== 'string' || !prefix.endsWith('/') || prefix.includes('\\') || path.posix.isAbsolute(prefix)) {
    throw new Error(`${label} is invalid`)
  }
  const normalized = path.posix.normalize(prefix)
  if (normalized !== prefix || normalized === '../' || normalized.startsWith('../')) {
    throw new Error(`${label} escapes the workspace`)
  }
  return prefix
}

function prefixesOverlap(left, right) {
  return left.startsWith(right) || right.startsWith(left)
}

export function validatePolicyFileRules(policy) {
  if (!Array.isArray(policy.baseline)) throw new Error('policy baseline is unavailable')
  if (!Array.isArray(policy.protectedFilePrefixes)) throw new Error('policy protectedFilePrefixes is unavailable')
  const baseline = policy.baseline.map((rule, index) => {
    const label = `policy baseline[${index}]`
    strictObject(rule, label, ['kind', 'resourcePrefix', 'source'])
    if (rule.kind !== 'file.write') throw new Error(`${label} is unclassified`)
    if (typeof rule.source !== 'string' || rule.source.trim() === '') throw new Error(`${label}.source must be non-empty`)
    return { ...rule, resourcePrefix: canonicalFilePrefix(rule.resourcePrefix, `${label}.resourcePrefix`) }
  })
  const protectedRules = policy.protectedFilePrefixes.map((rule, index) => {
    const label = `policy protectedFilePrefixes[${index}]`
    strictObject(rule, label, ['prefix', 'permission', 'constraint', 'source'])
    for (const key of ['permission', 'constraint', 'source']) {
      if (typeof rule[key] !== 'string' || rule[key].trim() === '') throw new Error(`${label}.${key} must be non-empty`)
    }
    return { ...rule, prefix: canonicalFilePrefix(rule.prefix, `${label}.prefix`) }
  })
  for (const baselineRule of baseline) {
    for (const protectedRule of protectedRules) {
      if (prefixesOverlap(baselineRule.resourcePrefix, protectedRule.prefix)) {
        throw new Error(`baseline overlaps protected file prefix: ${baselineRule.resourcePrefix} <> ${protectedRule.prefix}`)
      }
    }
  }
  for (let left = 0; left < protectedRules.length; left++) {
    for (let right = left + 1; right < protectedRules.length; right++) {
      if (prefixesOverlap(protectedRules[left].prefix, protectedRules[right].prefix)) {
        throw new Error(`protected file prefixes overlap: ${protectedRules[left].prefix} <> ${protectedRules[right].prefix}`)
      }
    }
  }
  return { baseline, protectedRules }
}
