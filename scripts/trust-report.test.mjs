// trust-report 的回归测试。
//
// 这份报告的价值全在"它是否准确"上：一份漏掉记录、或者把 not-proven 渲染成
// 空白的报告，比没有报告更糟 —— 它会让读者以为空白处是安全的。所以下面的
// 测试重点不是"能跑出东西"，而是**不完整时必须拒绝出报告**。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ENFORCEMENT, INVARIANTS } from '../registry/invariants.mjs'
import {
  buildTrustReport, main, parseArgv, renderJson, renderMd,
} from './trust-report.mjs'

/** 收集写入的字符串，替代 process.stdout / stderr。 */
const sink = () => {
  const chunks = []
  return { write: (s) => chunks.push(s), text: () => chunks.join('') }
}

const OK_RECORD = {
  id: 'X-OK',
  kind: 'invariant',
  title: 't',
  statement: 's',
  severity: 'error',
  schemaVersions: [1],
  enforcement: ENFORCEMENT.MACHINE,
  checks: [1],
  residualRisk: 'r',
  docRefs: ['README.md'],
}

test('真 registry 能生成报告：无 problem，四节划分不重不漏', () => {
  const report = buildTrustReport()
  assert.deepEqual(report.problems, [])
  assert.equal(report.sections.length, 4)
  assert.equal(report.total, INVARIANTS.length)

  const covered = report.sections.reduce((n, s) => n + s.records.length, 0)
  assert.equal(covered, INVARIANTS.length, '四节之和必须等于总数')

  // 不重：同一个 id 不能出现在两节里。
  const ids = report.sections.flatMap((s) => s.records.map((r) => r.id))
  assert.equal(new Set(ids).size, ids.length, 'id 不得跨节重复')
})

test('四节顺序固定为强→弱，且四类都在（空类别也要在）', () => {
  const report = buildTrustReport()
  assert.deepEqual(report.sections.map((s) => s.level), [
    ENFORCEMENT.MACHINE,
    ENFORCEMENT.TRUSTED,
    ENFORCEMENT.EXTERNAL,
    ENFORCEMENT.NOT_PROVEN,
  ])
})

test('fail closed：enforcement 落在四分法之外 ⇒ 报 problem，不静默丢弃', () => {
  const report = buildTrustReport(
    [{ ...OK_RECORD }, { ...OK_RECORD, id: 'X-WEIRD', enforcement: 'somewhat-enforced' }],
  )
  assert.ok(
    report.problems.some((p) => p.includes('X-WEIRD') && p.includes('不在四分法里')),
    `应当指名报出落在四分法外的记录，实际：${JSON.stringify(report.problems)}`,
  )
  // 关键：那条记录确实没有出现在任何一节里 —— 所以必须靠 problem 暴露它。
  const ids = report.sections.flatMap((s) => s.records.map((r) => r.id))
  assert.ok(!ids.includes('X-WEIRD'))
})

test('fail closed：registry 自身有问题会被前缀转述出来', () => {
  const report = buildTrustReport([{ ...OK_RECORD, residualRisk: '' }])
  assert.ok(
    report.problems.some((p) => p.startsWith('registry 自身有问题：') && p.includes('residualRisk')),
    `实际：${JSON.stringify(report.problems)}`,
  )
})

test('fail closed：有 problem 时 main 返回 1 且 stdout 一个字节都不写', () => {
  const out = sink()
  const err = sink()
  const code = main([], {
    stdout: out,
    stderr: err,
    records: [{ ...OK_RECORD, id: 'X-WEIRD', enforcement: 'nope' }],
  })
  assert.equal(code, 1)
  assert.equal(out.text(), '', '不完整的报告绝不能写到 stdout —— 半份报告会被当成完整的读')
  assert.match(err.text(), /无法生成信任边界报告/)
  assert.match(err.text(), /X-WEIRD/)
})

test('确定性：同一份 registry 连续两次渲染字节相同，且不含日期/时间戳', () => {
  const a = renderMd(buildTrustReport())
  const b = renderMd(buildTrustReport())
  assert.equal(a, b)

  const j1 = renderJson(buildTrustReport())
  const j2 = renderJson(buildTrustReport())
  assert.equal(j1, j2)

  // 时间戳会让报告无法进 golden 语料，也会制造无意义的 diff（D9 同理）。
  for (const [name, text] of [['md', a], ['json', j1]]) {
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, `${name} 不应含 ISO 日期`)
    assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}/, `${name} 不应含时钟时间`)
    assert.doesNotMatch(text, /generatedAt/, `${name} 不应含 generatedAt`)
  }
})

test('md 里每条记录的 residualRisk 都逐字出现 —— 这是报告唯一的新增信息', () => {
  const md = renderMd(buildTrustReport())
  for (const r of INVARIANTS) {
    // 表格转义只动 `|`，其余逐字。residualRisk 里目前没有 `|`，若将来有，
    // 这条断言会失败并提醒作者去核对转义 —— 那是期望的行为。
    assert.ok(
      md.includes(r.residualRisk),
      `${r.id} 的 residualRisk 没有出现在报告里：报告漏掉它等于假装它已被证明`,
    )
    assert.ok(md.includes(r.id), `${r.id} 本身没有出现在报告里`)
  }
})

test('md 显著声明"机器检查通过 ≠ 语义真相已证明"', () => {
  const md = renderMd(buildTrustReport())
  assert.ok(md.includes('机器检查通过 ≠ 语义真相已证明'))
  // 必须在开头（前 15 行内），不能埋在 600 行报告的末尾。
  const head = md.split('\n').slice(0, 15).join('\n')
  assert.ok(head.includes('机器检查通过 ≠ 语义真相已证明'), '免责声明埋在末尾等于没写')
})

test('residualRisk 不接受敷衍占位 —— 填字段糊过校验器就失去意义', () => {
  const cheap = new Set(['无', '没有', '暂无', '待补', 'TODO', 'TBD', 'N/A', 'n/a', '-', '—', 'r'])
  const lazy = INVARIANTS.filter((r) => cheap.has(r.residualRisk.trim()) || r.residualRisk.trim().length < 8)
  assert.deepEqual(
    lazy.map((r) => r.id), [],
    '这些记录的 residualRisk 是占位符：写不出残余风险通常意味着还没核对强制点',
  )
})

test('无机器证据的记录明确写"无"，不留空白让人误读为"有但没列"', () => {
  const md = renderMd(buildTrustReport())
  const noEvidence = INVARIANTS.filter((r) => r.checks.length === 0 && (r.evidence ?? []).length === 0)
  assert.ok(noEvidence.length > 0, '至少 external/not-proven 两类应当没有机器证据')
  assert.ok(md.includes('—— 无机器证据'))
  // 同理，severity 为 null 的记录不得渲染成 `null` 或空格。
  assert.doesNotMatch(md, /\| 严重度 \| *\|/)
  assert.doesNotMatch(md, /\| 严重度 \| null \|/)
})

test('json 形状：顶层带声明与来源，每条记录带 residualRisk 与 schemaKind', () => {
  const parsed = JSON.parse(renderJson(buildTrustReport()))
  assert.equal(parsed.report, 'trust-boundary')
  assert.match(parsed.disclaimer, /机器检查通过 ≠ 语义真相已证明/)
  assert.equal(parsed.source, 'registry/invariants.mjs')
  assert.equal(parsed.total, INVARIANTS.length)

  for (const s of parsed.sections) {
    for (const r of s.records) {
      assert.equal(typeof r.residualRisk, 'string')
      assert.notEqual(r.residualRisk, '')
      assert.equal(typeof r.schemaKind, 'string')
      assert.ok(Array.isArray(r.checks) && Array.isArray(r.evidence) && Array.isArray(r.docRefs))
      // checks 展开成 {id, name}，name 为 null 说明引用了不存在的 check。
      for (const c of r.checks) assert.notEqual(c.name, null, `${r.id} 引用了不存在的检查 ${c.id}`)
    }
  }
})

test('argv：未知参数报错并逐字沿用仓库文案', () => {
  assert.equal(parseArgv(['--bogus']).error, '未知参数：--bogus')
  assert.equal(main(['--bogus'], { stdout: sink(), stderr: sink() }), 2)
})

test('argv：--format 只接受 json / md，缺值也拒绝', () => {
  assert.match(parseArgv(['--format', 'xml']).error, /只接受 json 或 md/)
  assert.match(parseArgv(['--format']).error, /\(缺失\)/)
  assert.equal(parseArgv(['--format', 'json']).opts.format, 'json')
  assert.equal(parseArgv([]).opts.format, 'md', '缺省是 md')
})

test('--help 走 stdout 并返回 0；正常运行把报告写 stdout', () => {
  const help = sink()
  assert.equal(main(['--help'], { stdout: help, stderr: sink() }), 0)
  assert.match(help.text(), /用法：node scripts\/trust-report\.mjs/)

  const out = sink()
  assert.equal(main([], { stdout: out, stderr: sink() }), 0)
  assert.match(out.text(), /^# 信任边界报告\n/)
})

test('报告不落盘：模块里没有任何写文件的 import 或调用', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('./trust-report.mjs', import.meta.url), 'utf8',
  )
  // 派生物不能成为权威（N-02）。一份签进仓库的报告会立刻变成新的漂移面，
  // 所以这里从源码层面锁住"只写 stdout"。
  assert.doesNotMatch(src, /writeFileSync|writeFile\(|createWriteStream|node:fs/)
})
