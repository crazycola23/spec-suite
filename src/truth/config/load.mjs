// config 加载。默认值是 SCHEMA.md §6 记录过的、有意的默认值。

import fs from 'node:fs'
import path from 'node:path'
import { assertSchemaVersion } from '../../shared/schema-version.mjs'
import { readText } from '../../shared/text.mjs'

const DEFAULT_CONFIG_NAMES = ['spec-suite.config.json', 'scripts/spec-suite.config.json']

export function loadConfig({ specsRoot, configPath, fallbackConfigPath }) {
  let used = null
  const candidates = configPath
    ? [configPath]
    : DEFAULT_CONFIG_NAMES.map((n) => path.join(specsRoot, n))
  for (const c of candidates) {
    if (fs.existsSync(c)) { used = c; break }
  }
  if (!used && fallbackConfigPath && fs.existsSync(fallbackConfigPath)) used = fallbackConfigPath
  if (!used) throw new Error('找不到 spec-suite.config.json。用 --config 指定。')
  const cfg = JSON.parse(readText(used))
  // 版本判定放在读取任何键**之前**。config 决定命名空间正则、扫描范围与
  // 投影表 —— 用错版本的语义去解读它，可能整类检查被悄悄放过，而报告照样
  // 显示「通过」。所以未来未知版本直接 throw（五个调用方都把 config 错误
  // 当致命）。缺版本按策略只是 warn，但这里没有 collector，于是把判定挂在
  // 返回值上，由 pipeline 收进 findings。
  const schemaVerdict = assertSchemaVersion('suite-config', cfg)
  return {
    configPath: used,
    schemaVerdict,
    isFallback: used === fallbackConfigPath,
    dictionaries: cfg.dictionaries ?? [],
    generatedDir: cfg.generatedDir ?? 'generated',
    claudeMd: cfg.claudeMd ?? 'CLAUDE.md',
    agentEntry: cfg.agentEntry ?? null,
    bundle: cfg.bundle ?? null,
    idNamespaces: (cfg.idNamespaces ?? []).map((n) => ({ ...n, re: new RegExp(n.pattern) })),
    projections: cfg.projections ?? {},
    structuredFileGlobs: cfg.structuredFileGlobs ?? ['**/*.yaml', '**/*.yml', '**/*.json', '**/*.csv'],
    markdownGlobs: cfg.markdownGlobs ?? ['**/*.md'],
    ddlGlobs: cfg.ddlGlobs ?? ['**/*.sql'],
    excludeFromScan: cfg.excludeFromScan ?? ['node_modules/**', 'generated/**'],
    labelCopyAllowlist: cfg.labelCopyAllowlist ?? [],
    coverageRequirements: cfg.coverageRequirements ?? [],
  }
}
