// 只读 repository inspection。
//
// 这个模块只报告文件系统里能观察到的 adoption artifact。它不根据目录名字
// 猜“这是金融系统”，也不把两个 adapter 的存在猜成 shared contract。

import fs from 'node:fs'
import path from 'node:path'

import { isInside } from '../shared/paths.mjs'
import { ADOPTION_SCHEMA_VERSION } from './model.mjs'

const CONFIG_REL = 'spec-suite.config.json'
const UNRESOLVED_REL = '.spec-suite/unresolved.yaml'
const MANIFEST_REL = 'generated/manifest.json'

const CANONICAL_CANDIDATES = [
  'contracts/agent-entry.yaml',
  'agent-entry.yaml',
]

// 这是“可观察到的 agent 入口”，不是 shared contract 的证明。
const AGENT_ADAPTER_CANDIDATES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.cursor/rules',
  '.windsurfrules',
  '.gemini/GEMINI.md',
]

const asPosix = (value) => value.split(path.sep).join('/')

function exists(root, rel) {
  return fs.existsSync(path.resolve(root, rel))
}

function fileExists(root, rel) {
  try {
    return fs.statSync(path.resolve(root, rel)).isFile()
  } catch {
    return false
  }
}

function safeRelative(root, value, label, issues) {
  if (typeof value !== 'string' || value.trim() === '') return null
  if (path.isAbsolute(value)) {
    issues.push({
      code: `${label}-absolute-path`,
      message: `${label} 声明了绝对路径，adopt 不把它当作项目内 artifact：${value}`,
    })
    return null
  }
  const absolute = path.resolve(root, value)
  if (!isInside(root, absolute)) {
    issues.push({
      code: `${label}-path-escapes-root`,
      message: `${label} 越出项目根目录，adopt 不读取它：${value}`,
    })
    return null
  }
  const relative = asPosix(path.relative(root, absolute))
  return relative === '' ? null : relative
}

function readConfig(root, issues) {
  const present = exists(root, CONFIG_REL)
  if (!present) return { present: false, parseable: false, doc: null }

  let doc
  try {
    doc = JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'))
  } catch (error) {
    issues.push({
      code: 'config-not-parseable',
      message: `spec-suite.config.json 无法解析：${error.message}`,
    })
    return { present: true, parseable: false, doc: null }
  }
  if (!doc || Array.isArray(doc) || typeof doc !== 'object') {
    issues.push({
      code: 'config-not-object',
      message: 'spec-suite.config.json 必须是 JSON 对象。',
    })
    return { present: true, parseable: false, doc: null }
  }
  return { present: true, parseable: true, doc }
}

function inspectCanonicalEntry(root, config, issues) {
  const declaredValue = config?.agentEntry?.source
  const hasDeclaredSource = typeof declaredValue === 'string' && declaredValue.trim() !== ''
  const declared = safeRelative(root, declaredValue, 'agentEntry.source', issues)
  // 一旦 config 明确声明了 source，就不能因为它无效/缺失而退回到一个“看起来
  // 常见”的候选路径。否则 malformed canonical config 会被隐藏 fallback 洗成
  // full adoption。
  if (hasDeclaredSource) {
    return {
      path: declared && fileExists(root, declared) ? declared : null,
      declared: true,
    }
  }

  const candidates = []
  for (const candidate of CANONICAL_CANDIDATES) {
    if (fileExists(root, candidate) && !candidates.includes(candidate)) candidates.push(candidate)
  }
  return {
    path: candidates[0] ?? null,
    declared: false,
  }
}

function inspectDictionaries(root, config, issues) {
  const declared = Array.isArray(config?.dictionaries)
    ? config.dictionaries
      .map((value) => safeRelative(root, value, 'dictionaries', issues))
      .filter(Boolean)
    : []
  return {
    declared,
    present: declared.filter((rel) => fileExists(root, rel)),
  }
}

/**
 * @param {string} repoRoot
 * @returns {object} deterministic, relative-path-only observation
 */
export function inspectRepository(repoRoot = '.') {
  const root = path.resolve(repoRoot)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目根目录不存在或不是目录：${root}`)
  }

  const issues = []
  const config = readConfig(root, issues)
  const canonicalAgentEntry = inspectCanonicalEntry(root, config.doc, issues)
  const dictionaries = inspectDictionaries(root, config.doc, issues)
  const unresolvedPresent = fileExists(root, UNRESOLVED_REL)
  const manifestPresent = fileExists(root, MANIFEST_REL)
  const agentAdapters = AGENT_ADAPTER_CANDIDATES.filter((rel) => exists(root, rel))

  if (config.present && config.parseable && canonicalAgentEntry.path === null) {
    issues.push({
      code: 'canonical-agent-entry-not-found',
      message: '发现 spec-suite.config.json，但找不到可观察到的 canonical agent entry。',
    })
  } else if (config.present && config.parseable && !canonicalAgentEntry.declared) {
    issues.push({
      code: 'canonical-agent-entry-not-declared',
      message: '发现 agent entry 候选文件，但 spec-suite.config.json 没有用 agentEntry.source 声明它。',
    })
  }

  // full adoption 的判断只使用可解析 config 与它显式声明且实际存在的 agent entry。
  // 一个碰巧位于常见路径的文件不是 canonical source；它可以被报告为候选，但不能
  // 把半完成 adoption 洗成 no-op。这里仍不验证文件语义，也不把 manifest 当 source。
  const fullAdoption = config.present
    && config.parseable
    && canonicalAgentEntry.declared
    && canonicalAgentEntry.path !== null

  return {
    schemaVersion: ADOPTION_SCHEMA_VERSION,
    fullAdoption,
    lightweightState: unresolvedPresent,
    agentAdapters,
    artifacts: {
      config: {
        path: CONFIG_REL,
        present: config.present,
        parseable: config.parseable,
      },
      unresolvedRegistry: {
        path: UNRESOLVED_REL,
        present: unresolvedPresent,
      },
      canonicalAgentEntry: {
        path: canonicalAgentEntry.path,
        present: canonicalAgentEntry.path !== null,
        declared: canonicalAgentEntry.declared,
      },
      dictionaries,
      generatedManifest: {
        path: MANIFEST_REL,
        present: manifestPresent,
      },
    },
    issues,
  }
}
