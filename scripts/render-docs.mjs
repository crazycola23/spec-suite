#!/usr/bin/env node
/**
 * render-docs.mjs —— 把 registry 渲染进文档的生成区（D11）
 *
 * 为什么存在：SCHEMA.md §7 的七类检查表、DISCIPLINES.md §3 的 N-01～N-04
 * 清单，都是 registry 内容的**手抄副本**。手抄副本的问题不是当下不准，而是
 * 改动时只改一处 —— 于是出现「README 说 B、checker 强制 A、测试证明 A」，
 * 三份各自自洽、谁都不报错、读文档的人得到错误结论。
 *
 * 做法上刻意**复用仓库自己的两区制机制**（`findZones`），而不是另写一套
 * marker 解析：仓库里只允许有一份 zone 实现，否则「生成区」这个概念本身
 * 就有两种语义了。
 *
 * 与 V1 checker 的关系：checker 的检查 4 也扫生成区，但它只认在
 * `config.projections` 里注册过的 ID，而仓库根本没有 `spec-suite.config.json`
 * （D11：不自托管完整 suite）。所以 `registry.*` 这些 ID 不会与 checker
 * 管的投影 ID 冲突 —— 两者作用在不同的目录树上，各自 fail-closed。
 *
 * 退出码：`--check` 有漂移 → 1；`--write` 写入成功 → 0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { findZones } from '../src/truth/adapters/zones.mjs'
import { CHECKS, invariantsOfKind, validateRegistry } from '../registry/invariants.mjs'

/**
 * 每个文件允许出现的生成区 ID —— 白名单，不是通配。
 *
 * 为什么必须逐文件白名单而不是扫全部 `*.md`：`templates/L0/example/` 与
 * `scripts/fixtures/` 下有**真实的**生成区，它们由 V1 checker 按语料自己的
 * config 管理。若这里扫全树，就会用 registry 的内容去覆盖别人的投影 ——
 * 那是把两个真相源接到同一段字节上。
 *
 * 反向也堵：文件里出现了不在这张表里的 ID ⇒ 报错，不是忽略。
 */
export const DOC_TARGETS = [
  { file: 'SCHEMA.md', zones: ['registry.checks'] },
  { file: 'DISCIPLINES.md', zones: ['registry.bans'] },
]

/**
 * 把 ``` / ~~~ 围栏里的行**置空但不删除**。
 *
 * 必须这么做的原因：`SCHEMA.md` 里有一段 ```markdown 围栏，内容是
 * 「生成区标记长什么样」的**示例**（`<!-- BEGIN GENERATED: agent-entry.common -->`）。
 * `findZones` 不认识围栏 —— 对它来说示例标记和真标记逐字相同。不屏蔽的话，
 * 这里就会把一段文档说明当成生成区改掉。
 *
 * 置空而不删除，是为了让行号与原数组一一对应，splice 时下标才能直接用 ——
 * 与 `check-architecture.mjs` 的 `blankComments` 同一手法。
 *
 * 屏蔽只作用于**寻找**生成区的那份拷贝；写回时用的始终是原始行。
 *
 * 不在 `findZones` 里加围栏感知：那会改动 V1 checker 的既有语义
 * （检查 4 会突然对围栏内的标记视而不见），属于"顺手改核心"。
 *
 * @returns {{lines: string[], unclosed: number|null}} unclosed 是未闭合围栏的行号（1-based）
 */
export function maskFences(lines) {
  const OPEN = /^\s{0,3}(`{3,}|~{3,})/
  const out = []
  let fence = null
  let fenceAt = 0
  lines.forEach((line, i) => {
    if (fence === null) {
      const m = line.match(OPEN)
      if (m) { fence = m[1]; fenceAt = i + 1; out.push(''); return }
      out.push(line)
      return
    }
    // 闭合围栏：同种字符、不短于开启围栏、且该行没有其它内容。
    const c = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/)
    if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null
    out.push('')
  })
  // 未闭合围栏会把文件剩余部分全部吞掉 —— 那正是"静默宽松"的形状：
  // 生成区会凭空消失，而 --check 报"一切正常"。所以要显式报出来。
  return { lines: out, unclosed: fence === null ? null : fenceAt }
}

/** SCHEMA.md §7 的七类检查表。列头与既有文档一致，只有第二列改用 registry 的正式名字。 */
function renderChecks() {
  const L = ['| # | 检查 | error 的含义 |', '|---|---|---|']
  for (const c of CHECKS) L.push(`| ${c.id} | ${c.name} | ${c.errorMeaning} |`)
  return L
}

/** DISCIPLINES.md §3 的 N-01～N-04 清单。 */
function renderBans() {
  return invariantsOfKind('ban').map((r) => `- \`${r.id}\`：${r.statement}`)
}

/** 生成区 ID → 渲染器。渲染器是纯函数：无参数、只读 registry、返回行数组。 */
export const ZONE_RENDERERS = {
  'registry.checks': renderChecks,
  'registry.bans': renderBans,
}

/**
 * 算出每个目标文件的期望内容。只读，不写。
 *
 * @returns {{problems: string[], files: Array<{file: string, abs: string, changed: boolean, nextLines: string[], zones: Array<{id: string, changed: boolean, expected: string[], actual: string[]}>}>}}
 */
export function planDocs(repoRoot, targets = DOC_TARGETS) {
  const problems = validateRegistry().map((p) => `registry 自身有问题：${p}`)
  const files = []
  const rendered = new Set()

  for (const target of targets) {
    const abs = path.join(repoRoot, target.file)
    if (!fs.existsSync(abs)) { problems.push(`目标文件不存在：${target.file}`); continue }
    // 这里不用 V1 的 readText：那个函数会剥 BOM，而本脚本要按原字节写回。
    const text = fs.readFileSync(abs, 'utf8')
    const lines = text.split(/\r?\n/)
    const masked = maskFences(lines)
    if (masked.unclosed !== null) {
      problems.push(`${target.file}:${masked.unclosed} 的代码围栏没有闭合 —— 无法可靠判断哪些标记是示例，拒绝处理该文件`)
      continue
    }

    // col 收集 findZones 的标记结构错误（缩进、嵌套、ID 不匹配、未闭合）。
    // 这些在 V1 里是检查 4 的 finding；这里同样必须当成问题，不能当没看见。
    const markerProblems = []
    const col = { add: (_check, _sev, message, where) => markerProblems.push(`${target.file}:${where?.line ?? '?'} ${message}`) }
    const zones = findZones(masked.lines, { file: target.file, col })
    problems.push(...markerProblems)

    const allowed = new Set(target.zones)
    const seen = new Set()
    const zoneResults = []
    let nextLines = lines.slice()

    // 倒序处理：splice 会改变后续下标，从后往前改则前面的 begin/end 仍然有效。
    for (const z of [...zones].sort((a, b) => b.begin - a.begin)) {
      if (!allowed.has(z.id)) {
        problems.push(
          `${target.file}:${z.begin + 1} 有未登记的生成区 \`${z.id}\` —— 请加进 render-docs 的 DOC_TARGETS，`
          + `或确认它是否本该由别的生成器管理。未登记不等于放行。`,
        )
        continue
      }
      if (seen.has(z.id)) { problems.push(`${target.file} 里生成区 \`${z.id}\` 出现多次 —— 同一 ID 只能有一个权威位置`); continue }
      seen.add(z.id)
      rendered.add(z.id)

      const render = ZONE_RENDERERS[z.id]
      if (!render) { problems.push(`没有 \`${z.id}\` 的渲染器`); continue }
      const expected = render()
      const changed = z.body.length !== expected.length || z.body.some((l, i) => l !== expected[i])
      if (changed) nextLines.splice(z.begin + 1, z.end - z.begin - 1, ...expected)
      zoneResults.push({ id: z.id, changed, expected, actual: z.body })
    }

    for (const id of target.zones) {
      if (!seen.has(id)) problems.push(`${target.file} 里找不到生成区 \`${id}\` —— 标记被删了？`)
    }

    const changed = nextLines.length !== lines.length || nextLines.some((l, i) => l !== lines[i])
    files.push({ file: target.file, abs, changed, nextLines, zones: zoneResults })
  }

  // 有渲染器但没有任何文档区消费它 ⇒ 渲染器是死代码，或者标记被删了。
  for (const id of Object.keys(ZONE_RENDERERS)) {
    if (!rendered.has(id)) problems.push(`渲染器 \`${id}\` 没有被任何文档区使用`)
  }
  return { problems, files }
}

/** 落盘。与仓库其它写点一致：先写 tmp 再 rename，避免中断留下半份文件。 */
export function applyDocPlan(files) {
  const written = []
  for (const f of files) {
    if (!f.changed) continue
    const tmp = `${f.abs}.tmp-render`
    fs.writeFileSync(tmp, f.nextLines.join('\n'), 'utf8')
    fs.renameSync(tmp, f.abs)
    written.push(f.file)
  }
  return written
}

const HELP = `用法：node scripts/render-docs.mjs [--check|--write]

  --check   （默认）只比对，有漂移则退出码 1
  --write   把 registry 的内容写进文档生成区

生成区内容由 registry/invariants.mjs 决定。改文档里的生成区不会生效 ——
下一次 --check 就会把它报成漂移。要改内容，改 registry。
`

export function main(argv) {
  let mode = 'check'
  for (const arg of argv) {
    if (arg === '--check') mode = 'check'
    else if (arg === '--write') mode = 'write'
    else if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); return 0 }
    else { process.stderr.write(`未知参数：${arg}\n`); return 2 }
  }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const { problems, files } = planDocs(repoRoot)

  for (const p of problems) process.stderr.write(`✖ ${p}\n`)
  // 结构性问题不允许被 --write 盖过去：用坏掉的 registry 或读不懂的文件
  // 渲染，等于把错误固化进 canonical 文本。
  if (problems.length > 0) return 1

  const drifted = files.filter((f) => f.changed)
  if (mode === 'write') {
    const written = applyDocPlan(files)
    process.stdout.write(written.length === 0 ? '文档已是最新，未改动任何文件\n' : `已写入：${written.join(', ')}\n`)
    return 0
  }

  if (drifted.length === 0) { process.stdout.write(`${files.length} 个文件的生成区与 registry 一致\n`); return 0 }
  for (const f of drifted) {
    for (const z of f.zones.filter((x) => x.changed)) {
      process.stderr.write(`✖ ${f.file} 的生成区 \`${z.id}\` 与 registry 不一致：\n`)
      for (const l of z.actual) process.stderr.write(`  - ${l}\n`)
      for (const l of z.expected) process.stderr.write(`  + ${l}\n`)
    }
  }
  process.stderr.write('\n运行 `node scripts/render-docs.mjs --write` 重新生成。\n')
  return 1
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) process.exit(main(process.argv.slice(2)))
