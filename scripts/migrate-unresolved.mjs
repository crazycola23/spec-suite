#!/usr/bin/env node

/**
 * 把轻量 `.spec-suite/unresolved.yaml` 中的一条事实单向升级为 `G-*`。
 * 同一 `fact` 通过 `provenance.unresolvedFact` 保持稳定身份；重复执行返回原 G-*。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertSchemaVersion, schemaVersionHint } from '../src/shared/schema-version.mjs'
import { loadYamlLib, readText } from './check-spec-suite.mjs'

function parseArgs(argv) {
  const out = { blocks: [] }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    switch (argv[i]) {
      case '--specs-root': out.specsRoot = value; i++; break
      case '--unresolved': out.unresolved = value; i++; break
      case '--dictionary': out.dictionary = value; i++; break
      case '--fact': out.fact = value; i++; break
      case '--block': out.blocks.push(value); i++; break
      case '--protective-default': out.protectiveDefault = value; i++; break
      case '--rollback-cost': out.rollbackCost = value; i++; break
      case '--owner': out.owner = value; i++; break
      case '--help': out.help = true; break
      default: throw new Error(`未知参数：${argv[i]}`)
    }
  }
  return out
}

const HELP = `用法：
  node migrate-unresolved.mjs --specs-root <目录> --fact <稳定事实名>
    --block <受影响路径或 ID> [--block ...]
    --protective-default <保护性默认行为>
    --rollback-cost <回滚代价>
    --owner <责任方>

可选：--unresolved <路径>（默认 .spec-suite/unresolved.yaml）
      --dictionary <路径>（默认 contracts/dictionary.yaml）
`

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`缺少 ${name}`)
}

function nextGapCode(gaps) {
  const max = gaps.reduce((n, gap) => {
    const m = /^G-(\d+)$/.exec(String(gap?.code ?? ''))
    return m ? Math.max(n, Number(m[1])) : n
  }, 0)
  return `G-${String(max + 1).padStart(2, '0')}`
}

function writePreparedFiles(files) {
  const prepared = files.map(({ target, content }) => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    fs.writeFileSync(temp, content, 'utf8')
    return { target, temp }
  })
  for (const item of prepared) fs.renameSync(item.temp, item.target)
}

export async function migrateUnresolved(options) {
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  requireValue(options.fact, '--fact')
  requireValue(options.protectiveDefault, '--protective-default')
  requireValue(options.rollbackCost, '--rollback-cost')
  requireValue(options.owner, '--owner')
  if (!Array.isArray(options.blocks) || options.blocks.length === 0) throw new Error('至少需要一个 --block')

  const unresolvedPath = path.resolve(specsRoot, options.unresolved ?? '.spec-suite/unresolved.yaml')
  const dictionaryPath = path.resolve(specsRoot, options.dictionary ?? 'contracts/dictionary.yaml')
  if (!fs.existsSync(unresolvedPath)) throw new Error(`找不到轻量未决记录：${unresolvedPath}`)
  if (!fs.existsSync(dictionaryPath)) throw new Error(`找不到完整套件字典：${dictionaryPath}`)

  const YAML = await loadYamlLib(specsRoot)
  const unresolvedDoc = YAML.parseDocument(readText(unresolvedPath))
  const dictionaryDoc = YAML.parseDocument(readText(dictionaryPath))
  if (unresolvedDoc.errors.length) throw new Error(`unresolved YAML 无法解析：${unresolvedDoc.errors[0].message}`)
  if (dictionaryDoc.errors.length) throw new Error(`dictionary YAML 无法解析：${dictionaryDoc.errors[0].message}`)

  const unresolvedData = unresolvedDoc.toJS() ?? {}
  const dictionaryData = dictionaryDoc.toJS() ?? {}

  // 版本校验必须在**任何**写盘之前，且早于下面的 existing 分支——那条分支也会写。
  // 迁移一份版本未知的 registry 等于猜它的含义，然后把猜测盖章进派生 gap 的
  // provenance 里。宁可拒绝迁移。
  const unresolvedVersion = assertSchemaVersion('unresolved-registry', unresolvedData).version

  const facts = Array.isArray(unresolvedData.facts) ? unresolvedData.facts : []
  const gaps = Array.isArray(dictionaryData.gaps) ? dictionaryData.gaps : []
  const existing = gaps.find((gap) => gap?.provenance?.unresolvedFact === options.fact)

  if (existing) {
    const remaining = facts.filter((fact) => fact?.fact !== options.fact)
    if (remaining.length !== facts.length) {
      unresolvedDoc.setIn(['facts'], remaining)
      writePreparedFiles([{ target: unresolvedPath, content: unresolvedDoc.toString() }])
    }
    return { code: existing.code, migrated: false }
  }

  const index = facts.findIndex((fact) => fact?.fact === options.fact && fact?.status === 'unresolved')
  if (index < 0) throw new Error(`找不到 status=unresolved 的事实：${options.fact}`)
  const source = facts[index]
  const code = nextGapCode(gaps)
  const gap = {
    code,
    missing: source.fact,
    blocks: options.blocks,
    protectiveDefault: options.protectiveDefault,
    rollbackCost: options.rollbackCost,
    owner: options.owner,
    status: 'open',
    closedBy: null,
    closedAt: null,
    provenance: {
      // 校验过的真实版本，不是 `?? 1` 猜出来的。缺版本的 registry 上面已经拒绝了。
      schemaVersion: unresolvedVersion,
      unresolvedFact: source.fact,
      sourceSearch: Array.isArray(source.sourceSearch) ? source.sourceSearch : [],
      evidence: Array.isArray(source.evidence) ? source.evidence : [],
      blockedAction: source.blockedAction ?? null,
      nextEvidence: source.nextEvidence ?? null,
    },
  }

  dictionaryDoc.setIn(['gaps'], [...gaps, gap])
  unresolvedDoc.setIn(['facts'], facts.filter((_, i) => i !== index))
  writePreparedFiles([
    { target: dictionaryPath, content: dictionaryDoc.toString() },
    { target: unresolvedPath, content: unresolvedDoc.toString() },
  ])
  return { code, migrated: true }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) { process.stdout.write(HELP); return 0 }
    const result = await migrateUnresolved(options)
    process.stdout.write(`${result.code}${result.migrated ? ' migrated' : ' already-migrated'}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`迁移失败：${error.message}\n${schemaVersionHint(error)}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => process.exit(code))
