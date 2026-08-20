#!/usr/bin/env node

import { stableJson } from './control-plane-common.mjs'

const MAX_MESSAGE_BYTES = 1024 * 1024

function errorResponse(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    cause: error?.denialCause ?? null,
  }
}

async function respond(output, handler, line) {
  try {
    const request = JSON.parse(line)
    output.write(`${stableJson(await handler(request))}\n`)
  } catch (error) {
    output.write(`${stableJson(errorResponse(error))}\n`)
  }
}

export async function serveJsonLines({ input, output, handler }) {
  input.setEncoding('utf8')
  let buffer = ''
  for await (const chunk of input) {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES && !buffer.includes('\n')) {
      output.write(`${stableJson(errorResponse(new Error('IPC request exceeds the size limit')))}\n`)
      buffer = ''
      continue
    }
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        output.write(`${stableJson(errorResponse(new Error('IPC request exceeds the size limit')))}\n`)
      } else {
        await respond(output, handler, line)
      }
    }
  }
  if (buffer.trim() !== '') await respond(output, handler, buffer)
}
