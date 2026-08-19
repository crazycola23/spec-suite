# Schema、投影、bundle 与 config

定义持久化状态、canonical YAML、Agent Entry Contract、生成边界和 checker 配置时读本文件。

## 1. Canonical 记录规则

所有 `contracts/*.yaml` 遵守：

1. 每个集合都是对象数组；记录的稳定标识键是 `code`，不使用裸字符串集合。
2. 每个 code-bearing 业务事实都带非空 `source`。
3. `source` 必须是恰好一个可解析的 authoritative ID；`G-*`、`mayLackDefinition` 与 `generated/` 不是权威来源。
4. `label` 是人类展示文本；下游结构化文件引用 `code`，不复制 label。
5. 同一种记录只保留一种形状；声明属性挂在记录上，不另建重复清单。
6. 计数由 checker 派生，不把“共 N 项”写成事实。

checker 负责形状、引用和投影一致性；generator 在写 bundle 前再次验证 source 资格并 fail closed。

## 2. 轻量 unresolved 协议

尚未采用完整 suite 的普通仓库只需：

```yaml
# .spec-suite/unresolved.yaml
schemaVersion: 1
facts:
  - status: unresolved
    fact: retry_count
    sourceSearch:
      - config
      - docs
      - code
    evidence: []
    blockedAction: do_not_implement_default
    nextEvidence: product_owner_or_api_contract
```

`fact` 是稳定身份。重复任务读取同一条记录，不新增默认值。`sourceSearch` 只记录执行过的查找动作，不证明搜索充分，也不证明事实不存在。

读取守卫：

```bash
node scripts/guard-unresolved-fact.mjs --specs-root . --fact retry_count
```

命中时输出持久化状态并退出 3，且不写任何文件。模板见 `templates/lightweight/unresolved.yaml`。

进入完整 suite 后做单向幂等迁移：

```bash
node scripts/migrate-unresolved.mjs --specs-root . --fact retry_count \
  --block src/retry-policy.ts \
  --protective-default do_not_retry \
  --rollback-cost "change one policy value before any retry is emitted" \
  --owner product
```

迁移后的 `G-*` 保留 provenance：

```yaml
gaps:
  - code: G-07
    missing: retry_count
    blocks: [src/retry-policy.ts]
    protectiveDefault: do_not_retry
    rollbackCost: change one policy value before any retry is emitted
    owner: product
    status: open
    closedBy: null
    closedAt: null
    provenance:
      schemaVersion: 1
      unresolvedFact: retry_count
      sourceSearch: [config, docs, code]
      evidence: []
      blockedAction: do_not_implement_default
      nextEvidence: product_owner_or_api_contract
```

`provenance.unresolvedFact` 是迁移身份；重复迁移返回同一个 `G-*`，不会复制记录。

## 3. Canonical contracts

L0 dictionary：

```yaml
meta:
  suite: example
  truthSource: 10-why/02-rules.md

enums:
  - code: RetryMode
    label: Retry mode
    source: BR-RETRY-001
    values:
      - code: MANUAL_ONLY
        label: Manual only
        source: BR-RETRY-001

stateMachines:
  - code: PublishRecord
    label: Publish record
    source: BR-PUBLISH-001
    states:
      - code: draft
        label: Draft
        source: BR-PUBLISH-001
        terminal: false
        transitions:
          - to: submitted
            trigger: submit
            source: BR-PUBLISH-002
      - code: submitted
        label: Submitted
        source: BR-PUBLISH-001
        terminal: true
        transitions: []

gaps: []
```

`terminal: true` 必须配空 transitions；非终态必须有出边。缺少出边的业务选择保持 gap，不能为了闭合图而编一条边。

L1 可增加：

```yaml
errors:
  - code: GEO-40901
    httpStatus: 409
    class: business
    label: Idempotency conflict
    source: BR-PROJECT-002
    details: [existingId]
    frontendAction: navigate

permissions:
  - code: geo:budget:release
    label: Release budget
    source: BR-AUDIT-001
    risk: high
    inheritable: false
    routes: [/geo/budget]
```

## 4. Canonical Agent Entry Contract

共同纪律只维护在：

```yaml
# contracts/agent-entry.yaml
schemaVersion: 1
common:
  markdown: |
    ## Shared invariants

    ### N-01 Unknown stays unknown

    A fact without a resolvable authoritative source cannot enter canonical contracts.
```

adapter 用两区制：

```markdown
# Project · Claude adapter

<!-- BEGIN GENERATED: agent-entry.common -->
<由 contracts/agent-entry.yaml 渲染；不手改>
<!-- END GENERATED: agent-entry.common -->

## Claude-specific handwritten region

<只写平台加载、工具和上下文规则>
```

标记契约：

- BEGIN / END 独占一行且 ID 相同；
- 不嵌套；
- 区内字节由注册 renderer 决定；
- 共同纪律在区内，平台特有内容在区外；
- canonical 变化必须重渲染，adapter 手写变化不得改共同区。

V1 只提供 `agent-entry.common` → `agentEntryCommon` 和一个 Claude adapter。新增 AGENTS/GEMINI/Copilot 是 adapter 扩展，不是新增真相源。模板见 `templates/L0/agent-entry.yaml` 与 `templates/L0/CLAUDE.md`。

其他 Markdown 投影沿用同一标记，例如 `stateMachines.PublishRecord.transitions`。

## 5. Language-neutral bundle

V1 生成：

```text
contracts/*.yaml
      |
      +-- validate source graph
      +-- stabilize object-key order; preserve canonical array order
      v
generated/
├── contract-bundle.json
└── manifest.json
```

`contract-bundle.json` 包含 `schemaVersion`、`suite` 和非 gap 的 `contracts`。`manifest.json` 只固定生成边界：

```json
{
  "schemaVersion": 1,
  "inputs": ["contracts/dictionary.yaml"],
  "outputs": ["contract-bundle.json"]
}
```

V1 manifest 不放时间戳、`specHash`、SemVer 或兼容范围。输入和输出边界稳定后再在 V2 选择 hash 的语义对象。

generator MUST 在任何写入前完成：

- config 与所有 input 存在且可解析；
- checker 无 error；
- 每个 canonical fact 的 source 可唯一解析；
- source 不属于 gap、合法未决命名空间或 generated；
- output 与 manifest 都位于 `generatedDir`。

失败时旧 bundle 保持原字节。成功后相同输入重复运行得到相同字节。

consumer verifier 不解释版本，只验证：

```text
expected manifest  == consumer manifest
expected file set  == consumer file set
expected bytes     == consumer bytes
```

## 6. `spec-suite.config.json`

```json
{
  "dictionaries": ["contracts/dictionary.yaml"],
  "generatedDir": "generated",
  "claudeMd": "CLAUDE.md",
  "agentEntry": {
    "source": "contracts/agent-entry.yaml",
    "adapters": [
      { "platform": "claude", "path": "CLAUDE.md", "projection": "agent-entry.common" }
    ]
  },
  "bundle": {
    "inputs": ["contracts/dictionary.yaml"],
    "output": "generated/contract-bundle.json",
    "manifest": "generated/manifest.json"
  },
  "idNamespaces": [
    { "prefix": "BR", "pattern": "^BR-[A-Z]+-\\d{3}$", "kind": "rule", "definedIn": ["10-why/02-*.md"] },
    { "prefix": "G", "pattern": "^G-\\d{2}$", "kind": "gap", "definedIn": ["contracts/dictionary.yaml"] },
    { "prefix": "N", "pattern": "^N-\\d{2}$", "kind": "ban", "definedIn": ["CLAUDE.md"] }
  ],
  "projections": {
    "agent-entry.common": "agentEntryCommon",
    "stateMachines.*.transitions": "transitionTable",
    "enums.*.values": "enumTable",
    "gaps": "gapTable"
  },
  "coverageRequirements": [],
  "structuredFileGlobs": ["**/*.yaml", "**/*.yml", "**/*.json", "**/*.csv"],
  "markdownGlobs": ["**/*.md"],
  "ddlGlobs": ["contracts/ddl/**/*.sql"],
  "excludeFromScan": ["node_modules/**", ".git/**", "generated/**"],
  "labelCopyAllowlist": []
}
```

字段约束：

- `idNamespaces[].pattern` 必须 `^...$` 完全锚定且互斥。
- `mayLackDefinition: true` 只标“已引用、尚无定义文件”的合法未决命名空间；generator 不接受它作为 source。
- `excludeFromScan` 包含 generated、依赖目录和无裁决权的只读原型。
- `coverageRequirements` 声明某命名空间必须进入指定矩阵；空数组 no-op。
- `labelCopyAllowlist` 默认空，只对已解释的展示字段或精确键值豁免。
- 路径布局由 glob 决定；编号目录不是机制。已有仓库不必搬目录。

完整 L0 config 模板见 `templates/L0/spec-suite.config.json`。

## 7. Checker、fixer 与 audit

三个职责分开：

```bash
# 只读验证
node scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json

# 只改 Markdown generated regions
node scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json \
  --write-generated-regions

# 真正生成 bundle
node scripts/generate-contract-bundle.mjs --specs-root . --config spec-suite.config.json
```

checker 七类检查：

| # | 检查 | error 的含义 |
|---|---|---|
| 1 | schema | 记录形状、必填 source、占位符或 Agent Entry Contract 无效 |
| 2 | 状态机 | 出边悬空，或 terminal 与 transitions 矛盾 |
| 3 | ID 引用 | source/引用没有定义，或命名空间有歧义 |
| 4 | generated regions | canonical 与 Markdown 投影不一致 |
| 5 | `N-xx` 覆盖 | 禁令没有可信三态断言行 |
| 6 | label copy | 结构化字段完整复制 canonical label |
| 7 | 覆盖矩阵 | 配置要求的 ID 没出现在指定文件 |

审计既有仓库时，先写匹配该仓库命名空间与路径的 config，再只读运行：

```bash
node scripts/check-spec-suite.mjs --specs-root <target> \
  --config <target-config> --report <outside-target-directory>
```

`--report` 不授权修改目标库。报告是当次树的快照，不替代 CI。
