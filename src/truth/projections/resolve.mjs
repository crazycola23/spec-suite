// 投影 ID 解析与枚举。

/** 把 config.projections 的带 * 键匹配到具体投影 ID。 */
export function resolveProjection(projections, id) {
  const parts = id.split('.')
  for (const [pattern, renderer] of Object.entries(projections)) {
    const pp = pattern.split('.')
    if (pp.length !== parts.length) continue
    if (pp.every((p, i) => p === '*' || p === parts[i])) return { renderer, parts, pattern }
  }
  return null
}

/** 列出模型里应当存在生成区的全部投影 ID。 */
export function enumerateProjections(model, projections) {
  const out = []
  for (const pattern of Object.keys(projections)) {
    const pp = pattern.split('.')
    if (!pp.includes('*')) {
      if (pattern === 'agent-entry.common' && model.agentEntry) {
        out.push(pattern)
        continue
      }
      if ((model.collections[pp[0]] ?? []).length > 0) out.push(pattern)
      continue
    }
    const [head, , tail] = pp
    for (const e of model.collections[head] ?? []) {
      const code = e.value?.code
      if (!code) continue
      const child = e.value?.[tail === 'transitions' ? 'states' : tail]
      if (tail === 'transitions' ? Array.isArray(child) : Array.isArray(e.value?.[tail])) {
        out.push(`${head}.${code}.${tail}`)
      }
    }
  }
  return out
}
