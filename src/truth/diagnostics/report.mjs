// 报告渲染。纯函数：findings + stats → markdown。

import { toPosix } from '../../shared/text.mjs'

const CHECK_NAMES = {
  1: 'schema 符合性',
  2: '状态机闭合',
  3: 'ID 引用完整性',
  4: '两区制比对',
  5: 'N-xx 禁令覆盖',
  6: '禁止复制中文标签',
  7: '覆盖矩阵完整性',
}
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

  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
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
