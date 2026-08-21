// 主流程编排。只调用各检查，不做判定，不碰 exit code。

import path from 'node:path'
import { toPosix } from '../shared/text.mjs'
import { makeCollector } from './diagnostics/collector.mjs'
import { loadConfig } from './config/load.mjs'
import { loadYamlLib } from './config/yaml.mjs'
import { buildModel } from './model/build.mjs'
import { checkSchema } from './schema/records.mjs'
import { checkIdempotencyTuples } from './schema/idempotency.mjs'
import { checkStateMachines } from './schema/state-machines.mjs'
import { checkIdRefs } from './refs/check.mjs'
import { checkZones } from './adapters/zones.mjs'
import { checkBanCoverage } from './rules/ban-coverage.mjs'
import { checkLabelCopy } from './rules/label-copy.mjs'
import { checkCoverageMatrix } from './rules/coverage-matrix.mjs'

export async function run(opts) {
  const specsRoot = path.resolve(opts.specsRoot ?? '.')
  const col = makeCollector()
  const config = loadConfig({
    specsRoot,
    configPath: opts.config,
    fallbackConfigPath: opts.fallbackConfig,
  })
  if (config.isFallback) {
    col.add(1, 'warn',
      `本库没有 spec-suite.config.json，用的是 skill 自带示例（\`${toPosix(config.configPath)}\`）。` +
      `命名空间正则与路径未必匹配本库 —— 报告里的计数按示例 config 解读`)
  }

  const YAML = await loadYamlLib(specsRoot)
  const model = buildModel({ specsRoot, config, YAML, col })
  for (const m of model.missing) {
    col.add(1, 'error', `config 里声明的字典文件不存在：\`${m}\``)
  }

  checkSchema({ model, col })
  checkIdempotencyTuples({ specsRoot, config, model, col })
  checkStateMachines({ model, col })
  const idRefResult = checkIdRefs({ specsRoot, config, model, col })
  const zoneResult = checkZones({ specsRoot, config, model, col, write: !!opts.write })
  checkBanCoverage({ specsRoot, config, col })
  checkLabelCopy({ specsRoot, config, model, col })
  checkCoverageMatrix({ specsRoot, config, idRefResult, col })

  const errors = col.findings.filter((f) => f.severity === 'error').length
  // 刻意不带时间戳：report 要能进 golden 语料，逐字节可复现。
  // 与 SCHEMA.md §5「V1 manifest 不放时间戳」同一条理由。
  const report = {
    specsRoot: toPosix(specsRoot),
    configPath: toPosix(config.configPath),
    isFallbackConfig: config.isFallback,
    summary: {
      error: errors,
      warn: col.findings.filter((f) => f.severity === 'warn').length,
      info: col.findings.filter((f) => f.severity === 'info').length,
    },
    stats: col.stats,
    findings: col.findings,
  }
  return { report, config, model, col, errors, zoneResult, idRefResult }
}
