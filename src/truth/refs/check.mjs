// 检查 3：ID 引用完整性（悬空 + 孤儿）。

import path from 'node:path'
import { readText } from '../../shared/text.mjs'
import { matchesAny } from '../../shared/glob.mjs'
import { walkFiles } from '../../shared/walk.mjs'
import { extractIdTokens, isDefinitionSite } from './tokens.mjs'

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
