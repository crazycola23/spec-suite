// 检查 1b：幂等键元组从 DDL 提取后与字典声明比对。

import path from 'node:path'
import { readText } from '../../shared/text.mjs'
import { matchesAny } from '../../shared/glob.mjs'
import { walkFiles } from '../../shared/walk.mjs'

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
