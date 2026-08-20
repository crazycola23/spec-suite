import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { stableJson } from './control-plane-common.mjs'
import { interceptEffect } from './enforce-effect.mjs'
import { projectContext } from './project-context.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const CONTROL_PLANE = path.join(REPO_ROOT, 'control-plane')
const GRAPH = 'control-plane/example/context-graph.json'
const TASK = 'control-plane/example/task.json'
const STATE = 'control-plane/example/canonical-state.json'
const POLICY = 'control-plane/example/issuer-policy.json'
const PROJECTION = 'control-plane/example/generated/projection.json'
const LEASE = 'control-plane/example/generated/lease.json'
const REQUEST = 'control-plane/example/lease-request.json'

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

function makeHarness() {
  fs.mkdirSync(os.tmpdir(), { recursive: true })
  const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-v2-specs-'))
  fs.cpSync(CONTROL_PLANE, path.join(specsRoot, 'control-plane'), { recursive: true })
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-v2-isolated-'))
  const workspaceRoot = path.join(specsRoot, 'workspace')
  fs.mkdirSync(workspaceRoot, { recursive: true })

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const privateKeyPath = path.join(isolatedRoot, 'issuer-private.pem')
  const publicKeyPath = path.join(isolatedRoot, 'issuer-public.pem')
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
  fs.chmodSync(privateKeyPath, 0o600)

  const revocationsPath = path.join(isolatedRoot, 'revocations.json')
  writeJson(revocationsPath, { schemaVersion: 1, revokedLeaseIds: [] })
  const auditPath = path.join(isolatedRoot, 'audit.jsonl')
  const mockNetworkLogPath = path.join(isolatedRoot, 'mock-network.jsonl')
  return {
    specsRoot,
    isolatedRoot,
    workspaceRoot,
    privateKeyPath,
    publicKeyPath,
    revocationsPath,
    auditPath,
    mockNetworkLogPath,
  }
}

function projectionOptions(harness, extra = {}) {
  return {
    specsRoot: harness.specsRoot,
    graph: GRAPH,
    task: TASK,
    state: STATE,
    policy: POLICY,
    ...extra,
  }
}

function persistProjection(harness, projection = projectContext(projectionOptions(harness))) {
  writeJson(path.join(harness.specsRoot, PROJECTION), projection)
  return projection
}

function runIssuer(harness, overrides = {}) {
  const args = [
    path.join(HERE, 'lease-issuer.mjs'),
    '--specs-root', harness.specsRoot,
    '--graph', GRAPH,
    '--task', TASK,
    '--state', STATE,
    '--policy', POLICY,
    '--projection', PROJECTION,
    '--request', overrides.request ?? REQUEST,
    '--private-key', overrides.privateKey ?? harness.privateKeyPath,
    '--output', LEASE,
  ]
  return spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' })
}

function issueLease(harness) {
  persistProjection(harness)
  const result = runIssuer(harness)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return readJson(path.join(harness.specsRoot, LEASE))
}

function protectedNetworkEffect(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task:customer-update',
    subject: 'agent:harness',
    kind: 'network.mock.protected',
    resource: 'mock://protected.local/stripe/customers/cus_demo',
    payload: { customer_id: 'cus_demo', operation: 'update' },
    ...overrides,
  }
}

function fileEffect(resource, payload = 'customer payload') {
  return {
    schemaVersion: 1,
    taskId: 'task:customer-update',
    subject: 'agent:harness',
    kind: 'file.write',
    resource,
    payload,
  }
}

function enforcerOptions(harness, effect, lease, extra = {}) {
  return {
    specsRoot: harness.specsRoot,
    workspaceRoot: harness.workspaceRoot,
    graph: GRAPH,
    state: STATE,
    policy: POLICY,
    revocations: harness.revocationsPath,
    publicKey: harness.publicKeyPath,
    effect,
    lease,
    auditPath: harness.auditPath,
    mockNetworkLogPath: harness.mockNetworkLogPath,
    ...extra,
  }
}

test('Global Safety Kernel stays fixed-size and V1 truth rules remain outside Adapter Spec', () => {
  const kernel = fs.readFileSync(path.join(CONTROL_PLANE, 'global-safety-kernel.md'), 'utf8')
  const approximateTokens = kernel.match(/[\p{L}\p{N}_-]+|[^\s]/gu) ?? []
  assert.ok(approximateTokens.length < 500, `kernel grew to about ${approximateTokens.length} tokens`)
  assert.ok(Buffer.byteLength(kernel) < 2000, 'conservative byte ceiling for a <500-token kernel')

  const canonical = readJson(path.join(CONTROL_PLANE, 'example', 'canonical-facts.json'))
  const adapter = readJson(path.join(CONTROL_PLANE, 'example', 'adapters', 'stripe.adapter.json'))
  assert.equal(canonical.facts.length, 1)
  assert.equal(canonical.gaps.length, 1)
  assert.equal(canonical.gaps[0].code, 'G-17')
  assert.match(canonical.facts[0].source, /^[A-Z][A-Z0-9]*-[A-Z0-9]+-\d{3}$/)
  assert.equal(Object.hasOwn(canonical.facts[0], 'alias'), false)
  assert.equal(Object.hasOwn(canonical.facts[0], 'aliases'), false)
  assert.deepEqual(adapter.fieldMappings[0], {
    externalField: 'customer',
    canonicalField: 'customer_id',
    direction: 'inbound',
  })
  assert.equal(adapter.coreContractAuthority, false)
})

test('context projection is deterministic, knowledge-only, and candidate roots can only add', () => {
  const harness = makeHarness()
  const first = projectContext(projectionOptions(harness))
  const second = projectContext(projectionOptions(harness))
  assert.equal(stableJson(first), stableJson(second))
  assert.equal(first.knowledgeOnly, true)
  assert.equal(first.grantsPrivilege, false)
  assert.equal(first.leaseEligible, true)
  assert.ok(first.blockers.includes('gap:G-17'))
  assert.ok(first.nodes.some((node) => node.kind === 'file'))
  assert.ok(first.nodes.some((node) => node.kind === 'contract'))
  assert.ok(first.nodes.some((node) => node.kind === 'action'))
  assert.ok(first.nodes.some((node) => node.kind === 'provider'))
  assert.ok(first.nodes.some((node) => node.kind === 'permission'))
  assert.equal(first.nodes.some((node) => node.id === 'file:operator-runbook'), false)

  const taskPath = path.join(harness.specsRoot, TASK)
  const task = readJson(taskPath)
  task.candidateRoots = []
  writeJson(taskPath, task)
  const withoutCandidate = projectContext(projectionOptions(harness))
  const withCandidate = projectContext(projectionOptions(harness, { candidateRoots: ['file:operator-runbook'] }))
  const before = new Set(withoutCandidate.nodes.map((node) => node.id))
  const after = new Set(withCandidate.nodes.map((node) => node.id))
  assert.ok([...before].every((id) => after.has(id)))
  assert.equal(after.has('file:operator-runbook'), true)
  assert.ok(after.size > before.size)
})

test('valid short-lived lease authorizes exact file and protected mock effects with audit events', () => {
  const harness = makeHarness()
  const lease = issueLease(harness)
  const issuedAt = Date.parse(lease.payload.issuedAt)
  const expiresAt = Date.parse(lease.payload.expiresAt)
  assert.ok(expiresAt - issuedAt <= 30_000)
  assert.deepEqual(lease.payload.activeConstraints, ['gap:G-17'])

  const file = interceptEffect(enforcerOptions(
    harness,
    fileEffect('out/protected/customer.json', '{"customer_id":"cus_demo"}\n'),
    lease,
  ))
  assert.equal(file.allowed, true)
  assert.equal(file.executed, true)
  assert.equal(file.privilegeBasis, 'lease')
  assert.equal(
    fs.readFileSync(path.join(harness.workspaceRoot, 'out', 'protected', 'customer.json'), 'utf8'),
    '{"customer_id":"cus_demo"}\n',
  )

  const network = interceptEffect(enforcerOptions(harness, protectedNetworkEffect(), lease))
  assert.equal(network.allowed, true)
  assert.equal(network.executed, true)
  assert.equal(network.protected, true)
  assert.equal(fs.readFileSync(harness.mockNetworkLogPath, 'utf8').trim().split('\n').length, 1)
  const audit = fs.readFileSync(harness.auditPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(audit.length, 2)
  assert.deepEqual(audit.map((event) => event.decision), ['allow', 'allow'])
  assert.ok(audit.every((event) => event.leaseId === lease.payload.leaseId))
})

test('baseline allows only its file prefix; protected effects still require a lease', () => {
  const harness = makeHarness()
  issueLease(harness) // establishes a valid trusted public key/control-plane baseline, but is not supplied below

  const baseline = interceptEffect(enforcerOptions(harness, fileEffect('out/baseline/note.txt', 'ok'), null))
  assert.equal(baseline.allowed, true)
  assert.equal(baseline.privilegeBasis, 'baseline')
  assert.equal(fs.readFileSync(path.join(harness.workspaceRoot, 'out', 'baseline', 'note.txt'), 'utf8'), 'ok')

  const outside = interceptEffect(enforcerOptions(harness, fileEffect('out/unscoped/note.txt', 'no'), null))
  assert.equal(outside.allowed, false)
  assert.equal(fs.existsSync(path.join(harness.workspaceRoot, 'out', 'unscoped', 'note.txt')), false)

  const protectedResult = interceptEffect(enforcerOptions(harness, protectedNetworkEffect(), null))
  assert.equal(protectedResult.allowed, false)
  assert.equal(protectedResult.reason, 'lease_missing')
  assert.equal(fs.existsSync(harness.mockNetworkLogPath), false)
})

test('tampering, cross-task replay, expiration, old epoch, and revocation all reduce privilege', () => {
  const scenarios = [
    {
      name: 'tampered payload',
      mutate({ lease }) { lease.payload.permissions = ['permission:admin']; return {} },
      reason: 'lease_signature_invalid',
    },
    {
      name: 'cross-task replay',
      mutate() { return { effect: protectedNetworkEffect({ taskId: 'task:other' }) } },
      reason: 'lease_cross_task_replay',
    },
    {
      name: 'expired lease',
      mutate({ lease }) { return { now: Date.parse(lease.payload.expiresAt) } },
      reason: 'lease_expired',
    },
    {
      name: 'old policy epoch',
      mutate({ harness }) {
        const policyPath = path.join(harness.specsRoot, POLICY)
        const policy = readJson(policyPath)
        policy.policyEpoch += 1
        writeJson(policyPath, policy)
        return {}
      },
      reason: 'lease_policy_epoch_stale',
    },
    {
      name: 'revoked lease',
      mutate({ harness, lease }) {
        writeJson(harness.revocationsPath, { schemaVersion: 1, revokedLeaseIds: [lease.payload.leaseId] })
        return {}
      },
      reason: 'lease_revoked',
    },
  ]

  for (const scenario of scenarios) {
    const harness = makeHarness()
    const lease = issueLease(harness)
    const changes = scenario.mutate({ harness, lease })
    const effect = changes.effect ?? protectedNetworkEffect()
    const result = interceptEffect(enforcerOptions(harness, effect, lease, changes))
    assert.equal(result.allowed, false, scenario.name)
    assert.equal(result.executed, false, scenario.name)
    assert.match(result.reason, new RegExp(scenario.reason), scenario.name)
    assert.equal(fs.existsSync(harness.mockNetworkLogPath), false, scenario.name)
  }
})

test('canonical drift, revocation read failure, ambiguous classification, and audit failure fail closed', () => {
  const canonicalHarness = makeHarness()
  const canonicalLease = issueLease(canonicalHarness)
  fs.appendFileSync(path.join(canonicalHarness.specsRoot, 'control-plane/example/rules.md'), '\nmutated\n')
  const canonical = interceptEffect(enforcerOptions(canonicalHarness, protectedNetworkEffect(), canonicalLease))
  assert.equal(canonical.allowed, false)
  assert.match(canonical.reason, /control_plane_unavailable:canonical revision drift/)

  const revocationHarness = makeHarness()
  const revocationLease = issueLease(revocationHarness)
  fs.rmSync(revocationHarness.revocationsPath)
  const revocation = interceptEffect(enforcerOptions(revocationHarness, protectedNetworkEffect(), revocationLease))
  assert.equal(revocation.allowed, false)
  assert.match(revocation.reason, /control_plane_unavailable:revocation store/)

  const ambiguousHarness = makeHarness()
  const ambiguousLease = issueLease(ambiguousHarness)
  const ambiguous = interceptEffect(enforcerOptions(
    ambiguousHarness,
    protectedNetworkEffect({ resource: 'mock://protected.local/stripe/customers/cus_demo?alias=1' }),
    ambiguousLease,
  ))
  assert.equal(ambiguous.allowed, false)
  assert.match(ambiguous.reason, /effect_unclassified/)

  const symlinkHarness = makeHarness()
  const symlinkLease = issueLease(symlinkHarness)
  const outside = path.join(symlinkHarness.isolatedRoot, 'outside-write-target')
  fs.mkdirSync(path.join(symlinkHarness.workspaceRoot, 'out'), { recursive: true })
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(symlinkHarness.workspaceRoot, 'out', 'protected'), 'dir')
  const symlink = interceptEffect(enforcerOptions(
    symlinkHarness,
    fileEffect('out/protected/customer.json', 'must not escape'),
    symlinkLease,
  ))
  assert.equal(symlink.allowed, false)
  assert.match(symlink.reason, /effect_unclassified:file resource traverses a symbolic link/)
  assert.equal(fs.existsSync(path.join(outside, 'customer.json')), false)

  const auditHarness = makeHarness()
  const auditLease = issueLease(auditHarness)
  fs.mkdirSync(path.join(auditHarness.isolatedRoot, 'audit-directory'))
  const audit = interceptEffect(enforcerOptions(auditHarness, protectedNetworkEffect(), auditLease, {
    auditPath: path.join(auditHarness.isolatedRoot, 'audit-directory'),
  }))
  assert.equal(audit.allowed, false)
  assert.match(audit.reason, /audit_unavailable/)
  assert.equal(fs.existsSync(auditHarness.mockNetworkLogPath), false)
})

test('missing dependency edge widens context, blocks issuance, and satisfies uncertainty monotonicity', () => {
  const harness = makeHarness()
  const certainProjection = projectContext(projectionOptions(harness))
  const certainLease = issueLease(harness)
  const certainDecision = interceptEffect(enforcerOptions(harness, protectedNetworkEffect(), certainLease))
  assert.equal(certainDecision.allowed, true)

  const graphPath = path.join(harness.specsRoot, GRAPH)
  const graph = readJson(graphPath)
  const action = graph.nodes.find((node) => node.id === 'action:customer-update')
  action.dependsOn = action.dependsOn.filter((id) => id !== 'permission:customer-write')
  writeJson(graphPath, graph)
  const uncertainProjection = projectContext(projectionOptions(harness))
  persistProjection(harness, uncertainProjection)
  assert.equal(uncertainProjection.uncertainty.increased, true)
  assert.ok(uncertainProjection.uncertainty.reasons.includes('context_graph_revision_mismatch'))
  assert.equal(uncertainProjection.leaseEligible, false)
  assert.equal(uncertainProjection.privilegeCeiling, 'none')
  assert.ok(uncertainProjection.nodes.length > certainProjection.nodes.length)
  assert.ok(uncertainProjection.nodes.some((node) => node.id === 'file:operator-runbook'))

  const issuer = runIssuer(harness)
  assert.notEqual(issuer.status, 0)
  assert.match(issuer.stderr, /uncertain projection cannot receive privilege/)
  const effectsBefore = fs.readFileSync(harness.mockNetworkLogPath, 'utf8').trim().split('\n').length
  const uncertainDecision = interceptEffect(enforcerOptions(harness, protectedNetworkEffect(), certainLease))
  assert.equal(uncertainDecision.allowed, false)
  assert.match(uncertainDecision.reason, /control_plane_unavailable:context graph revision drift/)
  assert.equal(fs.readFileSync(harness.mockNetworkLogPath, 'utf8').trim().split('\n').length, effectsBefore)

  const deltaUncertainty = Number(uncertainProjection.uncertainty.increased) - Number(certainProjection.uncertainty.increased)
  const deltaPrivilege = Number(uncertainDecision.allowed) - Number(certainDecision.allowed)
  assert.ok(deltaUncertainty >= 0)
  assert.ok(deltaPrivilege <= 0)
})

test('issuer isolation rejects downtime, workspace keys, issuer-owned request fields, and scope expansion', () => {
  const down = makeHarness()
  persistProjection(down)
  const unavailable = runIssuer(down, { privateKey: path.join(down.isolatedRoot, 'missing.pem') })
  assert.notEqual(unavailable.status, 0)
  assert.match(unavailable.stderr, /signing key is unavailable/)
  const withoutIssuer = interceptEffect(enforcerOptions(down, protectedNetworkEffect(), null))
  assert.equal(withoutIssuer.allowed, false)

  const workspaceKey = makeHarness()
  persistProjection(workspaceKey)
  const inWorkspace = path.join(workspaceKey.specsRoot, 'agent-readable-private.pem')
  fs.copyFileSync(workspaceKey.privateKeyPath, inWorkspace)
  fs.chmodSync(inWorkspace, 0o600)
  const workspaceResult = runIssuer(workspaceKey, { privateKey: inWorkspace })
  assert.notEqual(workspaceResult.status, 0)
  assert.match(workspaceResult.stderr, /outside the agent-readable specs root/)

  const owned = makeHarness()
  persistProjection(owned)
  const ownedRequestPath = path.join(owned.specsRoot, 'control-plane/example/owned-request.json')
  const ownedRequest = readJson(path.join(owned.specsRoot, REQUEST))
  ownedRequest.policyEpoch = 999
  writeJson(ownedRequestPath, ownedRequest)
  const ownedResult = runIssuer(owned, { request: 'control-plane/example/owned-request.json' })
  assert.notEqual(ownedResult.status, 0)
  assert.match(ownedResult.stderr, /issuer-owned fields/)

  const expanded = makeHarness()
  persistProjection(expanded)
  const expandedRequestPath = path.join(expanded.specsRoot, 'control-plane/example/expanded-request.json')
  const expandedRequest = readJson(path.join(expanded.specsRoot, REQUEST))
  expandedRequest.effects.push({ kind: 'network.mock.protected', resource: 'mock://protected.local/stripe/customers/cus_other' })
  writeJson(expandedRequestPath, expandedRequest)
  const expandedResult = runIssuer(expanded, { request: 'control-plane/example/expanded-request.json' })
  assert.notEqual(expandedResult.status, 0)
  assert.match(expandedResult.stderr, /outside policy or ambiguous/)
})
