#!/usr/bin/env node
/**
 * check-architecture.mjs —— 静态架构约束检查
 *
 * 强制三件事：
 *   1. import 图无环
 *   2. 每条跨模块边都符合 src/layers.mjs 的 allowed-edge 声明
 *   3. 每个 .mjs 都归属于某一层（未归类 = 违规，不是默认放行）
 *
 * 为什么要有这个脚本：拆分后模块变多，环依赖是最容易悄悄引入、
 * 又最难在运行时发现的退化（ESM 允许环，只是把绑定变成 undefined）。
 * 一旦成环，"纯函数 + 分层"的结构就名存实亡。层边界同理 —— 用户要求的
 * 「Control Plane → Truth Integrity」这个方向，只有机器每次都查才守得住。
 *
 * 第 3 条是有意的 fail-closed：新增一个文件而忘了归类，检查报错而不是
 * 静默把它当作"随便可以 import 任何层"。这与仓库的 unknown-stays-unknown
 * 同源 —— 未知归属不能自动变成宽松默认。
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
import { LAYERS, edgeAllowed, layerOf } from '../src/layers.mjs'

// migrations/ 与 registry/ 也在扫描范围内：两者都是被 src/ 反向依赖的叶子
// （truth → registry），漏扫就等于放开了它们的方向约束 —— 例如
// shared → migrations 会让 shared 不再是叶子层，registry → truth 会成环。
//
// tests/ 必须在列：测试文件原先住在 scripts/ 下，本来就被扫着。它们搬进 tests/
// 之后若不把这个根加上，13 个文件会**静默**退出扫描范围 —— 违规数照旧是 0，
// 而"测试的相对 import 全部解析到真实文件""测试不参与环"这两条保证会悄悄消失。
// 搬家不该顺手削弱检查面，所以这里跟着搬。数量是可核对的：搬家前后都是 58 个
// .mjs（13 个换了目录，没有增减）。
//
// 导出，因为这份「本仓库自己的源码住在哪」是好几处 sweep 的共同前提：架构检查
// 之外，argv / canonical-json / paths / schema-version 四条源级锁也要走同一片
// 范围。此前它们各抄一份数组 —— 四份必须同步才有意义，却没有任何东西强制同步，
// 正是 P1 要消掉的那种多真相源。单一来源同时白拿了一层保护：`tests` 若从这里
// 被删掉，architecture.test.mjs:84 那条「测试节点必须在图里」立刻变红。
//
// 注意这份清单**不是**"仓库里所有目录"：fixtures/ 与 templates/ 被有意排除。
// 它们是冻结语料与下游样板，代表**别人的**仓库；把那里的字节当成本仓库的实现
// 证据，会让源级锁对着语料假红。
export const ROOTS = ['src', 'scripts', 'migrations', 'registry', 'tests']

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

/**
 * 检查分层。graph 的键与边都是仓库相对 POSIX 路径。
 *
 * 三类违规：
 *   - 源文件未归类（fail closed）
 *   - 边的目标未归类：说明相对 import 逃出了被归类的目录树
 *   - 层与层之间的方向不被 LAYERS 允许
 *
 * @returns {{violations: string[], layerCounts: Record<string, number>, crossEdges: Array<{from: string, to: string, fromLayer: string, toLayer: string}>}}
 */
export function checkLayers(graph) {
  const violations = []
  const layerCounts = {}
  for (const name of Object.keys(LAYERS)) layerCounts[name] = 0

  const layers = new Map()
  for (const file of [...graph.keys()].sort()) {
    const layer = layerOf(file)
    if (layer === null) {
      violations.push(
        `${file} 没有归属层 —— 请在 src/layers.mjs 的 FILE_LAYERS 里显式归类。`
        + `未归类不等于"可以随便 import"，所以这里报错而不是放行。`,
      )
      continue
    }
    layers.set(file, layer)
    layerCounts[layer] += 1
  }

  const crossEdges = []
  for (const from of [...graph.keys()].sort()) {
    const fromLayer = layers.get(from)
    if (fromLayer === undefined) continue // 已作为"未归类"报过，不重复刷屏
    for (const to of graph.get(from) ?? []) {
      const toLayer = layers.get(to) ?? layerOf(to)
      if (toLayer === null || toLayer === undefined) {
        violations.push(`${from} import 了未归类的 ${to} —— 相对 import 逃出了被归类的目录树`)
        continue
      }
      if (fromLayer !== toLayer) crossEdges.push({ from, to, fromLayer, toLayer })
      const verdict = edgeAllowed(fromLayer, toLayer)
      if (!verdict.allowed) violations.push(`违规边：${from}（${fromLayer}）→ ${to}（${toLayer}）：${verdict.reason}`)
    }
  }
  return { violations, layerCounts, crossEdges }
}

/** 汇总检查。返回 { violations, fileCount, edgeCount, graph, layerCounts, crossEdges }，不退出、不打印。 */
export function checkArchitecture(repoRoot, roots = ROOTS) {
  const { graph, problems } = buildImportGraph(repoRoot, roots)
  const violations = [...problems]
  for (const cyc of findCycles(graph)) violations.push(`import 环：${cyc.join(' → ')}`)
  const layers = checkLayers(graph)
  violations.push(...layers.violations)
  let edgeCount = 0
  for (const edges of graph.values()) edgeCount += edges.length
  return {
    violations,
    fileCount: graph.size,
    edgeCount,
    graph,
    layerCounts: layers.layerCounts,
    crossEdges: layers.crossEdges,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const r = checkArchitecture(repoRoot)
  for (const v of r.violations) process.stderr.write(`✖ ${v}\n`)
  const byLayer = Object.entries(r.layerCounts).map(([k, n]) => `${k} ${n}`).join(' / ')
  process.stdout.write(`扫描 ${r.fileCount} 个 .mjs / ${r.edgeCount} 条内部边 / ${r.crossEdges.length} 条跨层边；违规 ${r.violations.length}\n`)
  process.stdout.write(`分层：${byLayer}\n`)
  process.exit(r.violations.length > 0 ? 1 : 0)
}
