---
name: spec-suite
description: Use when the user wants a spec/contract suite that multiple AI agents can develop against without drifting — greenfield builds, turning meeting notes or a PRD into machine-checkable contracts, or auditing an existing spec repo for drift. Also use when an agent is about to add an enum value, error code, threshold, price, retry count, or permission code and no authoritative source says what it should be. Do not use for a single design doc, an ADR, or a README.
---

# 规格套件生成

让**多个 agent 同时开发而规范不漂移**的规格套件。不是文档模板集合 —— 是四个互锁机制加上强制它们的检查脚本。

漂移的真实成因不是文档写得不够多，是 agent 遇到规格没写的地方时**编造**（LLM 默认行为），以及下游**复制**上游的自然语言描述（复制一次，漂移一次）。这套东西针对这两件事。

## 0. 先判断规模

在小项目上落 L2/L3 是有害的 —— 维护成本超过收益，文档反而先烂掉。**默认从 L0 起，只在触发条件出现时升级。**

| 层 | 加什么 | 升级触发条件 |
|---|---|---|
| **L0** | `CLAUDE.md`、`README.md`、`contracts/dictionary.yaml`、`decisions/gaps.md`、`package.json`、checker + CI workflow | 只要有 ≥2 个 agent 或 ≥2 个仓库 |
| **L1** | `conventions.md`、`errors.yaml`、`permissions.yaml`、`decisions/`（`D-*` 裁决单）、消费仓库存根、代码生成器 | 涉及钱、权限、第三方非确定性接口，或有未定案的产品决策 |
| L2 | 屏/弹窗规格、任务切片、追溯矩阵（配 `coverageRequirements` 开检查 7） | 有前端且要前后端并行 |
| L3 | 进度台账、外部依赖基线、旧版停用清单 | 周期 >2 个月，或有历史代码要停用 |

契约层脚手架（openapi / DDL / fixtures）与层无关：**任何层进入工作流 E** 时从 `templates/contracts/` 拷。

**模板按层放在 `templates/L0/`～`templates/L3/`，契约层在 `templates/contracts/`。** 落 L0 就只拷 `templates/L0/`，不要预先摆出空的 L1/L2 骨架 —— 空骨架会被后来的 agent 当成"这里应该有内容"而去填，那就是编造。`templates/L0/example/` 是一套已填好、checker 跑出 0 error 的最小库，用它对照"填完长什么样"；CI workflow 在 `templates/L0/ci/spec-check.yml`。L1 模板见 `templates/L1/`（`conventions` / `errors.yaml` / `permissions.yaml` / `decision-register` / `decision-sheet` / `consuming-repo-stubs`）；L2/L3 模板（`screens-overview` / `screen-spec` / `modal-spec` / `traceability-matrix` / `task-slice`；`progress-ledger` / `provider-baseline` / `legacy-deprecation`）都提炼自一个真实运转的 L3 库的对应文件。**一律触发条件到了再拷。**

### 编号目录是门风，不是机制

`10-why/ 20-decisions/ 30-contracts/ 40-screens/ 50-delivery/` 这套编号的好处是 `ls` 出来就是裁决顺序。但**四个机制对它零依赖** —— checker 逻辑里没有任何一处认识这些目录名，全部路径来自 config 的 glob（`dictionaries` / `definedIn` / `mustAppearIn` / `excludeFromScan`）。库想用 flat 布局（`rules.md`、`contracts/`、`screens/`）就改 glob，机制一样成立；替换布局的 config 写法见 SCHEMA.md §5.2。

**已有库不要为了对齐编号去搬目录。** 那是纯成本、零收益，还会把 git history 打散。给它写一份匹配现状的 config 就行。

## 1. 四个机制（一个都不能省）

| 机制 | 落在哪 | 省掉会怎样 |
|---|---|---|
| **单一真相源 + 分级裁决顺序** | `README.md` 的裁决表 | 两个 agent 各选一个版本，都能举出依据，冲突无解 |
| **下游只引用 ID，不复制描述** | `CLAUDE.md` 硬纪律 + checker 检查 6 | 复制一次中文，漂移一次；两个 agent 的产出无法机器比对 |
| **机器可读字典 + 代码生成** | `contracts/*.yaml` → `generated/` | agent 各自手写常量，枚举值有 N 个物理来源 |
| **缺口登记 `G-*` = 合法的"我不知道"** | `decisions/gaps.md` | **最关键。** 没有这条路，agent 一定编造 —— 因为编造是它唯一能推进的动作 |

第四条是整套东西成立的支点。它必须同时有三样才生效：合法登记入口（`gaps.md`）、明确禁止补全的指令（`CLAUDE.md N-01`）、以及一个**保护性默认行为**（缺口未关闭时代码该怎么做）。只给禁令不给出路，agent 会绕过禁令。

## 2. 工作流

**顺序是反直觉的，别改。** 先冻结字典，不等任何决策关闭 —— 枚举值、错误码、权限码几乎不依赖产品决策的结论。实测收益：约 60% 的一期工作量因此不被任何未定案决策阻塞。

```
A 访谈抽取素材      → 见 INTERVIEW.md
B 冻结字典           contracts/*.yaml —— 不等决策
C 生成 CLAUDE.md + checker + 挂 CI 闸门   ← 优先级最高，见下
D 只关掉卡住数据模型根的那一个决策
E 契约层（DDL / API）
F （L2）屏规格与 E 并行 → 追溯矩阵体检 → 切片
```

### C 为什么排在契约层之前

`CLAUDE.md` 才是真正进入 coding agent 上下文的执行面；上万行规格是它的参考材料。**规格写完但 `CLAUDE.md` 没写，等于没有规格** —— agent 不会主动去读它不知道存在的文件。

同理，checker 必须在契约层大量产出之前就能跑。checker 晚于内容，内容里已经积累的不一致会一次性爆出来，通常的结果是把检查关掉。

### 挂闸门的位置（最容易做错的一步）

生成物**必须写进规格库自己的 `generated/`**，然后每个消费仓库有自己的 `verify:contracts` 比对签入副本与规格库的 `generated/`。

不要让规格库的生成脚本直接写到 `../其他仓库/`。那样规格库的 CI 结构上跑不了这个检查（相邻仓库在 CI 里不存在），消费仓库又没挂检查 —— 两边都是空的，而 `package.json` 里那条 script 看起来一切正常。

**闸门必须是 CI，不能是"手跑一次"。** 手跑的报告在活库上一写完就过期：底下文件再动一下，计数就变了，报告还是旧的。把 `templates/L0/ci/spec-check.yml` 拷进规格库的 `.github/workflows/`，每次 push / PR 对着当时的树跑 checker（有 error 退出码即 1）。`check-spec-suite.mjs` 与 config 也拷进规格库自身，别引用相邻的 skill 目录，否则 CI 里根本找不到。

## 3. 每阶段结束前的强制自检

问自己一句：**这一阶段我写下的东西，哪些是素材里没有的？**

下列每一项，必须能标注 `来自素材 §N` 或 `已登记 G-xx`。**没有第三个选项**：

枚举值 · 状态迁移 · 阈值 · 公式 · 价格/成本 · 重试次数 · 抽样比例 · 权限边界 · 平台/供应商名 · **数量**（"8 个平台"）· 超时 · 币种/单位 · SLA 数字

数量最容易滑过去 —— "支持 8 个平台"里的 8，素材里往往并没有。

编造一个不存在的 `BR-` 编号比不写更糟：它看起来有依据，会被下游当真，且不会被任何检查抓到。

## 4. 路由

- 落地一套新库（拷哪些文件、CI 怎么挂、"填完长什么样"）→ `templates/L0/`（含已填好的 `example/` 与 `ci/spec-check.yml`）
- 写通用约定 / 错误码 / 权限码 / 决策单（L1）→ `templates/L1/`：`conventions.md` 是查阅型，凡是不需要 agent 每次都记住的约定都放这里而不是 `CLAUDE.md`；`errors.yaml`（一个 code 一个语义，复用即前端误渲染）、`permissions.yaml`（`risk` / `inheritable` 是挂在每条上的声明属性，不另开高危清单节点）；`decision-register.md` + 每决策一份 `decision-sheet.md`（`D-*` 与 `G-*` 的分界见 INTERVIEW.md §4.1）；消费仓库的 `CLAUDE.md` 指针 + `AGENTS.md` 在 `consuming-repo-stubs.md`
- 写 API / DDL / 测试夹具（工作流 E 及以后）→ `templates/contracts/`（openapi.yaml、ddl/V1__baseline.sql、fixtures.json）
- 写屏 / 弹窗规格、追溯矩阵、任务切片（工作流 F，L2）→ `templates/L2/`；追溯 CSV 的列约定写在 task-slice.md 头部注释里
- 写进度台账 / 外部依赖基线 / 旧版停用清单（L3）→ `templates/L3/`
- 写或改 `CLAUDE.md` 的纪律条目、缺口登记程序、保护性默认行为 → 读 [DISCIPLINES.md](DISCIPLINES.md)
- 定 `.yaml` 的记录形状、两区制生成标记、checker 的 config 字段（含 `mayLackDefinition` / `coverageRequirements`）→ 读 [SCHEMA.md](SCHEMA.md)
- 进入访谈阶段，或素材不足要判断该登记还是该问 → 读 [INTERVIEW.md](INTERVIEW.md)
- 审计已有规格库（不是新建）→ 先为被审计库写一份匹配的 config（命名空间、路径、`mayLackDefinition`），再跑 `node scripts/check-spec-suite.mjs --specs-root <路径> --config <该库config> --report <输出目录>`，全程只读；然后按 SCHEMA.md 的"审计模式"节读报告。**不写 config 直接跑会用 skill 自带示例，路径不匹配，首屏一堆假缺陷。**

## 5. 四条铁律（写进你生成的每一个套件）

1. **一个概念一种记录形状。** 同一概念出现三种容器形状，通用 checker 就退化成一堆专用函数。
2. **计数派生，不写字面量。** `表数量 === 38` 这类断言会在改动时误报，然后被人改成新的魔数，最终文档里的数字和实际不符。
3. **每条禁令配一条断言。** 每条 `N-xx` 必须处于三态之一：(a) 有机器断言且写明在哪跑；(b) 显式标记"只能人工审查"并计入技术债；(c) 不允许存在。没有断言的禁令，三个月后一定已经被违反。
4. **散文里不写绝对路径，有台账的量不复述结论。** 只声明一个根变量，其余相对。进度、计数、哈希这类有唯一台账的量，别处只许引用文件名。
