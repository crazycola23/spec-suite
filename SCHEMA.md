# Schema、两区制标记与 config

定 `.yaml` 的记录形状、写生成区标记、配置 checker 时读这份。审计已有规格库读 §5。

设计约束只有一条：**通用 checker 只有在 schema 规整时才能保持通用。** 一个概念出现三种容器形状，checker 就退化成一堆专用函数（原型项目为了容忍一个裸字符串列表，多出了两个专用函数）。

---

## 1. 通用记录规则（所有 yaml 一律遵守）

1. **每个集合都是对象数组**，元素必带 `code`。不允许裸字符串集合 —— `values: [A, B]` 非法，写成 `values: [{code: A, ...}, {code: B, ...}]`。
2. **每个业务事实必带 `source`**，值是真相源里的规则 ID。checker 会解析它；解析不到就是 `N-01` 违规。
   > 这是"不得发明"从人工纪律变成机器断言的地方。`source` 必填 + ID 必须可解析 = 字典范围内的 `N-01` 有了机器兜底。散文仍然只能人工审查。
3. **`label` 是唯一允许出现的中文人类标签**，且只允许出现在字典里。别的结构化文件出现同样的字符串 = 复制描述 = 检查 6 报错。
4. **一个概念一种形状。** 「高危权限」若是权限记录的一个属性，就写成 `risk: high` 挂在每条权限上；不要另开一个 `highRiskPermissions:` 节点。多来源 union 是 checker 复杂度的主要来源。
5. **同一记录类型只用一种 YAML 写法。** 别一半 block 一半 flow 一行式 —— 会让人误以为是两种记录类型。
6. **不写字面量计数。** 任何"共 N 项"由 checker 派生后报告，不作为断言。

---

## 2. `contracts/dictionary.yaml`（L0）

```yaml
meta:
  suite: <项目代号>
  truthSource: 10-why/02-业务规则说明.md    # 相对路径，永不写绝对路径
  version: v1

enums:
  - code: AuditAction
    label: 审计动作
    source: BR-AUDIT-001
    values:
      - code: PROJECT_CREATED
        label: 项目创建
        source: BR-AUDIT-001
      - code: BUDGET_APPROVED
        label: 预算放行
        source: BR-AUDIT-001

stateMachines:
  - code: PublishRecord
    label: 发布记录
    source: BR-PUBLISH-002
    states:
      - code: draft
        label: 草稿
        source: BR-PUBLISH-002
        terminal: false
        transitions:
          - to: submitted            # 必须是本状态机内存在的 code（检查 2）
            trigger: submit
            source: BR-PUBLISH-003
      - code: published
        label: 已发布
        source: BR-PUBLISH-002
        terminal: true
        transitions: []              # 空数组，不是省略 —— 省略无法区分"终态"与"忘了写"

gaps:
  - code: G-01
    missing: <缺什么，一句话>
    blocks: [<被卡住的交付物 ID 或文件名>]
    protectiveDefault: <缺口未关闭时代码的行为>
    rollbackCost: <猜错了改回来要动什么>      # 写不出来说明基线选错了
    owner: <产品 | 业务 | 商务>
    status: open                              # open | closed
    closedBy: null                            # 关闭时填规则 ID
    closedAt: null                            # 关闭时填日期
```

`terminal: true` 且 `transitions: []` 是缺口的保护性默认形态 —— 少一条迁移可以后加，多一条已发生的迁移无法撤销。

## 3. `contracts/errors.yaml`、`permissions.yaml`（L1）

```yaml
errors:
  - code: GEO-40901
    httpStatus: 409
    class: business            # transport | business | validation —— 声明属性，不靠码段猜
    label: 业务幂等冲突
    source: BR-PROJECT-002
    details: [existingId]      # 前端可依赖的字段名，不是中文说明
    frontendAction: navigate   # 前端分支动作，枚举值
```

```yaml
permissions:
  - code: geo:budget:release
    label: 预算放行
    source: BR-AUDIT-001
    risk: high                 # high 即高危，不可被任何码继承（属性，不是清单）
    inheritable: false
    routes: [/geo/budget]
```

`class` / `risk` / `kind` 这类**声明属性**替代硬编码名字清单。原型项目用 `AUXILIARY_TABLES = new Set([...])` 加计数魔数做同一件事，代价是改动即误报，然后魔数被改大，文档里的数字最终和实际不符。

---

## 4. 两区制标记

`.md` 是 `.yaml` 的可读渲染 **加上** 只能手写的内容（阅读键、理由、⛔ 缺口小节、模式说明、决策历史、交叉引用）。整篇生成会删掉后者，而后者往往是文档里最有价值的部分。所以分区：

```markdown
## 3. PublishRecord 状态机

<!-- BEGIN GENERATED: stateMachines.PublishRecord.transitions -->
| 当前态 | 可迁移到 | 触发 | 依据 |
|---|---|---|---|
| draft | submitted | submit | BR-PUBLISH-003 |
<!-- END GENERATED: stateMachines.PublishRecord.transitions -->

### 为什么 published 是终态

<散文自由手写。撤回走独立的 withdraw 记录，见 BR-PUBLISH-007。>
```

契约：

- 标记必须独占一行、行首无空白（有缩进会被 markdown 当代码块）
- `BEGIN` 与 `END` 的投影 ID 必须一致
- 投影 ID 形如 `<集合>.<code>[.<视图>]`，视图名在 config 的 `projections` 里注册
- 不允许嵌套
- 区内内容与渲染器输出**逐字节相同**（含末尾换行），checker 重新渲染后比对
- **区内不许手改。** 要改值改 yaml

买到三件事：区内不可能出现复制的中文（它由 yaml 渲染）；yaml 有而 md 无的记录变成 CI 可见（原型项目里 `RL-05` 在 yaml 存在、md 里根本没有，无人发现）；散文全部保留。

---

## 5. `spec-suite.config.json`

```json
{
  "specsRoot": ".",
  "dictionaries": ["contracts/dictionary.yaml", "contracts/errors.yaml", "contracts/permissions.yaml"],
  "generatedDir": "generated",

  "idNamespaces": [
    { "prefix": "BR", "pattern": "^BR-[A-Z]+-\\d{3}$", "kind": "rule",     "definedIn": ["10-why/02-*.md"] },
    { "prefix": "AC", "pattern": "^AC-[A-Z]+-\\d{3}$", "kind": "acceptance","definedIn": ["10-why/04-*.md"] },
    { "prefix": "G",  "pattern": "^G-\\d{2}$",         "kind": "gap",      "definedIn": ["contracts/dictionary.yaml"] },
    { "prefix": "N",  "pattern": "^N-\\d{2}$",         "kind": "ban",      "definedIn": ["CLAUDE.md"] },
    { "prefix": "T-OPEN", "pattern": "^T-OPEN-\\d{2}$","kind": "tech-open","definedIn": ["decisions/T-OPEN-*.md"], "mayLackDefinition": true }
  ],

  "projections": {
    "stateMachines.*.transitions": "transitionTable",
    "enums.*.values": "enumTable",
    "errors": "errorTable",
    "permissions": "permissionTable",
    "gaps": "gapTable"
  },

  "coverageRequirements": [
    { "namespace": "BR", "mustAppearIn": "50-delivery/11-*.csv", "severity": "warn" }
  ],

  "structuredFileGlobs": ["**/*.yaml", "**/*.yml", "**/*.json", "**/*.csv"],
  "excludeFromScan": ["node_modules/**", "generated/**", "90-prototype/**"],
  "labelCopyAllowlist": []
}
```

### 5.1 字段为什么长这样

**`idNamespaces[].pattern` 必须完全锚定**（`^...$`）。这一个字段解掉三个计数陷阱：

| 陷阱 | 不锚定会怎样 |
|---|---|
| 子串碰撞 | `T-001` 被从 `BR-PROJECT-001` 里面截出来 |
| 命名空间碰撞 | `M-01`（弹窗）和 `M01`（另一种编号）混成一个 |
| 同前缀多命名空间 | `T-001` / `T-01` / `T-OPEN-01` 是三套编号，一个宽松正则会把它们合并 |

**`excludeFromScan` 必须含只读原型目录。** SVG 的 `path d="M16 8..."` 会伪造出上百个 `M16`、`M18` 假引用。冻结的原型没有裁决权，本来就不该参与引用完整性统计。

**`labelCopyAllowlist` 默认空。** 检查 6 命中时，正确动作 99% 是改被命中的文件（把中文换成 ID 引用），不是加白名单。加白名单要在同一行写理由。三种写法：`"草稿"`（放过这条 label，不论出现在哪）、`{"key":"name"}`（放过展示名字段的所有值）、`{"key":"name","label":"管理员"}`（只放过这一对）。

**`mayLackDefinition: true` 给"合法未决"的命名空间。** 有一类 ID 是"会开了、方向定了、还没落成文件"的（`T-OPEN-*` 就是典型）：它已经被别处引用，但定义文件还不存在。默认这会被检查 3 报成悬空 error —— 于是任何真实库首次审计都被这类假缺陷淹没。给这个命名空间标 `mayLackDefinition: true`，它的未定义引用降级为 warn（"合法未决"），落成文件后自动转正。**只给这一类用**，别拿它当"关掉悬空检查"的开关。

**记录的标识键是 `code`，不是 `id`。** 这是 §1.1 的硬规则，检查 1 按它报"缺 code"。为了不让同一个根因在检查 3 里再变成一片"悬空"噪声，检查 3 / 检查 6 在登记定义时也认 `id:`（与既有行为一致）—— 但这只是去重，不是许可：根因仍由检查 1 报一次，该改成 `code:` 还是要改（铁律 1，一个概念一种形状）。

**`coverageRequirements` 驱动检查 7。** 每条声明"某命名空间的 ID 必须全部出现在某个覆盖文件里"，形如 `{ "namespace": "BR", "mustAppearIn": "50-delivery/11-*.csv", "severity": "warn" }`。默认 `warn`（矩阵里合法地可以暂时缺一条），要当硬闸门写 `"severity": "error"`。空数组时检查 7 no-op。它补的是检查 3 结构上抓不到的洞：一个 BR 被定义、也被引用，却漏在追溯矩阵里。

**没有 `tableCount` 这类字段。** 计数由 checker 派生后报告，不作为断言（铁律 2）。

### 5.2 换布局只改 config，不改机制

checker 逻辑里**不存在**任何编号目录字面量（`10-why`、`50-delivery` 只出现在注释示例里）。所有路径都从 config 的 glob 来，所以 flat 布局同样成立：

```json
{
  "specsRoot": ".",
  "dictionaries": ["contracts/dictionary.yaml"],
  "generatedDir": "generated",
  "idNamespaces": [
    { "prefix": "BR", "pattern": "^BR-[A-Z]+-\\d{3}$", "kind": "rule", "definedIn": ["rules.md"] },
    { "prefix": "S",  "pattern": "^S-\\d{2}$",         "kind": "screen", "definedIn": ["screens/*.md"] },
    { "prefix": "G",  "pattern": "^G-\\d{2}$",         "kind": "gap",  "definedIn": ["contracts/dictionary.yaml"] },
    { "prefix": "N",  "pattern": "^N-\\d{2}$",         "kind": "ban",  "definedIn": ["CLAUDE.md"] }
  ],
  "coverageRequirements": [
    { "namespace": "BR", "mustAppearIn": "traceability.csv", "severity": "warn" }
  ],
  "excludeFromScan": ["node_modules/**", "generated/**", "legacy/**"]
}
```

要改的只有 `definedIn` / `mustAppearIn` / `excludeFromScan` 三处 glob。**没有 `namingProfile` 这类字段** —— 加一个"布局预设"就等于让路径有两个真相源（预设 + glob），冲突时无解（铁律 1）。glob 已经是那个唯一真相源。

唯一需要保留的实质约定：**`CLAUDE.md` 必须在根目录**（agent 只自动读根目录那一份），以及 `generatedDir` 下的内容必须签入（消费仓库要拿它比对）。

---

## 6. 审计模式：怎么读报告

**第 0 步先写 config，不要跳。** 被审计库的命名空间前缀、真相源路径、原型目录名都和本 skill 自带示例不一样。不给 `--config` 就会用示例那份，路径全不匹配，首屏一堆假缺陷 —— 实测这一步是新人放弃这套检查的最常见原因。先照 §5 写一份匹配被审计库的 config（`idNamespaces` 的 `prefix` / `pattern` / `definedIn`、`excludeFromScan` 里的只读原型目录、合法未决的命名空间标 `mayLackDefinition`），放在库外也可以。

```
node scripts/check-spec-suite.mjs --specs-root <路径> --config <该库的config> --report <输出目录>
```

全程只读，不写入被审计的库（`--report` 也指向库外，别把报告落在活库里）。报告是 `report.json` + `report.md`。

七类检查的严重度与处理动作：

| 检查 | 命中意味着 | 动作 |
|---|---|---|
| 1 schema 符合性 | 记录形状不规整 / `source` 缺失或不可解析 | 改 yaml。`source` 缺失即 `N-01` 嫌疑，优先看 |
| 2 状态机闭合 | 有迁移指向不存在的状态 | 一定是缺陷，无例外。全套里性价比最高的一条 |
| 3 ID 引用完整性 | 悬空引用 / 孤儿定义 | 悬空 = 引用方错或定义被删；**孤儿 = 定义了却没人用**，常见成因是缺口关闭时漏了补 AC 和补追溯矩阵行。标了 `mayLackDefinition` 的命名空间未定义引用只报 warn（合法未决），不算悬空 |
| 4 两区制比对 | md 生成区与 yaml 不一致 | 改 yaml 或重新生成，永不手改区内 |
| 5 `N-xx` 覆盖 | 有禁令没有断言行 | 补断言，或如实标记"只能人工审查 + 技术债" |
| 6 禁止复制中文标签 | 结构化文件里**某个键的完整标量值**整个等于字典的 `label` | 换成 ID 引用。这是漂移的**源头形态**，优先级高于它的字面严重度 |
| 7 覆盖矩阵完整性 | 某类已定义 ID 没进指定覆盖文件（如 BR 漏在追溯矩阵） | 补矩阵行。这是检查 3 结构上抓不到的洞（该 ID 被定义、也被引用，只是没进那张表）。由 `coverageRequirements` 声明，默认 warn |

> 检查 6 只匹配「完整标量值」，不匹配子串——实测：`semantics: 同目标已成功发布` 不该因为含「发布」二字就命中。拿 scrm-specs 回归时，按子串匹配报出 346→224 处几乎全是噪声，收窄到整值后剩 8 处、全部是真形状（`publicBoundary: 可公开`、`planStatus: 待确认` 这类本该写码的位置写了中文）。展示名字段（`name`/`summary`）用 config 的 `labelCopyAllowlist` 按键豁免，否则整道闸门会被逼到关掉。
>
> **检查 6 是源头形态探测器，不是穷尽的 label 扫描器。** 它按设计只抓"某个键的完整值就是 label"这一种形态；label 嵌在复合值里（`frontend: 已发布后不可编辑` 里的「已发布」）它抓不到。这是为压掉子串噪声主动做的取舍 —— 别把检查 6 全绿理解成"没有任何复制中文"。

审计一个没有标记的既有库时，检查 4 会把每份 md 报成"零生成区"。报告里给出**投影区 vs 散文区的行数占比**，用来估迁移成本 —— 占比高的文件先迁，收益最大。

**审计结论不等于修改授权。** 报告列出缺陷，改不改由库的所有者决定。
