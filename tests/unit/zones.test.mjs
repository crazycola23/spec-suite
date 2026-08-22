#!/usr/bin/env node
/**
 * 两区制适配层的单元测试：planZones（只读）/ applyZonePlan（只写）。
 *
 * 为什么单独一个文件：check-spec-suite.test.mjs 在整轮重构里当回归 oracle，
 * 不改动。拆分带来的新契约（校验与落盘可分别测）在这里锁。
 *
 * 这些用例刻意不经过 loadConfig / buildModel / YAML —— config 与 model
 * 都用字面量，坏一处只会有一处红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeCollector } from '../../src/truth/diagnostics/collector.mjs'
import { RENDERERS } from '../../src/truth/projections/renderers.mjs'
import { applyZonePlan, checkZones, planZones } from '../../src/truth/adapters/zones.mjs'

const CONFIG = {
  markdownGlobs: ['**/*.md'],
  excludeFromScan: ['node_modules/**'],
  projections: { gaps: 'gapTable' },
}

const MODEL = {
  collections: {
    gaps: [{ value: {
      code: 'G-01', missing: '缺一条', blocks: 'X', protectiveDefault: '拒绝',
      rollbackCost: '低', owner: '甲', status: 'open',
    } }],
  },
}

/** gapTable 对 MODEL 的期望输出。生成区的唯一正确内容。 */
const WANT = RENDERERS.gapTable(MODEL)

const zoned = (body) => ['# 台账', '', '<!-- BEGIN GENERATED: gaps -->', ...body, '<!-- END GENERATED: gaps -->', ''].join('\n')
const GOOD = zoned(WANT)
const BAD = zoned(WANT.map((l) => l.replace('G-01', 'G-99')))

const ENTRY_MODEL = {
  ...MODEL,
  agentEntry: { common: { markdown: '## Shared invariants\n\nUnknown stays unknown.' } },
}
const ENTRY_BODY = RENDERERS.agentEntryCommon(ENTRY_MODEL)
const entry = (platform) => [
  `# Project · ${platform} adapter`,
  '',
  '<!-- BEGIN GENERATED: agent-entry.common -->',
  ...ENTRY_BODY,
  '<!-- END GENERATED: agent-entry.common -->',
  '',
  `## ${platform}-specific handwritten region`,
  '',
].join('\n')
const ADAPTER_CONFIG = {
  markdownGlobs: ['**/*.md'],
  excludeFromScan: ['node_modules/**'],
  projections: { 'agent-entry.common': 'agentEntryCommon' },
  agentEntry: {
    source: 'contracts/agent-entry.yaml',
    adapters: [
      { platform: 'claude', path: 'CLAUDE.md', projection: 'agent-entry.common' },
      { platform: 'codex', path: 'AGENTS.md', projection: 'agent-entry.common' },
    ],
  },
}

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-zones-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return root
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')

test('planZones 即使 write:true 也不写盘 —— 唯一写点是 applyZonePlan', () => {
  const root = fixture({ 'gaps.md': BAD })
  const col = makeCollector()

  const r = planZones({ specsRoot: root, config: CONFIG, model: MODEL, col, write: true })

  // 磁盘必须原样不动
  assert.equal(read(root, 'gaps.md'), BAD, 'planZones 写盘了 —— 它必须是纯函数')
  // 但计划已经算好了
  assert.equal(r.rewritten, 1)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].file, 'gaps.md')
  assert.equal(r.plan[0].nextLines.join('\n'), GOOD)

  // 落盘是单独一步
  assert.equal(applyZonePlan(r.plan), 1)
  assert.equal(read(root, 'gaps.md'), GOOD)
})

test('计划里只包含真正被重写的文件（per-file 计数，不是"到此为止有人改过吗"）', () => {
  // a- 排在 b- 前面（walkFiles 排序）。旧代码里 rewritten 是函数级的，
  // 处理 b-good.md 时它已经是 1 —— 只靠后面的逐行比较才没误写。
  // 这条用例把"计划 == 真正被 splice 的文件"钉住。
  const root = fixture({ 'a-bad.md': BAD, 'b-good.md': GOOD })
  const col = makeCollector()

  const r = planZones({ specsRoot: root, config: CONFIG, model: MODEL, col, write: true })

  assert.deepEqual(r.plan.map((e) => e.file), ['a-bad.md'])
  assert.equal(r.mismatched, 1)
  assert.equal(r.rewritten, 1)

  applyZonePlan(r.plan)
  assert.equal(read(root, 'a-bad.md'), GOOD)
  assert.equal(read(root, 'b-good.md'), GOOD, '已经一致的文件不该被碰')
})

test('全部一致时计划为空，applyZonePlan 不写任何文件', () => {
  const root = fixture({ 'gaps.md': GOOD })
  const before = fs.statSync(path.join(root, 'gaps.md')).mtimeMs
  const col = makeCollector()

  const r = planZones({ specsRoot: root, config: CONFIG, model: MODEL, col, write: true })

  assert.deepEqual(r.plan, [])
  assert.equal(r.rewritten, 0)
  assert.equal(applyZonePlan(r.plan), 0)
  assert.equal(fs.statSync(path.join(root, 'gaps.md')).mtimeMs, before, '零改动却动了文件 mtime')
})

test('checkZones 的返回形状不含 plan —— facade 公开面不变', () => {
  const root = fixture({ 'gaps.md': BAD })
  const col = makeCollector()

  const r = checkZones({ specsRoot: root, config: CONFIG, model: MODEL, col, write: true })

  assert.deepEqual(Object.keys(r).sort(), ['mismatched', 'ratios', 'rewritten', 'uncovered', 'zoneCount'])
  assert.equal(r.rewritten, 1)
  // wrapper 仍然要落盘
  assert.equal(read(root, 'gaps.md'), GOOD)
})

test('"已重写" stat 只在 write 模式出现', () => {
  const root = fixture({ 'gaps.md': BAD })

  const ro = makeCollector()
  checkZones({ specsRoot: root, config: CONFIG, model: MODEL, col: ro })
  assert.ok(!('已重写' in (ro.stats[4] ?? {})), '只读模式不该报"已重写"')
  assert.equal(read(root, 'gaps.md'), BAD, 'write:false 绝不许写盘')

  const rw = makeCollector()
  checkZones({ specsRoot: root, config: CONFIG, model: MODEL, col: rw, write: true })
  assert.equal(rw.stats[4]['已重写'], 1)
})

test('重写会把 CRLF 归一成 LF —— 既有行为，determinism 测试依赖它', () => {
  const root = fixture({ 'gaps.md': BAD.replace(/\n/g, '\r\n') })
  const col = makeCollector()

  const r = planZones({ specsRoot: root, config: CONFIG, model: MODEL, col, write: true })
  applyZonePlan(r.plan)

  const after = read(root, 'gaps.md')
  assert.ok(!after.includes('\r'), '写回后不该残留 CR')
  assert.equal(after, GOOD)
})

test('每个已声明 adapter 都各自包含同一 canonical projection', () => {
  const root = fixture({
    'CLAUDE.md': entry('Claude'),
    'AGENTS.md': entry('Codex'),
  })
  const col = makeCollector()

  const r = planZones({ specsRoot: root, config: ADAPTER_CONFIG, model: ENTRY_MODEL, col })

  assert.equal(r.mismatched, 0)
  assert.equal(col.findings.filter((f) => f.severity === 'error').length, 0)
  assert.equal(col.stats[4]['已声明 adapter'], 2)
  assert.equal(col.stats[4]['有效 adapter'], 2)
})

test('另一个文件已经有 projection，也不能掩盖已声明 AGENTS.md 缺失', () => {
  const root = fixture({ 'CLAUDE.md': entry('Claude') })
  const col = makeCollector()

  planZones({ specsRoot: root, config: ADAPTER_CONFIG, model: ENTRY_MODEL, col })

  assert.ok(col.findings.some((f) =>
    f.severity === 'error' && /找不到已声明的 codex adapter.*AGENTS\.md/.test(f.message)))
  assert.equal(col.stats[4]['有效 adapter'], 1)
})

test('已声明 adapter 存在但没有对应 marker 时 fail closed', () => {
  const root = fixture({
    'CLAUDE.md': entry('Claude'),
    'AGENTS.md': '# Codex\n\n只有手写内容。\n',
  })
  const col = makeCollector()

  planZones({ specsRoot: root, config: ADAPTER_CONFIG, model: ENTRY_MODEL, col })

  assert.ok(col.findings.some((f) =>
    f.severity === 'error' && /AGENTS\.md.*必须恰好包含一个.*实际 0 个/.test(f.message)))
})

test('canonical common projection 已注册时，不允许 adapters 为空', () => {
  const root = fixture({ 'CLAUDE.md': entry('Claude') })
  const config = {
    ...ADAPTER_CONFIG,
    agentEntry: { ...ADAPTER_CONFIG.agentEntry, adapters: [] },
  }
  const col = makeCollector()

  planZones({ specsRoot: root, config, model: ENTRY_MODEL, col })

  assert.ok(col.findings.some((f) =>
    f.severity === 'error' && /agentEntry\.adapters.*为空.*没有任何平台执行入口/.test(f.message)))
})

test('adapter path 不得重复、逃出 specs root 或指向未注册 projection', () => {
  const root = fixture({
    'CLAUDE.md': entry('Claude'),
    'AGENTS.md': entry('Codex'),
  })
  const config = {
    ...ADAPTER_CONFIG,
    agentEntry: {
      ...ADAPTER_CONFIG.agentEntry,
      adapters: [
        { platform: 'claude', path: 'CLAUDE.md', projection: 'agent-entry.common' },
        { platform: 'duplicate', path: './CLAUDE.md', projection: 'agent-entry.common' },
        { platform: 'escape', path: '../AGENTS.md', projection: 'agent-entry.common' },
        { platform: 'unknown', path: 'AGENTS.md', projection: 'agent-entry.missing' },
      ],
    },
  }
  const col = makeCollector()

  planZones({ specsRoot: root, config, model: ENTRY_MODEL, col })
  const errors = col.findings.filter((f) => f.severity === 'error').map((f) => f.message).join('\n')

  assert.match(errors, /adapter 路径重复声明：`CLAUDE\.md`/)
  assert.match(errors, /逃出了 specs root/)
  assert.match(errors, /指向未注册投影 `agent-entry\.missing`/)
})
