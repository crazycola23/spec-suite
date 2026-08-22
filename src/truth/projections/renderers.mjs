// 渲染器注册表：yaml → 生成区表格。新增投影类型只改这里。

const cell = (v) => {
  if (v === undefined || v === null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join('、').replace(/\|/g, '\\|') : '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
]

const findByCode = (entries, code) => entries?.find((e) => e.value?.code === code)?.value

export const RENDERERS = {
  agentEntryCommon(model) {
    const markdown = model.agentEntry?.common?.markdown
    if (typeof markdown !== 'string' || markdown.trim() === '') return null
    return markdown.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  },

  // stateMachines.<code>.transitions
  transitionTable(model, parts) {
    const m = findByCode(model.collections.stateMachines, parts[1])
    if (!m) return null
    const rows = []
    for (const s of m.states ?? []) {
      const trs = Array.isArray(s?.transitions) ? s.transitions : []
      if (trs.length === 0) {
        rows.push([cell(s?.code), s?.terminal === true ? '—（终态）' : '—', '—', cell(s?.source)])
      } else {
        for (const t of trs) rows.push([cell(s?.code), cell(t?.to), cell(t?.trigger), cell(t?.source)])
      }
    }
    return table(['当前态', '可迁移到', '触发', '依据'], rows)
  },

  // enums.<code>.values
  enumTable(model, parts) {
    const e = findByCode(model.collections.enums, parts[1])
    if (!e) return null
    return table(['值', '含义', '依据'],
      (e.values ?? []).map((v) => [cell(v?.code), cell(v?.label), cell(v?.source)]))
  },

  errorTable(model) {
    const items = (model.collections.errors ?? []).map((e) => e.value)
    return table(['码', 'HTTP', '类别', '含义', '依据', '前端动作'],
      items.map((v) => [cell(v?.code), cell(v?.httpStatus), cell(v?.class), cell(v?.label), cell(v?.source), cell(v?.frontendAction)]))
  },

  permissionTable(model) {
    const items = (model.collections.permissions ?? []).map((e) => e.value)
    return table(['码', '含义', '风险', '可继承', '依据'],
      items.map((v) => [cell(v?.code), cell(v?.label), cell(v?.risk), cell(v?.inheritable), cell(v?.source)]))
  },

  redLineTable(model) {
    const items = (model.collections.frontendRedLines ?? []).map((e) => e.value)
    return table(['ID', '红线', '依据'], items.map((v) => [cell(v?.code), cell(v?.label), cell(v?.source)]))
  },

  gapTable(model) {
    const items = (model.collections.gaps ?? []).map((e) => e.value)
      .slice().sort((a, b) => String(a?.code).localeCompare(String(b?.code)))
    return table(['ID', '缺什么', '卡住的交付物', '保护性默认行为', '回滚代价', '责任', '状态'],
      items.map((v) => [cell(v?.code), cell(v?.missing), cell(v?.blocks), cell(v?.protectiveDefault),
        cell(v?.rollbackCost), cell(v?.owner), cell(v?.status)]))
  },
}
