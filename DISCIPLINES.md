# Agent Entry Contract 与 adapter

需要设计 agent 执行面、禁令、保护性行为或平台 adapter 时读本文件。共同纪律只在 canonical source 中维护；各平台入口文件是投影，不是并列真相源。

## 1. 两层结构

```text
contracts/agent-entry.yaml          canonical common contract
             |
             +-- render --> CLAUDE.md generated common region
             +-- render --> AGENTS.md generated common region      (future adapter)
             +-- render --> GEMINI.md generated common region      (future adapter)
             +-- render --> .github/copilot-instructions.md        (future adapter)
```

V1 只要求跑通一个真实 adapter；模板使用 `CLAUDE.md`。这证明的是 canonical → deterministic render → checked region，不是 Claude 的特殊地位。

每个 adapter 分两区：

- **共同区**：由 `contracts/agent-entry.yaml` 的 `common.markdown` 确定性渲染，MUST NOT 手改。
- **平台区**：手写平台加载规则、工具限制和上下文行为；MUST NOT 复制共同纪律。

平台区变更不得改变共同区；canonical 变更必须使共同区随之变化。checker 检查这两个方向。

## 2. 入口内容的预算

**Heuristic：**入口应保持短小，只放每次任务都必须看见的规则。目标不是固定行数，而是让必需信息在平台上下文预算内稳定加载。

共同区通常只保留：

- 权威来源与冲突顺序；
- “未知不得成为事实”的路径；
- canonical / derived 边界；
- 按任务打开哪些文件；
- 高风险领域禁令；
- 禁令到机器断言的覆盖表。

命名、分页、错误信封等查阅型约定放 `contracts/conventions.md`。详细 rationale 放本文件或其他参考文档，不复制到 adapter。

## 3. 通用禁令与领域禁令

`N-01`～`N-04` 可作为共同基线（下列由 `registry/invariants.mjs` 生成）：

<!-- BEGIN GENERATED: registry.bans -->
- `N-01`：无权威 source 的事实不得进入 canonical contract。
- `N-02`：generated region、bundle、manifest 与 consumer copy 不得手改或反向成为 source。
- `N-03`：下游引用稳定 ID，不复制 canonical 描述。
- `N-04`：实现选择不得隐式改变业务口径。
<!-- END GENERATED: registry.bans -->

领域禁令必须来自项目里的真实风险路径。用以下问题抽取：

1. 哪些值一旦猜错会付款、发布、发信、下单、扣费或产生其他不可撤销后果？
2. 哪些对象只允许追加？
3. 哪些动作必须有人明确确认，不能由模型输出直接触发？
4. 哪些输入通道是不可信数据而不是指令？

无法指出真实路径的领域禁令应删除，不能用泛化口号占位。

## 4. 未决事实与保护性行为

轻量模式默认动作是 `blockedAction: do_not_implement_default`：不把未知数字或枚举写入代码。

完整模式的 `G-*` 可以记录 `protectiveDefault`，但该行为也必须满足资格条件：

- 不声称未知值已经确定；
- 不产生不可撤销的外部动作；
- 对依赖该事实的行为 fail closed，或只允许人工处理；
- `rollbackCost` 明确且可验证；
- 若保护性行为本身依赖产品选择，它也保持 unresolved，不得由 agent 发明。

因此“未知重试次数”不等于“先重试一次”；安全形态通常是“不自动重试并暴露 unresolved”，直到获得 source 或负责人明确授权临时策略。

## 5. 禁令覆盖表

每条 `N-xx` 必须有一行，状态只能是：

- `✅`：有完整机器断言并写明运行位置；
- `⚠️ 部分`：只有部分路径可机器验证，表中明确边界；
- `⚠️ 技术债`：只能人工审查。

表头使用 checker 可识别的形状：

```markdown
| 禁令 | 强制方式 | 在哪跑 | 状态 |
|---|---|---|---|
| N-01 | source 必填、可解析且不得指向 gap/generated | 规格库 CI | ✅ |
```

没有断言的规则是风险，不是已验证事实；不得写“待补”掩盖。

## 6. 消费仓库入口

消费仓库需要两类内容：

- 指向规范库与签入 bundle 的共同入口投影；
- 只属于该消费仓库和平台的手写约定。

已有 Claude/AGENTS 示例见 `templates/L1/consuming-repo-stubs.md`。新增 Gemini、Copilot 等 adapter 时复用同一两区制：共同部分从 canonical source 生成，平台特有部分独立手写。
