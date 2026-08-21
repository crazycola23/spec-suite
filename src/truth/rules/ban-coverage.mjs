// 检查 5：N-xx 禁令覆盖。

import fs from 'node:fs'
import path from 'node:path'
import { readText, PLACEHOLDER_RE } from '../../shared/text.mjs'
import { extractIdTokens } from '../refs/tokens.mjs'

const VALID_STATES = ['✅', '⚠️ 部分', '⚠️ 技术债']

export function parseBanCoverage(text) {
  const lines = text.split(/\r?\n/)
  const bans = []
  const rows = []
  let inTable = false
  let stateIdx = -1
  let whereIdx = -1

  const addBan = (code, title, line) => {
    if (!bans.some((b) => b.code === code)) bans.push({ code, title, line })
  }

  lines.forEach((line, i) => {
    const h = line.match(/^#{2,4}\s*(N-\d{2})\b(.*)$/)
    if (h) addBan(h[1], h[2].trim(), i + 1)

    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim())
      if (cells.some((c) => /禁令/.test(c)) && cells.some((c) => /强制|方式/.test(c))) {
        inTable = true
        stateIdx = cells.findIndex((c) => /状态/.test(c))
        whereIdx = cells.findIndex((c) => /在哪跑|哪跑|运行/.test(c))
        return
      }
      if (inTable) {
        if (/^\|[\s:-]+\|/.test(line)) return
        rows.push({ cells, line: i + 1 })
        return
      }
      // 禁令也可能只以表格行的形式定义（无 ### 小节）。首列恰好是一个 N-xx 即算定义。
      const first = cells[0] ?? ''
      const m = first.match(/^[`*]{0,3}(N-\d{2})[`*]{0,3}$/)
      if (m) addBan(m[1], (cells[1] ?? '').slice(0, 60), i + 1)
    } else if (inTable && line.trim() === '') {
      // 空行不结束表格（表后常有空行 + 散文），靠非 | 非空行结束
    } else if (inTable && line.trim() !== '') {
      inTable = false
    }
  })
  bans.sort((a, b) => a.code.localeCompare(b.code))
  return { bans, rows, stateIdx, whereIdx }
}

export function checkBanCoverage({ specsRoot, config, col }) {
  const rel = config.agentEntry?.adapters?.[0]?.path ?? config.claudeMd
  const abs = path.join(specsRoot, rel)
  if (!fs.existsSync(abs)) {
    col.add(5, 'error', `找不到 Agent Entry adapter \`${rel}\` —— 当前平台没有可检查的执行入口`)
    return { bans: [], covered: 0 }
  }
  const text = readText(abs)
  const { bans, rows, stateIdx, whereIdx } = parseBanCoverage(text)

  if (bans.length === 0) {
    col.add(5, 'warn', `\`${rel}\` 里没有解析到 \`N-xx\` 禁令小节（期望形如 \`### N-01 …\`）`, { file: rel })
  }
  if (rows.length === 0) {
    col.add(5, 'error',
      `\`${rel}\` 里没有禁令→断言覆盖表。没有断言时，这些禁令只能视为未验证风险`, { file: rel })
    return { bans, covered: 0 }
  }

  const rowFor = new Map()
  for (const r of rows) {
    for (const tok of extractIdTokens(r.cells[0] ?? '')) {
      if (/^N-\d{2}$/.test(tok)) rowFor.set(tok, r)
    }
  }

  let covered = 0
  for (const b of bans) {
    const r = rowFor.get(b.code)
    if (!r) {
      col.add(5, 'error',
        `禁令 \`${b.code}\` 没有断言表行。每条禁令必须三态之一：有机器断言 / 显式标"只能人工审查 + 技术债" / 不允许存在`,
        { file: rel, line: b.line })
      continue
    }
    const state = (stateIdx >= 0 ? r.cells[stateIdx] : r.cells[r.cells.length - 1]) ?? ''
    if (/待补|TODO|待定/.test(state)) {
      col.add(5, 'error', `\`${b.code}\` 的状态是「${state}」。断言表没有"待补"这一态 —— 要么有断言，要么如实标技术债`,
        { file: rel, line: r.line })
      continue
    }
    if (!VALID_STATES.includes(state)) {
      col.add(5, 'error', `\`${b.code}\` 的状态「${state}」不在 ${VALID_STATES.join(' / ')} 之内`, { file: rel, line: r.line })
      continue
    }
    if (state !== '⚠️ 技术债' && whereIdx >= 0) {
      const where = r.cells[whereIdx] ?? ''
      if (!where || where === '—' || PLACEHOLDER_RE.test(where)) {
        col.add(5, 'error', `\`${b.code}\` 声称有断言（${state}）但没写在哪跑。断言必须写明运行位置，否则等于没挂`,
          { file: rel, line: r.line })
        continue
      }
    }
    covered++
  }

  for (const [code, r] of rowFor) {
    if (!bans.some((b) => b.code === code)) {
      col.add(5, 'warn', `断言表里有 \`${code}\` 的行，但 \`${rel}\` 里没有这条禁令的小节 —— 陈旧行`, { file: rel, line: r.line })
    }
  }

  col.stat(5, '禁令', bans.length)
  col.stat(5, '已覆盖', covered)
  return { bans, covered }
}
