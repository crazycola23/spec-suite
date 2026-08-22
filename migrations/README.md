# migrations/

Schema 版本迁移。**当前为空**，因为仓库里所有 artifact 都还是 `schemaVersion: 1`。

空目录是有意的，不是待办：预先造一条 `1 → 2` 迁移意味着先发明一个尚不存在的
schema 格式，那正是本仓库第一条 invariant 禁止的事（unknown stays unknown）。

## 版本策略在哪

判定逻辑只有一处：[`src/shared/schema-version.mjs`](../src/shared/schema-version.mjs)
的 `SCHEMA_POLICY` 表。每个 artifact kind 一行，声明：

| 字段 | 含义 |
|---|---|
| `current` | 当前工具**写出**的版本 |
| `supported` | 当前工具能**读**的版本（含 `current`） |
| `deprecated` | 仍可读但已宣告废弃，读到时 warn |
| `requiredNow` | 缺字段是否立即算 error（`false` = 迁移期，先 warn） |
| `migrationDirection` | `forward-only`：只支持 v(n) → v(n+1)，不支持降级 |
| `versionPath` | 字段位置（dictionary 在 `meta.schemaVersion`，其余在顶层） |

## 判定规则

| 读到的版本 | 结果 |
|---|---|
| 等于 `current` | 通过 |
| 低于 `current` 且在 `supported` 内 | 可读；指向对应迁移 |
| 在 `deprecated` 内 | warn，仍可读 |
| 低于 `current` 且不在 `supported` 内 | **error** —— 太旧，本工具不再支持 |
| 高于 `current` | **error** —— 未来未知 schema，**不支持也不猜测** |
| 不是 ≥1 的整数 | **error** |
| 缺失且 `requiredNow` | **error** |
| 缺失且未到期 | warn，并在 trust-report 里记为 `not-proven` |

任何路径都不允许 `?? default`。**缺版本不等于版本 1。**

## 新增一条迁移要做的四件事

缺一不可，否则 CI 会红：

1. 在本目录加实现文件，导出 `{ kind, from, to, migrate(doc) }`。`migrate` 必须是
   纯函数：输入旧文档，返回新文档，不碰文件系统。
2. 在 [`index.mjs`](./index.mjs) 的 `MIGRATIONS` 里注册，键为 `${kind}:${from}->${to}`。
3. 把 `SCHEMA_POLICY[kind].current` 提升到新版本，并把旧版本**留在** `supported`
   里（否则旧 artifact 立刻变成不可读）。
4. 在 `fixtures/` 下冻结一份旧版本语料，并加两条测试：
   - 旧 fixture 经新工具读取仍然通过（向后兼容）
   - **幂等性**：`migrate(migrate(x))` 等于 `migrate(x)`

## fail-closed 保证

`planMigration(kind, from, to)` 对没注册过的组合返回 `supported: false`，
**不会**返回一个「什么都不做」的恒等迁移 —— 那会让调用方误以为迁移成功。
降级请求（`to < from`）在 `forward-only` 下同样被拒绝。

这条性质由 [`tests/unit/schema-version.test.mjs`](../tests/unit/schema-version.test.mjs)
锁住：注册表为空时，任何 `(kind, from→to)` 都必须不被支持。
