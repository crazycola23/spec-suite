// argv 解析：仓库里 12 份手写解析器的并集。
//
// 计划里写的是"6 份"。实际盘点是 **12 份，分 3 种方言**：
//
//   | 方言                | 解析器                                                      |
//   |---------------------|-------------------------------------------------------------|
//   | 中文 `未知参数：`    | truth/cli/check、generate-contract-bundle、verify-consumer-  |
//   |                     | contracts、guard-unresolved-fact、migrate-unresolved、       |
//   |                     | trust-report、render-docs                          （7 份）  |
//   | 英文 `unknown argument: ` | enforce-effect、lease-issuer、project-context   （3 份）  |
//   | daemon 定长 `usage:` | effect-enforcer-daemon、lease-issuer-daemon        （2 份）  |
//
// **两种方言都保留**。V1 对人说中文、V2 对人说英文，这是仓库的既有事实；
// 统一成一种会改掉 3 个 CLI 的可观测输出，而且换不到任何东西。所以这里单一
// 来源化的是**逻辑**，不是**文案** —— 文案按方言各存一份（`MESSAGES_ZH` /
// `MESSAGES_EN`），从 10 份降到 2 份。
//
// 没有默认方言：`messages` 缺失直接抛 TypeError。给一个默认值等于让新 CLI
// 静默继承我随手选的那种语言 —— 那是隐藏 fallback 的形状。
//
// ## 顺手补上的两个真实 fail-closed 缺口
//
// 12 份里有 **11 份检测不到"取值型参数缺值"**（唯一的例外是 trust-report 的
// `--format`）。后果按参数不同，从"静默少干活"到"污染 canonical"：
//
//   * `check --report`（argv 末尾）⇒ `o.report = undefined` ⇒ `if (opts.report)`
//     为假 ⇒ **报告不写，退出码 0**。用户以为拿到了报告。
//   * `migrate-unresolved --block`（末尾）⇒ `blocks.push(undefined)` ⇒
//     `gap.blocks` 里带一个 `undefined` ⇒ 序列化进 `dictionary.yaml` 变成
//     `null`。**把猜测写进权威文件**。
//   * `--specs-root`（末尾）⇒ `path.resolve(undefined ?? '.')` ⇒ 静默用 cwd。
//
// 三者都是仓库自己禁止的形状（`unknown 自动变成 default` / 隐藏 fallback），
// 所以这里**无条件**检测缺值，不做成开关 —— 开关的关闭位就是上面那三个缺陷。
// 这是严格增强：以前静默做错的输入现在报错，以前正确的调用一个都没变。
//
// ## 两个刻意**没做**的收紧
//
//   1. **不**拒绝长得像参数的值。今天 `--fact --block` 会把 `'--block'` 当作
//      fact 名收下。加"值不能以 `-` 开头"会误伤合法的负数与破折号开头的值，
//      属于改语义而不是补缺口。只检测"值**不存在**"—— 那个无歧义。
//   2. **不**支持 `--flag=value`。今天 `--config=x` 是未知参数 ⇒ 报错。加上
//      这个语法是新功能，且会让"报错"变成"接受"。
//
// ## 不收进来的两份
//
// 两个 daemon 不是 flag 解析器：它们要求 argv **恰好**是 `--config <绝对路径>`，
// 没有 `--help`，也没有循环。硬塞进 flag spec 是重写，而且会凭空给 daemon 加
// 出一个 `--help`。它们之间真正重复的那 4 行由 `parseExactConfigFlag` 承载，
// 各自的 usage 文案作为参数传入（两份只差脚本名）。

import path from 'node:path'

/** V1 Truth Integrity 的文案。`未知参数：` 逐字沿用合并前的 7 份。 */
export const MESSAGES_ZH = {
  unknown: (arg) => `未知参数：${arg}`,
  // 合并前无人检测缺值，所以这句是新的。措辞对齐 migrate-unresolved 既有的
  // `requireValue` 抛的 `缺少 ${name}`。
  missing: (flag) => `缺少 ${flag} 的值`,
}

/** V2 Control Plane 的文案。`unknown argument: ` 逐字沿用合并前的 3 份。 */
export const MESSAGES_EN = {
  unknown: (arg) => `unknown argument: ${arg}`,
  missing: (flag) => `missing value for ${flag}`,
}

/**
 * 按 spec 解析 argv。纯函数：不读文件、不写流、不抛输入类错误。
 *
 * spec 是 `参数字面量 → 条目` 的查表，四种条目：
 *
 *   `{ key }`              取下一个 argv 作为值；缺值 ⇒ error
 *   `{ key, flag: true }`  置 `true`，不吃参数
 *   `{ key, set: X }`      置常量 `X`，不吃参数（同一 key 多次出现＝后者胜，
 *                          用于 render-docs 的 `--check` / `--write` 模式对）
 *   `{ key, list: true }`  取下一个 argv 追加进数组；缺值 ⇒ error
 *
 * 可选 `validate(value)`：返回错误串或 `null`。**带 validate 的条目由它自己
 * 负责缺值情形**（value 会是 `undefined`），因为 trust-report 的 `--format`
 * 把"缺失"和"取值非法"合并成了一句被测试钉住的文案。argv.test.mjs 有一条
 * 测试要求所有已注册的 validate 都拒绝 `undefined` —— 否则这个入口就成了绕过
 * 缺值检测的后门。
 *
 * `list` 型的 key 一律预置成 `[]`，所以返回的 options 形状与 argv 内容无关。
 *
 * @returns {{options: object} | {error: string}} 二者必有其一
 */
export function parseFlags(argv, spec, messages) {
  if (typeof messages?.unknown !== 'function' || typeof messages?.missing !== 'function') {
    // 调用方的 bug，不是用户输入问题 —— 这条该在开发期炸掉，不该变成 error 串。
    throw new TypeError('parseFlags 需要显式的 messages.unknown / messages.missing —— 没有默认方言')
  }

  const options = {}
  for (const entry of Object.values(spec)) {
    if (entry.list) options[entry.key] = []
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // hasOwnProperty 而不是 `spec[arg]`：否则 `constructor`、`toString`、
    // `__proto__` 会顺着原型链命中 Object 的成员，被当成已注册参数。
    const entry = Object.prototype.hasOwnProperty.call(spec, arg) ? spec[arg] : undefined
    if (entry === undefined) return { error: messages.unknown(arg) }

    if (entry.flag) { options[entry.key] = true; continue }
    if ('set' in entry) { options[entry.key] = entry.set; continue }

    const present = i + 1 < argv.length
    const value = present ? argv[i + 1] : undefined
    if (entry.validate) {
      const problem = entry.validate(value)
      if (problem) return { error: problem }
    } else if (!present) {
      return { error: messages.missing(arg) }
    }

    if (entry.list) options[entry.key].push(value)
    else options[entry.key] = value
    i += 1
  }

  return { options }
}

/**
 * `parseFlags` 的抛错版。合并前 9 份解析器都是"未知参数就 throw"，各自的 main
 * 在 try 里调用并打印带前缀的一行 —— 这个包装让那 9 处的控制流一字不改。
 */
export function parseFlagsOrThrow(argv, spec, messages) {
  const { options, error } = parseFlags(argv, spec, messages)
  if (error) throw new Error(error)
  return options
}

/**
 * 两个 daemon 的定长 argv 校验：必须**恰好**是 `--config <绝对路径>`。
 *
 * 不是 flag 解析：daemon 只在 supervisor 的控制下启动，参数形状是契约的一部分，
 * 多一个少一个都该拒绝，而不是"尽力理解"。
 *
 * @param {string} usage 该 daemon 的 usage 文案（两份只差脚本名，所以传入）
 */
export function parseExactConfigFlag(argv, usage) {
  if (argv.length !== 2 || argv[0] !== '--config') throw new Error(usage)
  if (!path.isAbsolute(argv[1])) throw new Error('--config must be an absolute isolated path')
  return argv[1]
}
