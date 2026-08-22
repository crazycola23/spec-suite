// 检查 4：两区制比对。生成区逐字节。

import fs from 'node:fs'
import path from 'node:path'
import { isInside } from '../../shared/paths.mjs'
import { readText, toPosix } from '../../shared/text.mjs'
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

/**
 * 计算两区制比对结果，并在 write 模式下一并算出重写计划。
 *
 * 只读不写。唯一的写入点是 applyZonePlan()，这样"校验"与"落盘"
 * 各自可以单独测：校验可以在只读语料上跑，落盘可以拿合成计划跑。
 */
export function planZones({ specsRoot, config, model, col, write = false }) {
  const all = walkFiles(specsRoot).filter(
    (r) => matchesAny(r, config.markdownGlobs) && !matchesAny(r, config.excludeFromScan))

  const seen = new Set()
  const zonesByFile = new Map()
  const ratios = []
  const plan = []
  let zoneCount = 0
  let mismatched = 0
  let rewritten = 0

  for (const rel of all) {
    const abs = path.join(specsRoot, rel)
    const text = readText(abs)
    const lines = text.split(/\r?\n/)
    const zones = findZones(lines, { file: rel, col })
    zonesByFile.set(rel, zones)
    if (zones.length === 0) {
      ratios.push({ file: rel, total: lines.length, zoneLines: 0, ratio: 0 })
      continue
    }
    zoneCount += zones.length
    let next = lines.slice()
    let shift = 0
    let zoneLines = 0
    let fileRewrites = 0

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
          fileRewrites++
        }
      }
    }
    ratios.push({ file: rel, total: lines.length, zoneLines, ratio: +(zoneLines / Math.max(lines.length, 1)).toFixed(3) })
    // fileRewrites 是 per-file 的。原来这里用的是函数级的 rewritten，
    // 语义上等于"到目前为止任何文件改过吗"，只靠后面的逐行比较才没写错文件；
    // 一旦有人删掉那个比较，第一个改过的文件之后所有文件都会被无故重写。
    if (write && fileRewrites > 0 && next.join('\n') !== lines.join('\n')) {
      plan.push({ file: rel, abs, nextLines: next })
    }
  }

  // config 里的 adapter 不是说明文字，而是 checker 必须逐项证明的执行入口。
  // 只看全库 seen Set 会有一个 fail-open 形状：CLAUDE.md 有公共区时，即使
  // 声明的 AGENTS.md 丢失，`agent-entry.common` 仍算“见过”，检查照样全绿。
  // 这里把声明路径、扫描范围和 marker 一一绑定；同一 canonical projection
  // 可以（也应该）出现在多个平台 adapter，但每个声明文件都必须各有一份。
  const adapters = config.agentEntry?.adapters
  let validAdapters = 0
  if (config.agentEntry && !Array.isArray(adapters)) {
    col.add(4, 'error', '`agentEntry.adapters` 必须是数组；每个 adapter 都要声明 platform、path 与 projection')
  } else if (Array.isArray(adapters)) {
    if (adapters.length === 0 && resolveProjection(config.projections, 'agent-entry.common')) {
      col.add(4, 'error',
        '`agentEntry.common` 已注册投影，但 `agentEntry.adapters` 为空 —— 没有任何平台执行入口')
    }
    const adapterPaths = new Set()
    adapters.forEach((adapter, index) => {
      const at = `agentEntry.adapters[${index}]`
      if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
        col.add(4, 'error', `\`${at}\` 不是对象`)
        return
      }

      const missing = ['platform', 'path', 'projection']
        .filter((key) => typeof adapter[key] !== 'string' || adapter[key].trim() === '')
      if (missing.length > 0) {
        col.add(4, 'error', `\`${at}\` 缺少非空字符串字段：${missing.join('、')}`)
        return
      }

      if (path.isAbsolute(adapter.path)) {
        col.add(4, 'error', `\`${at}.path\` 必须相对 specs root，不能是绝对路径：\`${adapter.path}\``)
        return
      }
      const abs = path.resolve(specsRoot, adapter.path)
      if (!isInside(specsRoot, abs)) {
        col.add(4, 'error', `\`${at}.path\` 逃出了 specs root：\`${adapter.path}\``)
        return
      }
      const rel = toPosix(path.relative(specsRoot, abs))
      if (adapterPaths.has(rel)) {
        col.add(4, 'error', `adapter 路径重复声明：\`${rel}\``)
        return
      }
      adapterPaths.add(rel)

      if (!fs.existsSync(abs)) {
        col.add(4, 'error', `找不到已声明的 ${adapter.platform} adapter：\`${rel}\``)
        return
      }
      if (!matchesAny(rel, config.markdownGlobs)) {
        col.add(4, 'error', `已声明的 adapter \`${rel}\` 不在 markdownGlobs 扫描范围内`)
        return
      }
      if (matchesAny(rel, config.excludeFromScan)) {
        col.add(4, 'error', `已声明的 adapter \`${rel}\` 被 excludeFromScan 排除了`)
        return
      }
      if (!zonesByFile.has(rel)) {
        col.add(4, 'error', `已声明的 adapter \`${rel}\` 不是 checker 可扫描的普通 Markdown 文件`)
        return
      }
      const resolved = resolveProjection(config.projections, adapter.projection)
      if (!resolved) {
        col.add(4, 'error',
          `\`${at}.projection\` 指向未注册投影 \`${adapter.projection}\``)
        return
      }
      if (resolved.renderer !== 'agentEntryCommon') {
        col.add(4, 'error',
          `\`${at}.projection\` 必须使用 \`agentEntryCommon\` renderer，实际 \`${resolved.renderer}\``)
        return
      }

      const matches = (zonesByFile.get(rel) ?? []).filter((zone) => zone.id === adapter.projection)
      if (matches.length !== 1) {
        col.add(4, 'error',
          `已声明的 ${adapter.platform} adapter \`${rel}\` 必须恰好包含一个 \`${adapter.projection}\` 生成区，实际 ${matches.length} 个`,
          { file: rel })
        return
      }
      validAdapters++
    })
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
  if (Array.isArray(adapters)) {
    col.stat(4, '已声明 adapter', adapters.length)
    col.stat(4, '有效 adapter', validAdapters)
  }
  if (write) col.stat(4, '已重写', rewritten)
  return { zoneCount, mismatched, uncovered, ratios, rewritten, plan }
}

/**
 * 执行重写计划。唯一的写入点。
 *
 * 注意 nextLines 是 readText + split(/\r?\n/) 的产物，join('\n') 会把
 * CRLF 归一成 LF —— 这是既有行为，determinism 测试依赖它，不要"修"。
 */
export function applyZonePlan(plan) {
  for (const entry of plan) {
    fs.writeFileSync(entry.abs, entry.nextLines.join('\n'), 'utf8')
  }
  return plan.length
}

/**
 * 签名兼容的 wrapper：先算计划，再落盘。既有调用方与测试无需改动。
 * 返回形状与拆分前逐字段一致（不含 plan —— 想要计划的调用方直接用 planZones）。
 */
export function checkZones({ specsRoot, config, model, col, write = false }) {
  const { plan, ...result } = planZones({ specsRoot, config, model, col, write })
  if (write) applyZonePlan(plan)
  return result
}
