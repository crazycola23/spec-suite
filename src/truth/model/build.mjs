// 模型构建：字典 yaml → 统一集合视图。

import fs from 'node:fs'
import path from 'node:path'
import { checkSchemaVersion } from '../../shared/schema-version.mjs'
import { readText } from '../../shared/text.mjs'

/**
 * @returns {{collections: Record<string, Array<{value:any,file:string,index:number}>>,
 *            files: Record<string, {doc:any, text:string}>, missing: string[]}}
 */
export function buildModel({ specsRoot, config, YAML, col }) {
  const collections = {}
  const files = {}
  const missing = []

  for (const rel of config.dictionaries) {
    const abs = path.join(specsRoot, rel)
    if (!fs.existsSync(abs)) { missing.push(rel); continue }
    const text = readText(abs)
    let doc
    try {
      doc = YAML.parse(text)
    } catch (e) {
      col?.add(1, 'error', `YAML 解析失败：${e.message}`, { file: rel })
      continue
    }
    files[rel] = { doc, text }
    if (!doc || typeof doc !== 'object') continue
    // 字典的版本判定。不读这一行，`meta.schemaVersion: 99` 就会被当成 v1
    // 静默读下去 —— 那正是仓库禁止的「遇到未来未知 schema 就猜」。
    // 缺版本目前只是 warn（策略里 requiredNow=false，处于迁移期），
    // 声明了高于本工具的版本则是 error。
    const version = checkSchemaVersion('dictionary', doc)
    if (version.severity !== 'ok') col?.add(1, version.severity, version.message, { file: rel })
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'meta') continue
      const list = Array.isArray(value) ? value : null
      if (!list) {
        col?.add(1, 'error', `顶层节点 \`${key}\` 不是数组。所有集合都必须是对象数组（SCHEMA.md §1.1）`, { file: rel })
        continue
      }
      collections[key] ??= []
      list.forEach((v, i) => collections[key].push({ value: v, file: rel, index: i }))
    }
  }
  let agentEntry = null
  if (config.agentEntry?.source) {
    const rel = config.agentEntry.source
    const abs = path.join(specsRoot, rel)
    if (!fs.existsSync(abs)) {
      col?.add(1, 'error', `agentEntry.source 不存在：\`${rel}\``, { file: rel })
    } else {
      try {
        agentEntry = YAML.parse(readText(abs))
      } catch (e) {
        col?.add(1, 'error', `Agent Entry Contract YAML 解析失败：${e.message}`, { file: rel })
      }
    }
  }
  return { collections, files, missing, agentEntry }
}
