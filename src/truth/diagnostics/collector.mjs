// findings 收集器。不判定、不退出，只累积。

export function makeCollector() {
  const findings = []
  const stats = {}
  return {
    findings,
    stats,
    add(check, severity, message, where) {
      findings.push({ check, severity, message, ...(where ?? {}) })
    },
    stat(check, key, value) {
      ;(stats[check] ??= {})[key] = value
    },
  }
}
