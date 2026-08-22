// yaml 库解析。被检查库自带的 yaml 优先。

import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function loadYamlLib(specsRoot) {
  try {
    const m = await import('yaml')
    return m.default ?? m
  } catch { /* 本 skill 目录没装，去被检查的库里找 */ }
  for (const base of [specsRoot, process.cwd()]) {
    try {
      const req = createRequire(pathToFileURL(path.join(base, 'package.json')).href)
      return req('yaml')
    } catch { /* 继续 */ }
  }
  throw new Error('找不到 yaml 依赖。在规格库里执行 `npm i yaml@^2`，或指定一个已装 yaml 的 --specs-root。')
}
