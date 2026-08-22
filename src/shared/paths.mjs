// 路径容纳判定：`child` 是否在 `parent` 之内。
//
// 合并前这一个判定散在 8 处，逐字重复（D4 之后仓库里第四组这样的重复）：
//
//   | 位置                                   | 形态      | 用法        |
//   |----------------------------------------|-----------|-------------|
//   | `generate-contract-bundle.mjs:54`      | 具名函数  | 布尔谓词    |
//   | `generate-contract-bundle.mjs:48`      | 内联      | 在外 ⇒ 抛错 |
//   | `guard-unresolved-fact.mjs:39`         | 内联      | 在外 ⇒ 抛错 |
//   | `verify-consumer-contracts.mjs:40`     | 内联      | 在外 ⇒ 抛错 |
//   | `control-plane-common.mjs:50`          | 内联      | 在外 ⇒ 抛错 |
//   | `control-plane-trust.mjs:159`          | 内联      | 在外 ⇒ 抛错 |
//   | `control-plane-trust.mjs:27`           | 内联      | **在内 ⇒ 抛错** |
//   | `lease-issuer.mjs:70`                  | 内联      | **在内 ⇒ 抛错** |
//
// 最后两行是这次合并最值得做的理由：仓库同时依赖这个判定的**两个方向** ——
// 「不许逃出规格库」与「必须落在 agent workspace 之外」。它们过去是两份各自
// 抄写的实现，而一旦抄歪，两个方向会**不对称地**失效：一边仍然拦得住，另一边
// 悄悄放行，而两边的测试各自照旧全绿。现在它们共用同一个定义，收紧或放宽都
// 必然同时作用于两个方向。
//
// ## 「`parent` 自身算在内」这条**行为**同时服务两个相反的语义
//
// 两个方向都依赖它，且依赖的方式相反：
//
//   * 解析型调用（在外 ⇒ 抛错）：`rel` 恰好解析到 root 自身时**不能**抛错 ——
//     `generatedDir: "."` 是合法配置。
//   * assertOutside（在内 ⇒ 抛错）：root 自身**必须**被判为「不在外面」而抛错 ——
//     否则把 trust root 设成 workspace 根目录本身就能绕过隔离。
//
// 也就是说这条行为一旦被改动，会在一个方向上放宽、另一个方向上收紧 —— 而收紧的
// 那一边会吵闹地立刻暴露（合法的 `.` 开始被拒），放宽的那一边是安静的。
//
// 但要说清楚代码层面的事实：`rel === ''` 这个 **clause 本身是冗余的**，
// 它只是把意图写出来 + 短路。空串同样满足其余三项（不以 `..` 开头、不等于 `..`、
// 不是绝对路径），所以删掉它行为不变 —— 这一点由 paths.test.mjs 的变异测试实测确认，
// 不是推理。真正会破坏这条行为的是**加**东西（比如"顺手"补一句
// `if (rel === '') return false`）或换成朴素的 `child.startsWith(parent)`。
// 所以 paths.test.mjs 钉的是行为，不是这一行。
//
// ## 它不是字符串前缀判定
//
// `child.startsWith(parent)` 是这个判定最常见的错写法，它把**兄弟目录**误判为在内：
// `/a` 与 `/ab`、`C:\root` 与 `C:\rootx`。这里走 `path.relative` 就没有这个问题
// （得到 `../ab`），代价是必须处理 `..` 的三种形态 —— 逐条见 paths.test.mjs 的
// clause 表（含每一项单独挡住的输入，以及删掉它的实测后果）。
//
// ## 它是**纯词法**判定 —— 不解析 symlink
//
// 只比较字符串，不碰文件系统。`parent` 内的一个符号链接指向外面，本函数照样
// 判为「在内」。V2 因此在 `control-plane-trust.mjs` 里**另外**用
// `assertNotSymlink` 挡这件事；V1 全仓库没有任何 realpath 调用，也就是说 V1 的
// 容纳判定对符号链接是敞开的。这不是本次合并引入的缺口（合并前 8 份都是纯词法），
// 但把它写在这里，免得下一个人以为 import 了这个函数就拿到了防越界的完整保证。
// 它属于 registry 的 not-proven 一类，而不是这里该顺手"修好"的东西。
//
// 同理不承诺：Windows 上的大小写不敏感、`8.3` 短名、UNC 前缀差异、尾随分隔符
// 之外的任何归一化。调用方若拿到的是用户输入，应当先自己 resolve。
//
// ## 刻意**没有**并进来的三处
//
// 它们只是长得像，输入域不同 —— 合并它们要靠 if/else 分叉出特例，正是本次重构
// 明令禁止的形状：
//
//   * `enforce-effect.mjs:90`  —— 作用于 `path.posix.normalize` 的输出，且额外
//     拒绝 `'.'`（这里的 `'.'` 是合法的「就是 root」）。
//   * `enforce-effect.mjs:134` —— 作用于 decodeURI 之后的字符串，要求前导 `/`、
//     拒绝 `\`、拒绝**任何**一段等于 `.` 或 `..`。
//   * `verify-consumer-contracts.mjs:75` —— 作用于已经 posix 化的相对路径，
//     用 `'../'` 而不是 `..${path.sep}`，与 OS 分隔符无关。

import path from 'node:path'

/**
 * `child` 是否位于 `parent` 之内（含 `parent` 自身）。
 *
 * 纯词法判定，不访问文件系统、不解析 symlink（见文件头）。两个实参都应当已经是
 * 绝对路径或同一基准下的相对路径 —— 本函数不替调用方 resolve。
 */
export function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}
