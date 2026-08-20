#!/usr/bin/env node

/**
 * Effect enforcement core plus a single-process protocol-eval CLI.
 *
 * Allowed(E) = Baseline(E) OR LeaseAuthorizes(E)
 * Protected(E) AND NOT LeaseAuthorizes(E) => Deny(E)
 *
 * The isolated entry point is effect-enforcer-daemon.mjs. This core recognizes
 * repository-relative file writes and two local mock-network classes. Unknown
 * or ambiguous effects fail closed.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertSchemaVersion,
  authorizedEffectKey,
  blockedEffectCause,
  canonicalAuthorizedEffect,
  computeCanonicalRevision,
  contentDigest,
  denialCause,
  effectReferenceKey,
  jsonDigest,
  loadAuthorityRecords,
  parseInstant,
  readJson,
  resolveInside,
  sameStrings,
  stableJson,
  stringSet,
  toPosix,
  validatePolicyFileRules,
} from './control-plane-common.mjs'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case '--specs-root': result.specsRoot = argv[++index]; break
      case '--workspace-root': result.workspaceRoot = argv[++index]; break
      case '--graph': result.graph = argv[++index]; break
      case '--state': result.state = argv[++index]; break
      case '--policy': result.policy = argv[++index]; break
      case '--revocations': result.revocations = argv[++index]; break
      case '--public-key': result.publicKey = argv[++index]; break
      case '--effect': result.effect = argv[++index]; break
      case '--lease': result.lease = argv[++index]; break
      case '--audit': result.audit = argv[++index]; break
      case '--mock-network-log': result.mockNetworkLog = argv[++index]; break
      case '--help': result.help = true; break
      default: throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  return result
}

const HELP = `Usage: node scripts/enforce-effect.mjs [options]

  --specs-root <path>         trusted canonical/policy root
  --workspace-root <path>     root for intercepted file writes
  --graph <relative path>     current trusted dependency graph
  --state <relative path>     canonical state JSON
  --policy <relative path>    current issuer policy JSON
  --revocations <path>        isolated revocation store JSON
  --public-key <path>         trusted Ed25519 public key PEM
  --effect <path>             effect request JSON
  --lease <path>              optional signed lease JSON
  --audit <path>              append-only audit JSONL sink
  --mock-network-log <path>   local sink for protected mock effects

Exit 0 = authorized and executed; 4 = denied; 1 = invocation failure.
`

function requireIdentity(effect) {
  for (const key of ['taskId', 'subject']) {
    if (typeof effect?.[key] !== 'string' || effect[key].trim() === '') throw new Error(`effect.${key} must be non-empty`)
  }
}

function normalizeFileResource(resource, workspaceRoot) {
  if (typeof resource !== 'string' || resource.trim() === '' || resource.includes('\\') || resource.includes('\0')) {
    throw new Error('file resource is not a canonical relative path')
  }
  if (path.posix.isAbsolute(resource)) throw new Error('file resource must be relative')
  const normalized = path.posix.normalize(resource)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('file resource escapes the workspace')
  }
  const absolute = resolveInside(workspaceRoot, normalized, 'file effect resource')
  let current = path.resolve(workspaceRoot)
  let rootStat
  try {
    rootStat = fs.lstatSync(current)
  } catch (error) {
    throw new Error(`workspace root is unavailable: ${error.message}`)
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('workspace root is not a stable directory')
  for (const segment of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('file resource traverses a symbolic link')
    }
  }
  return { resource: toPosix(path.relative(workspaceRoot, absolute)), absolute }
}

function normalizeMockResource(resource, hostname, label) {
  let parsed
  try {
    parsed = new URL(resource)
  } catch {
    throw new Error('mock network resource is not a URL')
  }
  if (parsed.protocol !== 'mock:' || parsed.hostname !== hostname || parsed.port !== '') {
    throw new Error(`mock network resource is outside the ${label} provider`)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('mock network resource contains ambiguous URL components')
  }
  const escapedHostname = hostname.replaceAll('.', '\\.')
  if (parsed.href !== resource || !(new RegExp(`^mock:\\/\\/${escapedHostname}\\/[A-Za-z0-9/_-]+$`)).test(resource)) {
    throw new Error('mock network resource is not canonical')
  }
  let decoded
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    throw new Error('mock network path is not decodable')
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('mock network path is ambiguous')
  }
  return parsed.href
}

export function classifyEffect(effect, workspaceRoot, policy) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) throw new Error('effect must be an object')
  requireIdentity(effect)
  if (effect.kind === 'file.write') {
    const normalized = normalizeFileResource(effect.resource, workspaceRoot)
    const { protectedRules } = validatePolicyFileRules(policy)
    const matches = protectedRules.filter((rule) => normalized.resource.startsWith(rule.prefix))
    if (matches.length > 1) throw new Error('file protection classification is ambiguous')
    const protection = matches[0] ?? null
    return {
      taskId: effect.taskId,
      subject: effect.subject,
      kind: effect.kind,
      resource: normalized.resource,
      absolute: normalized.absolute,
      protected: protection !== null,
      protection,
      payload: effect.payload,
    }
  }
  if (effect.kind === 'network.mock.protected') {
    return {
      taskId: effect.taskId,
      subject: effect.subject,
      kind: effect.kind,
      resource: normalizeMockResource(effect.resource, 'protected.local', 'protected local'),
      absolute: null,
      protected: true,
      protection: {
        constraint: 'PROTECTED_MOCK_NETWORK',
        permission: 'permission:customer-write',
        source: 'CP-PERM-001',
      },
      payload: effect.payload,
    }
  }
  if (effect.kind === 'network.mock.live-stripe') {
    return {
      taskId: effect.taskId,
      subject: effect.subject,
      kind: effect.kind,
      resource: normalizeMockResource(effect.resource, 'live-stripe.local', 'live Stripe mock'),
      absolute: null,
      protected: true,
      protection: {
        constraint: 'NO_LIVE_STRIPE',
        permission: 'permission:customer-write',
        source: 'CP-PERM-001',
      },
      payload: effect.payload,
    }
  }
  throw new Error('effect kind is not classified')
}

function loadControlPlane(options) {
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  for (const key of ['graph', 'state', 'policy']) {
    if (!options[key]) throw new Error(`missing ${key}`)
  }
  if (!options.revocations) throw new Error('revocation store is unavailable')
  if (!options.publicKey) throw new Error('trusted public key is unavailable')
  const graph = readJson(resolveInside(specsRoot, options.graph, 'context graph path'), 'context graph')
  const state = readJson(resolveInside(specsRoot, options.state, 'canonical state path'), 'canonical state')
  const policy = readJson(resolveInside(specsRoot, options.policy, 'issuer policy path'), 'issuer policy')
  const revocations = readJson(path.resolve(options.revocations), 'revocation store')
  assertSchemaVersion(graph, 'context graph')
  assertSchemaVersion(state, 'canonical state')
  assertSchemaVersion(policy, 'issuer policy')
  assertSchemaVersion(revocations, 'revocation store')
  if (graph.complete !== true) throw new Error('dependency graph is incomplete')
  if (typeof state.canonicalRevision !== 'string' || typeof state.contextGraphDigest !== 'string') {
    throw new Error('canonical revision is unavailable')
  }
  if (jsonDigest(graph) !== state.contextGraphDigest) throw new Error('context graph revision drift')
  let computedRevision
  try {
    computedRevision = computeCanonicalRevision(specsRoot, state.canonicalInputs)
  } catch (error) {
    throw new Error(`canonical revision is unreadable: ${error.message}`)
  }
  if (computedRevision !== state.canonicalRevision) throw new Error('canonical revision drift')
  if (!Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 1) throw new Error('policy epoch is unavailable')
  if (!Number.isSafeInteger(policy.maxTtlSeconds) || policy.maxTtlSeconds < 1) throw new Error('policy TTL is unavailable')
  for (const key of ['issuer', 'keyId']) {
    if (typeof policy[key] !== 'string' || policy[key].trim() === '') throw new Error(`policy ${key} is unavailable`)
  }
  if (!Array.isArray(policy.taskScopes)) throw new Error('policy rules are unavailable')
  const fileRules = validatePolicyFileRules(policy)
  const authorityRecords = loadAuthorityRecords(specsRoot, state)
  const taskIds = []
  for (const [index, scope] of policy.taskScopes.entries()) {
    if (typeof scope?.taskId !== 'string' || scope.taskId.trim() === '') throw new Error(`policy taskScopes[${index}] has no task ID`)
    taskIds.push(scope.taskId)
    stringSet(scope.subjects ?? [], `policy taskScopes[${index}] subjects`, { allowEmpty: false })
    stringSet(scope.requiredRoots ?? [], `policy taskScopes[${index}] required roots`, { allowEmpty: false })
    stringSet(scope.requiredSurfaces ?? [], `policy taskScopes[${index}] required surfaces`, { allowEmpty: false })
    stringSet(scope.requiredConstraints ?? [], `policy taskScopes[${index}] required constraints`)
    const effects = (scope.allowedEffects ?? []).map((effect, effectIndex) => {
      const normalized = canonicalAuthorizedEffect(effect, `policy taskScopes[${index}].allowedEffects[${effectIndex}]`)
      if (typeof effect.source !== 'string' || effect.source.trim() === '') {
        throw new Error(`policy taskScopes[${index}].allowedEffects[${effectIndex}].source must be non-empty`)
      }
      return normalized
    })
    if (effects.length === 0) throw new Error(`policy taskScopes[${index}] has no allowed effects`)
    const effectKeys = effects.map(authorizedEffectKey)
    if (new Set(effectKeys).size !== effectKeys.length) throw new Error(`policy taskScopes[${index}] has duplicate effects`)
  }
  if (new Set(taskIds).size !== taskIds.length) throw new Error('policy has duplicate task scopes')
  if (!Array.isArray(revocations.revokedLeaseIds)) throw new Error('revocation store is unreadable')
  const revokedLeaseIds = stringSet(revocations.revokedLeaseIds, 'revoked lease IDs')
  let publicKey
  try {
    publicKey = crypto.createPublicKey(fs.readFileSync(path.resolve(options.publicKey)))
  } catch (error) {
    throw new Error(`trusted public key is unavailable: ${error.message}`)
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('trusted public key must be Ed25519')
  return { graph, state, policy, fileRules, authorityRecords, revokedLeaseIds, publicKey }
}

function taskScopeFor(policy, taskId, subject) {
  if (!Array.isArray(policy.taskScopes)) throw new Error('policy task scopes are unavailable')
  const matches = policy.taskScopes.filter((scope) => scope?.taskId === taskId)
  if (matches.length !== 1) throw new Error('task scope is unavailable or ambiguous')
  const scope = matches[0]
  if (!stringSet(scope.subjects ?? [], 'task scope subjects', { allowEmpty: false }).includes(subject)) {
    throw new Error('subject is outside the task scope')
  }
  const effects = (scope.allowedEffects ?? []).map((effect, index) => {
    const normalized = canonicalAuthorizedEffect(effect, `task scope allowedEffects[${index}]`)
    if (typeof effect.source !== 'string' || effect.source.trim() === '') {
      throw new Error(`task scope allowedEffects[${index}].source must be non-empty`)
    }
    return { ...normalized, source: effect.source }
  })
  const keys = effects.map(authorizedEffectKey)
  if (new Set(keys).size !== keys.length) throw new Error('task scope contains duplicate effects')
  return { scope, effects }
}

function policyEffectFor(classified, effects) {
  const matches = effects.filter((effect) => effectReferenceKey(effect) === effectReferenceKey(classified))
  if (matches.length > 1) throw new Error('effect policy classification is ambiguous')
  return matches[0] ?? null
}

function baselineAuthorizes(policy, classified) {
  const matches = policy.baseline.filter((rule) => (
    classified.kind === 'file.write' && classified.resource.startsWith(rule.resourcePrefix)
  ))
  if (matches.length > 1) throw new Error('baseline classification is ambiguous')
  return matches[0] ?? null
}

function infrastructureCause(constraint, blockingRecord, detail) {
  return denialCause({
    type: 'infrastructure',
    constraint,
    blockingRecord,
    authorityState: 'unavailable',
    detail,
  })
}

function authorizationCause(reason, classified, policyEffect = null) {
  return denialCause({
    type: 'authorization',
    constraint: classified?.protection?.constraint ?? 'LEASE_AUTHORIZES_EFFECT',
    blockingRecord: 'context-lease',
    authorityState: 'authoritative',
    authoritativeSource: policyEffect?.source ?? classified?.protection?.source ?? 'CP-LEASE-001',
    detail: reason,
  })
}

function verifyLease(lease, control, classified, now) {
  try {
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error('lease_missing')
    assertSchemaVersion(lease, 'lease')
    if (lease.alg !== 'Ed25519' || lease.keyId !== control.policy.keyId) throw new Error('lease_key_mismatch')
    if (!lease.payload || typeof lease.payload !== 'object' || typeof lease.signature !== 'string') {
      throw new Error('lease_shape_invalid')
    }
    const signature = Buffer.from(lease.signature, 'base64url')
    if (!crypto.verify(null, Buffer.from(stableJson(lease.payload)), control.publicKey, signature)) {
      throw new Error('lease_signature_invalid')
    }
    const payload = lease.payload
    assertSchemaVersion(payload, 'lease payload')
    for (const key of ['leaseId', 'issuer', 'subject', 'taskId', 'projectionDigest']) {
      if (typeof payload[key] !== 'string' || payload[key].trim() === '') throw new Error(`lease_${key}_invalid`)
    }
    if (control.revokedLeaseIds.includes(payload.leaseId)) throw new Error('lease_revoked')
    if (payload.issuer !== control.policy.issuer) throw new Error('lease_issuer_mismatch')
    if (payload.taskId !== classified.taskId) throw new Error('lease_cross_task_replay')
    if (payload.subject !== classified.subject) throw new Error('lease_subject_mismatch')
    if (payload.canonicalRevision !== control.state.canonicalRevision) throw new Error('lease_canonical_revision_drift')
    if (payload.contextGraphDigest !== control.state.contextGraphDigest) throw new Error('lease_context_graph_drift')
    if (payload.policyEpoch !== control.policy.policyEpoch) throw new Error('lease_policy_epoch_stale')
    if (payload.policyDigest !== jsonDigest(control.policy)) throw new Error('lease_policy_drift')
    const active = stringSet(control.state.activeConstraints ?? [], 'canonical active constraints')
    if (!sameStrings(payload.activeConstraints, active)) throw new Error('lease_active_constraints_drift')

    const current = typeof now === 'number' ? now : Date.parse(now)
    if (!Number.isFinite(current)) throw new Error('enforcer_clock_unavailable')
    const issuedAt = parseInstant(payload.issuedAt, 'lease issuedAt')
    const notBefore = parseInstant(payload.notBefore, 'lease notBefore')
    const expiresAt = parseInstant(payload.expiresAt, 'lease expiresAt')
    if (notBefore < issuedAt || expiresAt <= notBefore) throw new Error('lease_time_window_invalid')
    if (current < notBefore) throw new Error('lease_not_yet_valid')
    if (current >= expiresAt) throw new Error('lease_expired')
    if (!Number.isSafeInteger(control.policy.maxTtlSeconds) || expiresAt - issuedAt > control.policy.maxTtlSeconds * 1000) {
      throw new Error('lease_ttl_exceeds_policy')
    }

    const { scope, effects } = taskScopeFor(control.policy, classified.taskId, classified.subject)
    if (payload.scopeDigest !== jsonDigest(scope)) throw new Error('lease_scope_drift')
    const policyEffect = policyEffectFor(classified, effects)
    if (!policyEffect) throw new Error('effect_outside_current_policy')
    if (!Array.isArray(payload.allowedEffects) || !Array.isArray(payload.permissions)) throw new Error('lease_scope_invalid')
    const leasedEffects = payload.allowedEffects.map((effect, index) => canonicalAuthorizedEffect(effect, `lease effect[${index}]`))
    const currentKeys = new Set(effects.map(authorizedEffectKey))
    if (leasedEffects.some((effect) => !currentKeys.has(authorizedEffectKey(effect)))) throw new Error('lease_scope_expanded')
    if (!leasedEffects.some((effect) => authorizedEffectKey(effect) === authorizedEffectKey(policyEffect))) {
      throw new Error('lease_does_not_authorize_effect')
    }
    const expectedPermissions = [...new Set(leasedEffects.map((effect) => effect.permission))].sort()
    if (!sameStrings(payload.permissions, expectedPermissions) || !payload.permissions.includes(policyEffect.permission)) {
      throw new Error('lease_permission_scope_invalid')
    }
    return { authorized: true, reason: 'lease_authorized', leaseId: payload.leaseId, policyEffect, cause: null }
  } catch (error) {
    return {
      authorized: false,
      reason: error.message,
      leaseId: lease?.payload?.leaseId ?? null,
      policyEffect: null,
      cause: authorizationCause(error.message, classified),
    }
  }
}

export function evaluateEffect(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? options.specsRoot ?? '.')
  let control
  try {
    control = loadControlPlane(options)
  } catch (error) {
    return {
      allowed: false,
      reason: `control_plane_unavailable:${error.message}`,
      privilegeBasis: null,
      protected: null,
      classified: null,
      leaseId: options.lease?.payload?.leaseId ?? null,
      canonicalRevision: null,
      policyEpoch: null,
      cause: infrastructureCause('CONTROL_PLANE_AVAILABLE', 'control-plane', error.message),
    }
  }

  let classified
  let baselineRule = null
  let leaseResult = { authorized: false, reason: 'lease_missing', leaseId: null, cause: null }
  try {
    classified = classifyEffect(options.effect, workspaceRoot, control.policy)
    const unresolved = blockedEffectCause(control.state, control.authorityRecords, classified)
    if (unresolved) {
      return {
        allowed: false,
        reason: 'effect_blocked_by_unresolved_authority',
        privilegeBasis: null,
        protected: classified.protected,
        classified,
        leaseId: options.lease?.payload?.leaseId ?? null,
        canonicalRevision: control.state.canonicalRevision,
        policyEpoch: control.policy.policyEpoch,
        cause: unresolved,
      }
    }
    baselineRule = baselineAuthorizes(control.policy, classified)
    leaseResult = verifyLease(options.lease, control, classified, options.now ?? Date.now())
  } catch (error) {
    return {
      allowed: false,
      reason: `effect_unclassified:${error.message}`,
      privilegeBasis: null,
      protected: null,
      classified: null,
      leaseId: options.lease?.payload?.leaseId ?? null,
      canonicalRevision: control.state.canonicalRevision,
      policyEpoch: control.policy.policyEpoch,
      cause: denialCause({
        type: 'classification',
        constraint: 'EFFECT_CLASSIFIED',
        blockingRecord: 'effect-classifier',
        authorityState: 'unresolved',
        detail: error.message,
      }),
    }
  }

  let allowed = baselineRule !== null || leaseResult.authorized
  let reason = baselineRule ? 'baseline_authorized' : leaseResult.reason
  let privilegeBasis = baselineRule ? 'baseline' : (leaseResult.authorized ? 'lease' : null)
  let cause = allowed ? null : leaseResult.cause
  if (classified.protected && !leaseResult.authorized) {
    allowed = false
    reason = leaseResult.reason
    privilegeBasis = null
    cause = leaseResult.cause ?? authorizationCause(reason, classified)
  }
  return {
    allowed,
    reason,
    privilegeBasis,
    protected: classified.protected,
    classified,
    leaseId: leaseResult.leaseId,
    canonicalRevision: control.state.canonicalRevision,
    policyEpoch: control.policy.policyEpoch,
    cause,
  }
}

function auditEvent(decision, effect, now) {
  const classified = decision.classified
  return {
    schemaVersion: 1,
    at: new Date(now).toISOString(),
    taskId: effect?.taskId ?? null,
    subject: effect?.subject ?? null,
    effect: classified ? { kind: classified.kind, resource: classified.resource } : null,
    effectDigest: effect ? jsonDigest(effect) : null,
    protected: decision.protected,
    decision: decision.allowed ? 'allow' : 'deny',
    reason: decision.reason,
    privilegeBasis: decision.privilegeBasis,
    leaseId: decision.leaseId,
    canonicalRevision: decision.canonicalRevision,
    policyEpoch: decision.policyEpoch,
    cause: decision.cause,
  }
}

function appendAudit(auditPath, event) {
  if (typeof auditPath !== 'string' || auditPath.trim() === '') throw new Error('audit sink is unavailable')
  const absolute = path.resolve(auditPath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.appendFileSync(absolute, `${stableJson(event)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function executeAuthorizedEffect(decision, options) {
  const effect = decision.classified
  if (effect.kind === 'file.write') {
    if (typeof effect.payload !== 'string') throw new Error('file.write payload must be a string')
    fs.mkdirSync(path.dirname(effect.absolute), { recursive: true })
    fs.writeFileSync(effect.absolute, effect.payload, 'utf8')
    return { kind: effect.kind, bytes: Buffer.byteLength(effect.payload), sha256: contentDigest(effect.payload) }
  }
  if (effect.kind === 'network.mock.protected' || effect.kind === 'network.mock.live-stripe') {
    if (!options.mockNetworkLogPath) throw new Error('mock network sink is unavailable')
    const sink = path.resolve(options.mockNetworkLogPath)
    fs.mkdirSync(path.dirname(sink), { recursive: true })
    const request = {
      resource: effect.resource,
      payload: effect.payload ?? null,
      taskId: effect.taskId,
      subject: effect.subject,
    }
    fs.appendFileSync(sink, `${stableJson(request)}\n`, { encoding: 'utf8', mode: 0o600 })
    return { kind: effect.kind, status: 202, requestDigest: jsonDigest(request) }
  }
  throw new Error('authorized effect lost its classifier')
}

export function interceptEffect(options) {
  const now = options.now ?? Date.now()
  let decision = evaluateEffect({ ...options, now })
  const event = auditEvent(decision, options.effect, now)
  try {
    appendAudit(options.auditPath, event)
  } catch (error) {
    if (decision.allowed) {
      decision = {
        ...decision,
        allowed: false,
        reason: `audit_unavailable:${error.message}`,
        privilegeBasis: null,
        cause: infrastructureCause('AUDIT_AVAILABLE', 'audit-sink', error.message),
      }
    }
    return { ...decision, executed: false, result: null, auditRecorded: false }
  }
  if (!decision.allowed) return { ...decision, executed: false, result: null, auditRecorded: true }
  try {
    const result = executeAuthorizedEffect(decision, options)
    return { ...decision, executed: true, result, auditRecorded: true }
  } catch (error) {
    return {
      ...decision,
      allowed: false,
      executed: false,
      result: null,
      reason: `effect_execution_failed:${error.message}`,
      cause: infrastructureCause('EFFECT_EXECUTABLE', 'effect-adapter', error.message),
      auditRecorded: true,
    }
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(HELP)
      return 0
    }
    for (const key of ['effect', 'audit']) {
      if (!options[key]) throw new Error(`missing --${key}`)
    }
    const effect = readJson(path.resolve(options.effect), 'effect')
    const lease = options.lease ? readJson(path.resolve(options.lease), 'lease') : null
    const result = interceptEffect({
      specsRoot: options.specsRoot,
      workspaceRoot: options.workspaceRoot,
      graph: options.graph,
      state: options.state,
      policy: options.policy,
      revocations: options.revocations,
      publicKey: options.publicKey,
      effect,
      lease,
      auditPath: options.audit,
      mockNetworkLogPath: options.mockNetworkLog,
    })
    process.stdout.write(`${stableJson(result, 2)}\n`)
    return result.allowed && result.executed ? 0 : 4
  } catch (error) {
    process.stderr.write(`effect interceptor failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => process.exit(code))
