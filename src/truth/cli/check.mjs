// CLI 层：唯一持有 exit code 的地方。
// 库代码一律返回值 / 抛异常，绝不 process.exit()。
//
// fallbackConfigDir 由调用方注入，而不是从 import.meta.url 推导：
// fallback config 实际位于 scripts/spec-suite.config.json，
// 锚点必须跟着入口脚本走，不能跟着本模块的位置走。

import fs from 'node:fs'
import path from 'node:path'
import { toPosix } from '../../shared/text.mjs'
import { schemaVersionHint } from '../../shared/schema-version.mjs'
import { renderReportMd } from '../diagnostics/report.mjs'
import { run } from '../pipeline.mjs'

export function parseArgv(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--specs-root') o.specsRoot = argv[++i]
    else if (a === '--config') o.config = argv[++i]
    else if (a === '--report') o.report = argv[++i]
    else if (a === '--write-generated-regions' || a === '--write') o.write = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return o
}

export const HELP = `用法：node check-spec-suite.mjs [选项]

  --specs-root <路径>   规格库根目录（默认当前目录）
  --config <路径>       config 文件（默认 <root>/spec-suite.config.json）
  --report <目录>       把 report.json + report.md 写到这里（不写入被检查的库）
  --write-generated-regions
                        只重写 .md 生成区，不生成 contract bundle
  --write               上一参数的兼容别名
  --quiet               只打摘要
`

export async function main({ argv, fallbackConfigDir }) {
  const opts = parseArgv(argv)
  if (opts.help) { process.stdout.write(HELP); return 0 }
  opts.fallbackConfig = path.join(fallbackConfigDir, 'spec-suite.config.json')

  let r
  try {
    r = await run(opts)
    if (opts.write && r.zoneResult.rewritten > 0) {
      r = await run({ ...opts, write: false })
    }
  } catch (e) {
    // 第一行逐字保留 `${e.message}`：v1-vertical-slice.test.mjs 按正则断言它。
    // 补充说明单独一行，与 guard / migrate / verify-consumer 三个脚本一致 ——
    // 版本类错误的历史文案是「必须是 schemaVersion 1」，字面上把人指向
    // 「降级文档」，而正确处置恰好相反。措辞属于 CLI 层，判定不动。
    process.stderr.write(`检查器无法运行：${e.message}\n${schemaVersionHint(e)}`)
    return 2
  }

  const md = renderReportMd({
    specsRoot: r.report.specsRoot,
    configPath: r.report.configPath,
    isFallback: r.report.isFallbackConfig,
    findings: r.col.findings,
    stats: r.col.stats,
  })

  if (opts.report) {
    fs.mkdirSync(opts.report, { recursive: true })
    fs.writeFileSync(path.join(opts.report, 'report.json'), JSON.stringify(r.report, null, 2), 'utf8')
    fs.writeFileSync(path.join(opts.report, 'report.md'), md, 'utf8')
    process.stdout.write(`报告已写入 ${toPosix(opts.report)}\n`)
  } else if (!opts.quiet) {
    process.stdout.write(md)
  }

  const s = r.report.summary
  process.stdout.write(`缺陷 ${s.error} / 警告 ${s.warn} / 信息 ${s.info}\n`)
  return r.errors > 0 ? 1 : 0
}
