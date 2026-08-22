#!/usr/bin/env node

/**
 * 从 canonical contracts 生成 language-neutral JSON bundle。
 *
 * 生成器是 fail-closed：先完成全部解析、checker 与权威 source 校验，再写任何输出。
 * `gaps` 和 generated/ 永远不是 bundle 的事实来源。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { MESSAGES_ZH, parseFlagsOrThrow } from '../src/shared/argv.mjs'
import { writeFilesAtomic } from '../src/shared/atomic-write.mjs'
// canonicalize 从这里来，而不再是本文件下方的一份局部实现（D4）。两份实现的差别
// 只有一处：本文件那份对非 JSON 值**静默放行**，于是 `undefined` / 函数 / symbol
// 会被随后的 JSON.stringify 悄悄丢掉 —— 字段从 bundle 里消失，而 manifest 的
// digest 照样自洽。合法输入的输出逐字节不变，收紧只影响以前被静默丢弃的输入。
import { canonicalize } from '../src/shared/canonical-json.mjs'
import { isInside } from '../src/shared/paths.mjs'
import { extractIdTokens, loadYamlLib, readText, run, toPosix } from './check-spec-suite.mjs'

const SPEC = {
  '--specs-root': { key: 'specsRoot' },
  '--config': { key: 'config' },
  '--help': { key: 'help', flag: true },
}

function parseArgs(argv) {
  return parseFlagsOrThrow(argv, SPEC, MESSAGES_ZH)
}

const HELP = `用法：node generate-contract-bundle.mjs [选项]

  --specs-root <路径>   规格库根目录（默认当前目录）
  --config <路径>       config 文件（默认 <root>/spec-suite.config.json）
`

function posixRelative(root, absolute) {
  return toPosix(path.relative(root, absolute))
}

function resolveInside(root, rel, label) {
  if (typeof rel !== 'string' || rel.trim() === '') throw new Error(`${label} 必须是非空相对路径`)
  if (path.isAbsolute(rel)) throw new Error(`${label} 必须是相对路径：${rel}`)
  const absolute = path.resolve(root, rel)
  if (!isInside(root, absolute)) throw new Error(`${label} 越出规格库：${rel}`)
  return absolute
}

function validateSources({ contracts, config, defs, generatedRoot, specsRoot }) {
  const problems = []
  const checkSource = (source, trail) => {
    if (typeof source !== 'string' || source.trim() === '') {
      problems.push(`${trail}.source 缺失或为空`)
      return
    }
    const sourcePath = path.resolve(specsRoot, source)
    if (isInside(generatedRoot, sourcePath)) {
      problems.push(`${trail}.source 指向派生产物：${source}`)
      return
    }
    const tokens = extractIdTokens(source)
    if (tokens.length !== 1 || tokens[0] !== source.trim()) {
      problems.push(`${trail}.source 必须恰好是一个 authoritative ID：${source}`)
      return
    }
    const token = tokens[0]
    const namespaces = config.idNamespaces.filter((namespace) => namespace.re.test(token))
    if (namespaces.length !== 1) {
      problems.push(`${trail}.source 无法唯一匹配命名空间：${token}`)
      return
    }
    const namespace = namespaces[0]
    if (namespace.kind === 'gap' || namespace.mayLackDefinition) {
      problems.push(`${trail}.source 仍是未决事实，不是 authoritative source：${token}`)
      return
    }
    const definition = defs.get(token)
    if (!definition) {
      problems.push(`${trail}.source 的定义不存在：${token}`)
      return
    }
    const definitionPath = path.resolve(specsRoot, definition.file)
    if (isInside(generatedRoot, definitionPath)) {
      problems.push(`${trail}.source 的定义来自派生产物：${token}`)
    }
  }

  const visit = (value, trail) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${trail}[${index}]`))
      return
    }
    if (!value || typeof value !== 'object') return
    if (Object.hasOwn(value, 'code')) checkSource(value.source, trail)
    else if (Object.hasOwn(value, 'source')) checkSource(value.source, trail)
    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'source') visit(nested, `${trail}.${key}`)
    }
  }

  visit(contracts, 'contracts')
  if (problems.length > 0) throw new Error(`bundle source 校验失败：\n- ${problems.join('\n- ')}`)
}

function writeAllAfterValidation(files) {
  // 语义不变：全有或全无，且内容相同的文件不重写。
  // 变化的是**强度** —— 原实现直写目标，第二个文件写失败时第一个已经落在
  // 目标位置，靠内存快照还原；现在所有 temp 写完才开始 rename，所以那类失败
  // 发生时目标一个都没被动过，根本用不到回滚。回滚只剩 rename 阶段兜底。
  writeFilesAtomic(files, { skipUnchanged: true })
}

export async function generateContractBundle(options = {}) {
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  const checked = await run({ specsRoot, config: options.config, write: false })
  if (checked.errors > 0) {
    throw new Error(`canonical checker 失败（${checked.errors} 个缺陷）；未修改 bundle`)
  }
  const { config } = checked
  if (!config.bundle) throw new Error('config 缺少 bundle 配置')
  if (!Array.isArray(config.bundle.inputs) || config.bundle.inputs.length === 0) {
    throw new Error('bundle.inputs 必须是非空数组')
  }

  const generatedRoot = resolveInside(specsRoot, config.generatedDir, 'generatedDir')
  const outputPath = resolveInside(specsRoot, config.bundle.output, 'bundle.output')
  const manifestPath = resolveInside(specsRoot, config.bundle.manifest, 'bundle.manifest')
  if (!isInside(generatedRoot, outputPath) || !isInside(generatedRoot, manifestPath)) {
    throw new Error('bundle.output 与 bundle.manifest 必须位于 generatedDir 内')
  }
  if (outputPath === manifestPath) throw new Error('bundle.output 与 bundle.manifest 不能是同一文件')

  const YAML = await loadYamlLib(specsRoot)
  const inputNames = [...new Set(config.bundle.inputs)].sort()
  const contracts = {}
  let suite = null
  for (const rel of inputNames) {
    const inputPath = resolveInside(specsRoot, rel, 'bundle input')
    if (isInside(generatedRoot, inputPath)) throw new Error(`派生产物不能作为 canonical input：${rel}`)
    if (!fs.existsSync(inputPath)) throw new Error(`canonical input 不存在：${rel}`)
    let doc
    try {
      doc = YAML.parse(readText(inputPath))
    } catch (error) {
      throw new Error(`canonical input 无法解析（${rel}）：${error.message}`)
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`canonical input 必须是对象：${rel}`)
    const inputSuite = doc.meta?.suite
    if (typeof inputSuite === 'string' && inputSuite !== '') {
      if (suite !== null && suite !== inputSuite) throw new Error(`canonical inputs 的 meta.suite 不一致：${suite} / ${inputSuite}`)
      suite = inputSuite
    }
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'meta' || key === 'gaps') continue
      if (!Array.isArray(value)) throw new Error(`${rel} 的顶层集合 ${key} 不是数组`)
      contracts[key] ??= []
      contracts[key].push(...value)
    }
  }
  if (!suite) throw new Error('canonical inputs 缺少非空 meta.suite')

  validateSources({ contracts, config, defs: checked.idRefResult.defs ?? new Map(), generatedRoot, specsRoot })
  const bundle = canonicalize({ schemaVersion: 1, suite, contracts })
  const manifest = {
    schemaVersion: 1,
    inputs: inputNames.map((rel) => toPosix(rel)),
    outputs: [posixRelative(generatedRoot, outputPath)],
  }
  const bundleBytes = `${JSON.stringify(bundle, null, 2)}\n`
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
  writeAllAfterValidation([
    { target: outputPath, content: bundleBytes },
    { target: manifestPath, content: manifestBytes },
  ])
  return { bundlePath: outputPath, manifestPath, bundleBytes, manifestBytes }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) { process.stdout.write(HELP); return 0 }
    const result = await generateContractBundle(options)
    process.stdout.write(`generated ${toPosix(result.bundlePath)}\n`)
    process.stdout.write(`manifest ${toPosix(result.manifestPath)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`生成失败：${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => process.exit(code))
