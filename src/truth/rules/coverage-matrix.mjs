// 检查 7：覆盖矩阵完整性。

import path from 'node:path'
import { readText } from '../../shared/text.mjs'
import { matchesAny } from '../../shared/glob.mjs'
import { walkFiles } from '../../shared/walk.mjs'
import { extractIdTokens } from '../refs/tokens.mjs'

/**
 * 检查 7：某一类 ID 必须全部出现在指定的覆盖文件里。
 *
 * 补的是检查 3 结构上抓不到的一类漂移：一个 BR 被定义、也被别处引用
 * （所以既不悬空也不孤儿），却漏在追溯矩阵里 —— 关闭缺口时漏了"补追溯
 * 记录行"那一步。检查 3 看引用图的连通性，看不到"有没有进那张指定的表"。
 * skill 自己的 10 步关闭程序里就有这一步，却一直没有断言强制它。
 *
 * 由 config.coverageRequirements 驱动，每条形如：
 *   { namespace: "BR", mustAppearIn: "50-delivery/11-*.csv", severity: "warn" }
 * 没有任何要求时本检查 no-op（报一条 info）。L2 起、有了追溯矩阵才配。
 *
 * 默认 severity 是 warn 不是 error：矩阵里合法地可以暂时缺一条（某 BR 刚
 * 回填、AC 还没补）。做成硬 error 会重蹈检查 6 的覆辙 —— 被逼到关掉。
 * 要当闸门，在 requirement 里显式写 severity: "error"。
 *
 * 依赖检查 3 的 defs：只对"已定义"的 ID 要求覆盖。标了 mayLackDefinition
 * 的命名空间（合法未决、还没有定义文件）整体跳过 —— 还没到该被覆盖的阶段。
 */
export function checkCoverageMatrix({ specsRoot, config, idRefResult, col }) {
  const reqs = config.coverageRequirements ?? []
  if (reqs.length === 0) {
    col.add(7, 'info', 'config 里没有 coverageRequirements —— 覆盖矩阵完整性检查跳过（L2 起、有追溯矩阵时才配）')
    return { requirements: [] }
  }
  const defs = idRefResult?.defs ?? new Map()
  const nsByPrefix = new Map(config.idNamespaces.map((n) => [n.prefix, n]))
  const all = walkFiles(specsRoot)
  const results = []
  for (const req of reqs) {
    const ns = nsByPrefix.get(req.namespace)
    const severity = req.severity === 'error' ? 'error' : 'warn'
    if (!ns) {
      col.add(7, 'error', `coverageRequirements 里的命名空间 \`${req.namespace}\` 未在 idNamespaces 声明`)
      continue
    }
    if (ns.mayLackDefinition) {
      col.add(7, 'info', `\`${req.namespace}\` 标了 mayLackDefinition，跳过覆盖要求 —— 还没到该被覆盖的阶段`)
      continue
    }
    const files = all.filter((r) => matchesAny(r, [req.mustAppearIn]) && !matchesAny(r, config.excludeFromScan))
    if (files.length === 0) {
      col.add(7, severity,
        `覆盖要求 \`${req.namespace}\` → \`${req.mustAppearIn}\`：没有文件匹配这个 glob。矩阵不存在 = 该类 ID 一条都没被覆盖`)
      continue
    }
    const present = new Set()
    for (const rel of files) {
      for (const line of readText(path.join(specsRoot, rel)).split(/\r?\n/)) {
        for (const tok of extractIdTokens(line)) if (ns.re.test(tok)) present.add(tok)
      }
    }
    const defined = [...defs.entries()].filter(([, d]) => d.ns === ns).map(([tok]) => tok)
    const missing = defined.filter((tok) => !present.has(tok))
    results.push({ namespace: req.namespace, file: req.mustAppearIn, defined: defined.length, missing })
    col.stat(7, `${req.namespace} → ${req.mustAppearIn}`, `覆盖 ${defined.length - missing.length}/${defined.length}`)
    if (missing.length) {
      col.add(7, severity,
        `${missing.length} 个 \`${req.namespace}\` 已定义却没进 \`${req.mustAppearIn}\`（被定义、也可能被别处引用，` +
        `所以检查 3 抓不到 —— 但没进覆盖矩阵，就是漏了关闭程序的补矩阵那一步）：\n` +
        missing.map((t) => `    ${t}`).join('\n'))
    }
  }
  return { requirements: results }
}

