// JSON 的 canonical 形式：递归排序键、拒绝非 JSON 值。
//
// 合并前有两份近乎逐字重复的实现（D4）：
//
//   | 位置                                  | 遇到非 JSON 值时 |
//   |---------------------------------------|------------------|
//   | `control-plane-common.mjs:7`（V2）    | throw            |
//   | `generate-contract-bundle.mjs:54`（V1）| **静默放行**     |
//
// 统一到 **V2 的严格语义**。理由不是"严格更好听"，而是两者的产物都是**字节精确
// 的 artifact**：
//
//   * V1 的 `contract-bundle.json` 被 `manifest.json` 的 digest 钉住，下游
//     consumer 按字节校验；
//   * V2 的 lease 签名就是 `stableJson(payload)` 的字节。
//
// 宽松版里 `undefined` / 函数 / symbol 会原样通过 canonicalize，然后被
// `JSON.stringify` **静默丢弃**（在数组里则变成 `null`）。也就是说：一个字段
// 悄悄从权威 artifact 里消失，而 digest 照样自洽、校验照样通过、没有任何人报错。
// 那正是本仓库禁令的形状 —— 无法证明正确就该阻止动作，而不是猜测后继续。
//
// 收紧对 V1 是严格增强：合法输入的输出**逐字节不变**（已用 golden 语料验证），
// 只有以前被静默丢弃的输入现在报错。
//
// ## 实现是从 V2 逐字搬过来的
//
// 一个字都没改，包括那句看起来冗余的 `!value`（`null` 已在上一行返回，所以它
// 实际只用于捕获 `undefined`）和错误文案。逐字搬移是这次合并的**安全论证本身**：
// V2 的 lease 签名是这个函数输出的字节，签名验证在跨进程、跨时间的两端各算一次，
// 输出只要差一个字节，既有的 lease 就全部失效。重写它需要的证明远多于搬移它。
//
// ## 它**不**保证什么（刻意记在这里，而不是假装没有）
//
//   1. `NaN` / `Infinity` 的 `typeof` 是 `'number'`，会原样通过，然后被
//      `JSON.stringify` 变成 `null`。这是与 `undefined` 同类的静默丢失，但拒绝
//      它属于**第三种**语义（两份原实现都放行），不在 D4 的授权范围内。要收紧
//      应当先在 registry 里登记一条 invariant，而不是在合并里顺手改掉。
//   2. `Date` / `Map` / `Set` / 类实例的 `typeof` 是 `'object'`，会被
//      `Object.keys` 摊平 —— `new Date()` 变成 `{}`，而不是 `JSON.stringify`
//      单独用时给出的 ISO 字符串。所以本函数只承诺"**纯 JSON 形状**的输入被
//      保序保真"，不承诺它等价于 `JSON.stringify`。
//
// 两条都由 canonical-json.test.mjs 钉住，免得"不保证"随实现漂移成"碰巧保证"。

/**
 * 递归 canonical 化：数组保序、对象按键名排序、非 JSON 值抛错。
 *
 * @throws {Error} 遇到 `undefined` / 函数 / symbol / bigint
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (!value || typeof value !== 'object') throw new Error(`value is not JSON-serializable: ${typeof value}`)
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  )
}

/** canonical 化后序列化。`space` 缺省 0 —— 签名与 digest 用的是紧凑形式。 */
export function stableJson(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space)
}
