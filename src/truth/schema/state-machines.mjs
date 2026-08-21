// 检查 2：状态机闭合。纯模型运算。

export function checkStateMachines({ model, col }) {
  const machines = model.collections.stateMachines ?? []
  let transitions = 0
  for (const { value: m, file } of machines) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.states)) continue
    const codes = new Set(m.states.map((s) => s?.code).filter(Boolean))
    const inbound = new Set()
    for (const s of m.states) {
      if (!s || typeof s !== 'object') continue
      const trs = Array.isArray(s.transitions) ? s.transitions : []
      transitions += trs.length
      for (const t of trs) {
        const to = t?.to
        if (to === undefined) continue
        inbound.add(to)
        if (!codes.has(to)) {
          col.add(2, 'error',
            `\`${m.code}.${s.code}\` 有迁移指向不存在的状态 \`${to}\`。现有状态：${[...codes].join(', ')}`,
            { file })
        }
      }
      if (s.terminal === true && trs.length > 0) {
        col.add(2, 'error', `\`${m.code}.${s.code}\` 标了 \`terminal: true\` 却有 ${trs.length} 条出边`, { file })
      }
      if (s.terminal === false && trs.length === 0) {
        col.add(2, 'error',
          `\`${m.code}.${s.code}\` 是 \`terminal: false\` 却没有出边 —— 要么它是终态，要么迁移漏写了。` +
          `保护性默认是标 \`terminal: true\` + \`transitions: []\`（少一条迁移可以后加，多一条已发生的迁移无法撤销）`,
          { file })
      }
    }
    const first = m.states[0]?.code
    for (const s of m.states) {
      if (!s?.code || s.code === first) continue
      if (!inbound.has(s.code)) {
        col.add(2, 'warn', `\`${m.code}.${s.code}\` 没有任何入边，且不是首状态 —— 不可达`, { file })
      }
    }
  }
  col.stat(2, '状态机', machines.length)
  col.stat(2, '迁移', transitions)
  return { machines: machines.length, transitions }
}
