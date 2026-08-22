// glob → RegExp。纯字符串运算，无 IO。

/** glob → RegExp。支持 ** / * / ?，路径一律用 / 分隔。 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchesAny(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel))
}
