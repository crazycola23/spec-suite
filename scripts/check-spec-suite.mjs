#!/usr/bin/env node
/**
 * check-spec-suite.mjs —— 规格套件一致性检查器
 *
 * 七类检查：
 *   1  schema 符合性（含 source 必填、残留 <...> 占位符、幂等键元组提取）
 *   2  状态机闭合
 *   3  ID 引用完整性（悬空 + 孤儿；mayLackDefinition 的命名空间算合法未决）
 *   4  两区制比对（生成区逐字节）
 *   5  N-xx 禁令覆盖
 *   6  禁止复制中文标签
 *   7  覆盖矩阵完整性（某类 ID 必须全部出现在指定覆盖文件里）
 *
 * 用法：
 *   node check-spec-suite.mjs [--specs-root <路径>] [--config <路径>]
 *                             [--report <输出目录>] [--write-generated-regions] [--quiet]
 *
 *   --write-generated-regions  只重写 .md 生成区；不生成 contract bundle
 *   --report  把 report.json + report.md 写到指定目录（不写入被检查的库）
 *
 * 退出码：有 error 级发现 → 1，否则 0。
 *
 * 计数一律派生后报告，不作为断言（见 SKILL.md 铁律 2）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 显式 UTF-8 + 去 BOM。Windows + 中文文件名下必须这样读。 */
export function readText(abs) {
  const t = fs.readFileSync(abs, 'utf8')
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

export function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** glob → RegExp。支持 ** / * / ?，路径一律用 / 分隔。 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchesAny(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel))
}

const PRUNE_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode', 'target', 'dist', 'build'])

/** 递归列出 specsRoot 下的相对路径（posix 风格）。 */
export function walkFiles(root) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? path.join(root, rel) : root
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue
        stack.push(childRel)
      } else if (e.isFile()) {
        out.push(childRel)
      }
    }
  }
  return out.sort()
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CJK_RE = /[㐀-䶿一-鿿　-〿＀-￯]/

// ---------------------------------------------------------------------------
// 发现（finding）
// ---------------------------------------------------------------------------

export function makeCollector() {
  const findings = []
  const stats = {}
  return {
    findings,
    stats,
    add(check, severity, message, where) {
      findings.push({ check, severity, message, ...(where ?? {}) })
    },
    stat(check, key, value) {
      ;(stats[check] ??= {})[key] = value
    },
  }
}

// ---------------------------------------------------------------------------
// 依赖与配置
// ---------------------------------------------------------------------------

export async function loadYamlLib(specsRoot) {
  try {
    const m = await import('yaml')
    return m.default ?? m
  } catch { /* 本 skill 目录没装，去被检查的库里找 */ }
  for (const base of [specsRoot, process.cwd()]) {
    try {
      const req = createRequire(pathToFileURL(path.join(base, 'package.json')).href)
      return req('yaml')
    } catch { /* 继续 */ }
  }
  throw new Error('找不到 yaml 依赖。在规格库里执行 `npm i yaml@^2`，或指定一个已装 yaml 的 --specs-root。')
}

const DEFAULT_CONFIG_NAMES = ['spec-suite.config.json', 'scripts/spec-suite.config.json']

export function loadConfig({ specsRoot, configPath, fallbackConfigPath }) {
  let used = null
  const candidates = configPath
    ? [configPath]
    : DEFAULT_CONFIG_NAMES.map((n) => path.join(specsRoot, n))
  for (const c of candidates) {
    if (fs.existsSync(c)) { used = c; break }
  }
  if (!used && fallbackConfigPath && fs.existsSync(fallbackConfigPath)) used = fallbackConfigPath
  if (!used) throw new Error('找不到 spec-suite.config.json。用 --config 指定。')
  const cfg = JSON.parse(readText(used))
  return {
    configPath: used,
    isFallback: used === fallbackConfigPath,
    dictionaries: cfg.dictionaries ?? [],
    generatedDir: cfg.generatedDir ?? 'generated',
    claudeMd: cfg.claudeMd ?? 'CLAUDE.md',
    agentEntry: cfg.agentEntry ?? null,
    bundle: cfg.bundle ?? null,
    idNamespaces: (cfg.idNamespaces ?? []).map((n) => ({ ...n, re: new RegExp(n.pattern) })),
    projections: cfg.projections ?? {},
    structuredFileGlobs: cfg.structuredFileGlobs ?? ['**/*.yaml', '**/*.yml', '**/*.json', '**/*.csv'],
    markdownGlobs: cfg.markdownGlobs ?? ['**/*.md'],
    ddlGlobs: cfg.ddlGlobs ?? ['**/*.sql'],
    excludeFromScan: cfg.excludeFromScan ?? ['node_modules/**', 'generated/**'],
    labelCopyAllowlist: cfg.labelCopyAllowlist ?? [],
    coverageRequirements: cfg.coverageRequirements ?? [],
  }
}

// ---------------------------------------------------------------------------
// 模型：把所有字典 yaml 读成统一的集合视图
// ---------------------------------------------------------------------------

/**
 * @returns {{collections: Record<string, Array<{value:any,file:string,index:number}>>,
 *            files: Record<string, {doc:any, text:string}>, missing: string[]}}
 */
export function buildModel({ specsRoot, config, YAML, col }) {
  const collections = {}
  const files = {}
  const missing = []

  for (const rel of config.dictionaries) {
    const abs = path.join(specsRoot, rel)
    if (!fs.existsSync(abs)) { missing.push(rel); continue }
    const text = readText(abs)
    let doc
    try {
      doc = YAML.parse(text)
    } catch (e) {
      col?.add(1, 'error', `YAML 解析失败：${e.message}`, { file: rel })
      continue
    }
    files[rel] = { doc, text }
    if (!doc || typeof doc !== 'object') continue
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'meta') continue
      const list = Array.isArray(value) ? value : null
      if (!list) {
        col?.add(1, 'error', `顶层节点 \`${key}\` 不是数组。所有集合都必须是对象数组（SCHEMA.md §1.1）`, { file: rel })
        continue
      }
      collections[key] ??= []
      list.forEach((v, i) => collections[key].push({ value: v, file: rel, index: i }))
    }
  }
  let agentEntry = null
  if (config.agentEntry?.source) {
    const rel = config.agentEntry.source
    const abs = path.join(specsRoot, rel)
    if (!fs.existsSync(abs)) {
      col?.add(1, 'error', `agentEntry.source 不存在：\`${rel}\``, { file: rel })
    } else {
      try {
        agentEntry = YAML.parse(readText(abs))
      } catch (e) {
        col?.add(1, 'error', `Agent Entry Contract YAML 解析失败：${e.message}`, { file: rel })
      }
    }
  }
  return { collections, files, missing, agentEntry }
}

// ---------------------------------------------------------------------------
// 检查 1：schema 符合性
// ---------------------------------------------------------------------------

/** 每种记录类型的必填键。children 指定嵌套集合的类型名。 */
export const RECORD_RULES = {
  enums: { required: ['code', 'label', 'source'], children: { values: 'enums.values' } },
  'enums.values': { required: ['code', 'label', 'source'] },
  stateMachines: { required: ['code', 'label', 'source'], children: { states: 'stateMachines.states' } },
  'stateMachines.states': {
    required: ['code', 'label', 'source', 'terminal', 'transitions'],
    children: { transitions: 'stateMachines.states.transitions' },
  },
  'stateMachines.states.transitions': { keyField: 'to', required: ['to', 'trigger', 'source'] },
  gaps: {
    required: ['code', 'missing', 'blocks', 'protectiveDefault', 'rollbackCost', 'owner', 'status'],
  },
  errors: { required: ['code', 'httpStatus', 'class', 'label', 'source'] },
  permissions: { required: ['code', 'label', 'source', 'risk', 'inheritable'] },
  frontendRedLines: { required: ['code', 'label', 'source'] },
  idempotencyKeys: { required: ['code', 'table', 'columns', 'source'] },
}

const PLACEHOLDER_RE = /<[^<>\n]{1,60}>/

export function checkSchema({ model, col }) {
  let records = 0
  let missingSource = 0
  let placeholders = 0

  const visit = (typeName, items, file, trail) => {
    const rule = RECORD_RULES[typeName]
    items.forEach((item, i) => {
      const at = `${trail}[${i}]`
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        col.add(1, 'error',
          `\`${at}\` 是${Array.isArray(item) ? '数组' : typeof item}，不是对象。不允许裸字符串集合（SCHEMA.md §1.1）`,
          { file })
        return
      }
      records++
      const keyField = rule?.keyField ?? 'code'
      if (item[keyField] === undefined || item[keyField] === null || item[keyField] === '') {
        col.add(1, 'error', `\`${at}\` 缺 \`${keyField}\`。每条记录必带标识键（SCHEMA.md §1.1）`, { file })
      }
      for (const k of rule?.required ?? []) {
        if (!(k in item)) {
          col.add(1, 'error', `\`${at}\`（${item[keyField] ?? '?'}）缺必填键 \`${k}\``, { file })
          if (k === 'source') missingSource++
        }
      }
      // source 存在但为空，等同于没写
      if ('source' in item && (item.source === null || item.source === '')) {
        col.add(1, 'error', `\`${at}\`（${item[keyField] ?? '?'}）的 \`source\` 为空。空 source 等于没有出处，N-01 嫌疑`, { file })
        missingSource++
      }
      // 残留占位符
      for (const [k, v] of Object.entries(item)) {
        if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
          placeholders++
          col.add(1, 'error',
            `\`${at}.${k}\` 仍是未替换的占位符：${v.trim()}。半填的模板比没有模板更危险`, { file })
        }
      }
      for (const [childKey, childType] of Object.entries(rule?.children ?? {})) {
        const child = item[childKey]
        if (child === undefined) continue
        if (!Array.isArray(child)) {
          col.add(1, 'error', `\`${at}.${childKey}\` 不是数组`, { file })
          continue
        }
        visit(childType, child, file, `${at}.${childKey}`)
      }
    })
  }

  for (const [key, entries] of Object.entries(model.collections)) {
    if (!RECORD_RULES[key]) {
      col.add(1, 'info', `集合 \`${key}\` 没有登记记录类型，只做通用校验（对象数组 + code）`, { file: entries[0]?.file })
    }
    // 按文件分组保留出处
    const byFile = new Map()
    for (const e of entries) {
      if (!byFile.has(e.file)) byFile.set(e.file, [])
      byFile.get(e.file).push(e.value)
    }
    for (const [file, items] of byFile) visit(key, items, file, key)
  }

  col.stat(1, '记录总数', records)
  col.stat(1, 'source 缺失或为空', missingSource)
  col.stat(1, '残留占位符', placeholders)
  if (model.agentEntry !== null) {
    if (model.agentEntry?.schemaVersion !== 1) {
      col.add(1, 'error', 'Agent Entry Contract 的 `schemaVersion` 必须是 1')
    }
    if (typeof model.agentEntry?.common?.markdown !== 'string' || model.agentEntry.common.markdown.trim() === '') {
      col.add(1, 'error', 'Agent Entry Contract 缺少非空的 `common.markdown`')
    }
  }
  return { records, missingSource, placeholders }
}

/**
 * 检查 1e：从 DDL 提取幂等键列元组。
 *
 * 有 idempotencyKeys: 声明 → 逐表比对（机器断言）。
 * 没有声明 → 只把提取到的元组列进报告，并明确写"只能人工比对"。
 * 后一种情况下这个缺陷类**抓不到**，不假装抓到。
 */
export function checkIdempotencyTuples({ specsRoot, config, model, col }) {
  const declared = new Map()
  for (const e of model.collections.idempotencyKeys ?? []) {
    const v = e.value
    if (v && typeof v === 'object' && v.table) declared.set(String(v.table), v)
  }

  const files = walkFiles(specsRoot).filter(
    (r) => matchesAny(r, config.ddlGlobs) && !matchesAny(r, config.excludeFromScan))

  const extracted = []
  for (const rel of files) {
    const text = readText(path.join(specsRoot, rel))
    let table = null
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]
      const ct = t.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z0-9_]+)[`"]?/i)
      if (ct) table = ct[1]
      if (!/GENERATED\s+ALWAYS\s+AS/i.test(t)) continue
      const colName = t.match(/^\s*[`"]?([A-Za-z0-9_]+)[`"]?\s/)?.[1] ?? '?'
      // 表达式可能跨行，取到本行为止再补后续行直到括号配平
      let expr = t.slice(t.search(/GENERATED\s+ALWAYS\s+AS/i))
      let depth = (expr.match(/\(/g) ?? []).length - (expr.match(/\)/g) ?? []).length
      let j = i
      while (depth > 0 && ++j < lines.length) {
        expr += '\n' + lines[j]
        depth += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length
      }
      const cols = []
      // 去掉字符串字面量，再取标识符；排除函数名（后随 "("）和 SQL 关键字
      const stripped = expr.replace(/'(?:[^']|'')*'/g, '')
      const idRe = /[`]?([A-Za-z_][A-Za-z0-9_]*)[`]?/g
      let m
      while ((m = idRe.exec(stripped))) {
        if (/^\s*\(/.test(stripped.slice(m.index + m[0].length))) continue
        if (/^(GENERATED|ALWAYS|AS|STORED|VIRTUAL|NOT|NULL|PERSISTED)$/i.test(m[1])) continue
        cols.push(m[1])
      }
      extracted.push({ file: rel, line: i + 1, table, column: colName, columns: cols })
    }
  }

  col.stat(1, 'DDL 生成列元组', extracted.length)

  if (declared.size === 0) {
    if (extracted.length > 0) {
      col.add(1, 'info',
        `字典里没有 \`idempotencyKeys:\` 声明，幂等键元组无法机器比对。` +
        `从 DDL 提取到 ${extracted.length} 组，需人工与契约/散文里的说法逐一核对：\n` +
        extracted.map((e) => `    ${e.table}.${e.column} = (${e.columns.join(', ')})  ← ${e.file}:${e.line}`).join('\n'))
    }
    return { extracted, compared: 0 }
  }

  let compared = 0
  for (const e of extracted) {
    const d = declared.get(e.table)
    if (!d) {
      col.add(1, 'warn', `DDL 里 \`${e.table}\` 有生成列 \`${e.column}\`，但字典 \`idempotencyKeys\` 未声明该表`,
        { file: e.file, line: e.line })
      continue
    }
    compared++
    const want = (d.columns ?? []).map(String)
    const got = e.columns.filter((c) => c !== e.column)
    if (want.join('|') !== got.join('|')) {
      col.add(1, 'error',
        `幂等键列元组不一致：\`${e.table}\` 声明 (${want.join(', ')})，DDL \`${e.column}\` 实际 (${got.join(', ')})。` +
        `以真相源 \`${d.source}\` 为准，另一边是缺陷`, { file: e.file, line: e.line })
    }
  }
  for (const [table, d] of declared) {
    if (!extracted.some((e) => e.table === table)) {
      col.add(1, 'warn', `字典声明了 \`${table}\` 的幂等键 (${(d.columns ?? []).join(', ')})，DDL 里没有对应生成列 —— 幂等在应用层实现即为缺陷（conventions.md §5）`)
    }
  }
  col.stat(1, '幂等键已比对', compared)
  return { extracted, compared }
}

// ---------------------------------------------------------------------------
// 检查 2：状态机闭合
// ---------------------------------------------------------------------------

export function checkStateMachines({ model, col }) {
  const machines = model.collections.stateMachines ?? []
  let transitions = 0
  for (const { value: m, file } of machines) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.states)) continue
    const codes = new Set(m.states.map((s) => s?.code).filter(Boolean))
    const inbound = new Set()
    for (const s of m.states) {
      if (!s || typeof s !== 'object') continue
      const trs = Array.isArray(s.transitions) ? s.transitions : []
      transitions += trs.length
      for (const t of trs) {
        const to = t?.to
        if (to === undefined) continue
        inbound.add(to)
        if (!codes.has(to)) {
          col.add(2, 'error',
            `\`${m.code}.${s.code}\` 有迁移指向不存在的状态 \`${to}\`。现有状态：${[...codes].join(', ')}`,
            { file })
        }
      }
      if (s.terminal === true && trs.length > 0) {
        col.add(2, 'error', `\`${m.code}.${s.code}\` 标了 \`terminal: true\` 却有 ${trs.length} 条出边`, { file })
      }
      if (s.terminal === false && trs.length === 0) {
        col.add(2, 'error',
          `\`${m.code}.${s.code}\` 是 \`terminal: false\` 却没有出边 —— 要么它是终态，要么迁移漏写了。` +
          `保护性默认是标 \`terminal: true\` + \`transitions: []\`（少一条迁移可以后加，多一条已发生的迁移无法撤销）`,
          { file })
      }
    }
    const first = m.states[0]?.code
    for (const s of m.states) {
      if (!s?.code || s.code === first) continue
      if (!inbound.has(s.code)) {
        col.add(2, 'warn', `\`${m.code}.${s.code}\` 没有任何入边，且不是首状态 —— 不可达`, { file })
      }
    }
  }
  col.stat(2, '状态机', machines.length)
  col.stat(2, '迁移', transitions)
  return { machines: machines.length, transitions }
}

// ---------------------------------------------------------------------------
// 检查 3：ID 引用完整性
// ---------------------------------------------------------------------------

/** 全锚定匹配 + 词边界，一次解掉子串碰撞、命名空间碰撞、同前缀多命名空间三个陷阱。 */
export const ID_TOKEN_RE = /(?<![A-Za-z0-9-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![A-Za-z0-9-])/g

export function extractIdTokens(line) {
  return [...line.matchAll(ID_TOKEN_RE)].map((m) => m[0])
}

/** 在 definedIn 文件里，什么位置算"定义"而不是"引用"。 */
export function isDefinitionSite(line, token) {
  const t = escapeRe(token)
  return new RegExp(`^\\s{0,3}#{1,6}\\s+.*${t}`).test(line)                       // 标题
    || new RegExp(`^\\s*\\|\\s*[\`*]{0,3}${t}`).test(line)                        // 表格首列
    || new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?[\`*]{0,3}${t}\\b`).test(line) // 行首 / 列表项开头
}

export function checkIdRefs({ specsRoot, config, model, col }) {
  const ns = config.idNamespaces
  if (ns.length === 0) {
    col.add(3, 'warn', 'config 里没有 idNamespaces，引用完整性检查跳过')
    return { namespaces: [] }
  }

  // 命名空间歧义：同一个 token 匹配多个 pattern，说明 config 的正则不够锚定
  const nsFor = (token) => ns.filter((n) => n.re.test(token))

  /** token -> {ns, file} */
  const defs = new Map()
  const defSites = new Set() // `${file}:${line}:${token}`

  // (a) 字典里的 code 就是定义
  const collectCodes = (items, file) => {
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      for (const [k, v] of Object.entries(it)) {
        // 认 code（唯一合法键）也认 id：某条记录若误用 `id:` 而非 `code:`，
        // 检查 1 已按 keyField 报"缺 code"（根因，报一次）；这里同时把它登记为定义，
        // 免得检查 3 又把它的每个引用重复报成"悬空"（同一根因的下游噪声）。
        if ((k === 'code' || k === 'id') && typeof v === 'string') {
          const hits = nsFor(v)
          if (hits.length === 1 && !defs.has(v)) defs.set(v, { ns: hits[0], file })
        } else if (Array.isArray(v)) {
          collectCodes(v.filter((x) => x && typeof x === 'object'), file)
        }
      }
    }
  }
  for (const entries of Object.values(model.collections)) {
    const byFile = new Map()
    for (const e of entries) {
      if (!byFile.has(e.file)) byFile.set(e.file, [])
      byFile.get(e.file).push(e.value)
    }
    for (const [file, items] of byFile) collectCodes(items, file)
  }

  // (b) definedIn 里的定义位置
  const all = walkFiles(specsRoot)
  for (const n of ns) {
    const globs = n.definedIn ?? []
    if (globs.length === 0) continue
    for (const rel of all) {
      if (!matchesAny(rel, globs) || matchesAny(rel, config.excludeFromScan)) continue
      const lines = readText(path.join(specsRoot, rel)).split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const tok of extractIdTokens(line)) {
          if (!n.re.test(tok)) continue
          if (!isDefinitionSite(line, tok)) continue
          defSites.add(`${rel}:${i + 1}:${tok}`)
          if (!defs.has(tok)) defs.set(tok, { ns: n, file: rel })
        }
      })
    }
  }

  // (c) 全库引用扫描
  const scanGlobs = [...config.markdownGlobs, ...config.structuredFileGlobs]
  const refs = new Map()   // token -> [{file, line}]
  const ambiguous = new Map()
  let sites = 0
  for (const rel of all) {
    if (!matchesAny(rel, scanGlobs) || matchesAny(rel, config.excludeFromScan)) continue
    const lines = readText(path.join(specsRoot, rel)).split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const tok of extractIdTokens(line)) {
        const hits = nsFor(tok)
        if (hits.length === 0) continue
        if (hits.length > 1) { ambiguous.set(tok, hits.map((h) => h.pattern)); continue }
        if (defSites.has(`${rel}:${i + 1}:${tok}`)) continue
        sites++
        if (!refs.has(tok)) refs.set(tok, [])
        refs.get(tok).push({ file: rel, line: i + 1 })
      }
    })
  }

  for (const [tok, pats] of ambiguous) {
    col.add(3, 'error',
      `\`${tok}\` 同时匹配多个 idNamespaces 正则（${pats.join(' / ')}）。pattern 必须完全锚定到互斥（SCHEMA.md §5.1）`)
  }

  // 悬空
  const dangling = []
  const pending = []
  for (const [tok, at] of refs) {
    if (defs.has(tok)) continue
    // refs 里的 token 必然恰好命中一个命名空间（多命中的进了 ambiguous，无命中的没进 refs）
    const namespace = nsFor(tok)[0]
    if (namespace?.mayLackDefinition) {
      pending.push({ token: tok, count: at.length, first: at[0] })
      col.add(3, 'warn',
        `\`${tok}\`（${at.length} 处）引用了尚无定义文件的 ID。该命名空间声明了 \`mayLackDefinition\` —— ` +
        `合法未决（例：会开了、方向定了、还没落成裁决单文件的 T-OPEN 项），不算悬空；落成文件时自动转正`, at[0])
      continue
    }
    dangling.push({ token: tok, count: at.length, first: at[0] })
    col.add(3, 'error', `悬空引用 \`${tok}\`（${at.length} 处）：定义不存在`, at[0])
  }

  // 孤儿：定义了但在别的文件里无人引用
  const orphans = []
  for (const [tok, d] of defs) {
    const at = refs.get(tok) ?? []
    if (at.some((r) => r.file !== d.file)) continue
    orphans.push({ token: tok, file: d.file })
  }
  if (orphans.length) {
    col.add(3, 'warn',
      `${orphans.length} 个 ID 定义了却无人引用（孤儿）。常见成因是缺口关闭时漏了第 6 步补验收条件、第 7 步补追溯记录：\n` +
      orphans.map((o) => `    ${o.token}  ← 定义于 ${o.file}`).join('\n'))
  }

  const perNs = ns.map((n) => {
    const d = [...defs.values()].filter((x) => x.ns === n).length
    const r = [...refs.entries()].filter(([t]) => n.re.test(t)).reduce((a, [, v]) => a + v.length, 0)
    return { prefix: n.prefix, pattern: n.pattern, defined: d, refSites: r }
  })
  col.stat(3, '定义总数', defs.size)
  col.stat(3, '引用点总数', sites)
  col.stat(3, '悬空', dangling.length)
  if (pending.length) col.stat(3, '合法未决（mayLackDefinition）', pending.length)
  col.stat(3, '孤儿', orphans.length)
  for (const p of perNs) col.stat(3, `  ${p.prefix}（${p.pattern}）`, `定义 ${p.defined} / 引用 ${p.refSites}`)

  return { defs, refs, dangling, pending, orphans, perNs, sites }
}

// ---------------------------------------------------------------------------
// 检查 7：覆盖矩阵完整性
// ---------------------------------------------------------------------------

/**
 * 检查 7：某一类 ID 必须全部出现在指定的覆盖文件里。
 *
 * 补的是检查 3 结构上抓不到的一类漂移：一个 BR 被定义、也被别处引用
 * （所以既不悬空也不孤儿），却漏在追溯矩阵里 —— 关闭缺口时漏了"补追溯
 * 记录行"那一步。检查 3 看引用图的连通性，看不到"有没有进那张指定的表"。
 * skill 自己的 10 步关闭程序里就有这一步，却一直没有断言强制它。
 *
 * 由 config.coverageRequirements 驱动，每条形如：
 *   { namespace: "BR", mustAppearIn: "50-delivery/11-*.csv", severity: "warn" }
 * 没有任何要求时本检查 no-op（报一条 info）。L2 起、有了追溯矩阵才配。
 *
 * 默认 severity 是 warn 不是 error：矩阵里合法地可以暂时缺一条（某 BR 刚
 * 回填、AC 还没补）。做成硬 error 会重蹈检查 6 的覆辙 —— 被逼到关掉。
 * 要当闸门，在 requirement 里显式写 severity: "error"。
 *
 * 依赖检查 3 的 defs：只对"已定义"的 ID 要求覆盖。标了 mayLackDefinition
 * 的命名空间（合法未决、还没有定义文件）整体跳过 —— 还没到该被覆盖的阶段。
 */
export function checkCoverageMatrix({ specsRoot, config, idRefResult, col }) {
  const reqs = config.coverageRequirements ?? []
  if (reqs.length === 0) {
    col.add(7, 'info', 'config 里没有 coverageRequirements —— 覆盖矩阵完整性检查跳过（L2 起、有追溯矩阵时才配）')
    return { requirements: [] }
  }
  const defs = idRefResult?.defs ?? new Map()
  const nsByPrefix = new Map(config.idNamespaces.map((n) => [n.prefix, n]))
  const all = walkFiles(specsRoot)
  const results = []
  for (const req of reqs) {
    const ns = nsByPrefix.get(req.namespace)
    const severity = req.severity === 'error' ? 'error' : 'warn'
    if (!ns) {
      col.add(7, 'error', `coverageRequirements 里的命名空间 \`${req.namespace}\` 未在 idNamespaces 声明`)
      continue
    }
    if (ns.mayLackDefinition) {
      col.add(7, 'info', `\`${req.namespace}\` 标了 mayLackDefinition，跳过覆盖要求 —— 还没到该被覆盖的阶段`)
      continue
    }
    const files = all.filter((r) => matchesAny(r, [req.mustAppearIn]) && !matchesAny(r, config.excludeFromScan))
    if (files.length === 0) {
      col.add(7, severity,
        `覆盖要求 \`${req.namespace}\` → \`${req.mustAppearIn}\`：没有文件匹配这个 glob。矩阵不存在 = 该类 ID 一条都没被覆盖`)
      continue
    }
    const present = new Set()
    for (const rel of files) {
      for (const line of readText(path.join(specsRoot, rel)).split(/\r?\n/)) {
        for (const tok of extractIdTokens(line)) if (ns.re.test(tok)) present.add(tok)
      }
    }
    const defined = [...defs.entries()].filter(([, d]) => d.ns === ns).map(([tok]) => tok)
    const missing = defined.filter((tok) => !present.has(tok))
    results.push({ namespace: req.namespace, file: req.mustAppearIn, defined: defined.length, missing })
    col.stat(7, `${req.namespace} → ${req.mustAppearIn}`, `覆盖 ${defined.length - missing.length}/${defined.length}`)
    if (missing.length) {
      col.add(7, severity,
        `${missing.length} 个 \`${req.namespace}\` 已定义却没进 \`${req.mustAppearIn}\`（被定义、也可能被别处引用，` +
        `所以检查 3 抓不到 —— 但没进覆盖矩阵，就是漏了关闭程序的补矩阵那一步）：\n` +
        missing.map((t) => `    ${t}`).join('\n'))
    }
  }
  return { requirements: results }
}

// ---------------------------------------------------------------------------
// 渲染器：yaml → 生成区表格
// ---------------------------------------------------------------------------

const cell = (v) => {
  if (v === undefined || v === null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join('、').replace(/\|/g, '\\|') : '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
]

const findByCode = (entries, code) => entries?.find((e) => e.value?.code === code)?.value

export const RENDERERS = {
  agentEntryCommon(model) {
    const markdown = model.agentEntry?.common?.markdown
    if (typeof markdown !== 'string' || markdown.trim() === '') return null
    return markdown.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  },

  // stateMachines.<code>.transitions
  transitionTable(model, parts) {
    const m = findByCode(model.collections.stateMachines, parts[1])
    if (!m) return null
    const rows = []
    for (const s of m.states ?? []) {
      const trs = Array.isArray(s?.transitions) ? s.transitions : []
      if (trs.length === 0) {
        rows.push([cell(s?.code), s?.terminal === true ? '—（终态）' : '—', '—', cell(s?.source)])
      } else {
        for (const t of trs) rows.push([cell(s?.code), cell(t?.to), cell(t?.trigger), cell(t?.source)])
      }
    }
    return table(['当前态', '可迁移到', '触发', '依据'], rows)
  },

  // enums.<code>.values
  enumTable(model, parts) {
    const e = findByCode(model.collections.enums, parts[1])
    if (!e) return null
    return table(['值', '含义', '依据'],
      (e.values ?? []).map((v) => [cell(v?.code), cell(v?.label), cell(v?.source)]))
  },

  errorTable(model) {
    const items = (model.collections.errors ?? []).map((e) => e.value)
    return table(['码', 'HTTP', '类别', '含义', '依据', '前端动作'],
      items.map((v) => [cell(v?.code), cell(v?.httpStatus), cell(v?.class), cell(v?.label), cell(v?.source), cell(v?.frontendAction)]))
  },

  permissionTable(model) {
    const items = (model.collections.permissions ?? []).map((e) => e.value)
    return table(['码', '含义', '风险', '可继承', '依据'],
      items.map((v) => [cell(v?.code), cell(v?.label), cell(v?.risk), cell(v?.inheritable), cell(v?.source)]))
  },

  redLineTable(model) {
    const items = (model.collections.frontendRedLines ?? []).map((e) => e.value)
    return table(['ID', '红线', '依据'], items.map((v) => [cell(v?.code), cell(v?.label), cell(v?.source)]))
  },

  gapTable(model) {
    const items = (model.collections.gaps ?? []).map((e) => e.value)
      .slice().sort((a, b) => String(a?.code).localeCompare(String(b?.code)))
    return table(['ID', '缺什么', '卡住的交付物', '保护性默认行为', '回滚代价', '责任', '状态'],
      items.map((v) => [cell(v?.code), cell(v?.missing), cell(v?.blocks), cell(v?.protectiveDefault),
        cell(v?.rollbackCost), cell(v?.owner), cell(v?.status)]))
  },
}

/** 把 config.projections 的带 * 键匹配到具体投影 ID。 */
export function resolveProjection(projections, id) {
  const parts = id.split('.')
  for (const [pattern, renderer] of Object.entries(projections)) {
    const pp = pattern.split('.')
    if (pp.length !== parts.length) continue
    if (pp.every((p, i) => p === '*' || p === parts[i])) return { renderer, parts, pattern }
  }
  return null
}

/** 列出模型里应当存在生成区的全部投影 ID。 */
export function enumerateProjections(model, projections) {
  const out = []
  for (const pattern of Object.keys(projections)) {
    const pp = pattern.split('.')
    if (!pp.includes('*')) {
      if (pattern === 'agent-entry.common' && model.agentEntry) {
        out.push(pattern)
        continue
      }
      if ((model.collections[pp[0]] ?? []).length > 0) out.push(pattern)
      continue
    }
    const [head, , tail] = pp
    for (const e of model.collections[head] ?? []) {
      const code = e.value?.code
      if (!code) continue
      const child = e.value?.[tail === 'transitions' ? 'states' : tail]
      if (tail === 'transitions' ? Array.isArray(child) : Array.isArray(e.value?.[tail])) {
        out.push(`${head}.${code}.${tail}`)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 检查 4：两区制比对
// ---------------------------------------------------------------------------

const BEGIN_RE = /^(\s*)<!--\s*BEGIN GENERATED:\s*(.+?)\s*-->\s*$/
const END_RE = /^(\s*)<!--\s*END GENERATED:\s*(.+?)\s*-->\s*$/

export function findZones(lines, { file, col } = {}) {
  const zones = []
  let open = null
  lines.forEach((line, i) => {
    const b = line.match(BEGIN_RE)
    if (b) {
      if (b[1].length > 0) col?.add(4, 'error', `生成区标记有缩进（第 ${i + 1} 行）—— 标记必须独占一行、行首无空白`, { file, line: i + 1 })
      if (open) col?.add(4, 'error', `生成区 \`${open.id}\` 未闭合就开始了 \`${b[2]}\` —— 不允许嵌套`, { file, line: i + 1 })
      open = { id: b[2], begin: i }
      return
    }
    const e = line.match(END_RE)
    if (e) {
      if (!open) { col?.add(4, 'error', `第 ${i + 1} 行有 END GENERATED 但没有对应的 BEGIN`, { file, line: i + 1 }); return }
      if (e[2] !== open.id) {
        col?.add(4, 'error', `生成区 ID 不匹配：BEGIN \`${open.id}\` / END \`${e[2]}\``, { file, line: open.begin + 1 })
      }
      zones.push({ id: open.id, begin: open.begin, end: i, body: lines.slice(open.begin + 1, i) })
      open = null
    }
  })
  if (open) col?.add(4, 'error', `生成区 \`${open.id}\` 没有 END GENERATED`, { file, line: open.begin + 1 })
  return zones
}

export function checkZones({ specsRoot, config, model, col, write = false }) {
  const all = walkFiles(specsRoot).filter(
    (r) => matchesAny(r, config.markdownGlobs) && !matchesAny(r, config.excludeFromScan))

  const seen = new Set()
  const ratios = []
  let zoneCount = 0
  let mismatched = 0
  let rewritten = 0

  for (const rel of all) {
    const abs = path.join(specsRoot, rel)
    const text = readText(abs)
    const lines = text.split(/\r?\n/)
    const zones = findZones(lines, { file: rel, col })
    if (zones.length === 0) {
      ratios.push({ file: rel, total: lines.length, zoneLines: 0, ratio: 0 })
      continue
    }
    zoneCount += zones.length
    let next = lines.slice()
    let shift = 0
    let zoneLines = 0

    for (const z of zones) {
      seen.add(z.id)
      zoneLines += z.body.length
      const p = resolveProjection(config.projections, z.id)
      if (!p) {
        col.add(4, 'error', `投影 ID \`${z.id}\` 未在 config.projections 注册`, { file: rel, line: z.begin + 1 })
        continue
      }
      const render = RENDERERS[p.renderer]
      if (!render) {
        col.add(4, 'error', `config 指定的渲染器 \`${p.renderer}\` 不存在。可用：${Object.keys(RENDERERS).join(', ')}`,
          { file: rel, line: z.begin + 1 })
        continue
      }
      const want = render(model, p.parts)
      if (!want) {
        col.add(4, 'error', `投影 \`${z.id}\` 在 yaml 里找不到对应记录 —— md 有、yaml 无`, { file: rel, line: z.begin + 1 })
        continue
      }
      if (want.join('\n') !== z.body.join('\n')) {
        mismatched++
        col.add(4, 'error',
          `生成区 \`${z.id}\` 与 yaml 不一致（区内 ${z.body.length} 行，应为 ${want.length} 行）。改 yaml 后重新生成，永不手改区内`,
          { file: rel, line: z.begin + 1 })
        if (write) {
          next.splice(z.begin + 1 + shift, z.body.length, ...want)
          shift += want.length - z.body.length
          rewritten++
        }
      }
    }
    ratios.push({ file: rel, total: lines.length, zoneLines, ratio: +(zoneLines / Math.max(lines.length, 1)).toFixed(3) })
    if (write && rewritten > 0 && next.join('\n') !== lines.join('\n')) {
      fs.writeFileSync(abs, next.join('\n'), 'utf8')
    }
  }

  // yaml 有、md 无 —— RL-05 那一类
  const expected = enumerateProjections(model, config.projections)
  const uncovered = expected.filter((id) => !seen.has(id))
  if (uncovered.length) {
    col.add(4, 'warn',
      `${uncovered.length} 个投影在 yaml 里存在但 md 里没有生成区（yaml 有、md 无，无人发现的那一类）：\n` +
      uncovered.map((id) => `    ${id}`).join('\n'))
  }

  if (zoneCount === 0 && all.length > 0) {
    const sorted = ratios.slice().sort((a, b) => b.total - a.total).slice(0, 12)
    col.add(4, 'info',
      `全库 ${all.length} 份 md 里没有任何生成区标记 —— 尚未迁移到两区制。\n` +
      `    按体量排前几份，用来估迁移成本（先迁表格占比高的收益最大）：\n` +
      sorted.map((r) => `    ${String(r.total).padStart(5)} 行  ${r.file}`).join('\n'))
  }

  col.stat(4, '生成区', zoneCount)
  col.stat(4, '不一致', mismatched)
  col.stat(4, 'yaml 有 / md 无', uncovered.length)
  if (write) col.stat(4, '已重写', rewritten)
  return { zoneCount, mismatched, uncovered, ratios, rewritten }
}

// ---------------------------------------------------------------------------
// 检查 5：N-xx 禁令覆盖
// ---------------------------------------------------------------------------

const VALID_STATES = ['✅', '⚠️ 部分', '⚠️ 技术债']

export function parseBanCoverage(text) {
  const lines = text.split(/\r?\n/)
  const bans = []
  const rows = []
  let inTable = false
  let stateIdx = -1
  let whereIdx = -1

  const addBan = (code, title, line) => {
    if (!bans.some((b) => b.code === code)) bans.push({ code, title, line })
  }

  lines.forEach((line, i) => {
    const h = line.match(/^#{2,4}\s*(N-\d{2})\b(.*)$/)
    if (h) addBan(h[1], h[2].trim(), i + 1)

    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim())
      if (cells.some((c) => /禁令/.test(c)) && cells.some((c) => /强制|方式/.test(c))) {
        inTable = true
        stateIdx = cells.findIndex((c) => /状态/.test(c))
        whereIdx = cells.findIndex((c) => /在哪跑|哪跑|运行/.test(c))
        return
      }
      if (inTable) {
        if (/^\|[\s:-]+\|/.test(line)) return
        rows.push({ cells, line: i + 1 })
        return
      }
      // 禁令也可能只以表格行的形式定义（无 ### 小节）。首列恰好是一个 N-xx 即算定义。
      const first = cells[0] ?? ''
      const m = first.match(/^[`*]{0,3}(N-\d{2})[`*]{0,3}$/)
      if (m) addBan(m[1], (cells[1] ?? '').slice(0, 60), i + 1)
    } else if (inTable && line.trim() === '') {
      // 空行不结束表格（表后常有空行 + 散文），靠非 | 非空行结束
    } else if (inTable && line.trim() !== '') {
      inTable = false
    }
  })
  bans.sort((a, b) => a.code.localeCompare(b.code))
  return { bans, rows, stateIdx, whereIdx }
}

export function checkBanCoverage({ specsRoot, config, col }) {
  const rel = config.agentEntry?.adapters?.[0]?.path ?? config.claudeMd
  const abs = path.join(specsRoot, rel)
  if (!fs.existsSync(abs)) {
    col.add(5, 'error', `找不到 Agent Entry adapter \`${rel}\` —— 当前平台没有可检查的执行入口`)
    return { bans: [], covered: 0 }
  }
  const text = readText(abs)
  const { bans, rows, stateIdx, whereIdx } = parseBanCoverage(text)

  if (bans.length === 0) {
    col.add(5, 'warn', `\`${rel}\` 里没有解析到 \`N-xx\` 禁令小节（期望形如 \`### N-01 …\`）`, { file: rel })
  }
  if (rows.length === 0) {
    col.add(5, 'error',
      `\`${rel}\` 里没有禁令→断言覆盖表。没有断言时，这些禁令只能视为未验证风险`, { file: rel })
    return { bans, covered: 0 }
  }

  const rowFor = new Map()
  for (const r of rows) {
    for (const tok of extractIdTokens(r.cells[0] ?? '')) {
      if (/^N-\d{2}$/.test(tok)) rowFor.set(tok, r)
    }
  }

  let covered = 0
  for (const b of bans) {
    const r = rowFor.get(b.code)
    if (!r) {
      col.add(5, 'error',
        `禁令 \`${b.code}\` 没有断言表行。每条禁令必须三态之一：有机器断言 / 显式标"只能人工审查 + 技术债" / 不允许存在`,
        { file: rel, line: b.line })
      continue
    }
    const state = (stateIdx >= 0 ? r.cells[stateIdx] : r.cells[r.cells.length - 1]) ?? ''
    if (/待补|TODO|待定/.test(state)) {
      col.add(5, 'error', `\`${b.code}\` 的状态是「${state}」。断言表没有"待补"这一态 —— 要么有断言，要么如实标技术债`,
        { file: rel, line: r.line })
      continue
    }
    if (!VALID_STATES.includes(state)) {
      col.add(5, 'error', `\`${b.code}\` 的状态「${state}」不在 ${VALID_STATES.join(' / ')} 之内`, { file: rel, line: r.line })
      continue
    }
    if (state !== '⚠️ 技术债' && whereIdx >= 0) {
      const where = r.cells[whereIdx] ?? ''
      if (!where || where === '—' || PLACEHOLDER_RE.test(where)) {
        col.add(5, 'error', `\`${b.code}\` 声称有断言（${state}）但没写在哪跑。断言必须写明运行位置，否则等于没挂`,
          { file: rel, line: r.line })
        continue
      }
    }
    covered++
  }

  for (const [code, r] of rowFor) {
    if (!bans.some((b) => b.code === code)) {
      col.add(5, 'warn', `断言表里有 \`${code}\` 的行，但 \`${rel}\` 里没有这条禁令的小节 —— 陈旧行`, { file: rel, line: r.line })
    }
  }

  col.stat(5, '禁令', bans.length)
  col.stat(5, '已覆盖', covered)
  return { bans, covered }
}

// ---------------------------------------------------------------------------
// 检查 6：禁止复制中文标签
// ---------------------------------------------------------------------------

/** 收集 label → 定义处。同一 label 在两处定义本身就是分叉源。 */
export function collectLabels(model, col) {
  const labels = new Map() // label -> [{file, code}]

  // 直接走原始 YAML 文档，不走 model.collections：
  // 容器形状不规整（map 而不是数组）是检查 1 的发现，不该让检查 6 跟着瞎掉。
  const walk = (node, file) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const v of node) walk(v, file)
      return
    }
    const lab = node.label
    if (typeof lab === 'string' && lab.length >= 2 && CJK_RE.test(lab)) {
      if (!labels.has(lab)) labels.set(lab, [])
      labels.get(lab).push({ file, code: node.code ?? node.id ?? node.to ?? '?' })
    }
    for (const v of Object.values(node)) walk(v, file)
  }
  for (const [file, { doc }] of Object.entries(model.files ?? {})) walk(doc, file)

  for (const [label, at] of labels) {
    if (at.length > 1) {
      col?.add(6, 'warn',
        `中文标签「${label}」被 ${at.length} 条记录共用（${at.map((a) => `${a.code}@${a.file}`).join(' / ')}）。` +
        `改一处会静默分叉；若确实是同一概念，其中一处应引用另一处的 code`)
    }
  }
  return labels
}

const unquote = (s) => s.replace(/^\s*["']|["']\s*$/g, '').trim()

/** 从 s[i] 起读一个值 token，返回 [raw, end)。引号与括号都成对跳过。 */
function readValueToken(s, i) {
  const ch = s[i]
  if (ch === '"' || ch === "'") {
    let j = i + 1
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue }
      if (s[j] === ch) { j++; break }
      j++
    }
    return { raw: s.slice(i, j), end: j }
  }
  if (ch === '[' || ch === '{') {
    let depth = 0, q = null, j = i
    for (; j < s.length; j++) {
      const c = s[j]
      if (q) { if (c === '\\') j++; else if (c === q) q = null; continue }
      if (c === '"' || c === "'") { q = c; continue }
      if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') { depth--; if (depth === 0) { j++; break } }
    }
    return { raw: s.slice(i, j), end: j }
  }
  let j = i
  while (j < s.length && !',}]#'.includes(s[j])) j++
  return { raw: s.slice(i, j), end: j }
}

/** 拆顶层逗号，返回 [{piece, index}]。引号与嵌套括号内的逗号不算分隔符。 */
function splitTopLevel(s, base) {
  const out = []
  let depth = 0, q = null, start = 0
  for (let j = 0; j <= s.length; j++) {
    const c = s[j]
    if (j === s.length || (c === ',' && depth === 0 && !q)) {
      out.push({ piece: s.slice(start, j), index: base + start })
      start = j + 1
      continue
    }
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return out
}

/**
 * 一行结构化文本里所有「完整标量值」的位置。
 *
 * 为什么必须是完整值而不是子串：实测 scrm-specs，按子串匹配在三份字典里报出 224 处，
 * 绝大多数是普通中文恰好含 2 字 label（`semantics: 同目标已成功发布` 命中「发布」）。
 * 真正要抓的缺陷形状是「本该写码的位置写了中文状态词」——那必然是某个键的完整值。
 *
 * 为什么用扫描器而不是一条正则：值可能是标量、引号串、flow 数组、嵌套对象，
 * 正则的括号分支要么截断 `to: [a, b]`（少了 b），要么吞掉 `rows: [{name: x}]` 里的
 * 内层键（少了 name）—— 两种漏检都试出来过。扫描器按嵌套深度走，两种都不漏。
 */
export function scalarValues(line, { csv = false } = {}) {
  const out = []
  if (csv) {
    let off = 0
    for (const cell of line.split(',')) {
      out.push({ value: unquote(cell), key: null, index: off })
      off += cell.length + 1
    }
    return out
  }
  const KEY_RE = /(?:^|[\s\-{,[])"?([A-Za-z_][\w.-]*)"?\s*:[ \t]*/g
  let m
  while ((m = KEY_RE.exec(line))) {
    const key = m[1]
    const start = m.index + m[0].length
    const { raw } = readValueToken(line, start)
    const val = raw.trim()
    if (val.startsWith('[') || val.startsWith('{')) {
      // 容器本身不是标量值。拆开：纯标量的项直接产出；带 `:` 的项留给外层
      // KEY_RE 继续扫（lastIndex 不前移，所以嵌套键一定会被再次命中）。
      for (const { piece, index } of splitTopLevel(val.slice(1, -1), start + 1)) {
        if (piece.includes(':')) continue
        if (piece.trim()) out.push({ value: unquote(piece), key, index })
      }
    } else {
      out.push({ value: unquote(raw), key, index: start })
    }
  }
  const im = line.match(/^\s*-\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#\n[{]*?)\s*$/)
  if (im) out.push({ value: unquote(im[1]), key: null, index: line.indexOf(im[1]) })
  return out
}

export function checkLabelCopy({ specsRoot, config, model, col }) {
  const labels = collectLabels(model, col)
  if (labels.size === 0) {
    col.add(6, 'info', '字典里没有中文 label，检查 6 无事可做')
    return { labels: 0, hits: [] }
  }

  // allowlist 三种写法："草稿"（放过这条 label）、{key:"name"}（放过展示名字段）、
  // {key,label}（只放过这一对）。缺了按键豁免，fixtures 里的 `name: 管理员` 会把整道闸门逼到关掉。
  const allowLabels = new Set()
  const allowKeys = new Set()
  const allowPairs = new Set()
  for (const a of config.labelCopyAllowlist) {
    if (typeof a === 'string') { allowLabels.add(a); continue }
    if (!a || typeof a !== 'object') continue
    if (a.key && a.label) allowPairs.add(`${a.key}\u0000${a.label}`)
    else if (a.key) allowKeys.add(a.key)
    else if (a.label) allowLabels.add(a.label)
  }
  const dictSet = new Set(config.dictionaries)
  const ownerFiles = new Map([...labels].map(([l, at]) => [l, new Set(at.map((a) => a.file))]))

  const files = walkFiles(specsRoot).filter(
    (r) => matchesAny(r, config.structuredFileGlobs) && !matchesAny(r, config.excludeFromScan))

  const hits = []
  for (const rel of files) {
    const isDict = dictSet.has(rel)
    const isYaml = /\.(ya?ml)$/i.test(rel)
    const csv = /\.csv$/i.test(rel)
    const lines = readText(path.join(specsRoot, rel)).split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!CJK_RE.test(line)) return
      const isComment = isYaml && /^\s*#/.test(line)
      for (const c of scalarValues(line, { csv })) {
        if (!c.value || !labels.has(c.value)) continue
        if (allowLabels.has(c.value)) continue
        if (c.key && (allowKeys.has(c.key) || allowPairs.has(`${c.key}\u0000${c.value}`))) continue
        // 本文件自己声明这条 label —— 唯一合法出现
        if (c.key === 'label' && isDict && ownerFiles.get(c.value)?.has(rel)) continue
        const owner = [...(ownerFiles.get(c.value) ?? [])].join('、')
        hits.push({ file: rel, line: i + 1, label: c.value, key: c.key, comment: isComment })
        col.add(6, isComment ? 'warn' : 'error',
          `\`${c.key ?? '数组项'}\` 的值整个就是字典 label「${c.value}」${isComment ? '（yaml 注释里）' : ''}` +
          `（定义在 ${owner}）。换成 ID 引用 —— 复制一次描述，就会漂移一次（N-03）`,
          { file: rel, line: i + 1 })
        return // 一行只报一次
      }
    })
  }

  col.stat(6, '字典 label', labels.size)
  col.stat(6, '扫描结构化文件', files.length)
  col.stat(6, '命中', hits.length)
  return { labels: labels.size, hits }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const CHECK_NAMES = {
  1: 'schema 符合性',
  2: '状态机闭合',
  3: 'ID 引用完整性',
  4: '两区制比对',
  5: 'N-xx 禁令覆盖',
  6: '禁止复制中文标签',
  7: '覆盖矩阵完整性',
}
const SEV_ORDER = { error: 0, warn: 1, info: 2 }
const SEV_LABEL = { error: '缺陷', warn: '警告', info: '信息' }

export function renderReportMd({ specsRoot, configPath, isFallback, findings, stats }) {
  const L = []
  L.push('# 规格套件检查报告', '')
  L.push(`- 被检查库：\`${toPosix(specsRoot)}\``)
  L.push(`- config：\`${toPosix(configPath)}\`${isFallback ? ' —— **这是 skill 自带的示例 config，不是本库的**，命名空间与路径未必匹配本库' : ''}`)
  const n = (s) => findings.filter((f) => f.severity === s).length
  L.push(`- 结论：缺陷 ${n('error')} / 警告 ${n('warn')} / 信息 ${n('info')}`)
  L.push('')
  L.push('> **审计结论不等于修改授权。** 报告只列出发现，改不改由库的所有者决定。')
  L.push('')

  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
    L.push(`## 检查 ${id} · ${CHECK_NAMES[id]}`, '')
    const st = stats[id]
    if (st && Object.keys(st).length) {
      L.push('派生计数（只报告，不作为断言）：', '')
      for (const [k, v] of Object.entries(st)) L.push(`- ${k}：${v}`)
      L.push('')
    }
    const fs_ = findings.filter((f) => f.check === id)
      .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    if (fs_.length === 0) { L.push('无发现。', ''); continue }
    for (const f of fs_) {
      const at = f.file ? ` \`${f.file}${f.line ? ':' + f.line : ''}\`` : ''
      L.push(`- **${SEV_LABEL[f.severity]}**${at} — ${f.message}`)
    }
    L.push('')
  }
  return L.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function run(opts) {
  const specsRoot = path.resolve(opts.specsRoot ?? '.')
  const col = makeCollector()
  const config = loadConfig({
    specsRoot,
    configPath: opts.config,
    fallbackConfigPath: opts.fallbackConfig,
  })
  if (config.isFallback) {
    col.add(1, 'warn',
      `本库没有 spec-suite.config.json，用的是 skill 自带示例（\`${toPosix(config.configPath)}\`）。` +
      `命名空间正则与路径未必匹配本库 —— 报告里的计数按示例 config 解读`)
  }

  const YAML = await loadYamlLib(specsRoot)
  const model = buildModel({ specsRoot, config, YAML, col })
  for (const m of model.missing) {
    col.add(1, 'error', `config 里声明的字典文件不存在：\`${m}\``)
  }

  checkSchema({ model, col })
  checkIdempotencyTuples({ specsRoot, config, model, col })
  checkStateMachines({ model, col })
  const idRefResult = checkIdRefs({ specsRoot, config, model, col })
  const zoneResult = checkZones({ specsRoot, config, model, col, write: !!opts.write })
  checkBanCoverage({ specsRoot, config, col })
  checkLabelCopy({ specsRoot, config, model, col })
  checkCoverageMatrix({ specsRoot, config, idRefResult, col })

  const errors = col.findings.filter((f) => f.severity === 'error').length
  const report = {
    generatedAt: new Date().toISOString(),
    specsRoot: toPosix(specsRoot),
    configPath: toPosix(config.configPath),
    isFallbackConfig: config.isFallback,
    summary: {
      error: errors,
      warn: col.findings.filter((f) => f.severity === 'warn').length,
      info: col.findings.filter((f) => f.severity === 'info').length,
    },
    stats: col.stats,
    findings: col.findings,
  }
  return { report, config, model, col, errors, zoneResult, idRefResult }
}

function parseArgv(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--specs-root') o.specsRoot = argv[++i]
    else if (a === '--config') o.config = argv[++i]
    else if (a === '--report') o.report = argv[++i]
    else if (a === '--write-generated-regions' || a === '--write') o.write = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return o
}

const HELP = `用法：node check-spec-suite.mjs [选项]

  --specs-root <路径>   规格库根目录（默认当前目录）
  --config <路径>       config 文件（默认 <root>/spec-suite.config.json）
  --report <目录>       把 report.json + report.md 写到这里（不写入被检查的库）
  --write-generated-regions
                        只重写 .md 生成区，不生成 contract bundle
  --write               上一参数的兼容别名
  --quiet               只打摘要
`

async function main() {
  const opts = parseArgv(process.argv.slice(2))
  if (opts.help) { process.stdout.write(HELP); return 0 }
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  opts.fallbackConfig = path.join(here, 'spec-suite.config.json')

  let r
  try {
    r = await run(opts)
    if (opts.write && r.zoneResult.rewritten > 0) {
      r = await run({ ...opts, write: false })
    }
  } catch (e) {
    process.stderr.write(`检查器无法运行：${e.message}\n`)
    return 2
  }

  const md = renderReportMd({
    specsRoot: r.report.specsRoot,
    configPath: r.report.configPath,
    isFallback: r.report.isFallbackConfig,
    findings: r.col.findings,
    stats: r.col.stats,
  })

  if (opts.report) {
    fs.mkdirSync(opts.report, { recursive: true })
    fs.writeFileSync(path.join(opts.report, 'report.json'), JSON.stringify(r.report, null, 2), 'utf8')
    fs.writeFileSync(path.join(opts.report, 'report.md'), md, 'utf8')
    process.stdout.write(`报告已写入 ${toPosix(opts.report)}\n`)
  } else if (!opts.quiet) {
    process.stdout.write(md)
  }

  const s = r.report.summary
  process.stdout.write(`缺陷 ${s.error} / 警告 ${s.warn} / 信息 ${s.info}\n`)
  return r.errors > 0 ? 1 : 0
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  main().then((c) => process.exit(c))
}
