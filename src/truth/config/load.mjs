// config 加载。默认值是 SCHEMA.md §6 记录过的、有意的默认值。

import fs from 'node:fs'
import path from 'node:path'
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
  return {
    configPath: used,
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
