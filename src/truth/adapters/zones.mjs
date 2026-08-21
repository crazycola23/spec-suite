// 检查 4：两区制比对。生成区逐字节。

import fs from 'node:fs'
import path from 'node:path'
import { readText } from '../../shared/text.mjs'
import { matchesAny } from '../../shared/glob.mjs'
import { walkFiles } from '../../shared/walk.mjs'
import { RENDERERS } from '../projections/renderers.mjs'
import { resolveProjection, enumerateProjections } from '../projections/resolve.mjs'

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
