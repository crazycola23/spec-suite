<!-- 模板：decisions/gaps.md
     §1 的表格是 contracts/dictionary.yaml 的 gaps: 节点投影，由 npm run fix:generated-regions 写入。
     生成区内不许手改 —— 要改改 yaml。散文区（§2 之后）自由手写。 -->

# 规则缺口台账

> 本文件是给人的缺口视图；canonical 记录在 `contracts/dictionary.yaml` 的 `gaps:`。别处只引用本文件，不复述未关闭清单。
> 缺口不必阻塞无关的可逆工作。依赖未知值的动作保持阻塞；只有已获授权、无不可撤销后果的 `protectiveDefault` 才能替代该动作。

---

## 1. 缺口清单

<!-- BEGIN GENERATED: gaps -->
| ID | 缺什么 | 卡住的交付物 | 保护性默认行为 | 回滚代价 | 责任 | 状态 |
|---|---|---|---|---|---|---|
<!-- END GENERATED: gaps -->

---

## 2. 按危险程度排序

<手写。只列 open 的，按"错误临时策略的后果"排，不按登记顺序排。
 这一节的作用是让读者知道先解决哪个 —— 数量多的时候按 ID 顺序读没有意义。>

**🔴 错误临时策略会造成不可逆后果**

- `<G-xx>`：<后果一句话。例：预留泄漏 → 误熔断 → 业务停摆>

**🟠 错误临时策略会造成数据污染，可清洗但有成本**

- `<G-xx>`：<后果一句话>

**🟢 错误临时策略只影响展示**

- `<G-xx>`：<后果一句话>

---

## 3. 关闭一条缺口的完整动作（10 步）

**少任何一步都会留下孤儿。** 第 6、7 步最常被漏 —— 漏掉的后果是规则有了、代码写了，但没有任何验收条件覆盖它，追溯记录里整行不存在。看起来关闭了，实际无人验证。

```
1   产品/业务给出结论
2   回填真相源文件，拿到正式规则 ID（新增或修订）
3   改 contracts/*.yaml —— 包括把本条 status 改 closed、填 closedBy / closedAt
4   重新生成（.md 生成区 + generated/），不手改
5   改 DDL：若涉及表结构，新增迁移文件，不改已发布的基线
6   补验收条件（AC）                  ← 最常漏
7   补追溯记录对应行                  ← 最常漏
8   删除代码里的 // GAP: G-xx
9   删除各 .md 里对应的 ⛔ 标记
10  若同时关闭了某个决策，记入决策关闭日志
```

**缺口未关闭时不要删 ⛔ 标记。** 标记是给下一个开发者的警告，不是待办勾选框。

关闭后 checker 会把"定义了却无人引用"的规则 ID 报成孤儿 —— 那通常就是漏了第 6 或第 7 步。

---

## 4. 登记格式

新缺口写进 `contracts/dictionary.yaml` 的 `gaps:`，不要在本文手写：

```yaml
- code: G-<两位数字>
  missing: <缺什么，一句话。写"缺什么"，不写"要做什么">
  blocks: [<被卡住的交付物 ID 或相对路径>]
  protectiveDefault: <已获授权的 fail-closed 行为；没有其他授权时写 block_dependent_action>
  rollbackCost: <该临时策略改变时要动什么>
  owner: <产品 | 业务 | 商务>
  status: open
  closedBy: null
  closedAt: null
```

两个字段值得单独说：

- **`protectiveDefault` 不允许伪装成未知事实的答案。** 无已授权行为时写 `block_dependent_action`；这仍允许无关的可逆工作继续。资格条件见 `DISCIPLINES.md §4`。
- **`rollbackCost` 的作用不是装饰，是校验。** 写不出来说明临时策略不可安全回滚，应继续阻塞依赖动作。
