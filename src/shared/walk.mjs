// 目录遍历。唯一的读目录入口。

import fs from 'node:fs'
import path from 'node:path'

const PRUNE_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode', 'target', 'dist', 'build'])

/** 递归列出 specsRoot 下的相对路径（posix 风格）。 */
export function walkFiles(root) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? path.join(root, rel) : root
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name)) continue
        stack.push(childRel)
      } else if (e.isFile()) {
        out.push(childRel)
      }
    }
  }
  return out.sort()
}
