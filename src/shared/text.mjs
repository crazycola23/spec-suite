// 文本读取与基础正则。多个上层模块共用，因此沉到最底层。

import path from 'node:path'
import fs from 'node:fs'

/** 显式 UTF-8 + 去 BOM。Windows + 中文文件名下必须这样读。 */
export function readText(abs) {
  const t = fs.readFileSync(abs, 'utf8')
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

export function toPosix(p) {
  return p.split(path.sep).join('/')
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const CJK_RE = /[㐀-䶿一-鿿　-〿＀-￯]/

export const PLACEHOLDER_RE = /<[^<>\n]{1,60}>/
