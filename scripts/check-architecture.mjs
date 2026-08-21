#!/usr/bin/env node
/**
 * check-architecture.mjs —— 静态架构约束检查
 *
 * 目前强制：import 图无环。
 *
 * 为什么要有这个脚本：拆分后模块变多，环依赖是最容易悄悄引入、
 * 又最难在运行时发现的退化（ESM 允许环，只是把绑定变成 undefined）。
 * 一旦成环，"纯函数 + 分层"的结构就名存实亡。
 *
 * 扫描器要求逐字正确，不能靠行匹配：scripts/ 下已有 6 处跨行
 * `import {` 语句，按行扫会漏掉真实边。因此先按字符扫掉注释
 * （保留字符串与偏移），再按语句匹配。
 *
 * 退出码：有违规 → 1，否则 0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// migrations/ 也在扫描范围内：它 import src/shared/ 的策略表，反向依赖
// （shared → migrations）会让 shared 不再是叶子层，必须被机器挡住。
const ROOTS = ['src', 'scripts', 'migrations']

/**
 * 把注释替换成等长空白，字符串 / 模板字面量原样保留。
 * 这样既不会把注释里被注掉的 import 当成真实边，
 * 也不会被字符串里的 `//`（例如 URL）截断。
 */
export function blankComments(src) {
  const out = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out.push(' '); i++ }
      continue
    }
    if (c === '/' && d === '*') {
      out.push(' ', ' ')
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out.push(src[i] === '\n' ? '\n' : ' '); i++ }
      if (i < n) { out.push(' ', ' '); i += 2 }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out.push(c)
      i++
      while (i < n) {
        if (src[i] === '\\') { out.push(src[i], src[i + 1] ?? ''); i += 2; continue }
        out.push(src[i])
        if (src[i] === quote) { i++; break }
        i++
      }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

// 语句级匹配。子句允许跨行，但不允许含引号——因此不会越过一个字符串字面量。
const IMPORT_FROM = /(?:^|[\n;])\s*import\s+(?:[^'"();\n]|\n)*?\sfrom\s*(['"])([^'"]+)\1/g
const IMPORT_BARE = /(?:^|[\n;])\s*import\s*(['"])([^'"]+)\1/g
const EXPORT_FROM = /(?:^|[\n;])\s*export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{(?:[^'"{}]|\n)*?\})\s*from\s*(['"])([^'"]+)\1/g

/** 取出一个文件里全部静态 module specifier。 */
export function staticSpecifiers(src) {
  const clean = blankComments(src)
  const found = new Set()
  for (const re of [IMPORT_FROM, IMPORT_BARE, EXPORT_FROM]) {
    re.lastIndex = 0
    for (const m of clean.matchAll(re)) found.add(m[2])
  }
  return [...found]
}

function listMjs(root) {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (e.isFile() && e.name.endsWith('.mjs')) out.push(abs)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

/**
 * 构建 import 图。只收相对 specifier；裸 specifier（node: / yaml）是外部依赖，
 * 不参与内部环检测。相对 specifier 解析不到真实文件即为违规（fail closed）。
 */
export function buildImportGraph(repoRoot, roots = ROOTS) {
  const files = roots.flatMap((r) => listMjs(path.join(repoRoot, r)))
  const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/')
  const graph = new Map()
  const problems = []
  const scannerSilent = []

  for (const abs of files) {
    const src = fs.readFileSync(abs, 'utf8')
    const specs = staticSpecifiers(src)
    // 扫描器完全失灵的兜底信号：文件里明显有 `from '`，却一条都没抽到。
    if (specs.length === 0 && /\sfrom\s*['"]/.test(blankComments(src))) scannerSilent.push(rel(abs))
    const edges = []
    for (const spec of specs) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue
      const target = path.resolve(path.dirname(abs), spec)
      if (!fs.existsSync(target)) {
        problems.push(`${rel(abs)} 里的相对 import 解析不到文件：${spec}`)
        continue
      }
      edges.push(rel(target))
    }
    graph.set(rel(abs), edges)
  }
  for (const f of scannerSilent) problems.push(`扫描器在 ${f} 里没抽到任何 specifier，但文件含 from '…' —— 扫描器可能失效`)
  return { graph, problems }
}

/** DFS 找环。返回每个环的路径（首尾同一节点）。 */
export function findCycles(graph) {
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]))
  const stack = []
  const cycles = []
  const seen = new Set()

  const visit = (node) => {
    color.set(node, GREY)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (!color.has(next)) continue
      if (color.get(next) === GREY) {
        const at = stack.indexOf(next)
        const cyc = [...stack.slice(at), next]
        const key = [...cyc].sort().join('|')
        if (!seen.has(key)) { seen.add(key); cycles.push(cyc) }
        continue
      }
      if (color.get(next) === WHITE) visit(next)
    }
    stack.pop()
    color.set(node, BLACK)
  }
  for (const node of [...graph.keys()].sort()) if (color.get(node) === WHITE) visit(node)
  return cycles
}

/** 汇总检查。返回 { violations, fileCount, edgeCount }，不退出、不打印。 */
export function checkArchitecture(repoRoot, roots = ROOTS) {
  const { graph, problems } = buildImportGraph(repoRoot, roots)
  const violations = [...problems]
  for (const cyc of findCycles(graph)) violations.push(`import 环：${cyc.join(' → ')}`)
  let edgeCount = 0
  for (const edges of graph.values()) edgeCount += edges.length
  return { violations, fileCount: graph.size, edgeCount, graph }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const r = checkArchitecture(repoRoot)
  for (const v of r.violations) process.stderr.write(`✖ ${v}\n`)
  process.stdout.write(`扫描 ${r.fileCount} 个 .mjs / ${r.edgeCount} 条内部边；违规 ${r.violations.length}\n`)
  process.exit(r.violations.length > 0 ? 1 : 0)
}
