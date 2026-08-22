#!/usr/bin/env node
/**
 * check-architecture.mjs —— 静态架构约束检查
 *
 * 强制四件事：
 *   1. import 图无环
 *   2. 每条跨模块边都符合 src/layers.mjs 的 allowed-edge 声明
 *   3. 每个 .mjs 都归属于某一层（未归类 = 违规，不是默认放行）
 *   4. 没有绕过 import 图的动态加载（计算式 import() / require / createRequire）
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
 * 第 4 条堵的是前三条共同的前提：它们全部建立在"import 图完整"之上。
 * `await import(expr)` 与 `createRequire()` 对静态扫描是不可见的，所以在
 * 加上第 4 条之前，任何被层策略禁止的边只要改写成动态形式就能绕过全部检查，
 * 而检查器照旧报告 0 违规 —— 那不是漏报一条边，而是整套边界检查存在一个
 * 语法级后门。见下方"动态加载：第二遍扫描"一节。
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

// ───────────────────────── 动态加载：第二遍扫描 ─────────────────────────
//
// 上面那套只看得见静态 `import` / `export from`。`import(expr)` 与
// `createRequire()` 对它是**不可见的** —— 于是任何一条被层策略禁止的边，
// 只要写成 `await import('../control/lease.mjs')` 就能绕过全部检查，而
// `npm run arch` 依旧报告 0 违规。这是本检查器最大的一个 fail-open 缺口：
// 不是"漏报一条边"，而是"存在一种语法能让边界检查整体失效"。
//
// 为什么需要**第二遍**而不能复用 blankComments：blankComments 有意逐字保留
// 字符串内容（这样它不会被 URL 里的 `//` 截断）。可 `require(` 也会出现在
// 字符串**里** —— tests/adversarial/v2-control-plane.test.mjs 有两处
// `node -e "require('node:fs')…"`，那是被 spawn 的子进程源码，不是本文件的边。
// 直接拿 blankComments 的输出去搜 `require(` 会把它们当成违规。
//
// 所以这里再扫一遍，把字符串**内容**也抹成等长的 `S`。长度不变是刻意的：
// 匹配位置能直接换算回原文的行号，也能从原文同一区间取回真实 specifier。
//
// 抹内容比保留内容多出一个必须处理的形状：**正则字面量**。blankComments
// 恰好免疫（它保留内容，所以即使把 `/…/` 中间当成字符串，输出仍等于输入），
// 而抹内容会被带偏 —— 本文件自己的 `/(['"])([^'"]+)\1/g` 里引号成对但**交错**：
// 扫描器用第一个 `'` 开串，会在 `[^'` 处收尾，然后剩下的 `"` 开出一个跨行的
// 假字符串，把后面真实的代码一起抹掉。那是 fail-open（漏报），必须堵住。

/**
 * 把注释、字符串内容、模板字面量内容、正则字面量内容都抹成等长的 `S`
 * （换行保留），引号 / 反引号 / 斜杠本身留下。模板里的 `${…}` **不抹** ——
 * 里面是真代码，抹掉就等于给动态加载留了个藏身处。
 *
 * 返回 `unterminated`：扫到文件尾时状态栈非空，说明扫描器跑偏了（漂移几乎
 * 总以栈不平衡收尾）。调用方必须把它当违规，而不是拿着可能错的结果继续 ——
 * 这条是本检查器自己的 fail-closed。
 *
 * @returns {{masked: string, unterminated: boolean}}
 */
export function maskLiterals(src) {
  const out = []
  const stack = [] // {kind: 'single'|'double'|'template'|'regex'|'interp', depth?, inClass?}
  let i = 0
  const n = src.length
  // code 模式下最后一个有意义的字符，用来分辨 `/` 是正则开头还是除号。
  let lastSig = ''
  const emit = (ch) => { out.push(ch); if (!/\s/.test(ch)) lastSig = ch }
  const mask = (ch) => out.push(ch === '\n' ? '\n' : 'S')
  const top = () => stack[stack.length - 1]

  // `/` 之前出现这些字符时不可能是除法 —— 只能是正则字面量的开头。
  // `)` 不在列内（`if (x) /re/` 这种极少见，宁可判成除法：判错成除法只会
  // 让正则内容被逐字保留，最坏是多报一条 unterminated；判错成正则会吃掉
  // 后面的真代码，那才是漏报。
  const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])

  while (i < n) {
    const frame = top()
    const kind = frame?.kind
    const c = src[i]
    const d = src[i + 1]

    if (kind === 'single' || kind === 'double') {
      const quote = kind === 'single' ? "'" : '"'
      if (c === '\\') { mask(c); mask(src[i + 1] ?? ''); i += 2; continue }
      if (c === quote) { out.push(c); lastSig = c; stack.pop(); i++; continue }
      mask(c); i++; continue
    }
    if (kind === 'template') {
      if (c === '\\') { mask(c); mask(src[i + 1] ?? ''); i += 2; continue }
      if (c === '`') { out.push(c); lastSig = c; stack.pop(); i++; continue }
      if (c === '$' && d === '{') { out.push('$', '{'); lastSig = '{'; stack.push({ kind: 'interp', depth: 0 }); i += 2; continue }
      mask(c); i++; continue
    }
    if (kind === 'regex') {
      if (c === '\\') { mask(c); mask(src[i + 1] ?? ''); i += 2; continue }
      if (c === '[') { frame.inClass = true; mask(c); i++; continue }
      if (c === ']') { frame.inClass = false; mask(c); i++; continue }
      // 未闭合的正则不允许跨行 —— 真到了换行说明前面把除号当成了正则开头。
      // 退出这一帧，让后续按 code 模式继续，避免一路吃到文件尾。
      if (c === '\n') { stack.pop(); out.push('\n'); i++; continue }
      if (c === '/' && !frame.inClass) { out.push(c); lastSig = c; stack.pop(); i++; continue }
      mask(c); i++; continue
    }

    // 以下是 code 模式（栈顶为 interp，或栈空 = 顶层）
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out.push(' '); i++ } continue }
    if (c === '/' && d === '*') {
      out.push(' ', ' ')
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out.push(src[i] === '\n' ? '\n' : ' '); i++ }
      if (i < n) { out.push(' ', ' '); i += 2 }
      continue
    }
    if (c === "'") { emit(c); stack.push({ kind: 'single' }); i++; continue }
    if (c === '"') { emit(c); stack.push({ kind: 'double' }); i++; continue }
    if (c === '`') { emit(c); stack.push({ kind: 'template' }); i++; continue }
    if (c === '/' && REGEX_PRECEDERS.has(lastSig)) { emit(c); stack.push({ kind: 'regex', inClass: false }); i++; continue }
    if (kind === 'interp') {
      if (c === '{') { frame.depth += 1; emit(c); i++; continue }
      if (c === '}') {
        if (frame.depth === 0) { stack.pop(); emit(c); i++; continue }
        frame.depth -= 1
        emit(c)
        i++
        continue
      }
    }
    emit(c)
    i++
  }
  return { masked: out.join(''), unterminated: stack.length > 0 }
}

// 前缀 `(^|[^.\w$])` 挡住 `foo.import(` / `myRequire(` / `import.meta`。
const DYN_IMPORT_ANY = /(^|[^.\w$])import\s*\(/g
// 字面量形态：抹过之后引号里只剩 `S`。模板里带 `${…}` 的不会match，因此
// 正确地落进"计算式"一类。
const DYN_IMPORT_LITERAL = /(^|[^.\w$])import\s*\(\s*(['"`])S*\2\s*\)/g
const REQUIRE_CALL = /(^|[^.\w$])require\s*\(/g
const CREATE_REQUIRE = /(^|[^.\w$])createRequire\b/g

/** index → 1-based 行号。 */
function lineAt(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line += 1
  return line
}

function matchesOf(re, masked) {
  re.lastIndex = 0
  return [...masked.matchAll(re)].map((m) => ({ start: m.index + m[1].length, length: m[0].length - m[1].length }))
}

/**
 * 一个文件里的动态加载点。
 *
 * `literalImports` 是**可静态分析**的：specifier 是字面量，所以它和静态
 * import 一样能定位到具体文件 —— 它们应该变成图里的真实边，而不是被豁免。
 * 其余三类无法从源码判定加载目标，按 fail-closed 处理。
 *
 * @returns {{literalImports: Array<{spec: string, line: number}>, computedImports: number[], requireCalls: number[], createRequires: number[], unterminated: boolean}}
 */
export function dynamicLoads(src) {
  const { masked, unterminated } = maskLiterals(src)
  const literalImports = []
  const literalStarts = new Set()
  for (const { start, length } of matchesOf(DYN_IMPORT_LITERAL, masked)) {
    literalStarts.add(start)
    // 长度与偏移都守恒，所以同一区间在原文里就是真实的 specifier。
    const raw = src.slice(start, start + length)
    const q = raw.match(/^import\s*\(\s*(['"`])([\s\S]*)\1\s*\)$/)
    if (q) literalImports.push({ spec: q[2], line: lineAt(src, start) })
  }
  const computedImports = matchesOf(DYN_IMPORT_ANY, masked)
    .filter((m) => !literalStarts.has(m.start))
    .map((m) => lineAt(src, m.start))
  return {
    literalImports,
    computedImports,
    requireCalls: matchesOf(REQUIRE_CALL, masked).map((m) => lineAt(src, m.start)),
    createRequires: matchesOf(CREATE_REQUIRE, masked).map((m) => lineAt(src, m.start)),
    unterminated,
  }
}

/** 字面量动态 import 的 specifier 列表。给 buildImportGraph 用。 */
export function literalDynamicSpecifiers(src) {
  return dynamicLoads(src).literalImports.map((x) => x.spec)
}

/**
 * 无法静态分析的加载形态的豁免名单。**按 (文件, 形态) 粒度**，不是按文件 ——
 * 一个因 createRequire 被豁免的文件不该顺带获得写计算式 import() 的许可。
 *
 * 每条必须写清 reason。名单的增长本身要在 architecture.test.mjs 里被断言，
 * 与 TREE_LOCK_EXCLUSIONS 同一个套路：豁免可以有，但不能悄悄多一条。
 *
 * 还有一条反向规则（见 checkDynamicLoads）：**用不上的豁免也是违规**。
 * 这条是这套检查的非空过保险 —— 如果哪天扫描器坏掉、一个形态都认不出来，
 * 两条豁免会同时变成"未使用"而报错，而不是安静地全绿。
 */
export const DYNAMIC_LOAD_EXEMPTIONS = [
  {
    file: 'src/truth/config/yaml.mjs',
    forms: ['createRequire'],
    reason: 'yaml 解析要用**被检查库自己**的 yaml，而不是本 skill 目录里的那份。'
      + '被检查库是运行期才知道的路径，只能用 createRequire(pathToFileURL(<被检查库>/package.json)) '
      + '去它的解析根里找。这是有意的：换成静态 import 就会把本仓库的 yaml 版本强加给下游。',
  },
  {
    file: 'tests/unit/argv.test.mjs',
    forms: ['computed-import'],
    reason: '源级普查：遍历 ROOTS 下的文件再逐个 import 进来检查其导出。'
      + '被 import 的路径是遍历结果，按定义不可能是字面量。',
  },
]

/**
 * 检查动态加载。三类无法静态分析的形态默认违规，只有名单里的 (文件, 形态) 放行。
 *
 * 注意**不在**这里报的一类：字面量动态 import。它们由 buildImportGraph 收成
 * 真实边，跟静态 import 一样走环检测与层策略 —— 那才是"封住"的意思。若把它们
 * 也一并禁掉，只会逼人改写成计算式，反而更看不见。
 *
 * @returns {{violations: string[], detected: Array<{file: string, form: string, line: number}>}}
 */
export function checkDynamicLoads(repoRoot, roots = ROOTS) {
  const files = roots.flatMap((r) => listMjs(path.join(repoRoot, r)))
  const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/')
  const violations = []
  const detected = []
  const used = new Set()
  // key 用 JSON.stringify 而不是拼分隔符：任何单字符分隔符都可能出现在文件名里，
  // 撞车的后果不是报错而是"豁免匹配到了另一个 (文件, 形态)" —— 静默放行。
  const exemptKey = (file, form) => JSON.stringify([file, form])
  const exempt = new Set(DYNAMIC_LOAD_EXEMPTIONS.flatMap((e) => e.forms.map((f) => exemptKey(e.file, f))))

  for (const abs of files.sort()) {
    const file = rel(abs)
    const src = fs.readFileSync(abs, 'utf8')
    const loads = dynamicLoads(src)
    if (loads.unterminated) {
      violations.push(`${file}：字面量扫描器在文件尾状态未闭合 —— 结果不可信，按违规处理而不是继续`)
      continue
    }
    const found = [
      ...loads.computedImports.map((line) => ({ form: 'computed-import', line })),
      ...loads.requireCalls.map((line) => ({ form: 'require', line })),
      ...loads.createRequires.map((line) => ({ form: 'createRequire', line })),
    ]
    for (const { form, line } of found) {
      detected.push({ file, form, line })
      const key = exemptKey(file, form)
      if (exempt.has(key)) { used.add(key); continue }
      violations.push(
        `${file}:${line} 用了无法静态分析的加载形态（${form}）—— 它绕过 import 图，`
        + `层策略与环检测都看不见。要么改成静态 import 或字面量 import()，`
        + `要么在 check-architecture.mjs 的 DYNAMIC_LOAD_EXEMPTIONS 里显式登记并写明理由。`,
      )
    }
  }
  for (const key of exempt) {
    if (used.has(key)) continue
    const [file, form] = JSON.parse(key)
    violations.push(
      `DYNAMIC_LOAD_EXEMPTIONS 里 ${file} 的 ${form} 豁免用不上了 —— 要么源码已经不再需要它`
      + `（那就删掉这条豁免），要么检测器认不出这个形态了（那是检测器坏了）。`
      + `两种情况都不能留着：留着等于让这套检查在无声失效时依然全绿。`,
    )
  }
  return { violations, detected }
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
    // 字面量 `import('./x.mjs')` 与静态 import 同等对待。这是"封住 bypass"的
    // 主体动作：不禁止这种写法，而是让它落进图里，照样受环检测与层策略约束。
    // 目前仓库里一条相对路径的字面量动态 import 都没有（只有裸 specifier
    // 'yaml' / 'node:fs/promises'），所以这行今天不改变任何计数 —— 它防的是
    // 将来某次为了绕开层策略而把静态 import 改写成 import('../control/…')。
    const allSpecs = [...new Set([...specs, ...literalDynamicSpecifiers(src)])]
    const edges = []
    for (const spec of allSpecs) {
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

/** 汇总检查。返回 { violations, fileCount, edgeCount, graph, layerCounts, crossEdges, dynamicLoads }，不退出、不打印。 */
export function checkArchitecture(repoRoot, roots = ROOTS) {
  const { graph, problems } = buildImportGraph(repoRoot, roots)
  const violations = [...problems]
  for (const cyc of findCycles(graph)) violations.push(`import 环：${cyc.join(' → ')}`)
  const layers = checkLayers(graph)
  violations.push(...layers.violations)
  const dyn = checkDynamicLoads(repoRoot, roots)
  violations.push(...dyn.violations)
  let edgeCount = 0
  for (const edges of graph.values()) edgeCount += edges.length
  return {
    violations,
    fileCount: graph.size,
    edgeCount,
    graph,
    layerCounts: layers.layerCounts,
    crossEdges: layers.crossEdges,
    dynamicLoads: dyn.detected,
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
  // 把已登记的动态加载点打出来，而不是让它们只存在于豁免名单里 —— 每次跑都
  // 看见"有 N 处绕过静态分析"比一行"违规 0"更接近真相。
  process.stdout.write(`动态加载：${r.dynamicLoads.length} 处（全部已在 DYNAMIC_LOAD_EXEMPTIONS 登记）\n`)
  process.exit(r.violations.length > 0 ? 1 : 0)
}
