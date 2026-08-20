#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertSchemaVersion, strictObject } from './control-plane-common.mjs'
import { serveJsonLines } from './control-plane-ipc.mjs'
import { loadEnforcerDaemonConfig } from './control-plane-trust.mjs'
import { interceptEffect } from './enforce-effect.mjs'

function parseConfigPath(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') {
    throw new Error('usage: node scripts/effect-enforcer-daemon.mjs --config <isolated absolute path>')
  }
  if (!path.isAbsolute(argv[1])) throw new Error('--config must be an absolute isolated path')
  return argv[1]
}

function validateIpcRequest(request, config) {
  strictObject(request, 'enforcer IPC request', ['schemaVersion', 'op', 'effect', 'lease'])
  assertSchemaVersion(request, 'enforcer IPC request')
  if (request.op !== 'executeEffect') throw new Error('enforcer IPC op must be executeEffect')
  if (!request.effect || typeof request.effect !== 'object' || Array.isArray(request.effect)) {
    throw new Error('enforcer IPC effect must be an object')
  }
  if (request.effect.subject !== config.agentIdentity.subject) {
    throw new Error('enforcer IPC subject does not match the configured agent identity')
  }
  if (request.lease !== null && (typeof request.lease !== 'object' || Array.isArray(request.lease))) {
    throw new Error('enforcer IPC lease must be an object or null')
  }
  return { effect: request.effect, lease: request.lease }
}

async function main() {
  try {
    const config = loadEnforcerDaemonConfig(parseConfigPath(process.argv.slice(2)))
    process.stderr.write('READY effect-enforcer\n')
    await serveJsonLines({
      input: process.stdin,
      output: process.stdout,
      handler(request) {
        const ipc = validateIpcRequest(request, config)
        const decision = interceptEffect({
          specsRoot: config.snapshotRoot,
          workspaceRoot: config.workspaceRoot,
          graph: config.graph,
          state: config.state,
          policy: config.policy,
          revocations: config.revocations,
          publicKey: config.publicKey,
          effect: ipc.effect,
          lease: ipc.lease,
          auditPath: config.audit,
          mockNetworkLogPath: config.mockNetworkLog,
        })
        return { ok: true, decision }
      },
    })
    return 0
  } catch (error) {
    process.stderr.write(`effect enforcer daemon failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => {
  if (code !== 0) process.exit(code)
})
