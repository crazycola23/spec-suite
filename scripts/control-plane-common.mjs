import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

export function writeJsonAtomic(target, value) {
  const bytes = `${stableJson(value, 2)}\n`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary)
  }
  return bytes
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

export function assertSchemaVersion(document, label) {
  if (document.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`)
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
