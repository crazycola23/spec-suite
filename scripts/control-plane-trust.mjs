import fs from 'node:fs'
import path from 'node:path'

import {
  assertSchemaVersion,
  readJson,
  resolveInside,
  strictObject,
} from './control-plane-common.mjs'

function requirePosixIdentity() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('isolated daemons require POSIX process identities')
  }
  return { uid: process.getuid(), gid: process.getgid() }
}

function assertAbsolute(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`)
  return path.resolve(candidate)
}

function assertOutside(root, candidate, label) {
  const absoluteRoot = path.resolve(root)
  const absolute = assertAbsolute(candidate, label)
  const relative = path.relative(absoluteRoot, absolute)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be outside the agent workspace`)
  }
  return absolute
}

function identityBits(stat, identity) {
  if (stat.uid === identity.uid) return (stat.mode >> 6) & 0o7
  if (stat.gid === identity.gid || identity.groups.includes(stat.gid)) return (stat.mode >> 3) & 0o7
  return stat.mode & 0o7
}

function assertNotSymlink(candidate, label) {
  let stat
  try {
    stat = fs.lstatSync(candidate)
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.message}`)
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  return stat
}

function assertAgentDenied(candidate, identity, deniedBits, label) {
  const stat = assertNotSymlink(candidate, label)
  if ((identityBits(stat, identity) & deniedBits) !== 0) {
    throw new Error(`${label} permissions expose it to the agent identity`)
  }
  return stat
}

function validateAgentIdentity(value, daemon) {
  strictObject(value, 'daemon config.agentIdentity', ['uid', 'gid', 'groups', 'subject'])
  for (const key of ['uid', 'gid']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`daemon config.agentIdentity.${key} is invalid`)
  }
  if (value.uid === daemon.uid) throw new Error('agent and daemon must use distinct OS identities')
  if (value.uid === 0) throw new Error('agent identity must not be root')
  if (!Array.isArray(value.groups) || value.groups.some((group) => !Number.isSafeInteger(group) || group < 0)) {
    throw new Error('daemon config.agentIdentity.groups must contain numeric GIDs')
  }
  if (typeof value.subject !== 'string' || value.subject.trim() === '') {
    throw new Error('daemon config.agentIdentity.subject must be non-empty')
  }
  return { ...value, groups: [...new Set(value.groups)] }
}

function validateConfigEnvelope(configPath, role, allowedKeys) {
  const daemon = requirePosixIdentity()
  const absoluteConfig = assertAbsolute(configPath, '--config')
  const config = readJson(absoluteConfig, 'daemon config')
  assertSchemaVersion(config, 'daemon config')
  strictObject(config, 'daemon config', ['schemaVersion', 'role', 'agentIdentity', 'agentWorkspaceRoot', 'snapshotRoot', ...allowedKeys])
  if (config.role !== role) throw new Error(`daemon config.role must be ${role}`)
  const agentIdentity = validateAgentIdentity(config.agentIdentity, daemon)
  const agentWorkspaceRoot = assertAbsolute(config.agentWorkspaceRoot, 'daemon config.agentWorkspaceRoot')
  const workspaceStat = assertNotSymlink(agentWorkspaceRoot, 'daemon config.agentWorkspaceRoot')
  if (!workspaceStat.isDirectory()) throw new Error('daemon config.agentWorkspaceRoot must be a directory')
  assertOutside(agentWorkspaceRoot, absoluteConfig, 'daemon config path')
  assertAgentDenied(absoluteConfig, agentIdentity, 0o6, 'daemon config')
  assertAgentDenied(path.dirname(absoluteConfig), agentIdentity, 0o2, 'daemon config directory')
  return { config, configPath: absoluteConfig, daemon, agentIdentity, agentWorkspaceRoot }
}

function validateSnapshot(envelope) {
  const snapshotRoot = assertOutside(
    envelope.agentWorkspaceRoot,
    envelope.config.snapshotRoot,
    'daemon config.snapshotRoot',
  )
  const rootStat = assertAgentDenied(snapshotRoot, envelope.agentIdentity, 0o2, 'trusted snapshot root')
  if (!rootStat.isDirectory()) throw new Error('trusted snapshot root must be a directory')
  assertAgentDenied(path.dirname(snapshotRoot), envelope.agentIdentity, 0o2, 'trusted snapshot parent')
  const pending = [snapshotRoot]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const stat = assertAgentDenied(absolute, envelope.agentIdentity, 0o2, `trusted snapshot entry ${entry.name}`)
      if (stat.isDirectory()) pending.push(absolute)
      else if (!stat.isFile()) throw new Error(`trusted snapshot entry is not a regular file: ${absolute}`)
    }
  }
  return snapshotRoot
}

function validateFixedRelative(snapshotRoot, candidate, label) {
  const absolute = resolveInside(snapshotRoot, candidate, label)
  const stat = assertNotSymlink(absolute, label)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  return candidate
}

function validateExternalFile(envelope, candidate, label, { secret = false } = {}) {
  const absolute = assertOutside(envelope.agentWorkspaceRoot, candidate, label)
  const stat = assertAgentDenied(absolute, envelope.agentIdentity, secret ? 0o6 : 0o2, label)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  assertAgentDenied(path.dirname(absolute), envelope.agentIdentity, 0o2, `${label} directory`)
  if (secret && (stat.mode & 0o077) !== 0) throw new Error(`${label} must not grant group/other access`)
  return absolute
}

function validateExternalSink(envelope, candidate, label) {
  const absolute = assertOutside(envelope.agentWorkspaceRoot, candidate, label)
  const parent = path.dirname(absolute)
  assertAgentDenied(parent, envelope.agentIdentity, 0o2, `${label} directory`)
  if (fs.existsSync(absolute)) assertAgentDenied(absolute, envelope.agentIdentity, 0o2, label)
  return absolute
}

export function loadIssuerDaemonConfig(configPath) {
  const envelope = validateConfigEnvelope(configPath, 'lease-issuer', ['graph', 'task', 'state', 'policy', 'privateKey'])
  const snapshotRoot = validateSnapshot(envelope)
  return {
    ...envelope.config,
    agentIdentity: envelope.agentIdentity,
    snapshotRoot,
    graph: validateFixedRelative(snapshotRoot, envelope.config.graph, 'trusted graph'),
    task: validateFixedRelative(snapshotRoot, envelope.config.task, 'trusted task'),
    state: validateFixedRelative(snapshotRoot, envelope.config.state, 'trusted state'),
    policy: validateFixedRelative(snapshotRoot, envelope.config.policy, 'trusted policy'),
    privateKey: validateExternalFile(envelope, envelope.config.privateKey, 'issuer private key', { secret: true }),
  }
}

export function loadEnforcerDaemonConfig(configPath) {
  const envelope = validateConfigEnvelope(configPath, 'effect-enforcer', [
    'graph', 'state', 'policy', 'publicKey', 'revocations', 'audit', 'mockNetworkLog', 'workspaceRoot',
  ])
  const snapshotRoot = validateSnapshot(envelope)
  const workspaceRoot = path.resolve(envelope.config.workspaceRoot)
  const relativeWorkspace = path.relative(envelope.agentWorkspaceRoot, workspaceRoot)
  if (relativeWorkspace === '..' || relativeWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorkspace)) {
    throw new Error('enforcer workspaceRoot must be inside the fixed agent workspace')
  }
  const workspaceStat = assertNotSymlink(workspaceRoot, 'enforcer workspaceRoot')
  if (!workspaceStat.isDirectory()) throw new Error('enforcer workspaceRoot must be a directory')
  return {
    ...envelope.config,
    agentIdentity: envelope.agentIdentity,
    snapshotRoot,
    graph: validateFixedRelative(snapshotRoot, envelope.config.graph, 'trusted graph'),
    state: validateFixedRelative(snapshotRoot, envelope.config.state, 'trusted state'),
    policy: validateFixedRelative(snapshotRoot, envelope.config.policy, 'trusted policy'),
    publicKey: validateExternalFile(envelope, envelope.config.publicKey, 'trusted public key'),
    revocations: validateExternalFile(envelope, envelope.config.revocations, 'revocation store'),
    audit: validateExternalSink(envelope, envelope.config.audit, 'audit sink'),
    mockNetworkLog: validateExternalSink(envelope, envelope.config.mockNetworkLog, 'mock network sink'),
    workspaceRoot,
  }
}
