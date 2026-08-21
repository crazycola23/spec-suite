// 检查 1a：记录级 schema 符合性。

import { checkSchemaVersion } from '../../shared/schema-version.mjs'
import { PLACEHOLDER_RE } from '../../shared/text.mjs'

/** 每种记录类型的必填键。children 指定嵌套集合的类型名。 */
export const RECORD_RULES = {
  enums: { required: ['code', 'label', 'source'], children: { values: 'enums.values' } },
  'enums.values': { required: ['code', 'label', 'source'] },
  stateMachines: { required: ['code', 'label', 'source'], children: { states: 'stateMachines.states' } },
  'stateMachines.states': {
    required: ['code', 'label', 'source', 'terminal', 'transitions'],
    children: { transitions: 'stateMachines.states.transitions' },
  },
  'stateMachines.states.transitions': { keyField: 'to', required: ['to', 'trigger', 'source'] },
  gaps: {
    required: ['code', 'missing', 'blocks', 'protectiveDefault', 'rollbackCost', 'owner', 'status'],
  },
  errors: { required: ['code', 'httpStatus', 'class', 'label', 'source'] },
  permissions: { required: ['code', 'label', 'source', 'risk', 'inheritable'] },
  frontendRedLines: { required: ['code', 'label', 'source'] },
  idempotencyKeys: { required: ['code', 'table', 'columns', 'source'] },
}

export function checkSchema({ model, col }) {
  let records = 0
  let missingSource = 0
  let placeholders = 0

  const visit = (typeName, items, file, trail) => {
    const rule = RECORD_RULES[typeName]
    items.forEach((item, i) => {
      const at = `${trail}[${i}]`
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        col.add(1, 'error',
          `\`${at}\` 是${Array.isArray(item) ? '数组' : typeof item}，不是对象。不允许裸字符串集合（SCHEMA.md §1.1）`,
          { file })
        return
      }
      records++
      const keyField = rule?.keyField ?? 'code'
      if (item[keyField] === undefined || item[keyField] === null || item[keyField] === '') {
        col.add(1, 'error', `\`${at}\` 缺 \`${keyField}\`。每条记录必带标识键（SCHEMA.md §1.1）`, { file })
      }
      for (const k of rule?.required ?? []) {
        if (!(k in item)) {
          col.add(1, 'error', `\`${at}\`（${item[keyField] ?? '?'}）缺必填键 \`${k}\``, { file })
          if (k === 'source') missingSource++
        }
      }
      // source 存在但为空，等同于没写
      if ('source' in item && (item.source === null || item.source === '')) {
        col.add(1, 'error', `\`${at}\`（${item[keyField] ?? '?'}）的 \`source\` 为空。空 source 等于没有出处，N-01 嫌疑`, { file })
        missingSource++
      }
      // 残留占位符
      for (const [k, v] of Object.entries(item)) {
        if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
          placeholders++
          col.add(1, 'error',
            `\`${at}.${k}\` 仍是未替换的占位符：${v.trim()}。半填的模板比没有模板更危险`, { file })
        }
      }
      for (const [childKey, childType] of Object.entries(rule?.children ?? {})) {
        const child = item[childKey]
        if (child === undefined) continue
        if (!Array.isArray(child)) {
          col.add(1, 'error', `\`${at}.${childKey}\` 不是数组`, { file })
          continue
        }
        visit(childType, child, file, `${at}.${childKey}`)
      }
    })
  }

  for (const [key, entries] of Object.entries(model.collections)) {
    if (!RECORD_RULES[key]) {
      col.add(1, 'info', `集合 \`${key}\` 没有登记记录类型，只做通用校验（对象数组 + code）`, { file: entries[0]?.file })
    }
    // 按文件分组保留出处
    const byFile = new Map()
    for (const e of entries) {
      if (!byFile.has(e.file)) byFile.set(e.file, [])
      byFile.get(e.file).push(e.value)
    }
    for (const [file, items] of byFile) visit(key, items, file, key)
  }

  col.stat(1, '记录总数', records)
  col.stat(1, 'source 缺失或为空', missingSource)
  col.stat(1, '残留占位符', placeholders)
  if (model.agentEntry !== null) {
    // 版本判定走统一策略表（src/shared/schema-version.mjs），不再本地写 `!== 1`。
    // 文案由 SCHEMA_POLICY 的 legacyMessage 逐字保留，severity 由策略给出 ——
    // 将来把某个版本标成 deprecated，这里会自动变 warn 而不必改代码。
    const version = checkSchemaVersion('agent-entry', model.agentEntry)
    if (version.severity !== 'ok') col.add(1, version.severity, version.message)
    if (typeof model.agentEntry?.common?.markdown !== 'string' || model.agentEntry.common.markdown.trim() === '') {
      col.add(1, 'error', 'Agent Entry Contract 缺少非空的 `common.markdown`')
    }
  }
  return { records, missingSource, placeholders }
}
