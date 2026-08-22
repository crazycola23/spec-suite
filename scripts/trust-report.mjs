#!/usr/bin/env node
// trust-report —— 把"什么被证明了、什么只是被相信了"写清楚。
//
// 这份报告存在的唯一理由：本仓库最危险的误读是把**机器检查通过**当成
// **语义真相已证明**。CI 绿灯只说明 checker 找不到它会找的那些问题；
// 它不说明 canonical 里的数字是对的、source 文档真的规定了那件事、
// 或者 OS 真的按 mode bit 隔离了两个身份。
//
// 所以报告的主体不是"通过了多少条"，而是每条规则的 residualRisk ——
// 它**没有**证明什么。只报"通过"的报告会让读者更自信，而这里要做的
// 恰恰相反：让人准确地知道自己的信心该建立在什么上。
//
// 设计约束：
//   * **只写 stdout，不落盘。** 一份签进仓库的 trust-report 会变成第 N 份
//     副本，还会带来"报告与 registry 漂移"这个新的漂移面。派生物不能成为
//     权威（N-02）—— 报告是派生物，所以它不留下可被引用的副本。
//   * **确定性**：没有时间戳、没有主机名、没有随机顺序。同一份 registry
//     永远得到同一份字节，可以直接进 golden 语料、也可以 diff。
//   * **fail closed**：registry 自身有问题、或有记录落在四分法之外时，
//     打印问题并退出 1，不渲染一份"看起来完整"的报告。
//   * domain 逻辑不退出进程：`main(argv)` 返回退出码，只有文件末尾的 CLI
//     guard 调 `process.exit`。

import { pathToFileURL } from 'node:url'

import { MESSAGES_ZH, parseFlags } from '../src/shared/argv.mjs'

import {
  CHECKS, ENFORCEMENT, INVARIANTS,
  DEFAULT_SCHEMA_KIND, checkById, groupByEnforcement, validateRegistry,
} from '../registry/invariants.mjs'

/**
 * 四类的呈现顺序与说明。
 *
 * 顺序从强到弱，是有意的：读者从上往下走，信心逐段下降，最后停在
 * not-proven。反过来排会让报告以"已覆盖"收尾，那是错误的最终印象。
 *
 * `meaning` 写的是**这一类的绿灯能推出什么**，`caution` 写的是**不能推出
 * 什么**。两句都必须具体 —— 泛泛的免责声明没人会读第二遍。
 */
const SECTIONS = [
  {
    level: ENFORCEMENT.MACHINE,
    title: 'Machine Enforced —— 每次运行都验证',
    meaning: '有 checker 或 V2 代码在每次运行时验证；违反会被拦下。',
    caution: '证明的是"这段代码检查的那件事成立"，不是"这条规则的意图达成了"。'
      + '每条的 residualRisk 写明了强制点到意图之间的缺口。',
  },
  {
    level: ENFORCEMENT.TRUSTED,
    title: 'Trusted Assertion —— 工具接受但不验证',
    meaning: '由人或文档声明为真，工具原样接受。',
    caution: '这一类的绿灯**不含任何证据**。工具沿着这些声明继续推理，'
      + '所以一条错误的声明会安静地污染它下游的一切结论。',
  },
  {
    level: ENFORCEMENT.EXTERNAL,
    title: 'External Assumption —— 依赖工具之外的东西',
    meaning: '依赖 OS、部署形态或运维配置成立；工具最多能验证自己看得见的那部分。',
    caution: '这些假设不成立时，工具通常**察觉不到**，仍然照常返回 allow。'
      + '它们是整条链的地基，却不在链的验证范围内。',
  },
  {
    level: ENFORCEMENT.NOT_PROVEN,
    title: 'Not Proven —— 已知没人验证',
    meaning: '核对过强制点，确认没有任何机器检查覆盖它。登记在案。',
    caution: '这一类**不是待办清单**，也不是缺陷列表。它是这份报告最重要的一节：'
      + '空白写下来才能被看见。省掉它会让覆盖率看起来更高，而那正是本报告要防的事。',
  },
]

const HELP = `用法：node scripts/trust-report.mjs [--format json|md]

把 registry 的四分法（machine-enforced / trusted-assertion /
external-assumption / not-proven）渲染成信任边界报告。

  --format md     Markdown，供人阅读（缺省）
  --format json   机器可读，供下游工具消费
  -h, --help      显示本帮助

只写 stdout，不落盘。输出是确定性的：同一份 registry 得到同一份字节。`

/**
 * `--format` 的取值校验交给 spec 的 `validate` —— 它同时负责"缺失"情形，因为
 * 合并前这一句把"缺失"与"取值非法"合成了一条文案，而那条文案被
 * trust-report.test.mjs 逐字/正则钉住（`/\(缺失\)/`、`/只接受 json 或 md/`）。
 * 共享解析器的通用缺值文案会覆盖掉它，所以带 validate 的条目由 validate 自己
 * 处理 undefined；argv.test.mjs 有一条测试要求所有 validate 都拒绝 undefined，
 * 免得这个入口变成绕过缺值检测的后门。
 *
 * 因此 `SPEC` 必须导出：那条测试是全仓库扫描式的（找出所有带 validate 的 spec
 * 再逐条喂 undefined），藏在未导出的表里就等于豁免了检查。这是本文件里唯一一个
 * "为了被测试而导出"的名字，值得 —— 它换来的是"以后新增的 validate 也躲不掉"。
 */
export const SPEC = {
  '-h': { key: 'help', flag: true },
  '--help': { key: 'help', flag: true },
  '--format': {
    key: 'format',
    validate: (v) => (v === 'json' || v === 'md' ? null : `--format 只接受 json 或 md，收到：${v ?? '(缺失)'}`),
  },
}

/** 解析 argv。未知参数一律报错，不猜测。 */
export function parseArgv(argv) {
  const { options, error } = parseFlags(argv, SPEC, MESSAGES_ZH)
  if (error) return { error }
  // 缺省 md、help 缺省 false —— 与合并前的初值逐字相同。
  return { opts: { format: 'md', help: false, ...options } }
}

/**
 * 纯函数：registry → 报告数据。不读文件、不写文件。
 *
 * `problems` 非空时调用方必须放弃渲染。分两类：registry 自身的结构问题，
 * 以及"有记录落在四分法之外"。后者单独判一次是因为它的后果特别隐蔽 ——
 * 那条记录会从所有分组里消失，而报告本身看不出少了东西。
 */
export function buildTrustReport(records = INVARIANTS, checks = CHECKS) {
  const problems = validateRegistry(records, checks).map((p) => `registry 自身有问题：${p}`)
  const { groups, unclassified } = groupByEnforcement(records)

  for (const r of unclassified) {
    problems.push(
      `${r.id} 的 enforcement 是 \`${r.enforcement}\`，不在四分法里 —— 它会从报告的每一节里消失。`
      + `新增一类 enforcement 必须同时在 trust-report 的 SECTIONS 里加一节`,
    )
  }

  const sections = SECTIONS.map((s) => ({
    level: s.level,
    title: s.title,
    meaning: s.meaning,
    caution: s.caution,
    records: (groups[s.level] ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      statement: r.statement,
      severity: r.severity,
      schemaKind: r.schemaKind ?? DEFAULT_SCHEMA_KIND,
      schemaVersions: [...r.schemaVersions],
      checks: r.checks.map((id) => ({ id, name: checkById(id)?.name ?? null })),
      evidence: [...(r.evidence ?? [])],
      residualRisk: r.residualRisk,
      docRefs: [...r.docRefs],
    })),
  }))

  // 分组必须是**划分**：不重不漏。少一条会让某条规则从报告里静默消失，
  // 而那正是这份报告要防的失败形态，所以这里自查一次而不是相信 groupBy。
  const covered = sections.reduce((n, s) => n + s.records.length, 0)
  if (covered !== records.length) {
    problems.push(
      `四分法分组只覆盖了 ${covered} / ${records.length} 条记录 —— 报告不完整。`
      + `任何一条规则从报告里消失，都会让读者以为它不存在`,
    )
  }

  return { problems, sections, total: records.length }
}

const fence = (s) => String(s).replace(/\|/g, '\\|')

/** 一条记录的证据列：机器强制的指向 check 或文件，其余明确写"无"。 */
function evidenceCell(r) {
  const parts = [
    ...r.checks.map((c) => `检查 ${c.id}（${c.name ?? '?'}）`),
    ...r.evidence.map((f) => `\`${f}\``),
  ]
  return parts.length > 0 ? parts.join('；') : '—— 无机器证据'
}

/** Markdown 渲染。行序完全由 registry 决定，不含任何时间相关内容。 */
export function renderMd(report) {
  const out = ['# 信任边界报告', '']
  out.push(
    '> **机器检查通过 ≠ 语义真相已证明。**',
    '>',
    '> `npm test` 全绿、checker 零 error，说明的是"这些代码检查的那些事都成立"。',
    '> 它不说明 canonical 里的数字正确、`source` 指的文档真的规定了那件事、',
    '> 或者部署环境真的隔离了两个身份。本报告按证明强度把每条规则分成四类，',
    '> 并逐条写出它**没有**证明什么。',
    '',
    '本报告由 `registry/invariants.mjs` 派生（`node scripts/trust-report.mjs`），',
    '不落盘、不带时间戳。派生物不是权威：要改内容请改 registry。',
    '',
  )

  out.push('## 分布', '', '| 类别 | 条数 | 这一类的绿灯意味着 |', '|---|---:|---|')
  for (const s of report.sections) {
    out.push(`| ${fence(s.level)} | ${s.records.length} | ${fence(s.meaning)} |`)
  }
  out.push(`| **合计** | **${report.total}** | |`, '')

  for (const s of report.sections) {
    out.push(`## ${s.title}`, '', s.meaning, '', `**注意**：${s.caution}`, '')
    if (s.records.length === 0) {
      out.push('*本类别当前没有记录。*', '')
      continue
    }
    for (const r of s.records) {
      out.push(`### ${r.id} · ${r.title}`, '')
      out.push(`${r.statement}`, '')
      out.push('| | |', '|---|---|')
      out.push(`| 强制证据 | ${fence(evidenceCell(r))} |`)
      out.push(`| 严重度 | ${r.severity === null ? '—— 无机器强制，不编造严重度' : fence(r.severity)} |`)
      out.push(`| 适用 schema | ${fence(r.schemaKind)} v${r.schemaVersions.join(', v')} |`)
      out.push(`| 文档 | ${fence(r.docRefs.join('；'))} |`)
      out.push('')
      out.push(`**没有证明**：${r.residualRisk}`, '')
    }
  }

  return `${out.join('\n')}\n`
}

/** JSON 渲染。键序由构造顺序固定，字节确定。 */
export function renderJson(report) {
  return `${JSON.stringify({
    report: 'trust-boundary',
    disclaimer: '机器检查通过 ≠ 语义真相已证明。每条记录的 residualRisk 写明它没有证明什么。',
    source: 'registry/invariants.mjs',
    total: report.total,
    sections: report.sections,
  }, null, 2)}\n`
}

/**
 * CLI 主体。返回退出码，不调 process.exit —— 便于测试直接断言退出码。
 *
 * 退出码：0 正常；1 registry 有问题（不输出报告）；2 参数错误。
 *
 * `records` 可注入，缺省就是真 registry。这个参数只用于让测试能构造"registry
 * 坏了"的情形并断言 stdout 为空；它无法让报告变得更宽松 —— 判定逻辑全在
 * buildTrustReport 里，注入什么都要过同一道自检。
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr, records = INVARIANTS } = {}) {
  const parsed = parseArgv(argv)
  if (parsed.error) {
    stderr.write(`${parsed.error}\n\n${HELP}\n`)
    return 2
  }
  if (parsed.opts.help) {
    stdout.write(`${HELP}\n`)
    return 0
  }

  const report = buildTrustReport(records)
  if (report.problems.length > 0) {
    // fail closed：先自检，再渲染。反过来会产出一份"看起来完整"的报告，
    // 而报告的读者没有任何办法发现它少了东西。
    stderr.write(`无法生成信任边界报告：\n${report.problems.map((p) => `  - ${p}`).join('\n')}\n`)
    return 1
  }

  stdout.write(parsed.opts.format === 'json' ? renderJson(report) : renderMd(report))
  return 0
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) process.exit(main(process.argv.slice(2)))
