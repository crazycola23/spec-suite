#!/usr/bin/env node

/**
 * 在轻量模式下读取持久化 unresolved registry。
 * 命中时退出 3，阻止调用方把未知值实现成默认事实；本命令永不写文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertSchemaVersion, schemaVersionHint } from '../src/shared/schema-version.mjs'
import { loadYamlLib, readText } from './check-spec-suite.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--specs-root': out.specsRoot = argv[++i]; break
      case '--unresolved': out.unresolved = argv[++i]; break
      case '--fact': out.fact = argv[++i]; break
      case '--help': out.help = true; break
      default: throw new Error(`未知参数：${argv[i]}`)
    }
  }
  return out
}

const HELP = `用法：node guard-unresolved-fact.mjs --fact <稳定事实名> [选项]

  --specs-root <路径>  项目根目录（默认当前目录）
  --unresolved <路径>  registry（默认 .spec-suite/unresolved.yaml）

退出码：0 = 未登记为 unresolved；3 = 仍 unresolved；1 = registry 无效。
`

function resolveRegistry(specsRoot, rel) {
  if (path.isAbsolute(rel)) throw new Error('--unresolved 必须是项目内相对路径')
  const absolute = path.resolve(specsRoot, rel)
  const back = path.relative(specsRoot, absolute)
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error('--unresolved 越出项目根目录')
  }
  return absolute
}

export async function inspectUnresolvedFact(options = {}) {
  if (typeof options.fact !== 'string' || options.fact.trim() === '') throw new Error('缺少 --fact')
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  const registryPath = resolveRegistry(specsRoot, options.unresolved ?? '.spec-suite/unresolved.yaml')
  if (!fs.existsSync(registryPath)) return { status: 'not-recorded', fact: options.fact }

  const YAML = await loadYamlLib(specsRoot)
  let doc
  try {
    doc = YAML.parse(readText(registryPath))
  } catch (error) {
    throw new Error(`unresolved registry 无法解析：${error.message}`)
  }
  // 版本与形状分两步判，但文案与旧版逐字相同（任一条不满足都是同一句）。
  // 版本走统一策略表；未来未知版本会被明确拒绝，而不是当成 1。
  assertSchemaVersion('unresolved-registry', doc)
  if (!Array.isArray(doc?.facts)) {
    throw new Error('unresolved registry 必须是 schemaVersion 1 且包含 facts 数组')
  }
  const matches = doc.facts.filter((item) => item?.fact === options.fact)
  if (matches.length > 1) throw new Error(`同一 unresolved fact 重复登记：${options.fact}`)
  if (matches.length === 0) return { status: 'not-recorded', fact: options.fact }
  const item = matches[0]
  if (item.status !== 'unresolved') throw new Error(`${options.fact} 的轻量状态必须是 unresolved`)
  return {
    status: 'unresolved',
    fact: item.fact,
    sourceSearch: Array.isArray(item.sourceSearch) ? item.sourceSearch : [],
    evidence: Array.isArray(item.evidence) ? item.evidence : [],
    blockedAction: item.blockedAction ?? null,
    nextEvidence: item.nextEvidence ?? null,
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) { process.stdout.write(HELP); return 0 }
    const result = await inspectUnresolvedFact(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.status === 'unresolved' ? 3 : 0
  } catch (error) {
    process.stderr.write(`unresolved guard 失败：${error.message}\n${schemaVersionHint(error)}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => process.exit(code))
