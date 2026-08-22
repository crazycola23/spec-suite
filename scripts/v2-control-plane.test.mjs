import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { jsonDigest, stableJson } from './control-plane-common.mjs'
import { loadIssuerDaemonConfig } from './control-plane-trust.mjs'
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

// ---------------------------------------------------------------------------
// 能力探测（D10）
// ---------------------------------------------------------------------------
//
// 下面一部分断言验证的是**操作系统级**的隔离：POSIX uid/gid 身份、以及符号
// 链接逃逸。Windows 上这两样都拿不到 —— `process.getuid` 根本不存在，
// `fs.symlinkSync` 在没有开发者模式/管理员权限时抛 EPERM。
//
// 缺能力时有三种做法，只有第三种是对的：
//   1. 让它红着 —— 每次本机跑都有固定几个失败，久了就没人再看失败列表
//   2. `if (canDoIt) { … }` 静默绕过 —— 这是隐藏 fallback：覆盖率悄悄降低，
//      而输出看起来跟全跑一样绿
//   3. 显式 skip 并打印**缺的是哪个能力**，同时给 CI 一个开关，让"缺能力"
//      在 CI 上变成硬失败
//
// 第三种的后半句才是重点。只有 skip 的话，某天 CI 镜像掉了 symlink 权限、
// 或者换成非 POSIX runner，整组隔离断言会安静地全部跳过而 CI 依旧全绿 ——
// 那正是本仓库最想防的形状：**没被证明的东西看起来已被证明**。所以 CI 上设
// `SPEC_SUITE_REQUIRE_POSIX_ISOLATION=1`，缺能力即失败。
const REQUIRE_POSIX_ISOLATION = process.env.SPEC_SUITE_REQUIRE_POSIX_ISOLATION === '1'

/** POSIX 身份能力：daemon 的身份隔离全靠 uid/gid，缺一个就无从断言。 */
const hasPosixIdentity = typeof process.getuid === 'function' && typeof process.getgid === 'function'

/**
 * symlink 能力：只能靠真的建一个来判断 —— Windows 上 `fs.symlinkSync` 存在，
 * 调用才抛 EPERM，所以"函数在不在"不是能力。结果缓存，避免每次都动文件系统。
 */
let symlinkCapability = null
function hasSymlinkCapability() {
  if (symlinkCapability !== null) return symlinkCapability
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-symlink-probe-'))
  try {
    fs.mkdirSync(path.join(probe, 'target'))
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'dir')
    symlinkCapability = true
  } catch {
    symlinkCapability = false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
  return symlinkCapability
}

/**
 * 缺能力 ⇒ 严格模式下硬失败，否则 skip 并说明缺什么。返回 true 表示调用方
 * 应当立刻 return。
 *
 * 注意 `t.skip()` 之后测试体**仍会继续执行** —— node:test 的 skip 只影响报告，
 * 不中断函数。所以调用方必须靠返回值提前 return；忘了 return 就会在缺能力的
 * 平台上照旧抛异常。
 */
function requireCapability(t, available, capability, why) {
  if (available) return false
  const missing = `缺少能力 ${capability}：${why}`
  if (REQUIRE_POSIX_ISOLATION) {
    assert.fail(
      `${missing}\n`
      + 'SPEC_SUITE_REQUIRE_POSIX_ISOLATION=1 要求这些隔离断言必须真的跑过 —— '
      + '在 CI 上跳过安全测试，等于把"未验证"记成了"已通过"。',
    )
  }
  t.skip(missing)
  return true
}

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
  fs.chmodSync(isolatedRoot, 0o700)
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
  const snapshotRoot = path.join(isolatedRoot, 'snapshot')
  fs.mkdirSync(snapshotRoot)
  fs.cpSync(CONTROL_PLANE, path.join(snapshotRoot, 'control-plane'), { recursive: true })
  const protectTree = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name)
      if (entry.isDirectory()) {
        protectTree(absolute)
        fs.chmodSync(absolute, 0o555)
      } else {
        fs.chmodSync(absolute, 0o444)
      }
    }
  }
  protectTree(snapshotRoot)
  fs.chmodSync(snapshotRoot, 0o555)

  const daemonUid = typeof process.getuid === 'function' ? process.getuid() : 0
  const daemonGid = typeof process.getgid === 'function' ? process.getgid() : 0
  const agentUid = daemonUid === 65534 ? 65533 : 65534
  const agentIdentity = { uid: agentUid, gid: daemonGid, groups: [daemonGid], subject: 'agent:harness' }
  const issuerConfigPath = path.join(isolatedRoot, 'issuer-daemon.json')
  const enforcerConfigPath = path.join(isolatedRoot, 'enforcer-daemon.json')
  writeJson(issuerConfigPath, {
    schemaVersion: 1,
    role: 'lease-issuer',
    agentIdentity,
    agentWorkspaceRoot: specsRoot,
    snapshotRoot,
    graph: GRAPH,
    task: TASK,
    state: STATE,
    policy: POLICY,
    privateKey: privateKeyPath,
  })
  writeJson(enforcerConfigPath, {
    schemaVersion: 1,
    role: 'effect-enforcer',
    agentIdentity,
    agentWorkspaceRoot: specsRoot,
    snapshotRoot,
    graph: GRAPH,
    state: STATE,
    policy: POLICY,
    publicKey: publicKeyPath,
    revocations: revocationsPath,
    audit: auditPath,
    mockNetworkLog: mockNetworkLogPath,
    workspaceRoot,
  })
  fs.chmodSync(issuerConfigPath, 0o600)
  fs.chmodSync(enforcerConfigPath, 0o600)

  return {
    specsRoot,
    isolatedRoot,
    workspaceRoot,
    snapshotRoot,
    privateKeyPath,
    publicKeyPath,
    revocationsPath,
    auditPath,
    mockNetworkLogPath,
    agentIdentity,
    issuerConfigPath,
    enforcerConfigPath,
  }
}

async function startDaemon(script, configPath) {
  const child = spawn(process.execPath, [path.join(HERE, script), '--config', configPath], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`daemon readiness timed out: ${stderr}`)), 5000)
    const inspect = () => {
      if (!stderr.includes('READY ')) return
      clearTimeout(timeout)
      child.off('exit', exited)
      resolve()
    }
    const exited = (code) => {
      clearTimeout(timeout)
      reject(new Error(`daemon exited before readiness (${code}): ${stderr}`))
    }
    child.stderr.on('data', inspect)
    child.once('exit', exited)
    inspect()
  })
  return child
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdin.end()
  await exited
}

function sendDaemonRequest(child, request) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      cleanup()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`daemon exited while awaiting a response: ${code}`))
    }
    const cleanup = () => {
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.stdin.write(`${stableJson(request)}\n`)
  })
}

function leaseIpcRequest(effects) {
  return {
    schemaVersion: 1,
    op: 'requestLease',
    taskId: 'task:customer-update',
    subject: 'agent:harness',
    requestedEffects: effects,
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

function liveStripeEffect(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task:customer-update',
    subject: 'agent:harness',
    kind: 'network.mock.live-stripe',
    resource: 'mock://live-stripe.local/stripe/customers/cus_demo',
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

function assertMachineCause(value, expectedType = null) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  for (const key of ['type', 'constraint', 'blockingRecord', 'authorityState']) {
    assert.equal(typeof value[key], 'string', `cause.${key}`)
    assert.notEqual(value[key].length, 0, `cause.${key}`)
  }
  for (const key of ['authoritativeSource', 'unresolvedSource', 'detail']) {
    assert.ok(value[key] === null || (typeof value[key] === 'string' && value[key].length > 0), `cause.${key}`)
  }
  if (expectedType) assert.equal(value.type, expectedType)
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
  assert.equal(file.protected, true)
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

test('a file effect whose path traverses a symbolic link fails closed instead of escaping the workspace', (t) => {
  // 单独成一条测试而不是并进上面那组：它是这个文件里唯一需要 symlink 能力的
  // 断言。混在一起的话，缺能力就得整组跳过，连带失掉 canonical drift /
  // revocation / ambiguous / audit 四个在 Windows 上跑得好的场景。
  if (requireCapability(t, hasSymlinkCapability(), 'fs.symlinkSync', '无法建立符号链接，因此无法构造逃逸路径')) return

  const harness = makeHarness()
  const lease = issueLease(harness)
  const outside = path.join(harness.isolatedRoot, 'outside-write-target')
  fs.mkdirSync(path.join(harness.workspaceRoot, 'out'), { recursive: true })
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(harness.workspaceRoot, 'out', 'protected'), 'dir')
  const symlink = interceptEffect(enforcerOptions(
    harness,
    fileEffect('out/protected/customer.json', 'must not escape'),
    lease,
  ))
  assert.equal(symlink.allowed, false)
  assert.match(symlink.reason, /effect_unclassified:file resource traverses a symbolic link/)
  assert.equal(fs.existsSync(path.join(outside, 'customer.json')), false)
})

test('edge mutation with a stale digest detects graph drift and satisfies uncertainty monotonicity', () => {
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

test('semantic graph completeness remains a trusted declaration when graph and digest move together', () => {
  const harness = makeHarness()
  const graphPath = path.join(harness.specsRoot, GRAPH)
  const statePath = path.join(harness.specsRoot, STATE)
  const graph = readJson(graphPath)
  const action = graph.nodes.find((node) => node.id === 'action:customer-update')
  action.dependsOn = action.dependsOn.filter((id) => id !== 'permission:customer-write')
  writeJson(graphPath, graph)
  const state = readJson(statePath)
  state.contextGraphDigest = jsonDigest(graph)
  writeJson(statePath, state)

  const projection = projectContext(projectionOptions(harness))
  assert.equal(graph.complete, true)
  assert.equal(projection.uncertainty.increased, false)
  assert.equal(projection.leaseEligible, true)
  assert.equal(projection.nodes.some((node) => node.id === 'permission:customer-write'), false)
})

test('isolated daemons pin trust roots at startup and expose path-free IPC only', async (t) => {
  // 这条测试从 `loadIssuerDaemonConfig` 开始就要求 POSIX 身份
  // （control-plane-trust.mjs 的 requirePosixIdentity 在缺 getuid 时 throw），
  // 而那正是被测行为本身：daemon 在拿不到身份时**正确地** fail closed。
  // 缺能力时它抛的是"前提不满足"，不是"隔离失效"，两者必须区分开。
  if (requireCapability(t, hasPosixIdentity, 'process.getuid/getgid', 'daemon 的身份隔离以 POSIX uid/gid 为前提')) return

  const harness = makeHarness()
  const issuer = await startDaemon('lease-issuer-daemon.mjs', harness.issuerConfigPath)
  let enforcer = null
  t.after(async () => {
    if (enforcer) await stopDaemon(enforcer)
    await stopDaemon(issuer)
  })

  const policyPath = path.join(harness.specsRoot, POLICY)
  const agentPolicy = readJson(policyPath)
  agentPolicy.taskScopes[0].allowedEffects.push({
    kind: 'network.mock.protected',
    resource: 'mock://protected.local/stripe/customers/cus_agent_added',
    permission: 'permission:customer-write',
    source: 'AGENT-SELF-AUTHORIZATION',
  })
  writeJson(policyPath, agentPolicy)

  const rejectedExpansion = await sendDaemonRequest(issuer, leaseIpcRequest([{
    kind: 'network.mock.protected',
    resource: 'mock://protected.local/stripe/customers/cus_agent_added',
  }]))
  assert.equal(rejectedExpansion.ok, false)
  assert.match(rejectedExpansion.error, /outside policy or ambiguous/)

  const injectedPath = await sendDaemonRequest(issuer, {
    ...leaseIpcRequest([{ kind: 'network.mock.protected', resource: 'mock://protected.local/stripe/customers/cus_demo' }]),
    policy: policyPath,
  })
  assert.equal(injectedPath.ok, false)
  assert.match(injectedPath.error, /forbidden fields: policy/)

  const injectedTtl = await sendDaemonRequest(issuer, {
    ...leaseIpcRequest([{ kind: 'network.mock.protected', resource: 'mock://protected.local/stripe/customers/cus_demo' }]),
    ttlSeconds: 30_000,
  })
  assert.equal(injectedTtl.ok, false)
  assert.match(injectedTtl.error, /forbidden fields: ttlSeconds/)

  const issued = await sendDaemonRequest(issuer, leaseIpcRequest([{
    kind: 'network.mock.protected',
    resource: 'mock://protected.local/stripe/customers/cus_demo',
  }]))
  assert.equal(issued.ok, true, issued.error)
  assert.ok(Date.parse(issued.lease.payload.expiresAt) - Date.parse(issued.lease.payload.issuedAt) <= 15_000)

  enforcer = await startDaemon('effect-enforcer-daemon.mjs', harness.enforcerConfigPath)
  const executed = await sendDaemonRequest(enforcer, {
    schemaVersion: 1,
    op: 'executeEffect',
    effect: protectedNetworkEffect(),
    lease: issued.lease,
  })
  assert.equal(executed.ok, true)
  assert.equal(executed.decision.allowed, true)
  assert.equal(executed.decision.executed, true)

  const enforcerInjection = await sendDaemonRequest(enforcer, {
    schemaVersion: 1,
    op: 'executeEffect',
    effect: protectedNetworkEffect(),
    lease: issued.lease,
    publicKey: harness.publicKeyPath,
  })
  assert.equal(enforcerInjection.ok, false)
  assert.match(enforcerInjection.error, /forbidden fields: publicKey/)

  const sameIdentityPath = path.join(harness.isolatedRoot, 'same-identity-config.json')
  const sameIdentity = readJson(harness.issuerConfigPath)
  sameIdentity.agentIdentity.uid = process.getuid()
  writeJson(sameIdentityPath, sameIdentity)
  fs.chmodSync(sameIdentityPath, 0o600)
  assert.throws(() => loadIssuerDaemonConfig(sameIdentityPath), /distinct OS identities/)

  const trustedPolicy = path.join(harness.snapshotRoot, POLICY)
  assert.equal(fs.statSync(trustedPolicy).mode & 0o222, 0)
  assert.equal(fs.statSync(harness.privateKeyPath).mode & 0o077, 0)
  if (process.getuid() === 0) {
    const attemptedWrite = spawnSync(process.execPath, ['-e', "require('node:fs').appendFileSync(process.argv[1], 'x')", trustedPolicy], {
      uid: harness.agentIdentity.uid,
      gid: harness.agentIdentity.gid,
      encoding: 'utf8',
    })
    assert.notEqual(attemptedWrite.status, 0, 'the configured agent OS identity must not write the trusted snapshot')
    const attemptedKeyRead = spawnSync(process.execPath, ['-e', "require('node:fs').readFileSync(process.argv[1])", harness.privateKeyPath], {
      uid: harness.agentIdentity.uid,
      gid: harness.agentIdentity.gid,
      encoding: 'utf8',
    })
    assert.notEqual(attemptedKeyRead.status, 0, 'the configured agent OS identity must not read the issuer private key')
  }
})

test('G-17 blocks live Stripe mock issuance and defeats a correctly signed over-authorizing lease', async (t) => {
  if (requireCapability(t, hasPosixIdentity, 'process.getuid/getgid', 'daemon 的身份隔离以 POSIX uid/gid 为前提')) return

  const harness = makeHarness()
  const issuer = await startDaemon('lease-issuer-daemon.mjs', harness.issuerConfigPath)
  const enforcer = await startDaemon('effect-enforcer-daemon.mjs', harness.enforcerConfigPath)
  t.after(async () => {
    await stopDaemon(enforcer)
    await stopDaemon(issuer)
  })

  const issuance = await sendDaemonRequest(issuer, leaseIpcRequest([{
    kind: 'network.mock.live-stripe',
    resource: 'mock://live-stripe.local/stripe/customers/cus_demo',
  }]))
  assert.equal(issuance.ok, false)
  assert.equal(issuance.error, 'effect_blocked_by_unresolved_authority')
  assertMachineCause(issuance.cause, 'unresolved')
  assert.equal(issuance.cause.constraint, 'NO_LIVE_STRIPE')
  assert.equal(issuance.cause.blockingRecord, 'G-17')
  assert.equal(issuance.cause.authorityState, 'unresolved')

  const trustedPolicy = readJson(path.join(harness.snapshotRoot, POLICY))
  assert.ok(trustedPolicy.taskScopes[0].allowedEffects.some((effect) => effect.kind === 'network.mock.live-stripe'))

  const lease = issueLease(harness)
  lease.payload.allowedEffects.push({
    kind: 'network.mock.live-stripe',
    resource: 'mock://live-stripe.local/stripe/customers/cus_demo',
    permission: 'permission:customer-write',
  })
  const signingKey = crypto.createPrivateKey(fs.readFileSync(harness.privateKeyPath))
  lease.signature = crypto.sign(null, Buffer.from(stableJson(lease.payload)), signingKey).toString('base64url')
  const verificationKey = crypto.createPublicKey(fs.readFileSync(harness.publicKeyPath))
  assert.equal(
    crypto.verify(null, Buffer.from(stableJson(lease.payload)), verificationKey, Buffer.from(lease.signature, 'base64url')),
    true,
  )

  const enforcement = await sendDaemonRequest(enforcer, {
    schemaVersion: 1,
    op: 'executeEffect',
    effect: liveStripeEffect(),
    lease,
  })
  assert.equal(enforcement.ok, true)
  assert.equal(enforcement.decision.allowed, false)
  assert.equal(enforcement.decision.executed, false)
  assert.equal(enforcement.decision.reason, 'effect_blocked_by_unresolved_authority')
  assertMachineCause(enforcement.decision.cause, 'unresolved')
  assert.equal(enforcement.decision.cause.blockingRecord, 'G-17')
  assert.equal(fs.existsSync(harness.mockNetworkLogPath), false)
})

test('protected file classification rejects any baseline overlap before authorization', () => {
  const harness = makeHarness()
  const lease = issueLease(harness)
  const policyPath = path.join(harness.specsRoot, POLICY)
  const policy = readJson(policyPath)
  policy.baseline[0].resourcePrefix = 'out/'
  writeJson(policyPath, policy)

  const decision = interceptEffect(enforcerOptions(
    harness,
    fileEffect('out/protected/customer.json', 'must remain denied'),
    lease,
  ))
  assert.equal(decision.allowed, false)
  assert.equal(decision.executed, false)
  assert.match(decision.reason, /control_plane_unavailable:baseline overlaps protected file prefix/)
  assertMachineCause(decision.cause, 'infrastructure')
  assert.equal(fs.existsSync(path.join(harness.workspaceRoot, 'out', 'protected', 'customer.json')), false)

  persistProjection(harness)
  const issuer = runIssuer(harness)
  assert.notEqual(issuer.status, 0)
  assert.match(issuer.stderr, /baseline overlaps protected file prefix/)
})

test('every denied effect and recorded denial has machine-readable provenance', () => {
  const authorizationHarness = makeHarness()
  const authorization = interceptEffect(enforcerOptions(authorizationHarness, protectedNetworkEffect(), null))

  const unresolvedHarness = makeHarness()
  const unresolved = interceptEffect(enforcerOptions(unresolvedHarness, liveStripeEffect(), null))

  const classificationHarness = makeHarness()
  const classification = interceptEffect(enforcerOptions(
    classificationHarness,
    protectedNetworkEffect({ resource: 'mock://protected.local/stripe/customers/cus_demo?ambiguous=1' }),
    null,
  ))

  const infrastructureHarness = makeHarness()
  fs.rmSync(infrastructureHarness.revocationsPath)
  const infrastructure = interceptEffect(enforcerOptions(infrastructureHarness, protectedNetworkEffect(), null))

  const cases = [
    [authorizationHarness, authorization, 'authorization'],
    [unresolvedHarness, unresolved, 'unresolved'],
    [classificationHarness, classification, 'classification'],
    [infrastructureHarness, infrastructure, 'infrastructure'],
  ]
  for (const [harness, decision, type] of cases) {
    assert.equal(decision.allowed, false)
    assertMachineCause(decision.cause, type)
    const events = fs.readFileSync(harness.auditPath, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(events.length, 1)
    assert.equal(events[0].decision, 'deny')
    assertMachineCause(events[0].cause, type)
  }
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
