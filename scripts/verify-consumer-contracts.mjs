#!/usr/bin/env node

/**
 * 验证消费仓库签入的 contract 副本是否与规格库 generated/ 完全一致。
 * V1 只比较 manifest、文件集合与字节；不解释 SemVer 或兼容范围。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { MESSAGES_ZH, parseFlagsOrThrow } from '../src/shared/argv.mjs'
import { assertSchemaVersion, schemaVersionHint } from '../src/shared/schema-version.mjs'
import { loadConfig, readText, toPosix } from './check-spec-suite.mjs'

const SPEC = {
  '--specs-root': { key: 'specsRoot' },
  '--consumer-root': { key: 'consumerRoot' },
  '--config': { key: 'config' },
  '--help': { key: 'help', flag: true },
}

function parseArgs(argv) {
  return parseFlagsOrThrow(argv, SPEC, MESSAGES_ZH)
}

const HELP = `用法：node verify-consumer-contracts.mjs [选项]

  --specs-root <路径>    规格库根目录（默认当前目录）
  --consumer-root <路径> 消费仓库中保存 bundle 副本的目录（必填）
  --config <路径>        config 文件（默认 <specs-root>/spec-suite.config.json）
`

function requireInside(root, rel, label) {
  if (typeof rel !== 'string' || rel.trim() === '' || path.isAbsolute(rel)) {
    throw new Error(`${label} 必须是非空相对路径：${rel}`)
  }
  const absolute = path.resolve(root, rel)
  const back = path.relative(root, absolute)
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error(`${label} 越出约定目录：${rel}`)
  }
  return absolute
}

function walkFiles(root, dir = root) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`consumer contract 目录不接受符号链接：${toPosix(path.relative(root, absolute))}`)
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute))
    else if (entry.isFile()) files.push(toPosix(path.relative(root, absolute)))
  }
  return files.sort()
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function verifyConsumerContracts(options = {}) {
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  if (!options.consumerRoot) throw new Error('缺少 --consumer-root')
  const consumerRoot = path.resolve(options.consumerRoot)
  if (!fs.existsSync(consumerRoot) || !fs.statSync(consumerRoot).isDirectory()) {
    throw new Error(`consumer contract 目录不存在：${consumerRoot}`)
  }
  const config = loadConfig({ specsRoot, configPath: options.config })
  if (!config.bundle) throw new Error('config 缺少 bundle 配置')

  const generatedRoot = requireInside(specsRoot, config.generatedDir, 'generatedDir')
  const expectedManifestPath = requireInside(specsRoot, config.bundle.manifest, 'bundle.manifest')
  if (!fs.existsSync(expectedManifestPath)) throw new Error('规格库缺少 generated manifest；请先运行 generator')
  const manifestRel = toPosix(path.relative(generatedRoot, expectedManifestPath))
  if (manifestRel === '..' || manifestRel.startsWith('../')) throw new Error('bundle.manifest 必须位于 generatedDir 内')

  let manifest
  try {
    manifest = JSON.parse(readText(expectedManifestPath))
  } catch (error) {
    throw new Error(`规格库 generated manifest 无法解析：${error.message}`)
  }
  // 同上：版本走统一策略表，形状单独判，文案与旧版逐字相同。
  assertSchemaVersion('generated-manifest', manifest)
  if (!Array.isArray(manifest?.outputs)) {
    throw new Error('generated manifest 必须是 schemaVersion 1 且包含 outputs 数组')
  }
  const outputs = [...new Set(manifest.outputs)].sort()
  if (outputs.length !== manifest.outputs.length) throw new Error('generated manifest.outputs 含重复路径')
  for (const rel of outputs) {
    requireInside(generatedRoot, rel, 'manifest output')
    requireInside(consumerRoot, rel, 'consumer output')
  }

  const expectedFiles = [manifestRel, ...outputs].sort()
  const actualFiles = walkFiles(consumerRoot)
  if (!sameList(expectedFiles, actualFiles)) {
    throw new Error(`文件集合不一致；期望 [${expectedFiles.join(', ')}]，实际 [${actualFiles.join(', ')}]`)
  }

  for (const rel of expectedFiles) {
    const expectedPath = rel === manifestRel
      ? expectedManifestPath
      : requireInside(generatedRoot, rel, 'manifest output')
    const consumerPath = requireInside(consumerRoot, rel, 'consumer file')
    if (!fs.readFileSync(expectedPath).equals(fs.readFileSync(consumerPath))) {
      throw new Error(`字节不一致：${rel}`)
    }
  }
  return { files: expectedFiles }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) { process.stdout.write(HELP); return 0 }
    const result = verifyConsumerContracts(options)
    process.stdout.write(`consumer contracts verified (${result.files.length} files)\n`)
    return 0
  } catch (error) {
    process.stderr.write(`消费副本验证失败：${error.message}\n${schemaVersionHint(error)}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) process.exit(main())
