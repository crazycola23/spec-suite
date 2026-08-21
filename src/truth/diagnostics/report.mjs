// 报告渲染。纯函数：findings + stats → markdown。

import { toPosix } from '../../shared/text.mjs'
import { checkIds, checkNames } from '../../../registry/invariants.mjs'

// 小节标题与顺序都从 registry 派生，不在这里再维护一份。
// 原先这两处是本文件里的字面量（一张 CHECK_NAMES 表 + 一个写死的
// [1..7] 循环），与 SCHEMA.md §7 的表格是两份手抄 —— 加第 8 类检查时
// 极易只改一处，报告就会静默漏掉一整节。
const CHECK_NAMES = checkNames()
const CHECK_IDS = checkIds()
const SEV_ORDER = { error: 0, warn: 1, info: 2 }
const SEV_LABEL = { error: '缺陷', warn: '警告', info: '信息' }

export function renderReportMd({ specsRoot, configPath, isFallback, findings, stats }) {
  const L = []
  L.push('# 规格套件检查报告', '')
  L.push(`- 被检查库：\`${toPosix(specsRoot)}\``)
  L.push(`- config：\`${toPosix(configPath)}\`${isFallback ? ' —— **这是 skill 自带的示例 config，不是本库的**，命名空间与路径未必匹配本库' : ''}`)
  const n = (s) => findings.filter((f) => f.severity === s).length
  L.push(`- 结论：缺陷 ${n('error')} / 警告 ${n('warn')} / 信息 ${n('info')}`)
  L.push('')
  L.push('> **审计结论不等于修改授权。** 报告只列出发现，改不改由库的所有者决定。')
  L.push('')

  for (const id of CHECK_IDS) {
    L.push(`## 检查 ${id} · ${CHECK_NAMES[id]}`, '')
    const st = stats[id]
    if (st && Object.keys(st).length) {
      L.push('派生计数（只报告，不作为断言）：', '')
      for (const [k, v] of Object.entries(st)) L.push(`- ${k}：${v}`)
      L.push('')
    }
    const fs_ = findings.filter((f) => f.check === id)
      .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
    if (fs_.length === 0) { L.push('无发现。', ''); continue }
    for (const f of fs_) {
      const at = f.file ? ` \`${f.file}${f.line ? ':' + f.line : ''}\`` : ''
      L.push(`- **${SEV_LABEL[f.severity]}**${at} — ${f.message}`)
    }
    L.push('')
  }
  return L.join('\n') + '\n'
}
