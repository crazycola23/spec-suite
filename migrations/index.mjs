// 迁移注册表。**当前真的为空** —— 仓库里所有 artifact 都还是 v1。
//
// 为什么不预先造一条 1→2：凭空发明一个尚不存在的 schema 格式，本身就是
// invent unknown fact，违反仓库第一条 invariant（unknown stays unknown）。
// 空注册表不是待办事项，而是对当前事实的准确表示。
//
// 关键性质：**未注册即不支持**。planMigration() 对没登记过的
// (kind, from→to) 一律返回 supported:false，绝不返回一个「什么都不做」
// 的恒等迁移 —— 那会让调用方以为迁移成功了。
//
// 新增一条迁移时要同时做四件事，缺一不可：
//   1. 在 migrations/ 下加实现文件，导出 { kind, from, to, migrate(doc) }
//   2. 在下面的 MIGRATIONS 里注册它
//   3. 把 SCHEMA_POLICY[kind].current 提升，并把旧版本留在 supported 里
//   4. 在 fixtures/ 下冻结一份旧版本语料，并加幂等性测试
//      （migrate(migrate(x)) 必须等于 migrate(x)）

import { SCHEMA_POLICY } from '../src/shared/schema-version.mjs'

/**
 * 已注册的迁移。键是 `${kind}:${from}->${to}`。
 * 空对象是有意的，见文件头。
 */
export const MIGRATIONS = {}

export const migrationKey = (kind, from, to) => `${kind}:${from}->${to}`

/**
 * 查一条迁移。fail-closed：查不到就是不支持，不猜、不降级、不空转。
 *
 * @returns {{supported: boolean, key: string, migrate?: Function, reason?: string}}
 */
export function planMigration(kind, from, to) {
  const key = migrationKey(kind, from, to)
  const policy = SCHEMA_POLICY[kind]
  if (!policy) {
    return { supported: false, key, reason: `未注册的 schema kind：${kind}` }
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    return { supported: false, key, reason: `版本号必须是 ≥1 的整数，收到 ${JSON.stringify(from)}→${JSON.stringify(to)}` }
  }
  if (from === to) {
    return { supported: false, key, reason: `${from}→${to} 不是迁移。同版本不需要迁移，调用方不应该走到这里` }
  }
  if (to < from && policy.migrationDirection === 'forward-only') {
    return { supported: false, key, reason: `${kind} 的迁移方向是 forward-only，不支持从 ${from} 降级到 ${to}` }
  }
  const entry = MIGRATIONS[key]
  if (!entry) {
    return {
      supported: false, key,
      reason: `没有注册 ${kind} 的 ${from}→${to} 迁移。`
        + `已注册的迁移：${Object.keys(MIGRATIONS).length === 0 ? '（无）' : Object.keys(MIGRATIONS).join(', ')}。`
        + `无法证明迁移正确 ⇒ 阻止该动作，而不是原样通过。`,
    }
  }
  return { supported: true, key, migrate: entry.migrate }
}
