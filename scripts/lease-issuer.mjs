#!/usr/bin/env node

/**
 * Isolated lease issuer for the minimal V2 control-plane slice.
 *
 * Run this process under a separate identity. The Ed25519 private key MUST live
 * outside the agent-readable specs root. Requests may ask for scope; the issuer
 * independently recomputes context and only signs an exact subset of policy.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertSchemaVersion,
  authorizedEffectKey,
  canonicalAuthorizedEffect,
  canonicalEffectReference,
  effectReferenceKey,
  jsonDigest,
  readJson,
  resolveInside,
  sameStrings,
  stableJson,
  stringSet,
  writeJsonAtomic,
} from './control-plane-common.mjs'
import { projectContext } from './project-context.mjs'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case '--specs-root': result.specsRoot = argv[++index]; break
      case '--graph': result.graph = argv[++index]; break
      case '--task': result.task = argv[++index]; break
      case '--state': result.state = argv[++index]; break
      case '--policy': result.policy = argv[++index]; break
      case '--projection': result.projection = argv[++index]; break
      case '--request': result.request = argv[++index]; break
      case '--private-key': result.privateKey = argv[++index]; break
      case '--output': result.output = argv[++index]; break
      case '--help': result.help = true; break
      default: throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  return result
}

const HELP = `Usage: node scripts/lease-issuer.mjs [options]

  --specs-root <path>       repository/spec root
  --graph <relative path>   trusted dependency graph
  --task <relative path>    trusted task declaration
  --state <relative path>   canonical revision and active constraints
  --policy <relative path>  issuer policy and policy epoch
  --projection <path>       agent-readable knowledge projection
  --request <path>          requested task/subject/effects/TTL
  --private-key <abs path>  Ed25519 PEM outside specs root, mode 0600
  --output <relative path>  optional agent-readable lease output
`

function assertOutside(root, candidate, label) {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute isolated path`)
  const relative = path.relative(root, candidate)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the agent-readable specs root`)
  }
}

function readPrivateKey(specsRoot, keyPath) {
  if (!keyPath) throw new Error('missing --private-key')
  assertOutside(specsRoot, keyPath, '--private-key')
  let stat
  let key
  try {
    stat = fs.statSync(keyPath)
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('private key permissions must not grant group/other access')
    }
    key = crypto.createPrivateKey(fs.readFileSync(keyPath))
  } catch (error) {
    throw new Error(`isolated signing key is unavailable: ${error.message}`)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('isolated signing key must be Ed25519')
  return key
}

function validateRequest(request) {
  assertSchemaVersion(request, 'lease request')
  const allowedKeys = new Set(['schemaVersion', 'taskId', 'subject', 'ttlSeconds', 'effects'])
  const unexpected = Object.keys(request).filter((key) => !allowedKeys.has(key))
  if (unexpected.length > 0) throw new Error(`lease request contains issuer-owned fields: ${unexpected.sort().join(', ')}`)
  for (const key of ['taskId', 'subject']) {
    if (typeof request[key] !== 'string' || request[key].trim() === '') throw new Error(`lease request.${key} must be non-empty`)
  }
  if (!Number.isSafeInteger(request.ttlSeconds) || request.ttlSeconds < 1) {
    throw new Error('lease request.ttlSeconds must be a positive integer')
  }
  if (!Array.isArray(request.effects) || request.effects.length === 0) {
    throw new Error('lease request.effects must be a non-empty array')
  }
  return request.effects.map((effect, index) => canonicalEffectReference(effect, `lease request.effects[${index}]`))
}

function validatePolicy(policy, taskId, subject) {
  assertSchemaVersion(policy, 'issuer policy')
  if (!Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 1) throw new Error('issuer policy epoch is unavailable')
  if (!Number.isSafeInteger(policy.maxTtlSeconds) || policy.maxTtlSeconds < 1) {
    throw new Error('issuer policy.maxTtlSeconds must be a positive integer')
  }
  for (const key of ['issuer', 'keyId']) {
    if (typeof policy[key] !== 'string' || policy[key].trim() === '') throw new Error(`issuer policy.${key} must be non-empty`)
  }
  if (!Array.isArray(policy.taskScopes)) throw new Error('issuer policy.taskScopes must be an array')
  const matches = policy.taskScopes.filter((scope) => scope?.taskId === taskId)
  if (matches.length !== 1) throw new Error('task scope is unavailable or ambiguous')
  const scope = matches[0]
  const subjects = stringSet(scope.subjects ?? [], 'task scope subjects', { allowEmpty: false })
  if (!subjects.includes(subject)) throw new Error('subject is outside the task scope')
  const allowedEffects = (scope.allowedEffects ?? []).map((effect, index) => (
    canonicalAuthorizedEffect(effect, `task scope allowedEffects[${index}]`)
  ))
  if (allowedEffects.length === 0) throw new Error('task scope has no allowed effects')
  const keys = allowedEffects.map(authorizedEffectKey)
  if (new Set(keys).size !== keys.length) throw new Error('task scope contains duplicate allowed effects')
  return { scope, allowedEffects }
}

function selectEffects(requested, allowed) {
  const byReference = new Map()
  for (const effect of allowed) {
    const key = effectReferenceKey(effect)
    const values = byReference.get(key) ?? []
    values.push(effect)
    byReference.set(key, values)
  }
  const selected = requested.map((effect) => {
    const matches = byReference.get(effectReferenceKey(effect)) ?? []
    if (matches.length !== 1) throw new Error(`requested effect is outside policy or ambiguous: ${effect.kind} ${effect.resource}`)
    return matches[0]
  })
  const keys = selected.map(authorizedEffectKey)
  if (new Set(keys).size !== keys.length) throw new Error('lease request contains duplicate effects')
  return selected.sort((left, right) => authorizedEffectKey(left).localeCompare(authorizedEffectKey(right)))
}

function validateProjection({ supplied, recomputed, state, policy, scope }) {
  if (stableJson(supplied) !== stableJson(recomputed)) throw new Error('projection was not produced from current trusted inputs')
  if (supplied.knowledgeOnly !== true || supplied.grantsPrivilege !== false) {
    throw new Error('projection must be explicitly knowledge-only')
  }
  if (supplied.leaseEligible !== true || supplied.uncertainty?.increased !== false) {
    throw new Error('uncertain projection cannot receive privilege')
  }
  if (supplied.canonicalRevision !== state.canonicalRevision) throw new Error('canonical revision drift')
  if (supplied.policyEpoch !== policy.policyEpoch) throw new Error('policy epoch drift')
  if (supplied.contextGraphDigest !== state.contextGraphDigest) throw new Error('context graph revision drift')
  const active = stringSet(state.activeConstraints ?? [], 'canonical active constraints')
  if (!sameStrings(supplied.activeConstraints, active)) throw new Error('active constraints drift')
  const required = stringSet(scope.requiredConstraints ?? [], 'task scope required constraints')
  if (!required.every((constraint) => supplied.blockers.includes(constraint))) {
    throw new Error('projection omitted a task-surface blocker')
  }
  const requiredRoots = stringSet(scope.requiredRoots ?? [], 'task scope required roots', { allowEmpty: false })
  if (!requiredRoots.every((root) => supplied.explicitRoots.includes(root))) {
    throw new Error('projection omitted a policy-required root')
  }
  const requiredSurfaces = stringSet(scope.requiredSurfaces ?? [], 'task scope required surfaces', { allowEmpty: false })
  if (!requiredSurfaces.every((surface) => supplied.surfaces.includes(surface))) {
    throw new Error('projection omitted a policy-required surface')
  }
  const unsigned = { ...supplied }
  delete unsigned.projectionDigest
  if (supplied.projectionDigest !== jsonDigest(unsigned)) throw new Error('projection self-digest is invalid')
}

function issueLease({ options, now = Date.now() }) {
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  for (const key of ['graph', 'task', 'state', 'policy', 'projection', 'request']) {
    if (!options[key]) throw new Error(`missing --${key}`)
  }
  const inputs = Object.fromEntries(['graph', 'task', 'state', 'policy', 'projection', 'request'].map((key) => [
    key,
    resolveInside(specsRoot, options[key], `--${key}`),
  ]))
  const state = readJson(inputs.state, 'canonical state')
  const policy = readJson(inputs.policy, 'issuer policy')
  const request = readJson(inputs.request, 'lease request')
  assertSchemaVersion(state, 'canonical state')
  const requestedEffects = validateRequest(request)
  const { scope, allowedEffects } = validatePolicy(policy, request.taskId, request.subject)
  if (request.ttlSeconds > policy.maxTtlSeconds) throw new Error('requested TTL exceeds issuer policy')

  const recomputed = projectContext({
    specsRoot,
    graph: options.graph,
    task: options.task,
    state: options.state,
    policy: options.policy,
  })
  const supplied = readJson(inputs.projection, 'context projection')
  validateProjection({ supplied, recomputed, state, policy, scope })
  if (recomputed.taskId !== request.taskId) throw new Error('request task does not match the trusted task projection')
  const effects = selectEffects(requestedEffects, allowedEffects)
  const privateKey = readPrivateKey(specsRoot, options.privateKey)

  const issuedAt = new Date(now).toISOString()
  const expiresAt = new Date(now + request.ttlSeconds * 1000).toISOString()
  const payload = {
    schemaVersion: 1,
    leaseId: crypto.randomUUID(),
    issuer: policy.issuer,
    subject: request.subject,
    taskId: request.taskId,
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
    canonicalRevision: state.canonicalRevision,
    contextGraphDigest: state.contextGraphDigest,
    policyEpoch: policy.policyEpoch,
    policyDigest: jsonDigest(policy),
    scopeDigest: jsonDigest(scope),
    projectionDigest: supplied.projectionDigest,
    activeConstraints: stringSet(state.activeConstraints ?? [], 'canonical active constraints'),
    permissions: [...new Set(effects.map((effect) => effect.permission))].sort(),
    allowedEffects: effects,
  }
  const signature = crypto.sign(null, Buffer.from(stableJson(payload)), privateKey).toString('base64url')
  return {
    schemaVersion: 1,
    alg: 'Ed25519',
    keyId: policy.keyId,
    payload,
    signature,
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(HELP)
      return 0
    }
    const lease = issueLease({ options })
    if (options.output) {
      const root = path.resolve(options.specsRoot ?? '.')
      writeJsonAtomic(resolveInside(root, options.output, '--output'), lease)
    } else {
      process.stdout.write(`${stableJson(lease, 2)}\n`)
    }
    return 0
  } catch (error) {
    process.stderr.write(`lease issuance failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => process.exit(code))
