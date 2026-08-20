#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertSchemaVersion,
  canonicalEffectReference,
  readJson,
  resolveInside,
  strictObject,
} from './control-plane-common.mjs'
import { serveJsonLines } from './control-plane-ipc.mjs'
import { loadIssuerDaemonConfig } from './control-plane-trust.mjs'
import { issueLeaseFromTrustedInputs } from './lease-issuer.mjs'

function parseConfigPath(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') {
    throw new Error('usage: node scripts/lease-issuer-daemon.mjs --config <isolated absolute path>')
  }
  if (!path.isAbsolute(argv[1])) throw new Error('--config must be an absolute isolated path')
  return argv[1]
}

function validateIpcRequest(request, config) {
  strictObject(request, 'issuer IPC request', ['schemaVersion', 'op', 'taskId', 'subject', 'requestedEffects'])
  assertSchemaVersion(request, 'issuer IPC request')
  if (request.op !== 'requestLease') throw new Error('issuer IPC op must be requestLease')
  for (const key of ['taskId', 'subject']) {
    if (typeof request[key] !== 'string' || request[key].trim() === '') throw new Error(`issuer IPC ${key} must be non-empty`)
  }
  if (request.subject !== config.agentIdentity.subject) throw new Error('issuer IPC subject does not match the configured agent identity')
  if (!Array.isArray(request.requestedEffects) || request.requestedEffects.length === 0) {
    throw new Error('issuer IPC requestedEffects must be a non-empty array')
  }
  const effects = request.requestedEffects.map((effect, index) => {
    strictObject(effect, `issuer IPC requestedEffects[${index}]`, ['kind', 'resource'])
    return canonicalEffectReference(effect, `issuer IPC requestedEffects[${index}]`)
  })
  return { taskId: request.taskId, subject: request.subject, effects }
}

async function main() {
  try {
    const config = loadIssuerDaemonConfig(parseConfigPath(process.argv.slice(2)))
    process.stderr.write('READY lease-issuer\n')
    await serveJsonLines({
      input: process.stdin,
      output: process.stdout,
      handler(request) {
        const ipc = validateIpcRequest(request, config)
        const policy = readJson(resolveInside(config.snapshotRoot, config.policy, 'trusted policy'), 'issuer policy')
        const lease = issueLeaseFromTrustedInputs({
          specsRoot: config.snapshotRoot,
          graph: config.graph,
          task: config.task,
          state: config.state,
          policy: config.policy,
          privateKey: config.privateKey,
          request: {
            schemaVersion: 1,
            taskId: ipc.taskId,
            subject: ipc.subject,
            ttlSeconds: policy.leaseTtlSeconds,
            effects: ipc.effects,
          },
        })
        return { ok: true, lease }
      },
    })
    return 0
  } catch (error) {
    process.stderr.write(`lease issuer daemon failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => {
  if (code !== 0) process.exit(code)
})
