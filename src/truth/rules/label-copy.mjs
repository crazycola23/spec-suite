// 检查 6：禁止复制中文标签。

import path from 'node:path'
import { readText, CJK_RE } from '../../shared/text.mjs'
import { matchesAny } from '../../shared/glob.mjs'
import { walkFiles } from '../../shared/walk.mjs'

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
