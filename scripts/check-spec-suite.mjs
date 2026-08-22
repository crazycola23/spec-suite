#!/usr/bin/env node
/**
 * check-spec-suite.mjs —— 规格套件一致性检查器
 *
 * 七类检查：
 *   1  schema 符合性（含 source 必填、残留 <...> 占位符、幂等键元组提取）
 *   2  状态机闭合
 *   3  ID 引用完整性（悬空 + 孤儿；mayLackDefinition 的命名空间算合法未决）
 *   4  两区制比对（生成区逐字节）
 *   5  N-xx 禁令覆盖
 *   6  禁止复制中文标签
 *   7  覆盖矩阵完整性（某类 ID 必须全部出现在指定覆盖文件里）
 *
 * 用法：
 *   node check-spec-suite.mjs [--specs-root <路径>] [--config <路径>]
 *                             [--report <输出目录>] [--write-generated-regions] [--quiet]
 *
 *   --write-generated-regions  只重写 .md 生成区；不生成 contract bundle
 *   --report  把 report.json + report.md 写到指定目录（不写入被检查的库）
 *
 * 退出码：有 error 级发现 → 1，否则 0。
 *
 * 计数一律派生后报告，不作为断言（见 SKILL.md 铁律 2）。
 *
 * ---------------------------------------------------------------------------
 * 本文件现在只做两件事：CLI 入口 + 向后兼容的 re-export facade。
 * 库代码在 src/truth/ 下按职责分模块；新增 invariant 请改对应模块，
 * 不要再往这里堆。依赖方向：shared ← truth ← control ← cli。
 * ---------------------------------------------------------------------------
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { main } from '../src/truth/cli/check.mjs'

// 兼容 facade：以下 30 个命名导出是既有公开面，被测试与兄弟脚本按名字 import。
// 顺序与拆分前一致，便于逐项核对。
export { readText, toPosix } from '../src/shared/text.mjs'
export { globToRegExp, matchesAny } from '../src/shared/glob.mjs'
export { walkFiles } from '../src/shared/walk.mjs'
export { makeCollector } from '../src/truth/diagnostics/collector.mjs'
export { loadYamlLib } from '../src/truth/config/yaml.mjs'
export { loadConfig } from '../src/truth/config/load.mjs'
export { buildModel } from '../src/truth/model/build.mjs'
export { RECORD_RULES, checkSchema } from '../src/truth/schema/records.mjs'
export { checkIdempotencyTuples } from '../src/truth/schema/idempotency.mjs'
export { checkStateMachines } from '../src/truth/schema/state-machines.mjs'
export { ID_TOKEN_RE, extractIdTokens, isDefinitionSite } from '../src/truth/refs/tokens.mjs'
export { checkIdRefs } from '../src/truth/refs/check.mjs'
export { checkCoverageMatrix } from '../src/truth/rules/coverage-matrix.mjs'
export { RENDERERS } from '../src/truth/projections/renderers.mjs'
export { resolveProjection, enumerateProjections } from '../src/truth/projections/resolve.mjs'
export { findZones, checkZones } from '../src/truth/adapters/zones.mjs'
export { parseBanCoverage, checkBanCoverage } from '../src/truth/rules/ban-coverage.mjs'
export { collectLabels, scalarValues, checkLabelCopy } from '../src/truth/rules/label-copy.mjs'
export { renderReportMd } from '../src/truth/diagnostics/report.mjs'
export { run } from '../src/truth/pipeline.mjs'

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) {
  // fallback config 位于本目录（scripts/），锚点必须在入口脚本这里推导。
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  main({ argv: process.argv.slice(2), fallbackConfigDir: here }).then((c) => process.exit(c))
}
