// ID token 词法。全锚定 + 词边界。ID_TOKEN_RE 的 g 标志是 matchAll 的硬要求。

import { escapeRe } from '../../shared/text.mjs'

/** 全锚定匹配 + 词边界，一次解掉子串碰撞、命名空间碰撞、同前缀多命名空间三个陷阱。 */
export const ID_TOKEN_RE = /(?<![A-Za-z0-9-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![A-Za-z0-9-])/g

export function extractIdTokens(line) {
  return [...line.matchAll(ID_TOKEN_RE)].map((m) => m[0])
}

/** 在 definedIn 文件里，什么位置算"定义"而不是"引用"。 */
export function isDefinitionSite(line, token) {
  const t = escapeRe(token)
  return new RegExp(`^\\s{0,3}#{1,6}\\s+.*${t}`).test(line)                       // 标题
    || new RegExp(`^\\s*\\|\\s*[\`*]{0,3}${t}`).test(line)                        // 表格首列
    || new RegExp(`^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?[\`*]{0,3}${t}\\b`).test(line) // 行首 / 列表项开头
}
