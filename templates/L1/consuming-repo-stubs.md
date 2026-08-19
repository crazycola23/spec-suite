# 消费仓库的两个薄文件

代码仓库（后端、前端）各放两个文件。**业务规则一律不在代码仓库定义。**

拓扑：规格库 `CLAUDE.md`（全部纪律，150~200 行）→ 消费仓库 `CLAUDE.md`（纯指针，3 行）→ 消费仓库 `AGENTS.md`（仓库本地约定，约 20 行）。

指针那层不能省：**agent 不会去读它不知道存在的文件。** 消费仓库里没有指针，agent 读不到真相源，只会凭空补全 —— 而它补出来的东西看起来和真规格一样。

---

## 1. 消费仓库 `CLAUDE.md`

```markdown
# <仓库名>

业务规则、契约与页面规格的唯一来源是规格库：`<相对路径，如 ../<项目代号>-specs>`。
开工前先读 `<相对路径>/CLAUDE.md`，本仓库的本地约定见 [AGENTS.md](./AGENTS.md)。
```

三行，不要多写。多写的每一行都会和规格库分叉。

**用相对路径。** 绝对路径在别人的机器上、CI 里、以及仓库被移动后全部失效 —— 真实项目里出现过三处过期的绝对路径同时存在，指向两个不同的旧地址。

---

## 2. 消费仓库 `AGENTS.md`

```markdown
# <仓库名> · agent 约定

## 1. 本仓库不是业务规则来源
枚举值、状态迁移、阈值、权限码、错误码一律来自 `<相对路径>/contracts/`。
本仓库出现它们的字面量定义（除 `<生成目录>` 外）即为缺陷。

## 2. 开工前必读
1. `<相对路径>/CLAUDE.md`
2. `<相对路径>/contracts/conventions.md`
3. <本仓库专属的那一份，如 contracts/openapi.yaml 的相关片段>

## 3. 有疑问停手提问
规格没写的，不要按"合理推断"实现。按 `<相对路径>/CLAUDE.md §3` 登记缺口。

## 4. 先改规格再实现
实现与规格冲突时，先改规格拿到 ID，再改代码。反过来做的结果是规格永远追不上代码。

## 5. 改代码要同步的规格
| 改了什么 | 同步哪里 |
|---|---|
| 新增枚举值 / 错误码 / 权限码 | `<相对路径>/contracts/*.yaml`，然后重新生成 |
| 改接口出入参 | `<相对路径>/contracts/<openapi>` |
| 改表结构 | `<相对路径>/contracts/<ddl>` 新增迁移文件 |

## 6. 完成时报这五项
1. 实现了哪些规则 ID
2. 涉及哪些缺口（`// GAP: G-xx`）
3. 跑了哪些检查，结果
4. 哪些验证**没有**做（缺运行时、缺依赖、缺数据）—— 必须如实列出
5. 本次编造的内容：<列出，或写"无"并说明每项出处>

## 7. 不得自行 commit / push
除用户明确指示，不执行 commit、push、创建分支、打 tag。

## 8. 提交说明用 <语言>
```

第 6 项的第 4 小点是最容易被省略的。"编译通过"不等于"跑通了" —— 缺 Redis、缺数据库、缺容器时，能做的验证和不能做的验证要分开写清楚，否则读者会以为集成也验过了。

---

## 3. 生成物与闸门挂在哪（最容易做错的一步）

**规格库的生成脚本只写进规格库自己的 `generated/`。** 不要写到 `../其他仓库/`。

每个消费仓库把需要的契约文件**签入自己的仓库**，并挂一条自己的检查：

```json
{
  "scripts": {
    "verify:contracts": "node scripts/verify-contracts.mjs"
  }
}
```

```js
// 消费仓库 scripts/verify-contracts.mjs —— 逐字节比对签入副本与规格库 generated/
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SPECS = process.env.SPECS_ROOT ?? join('..', '<项目代号>-specs')
const FILES = [
  ['<生成目录>/<ContractCodes.java>', 'generated/<java/ContractCodes.java>'],
]

let bad = 0
for (const [local, upstream] of FILES) {
  const a = readFileSync(local, 'utf8')
  const b = readFileSync(join(SPECS, upstream), 'utf8')
  if (a !== b) { console.error(`漂移：${local} 与规格库 ${upstream} 不一致，运行同步脚本`); bad++ }
}
process.exit(bad ? 1 : 0)
```

### 为什么这个位置重要

如果让规格库直接写到 `../消费仓库/`：

- 规格库的 CI 里**没有**相邻仓库 → 这个检查结构上跑不通
- 消费仓库里**没挂**任何检查 → 那边也是空的
- 而两边的 `package.json` 看起来都很正常

结果是产物在消费仓库、闸门两边都没挂上，且没有任何迹象表明这一点。真实项目里已经发生过：`check:*` 脚本存在、CI 只跑测试不跑它、消费仓库对规格库零引用。

正确做法下两边 CI 都跑得动：规格库检查 `contracts/*.yaml → generated/` 一致，消费仓库检查签入副本 → 规格库 `generated/` 一致。
