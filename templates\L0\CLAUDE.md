<!-- Claude adapter template.
     The common region is rendered from contracts/agent-entry.yaml.
     Replace placeholders in the canonical source, then run npm run fix:generated-regions. -->

# <project> · Claude adapter

<!-- BEGIN GENERATED: agent-entry.common -->
## 0. Authority order

| Priority | Source | Conflict handling |
|---:|---|---|
| 1 | Closed `D-*` decisions | Backfill the canonical rule; decision wins until then |
| 2 | `<authoritative-rules-file>` (`<rule-prefix>-*`) | The only business-rule authority |
| 3 | `contracts/*.yaml` | If it conflicts with priority 2, the contract is wrong |
| 4 | Derived adapters, bundles, manifests, consumer copies | No authority; regenerate or resync |

## 1. Shared invariants

### N-01 Unknown stays unknown

A fact without a resolvable authoritative source cannot enter canonical contracts or code. Persist it as unresolved; in a full suite, upgrade the same fact to one `G-*`.

### N-02 Canonical stays canonical

Generated regions, `generated/`, manifests, reports, and consumer copies are derived artifacts. Never edit them as sources or cite them as authority.

### N-03 Reference IDs; do not copy descriptions

Downstream specs and code reference stable IDs. Copying canonical prose creates another physical truth source.

### N-04 Implementation choices cannot change business meaning

If implementation and a canonical rule conflict, stop the dependent action and surface the conflict. Do not silently choose a more convenient interpretation.

## 2. Unresolved fact path

1. Stop before inserting a temporary value.
2. Search existing authority and record search actions as provenance only.
3. Ask the owner when possible.
4. Persist unresolved state; do not implement the missing default.
5. Continue only unrelated reversible work.

## 3. Task routing

| Task | Open |
|---|---|
| Add or change an enum/state | `contracts/dictionary.yaml` and its source rule |
| Change common agent discipline | `contracts/agent-entry.yaml` |
| Inspect unresolved facts | `.spec-suite/unresolved.yaml` or canonical `gaps` |
| Consume a contract | checked-in bundle plus consumer verifier |

## 4. Enforcement

| 禁令 | 强制方式 | 在哪跑 | 状态 |
|---|---|---|---|
| N-01 | source 必填、可解析，generator 拒绝 gap/generated | spec CI | ✅ |
| N-02 | generated region、bundle 与 consumer 字节比对 | spec CI + consumer CI | ✅ |
| N-03 | 结构化 label copy 检查 | spec CI | ⚠️ 部分 |
| N-04 | 只能人工审查业务语义是否被隐式改变 | PR review | ⚠️ 技术债 |
<!-- END GENERATED: agent-entry.common -->

## Claude-specific handwritten region

- Claude Code loads this root adapter as its platform entrypoint.
- Before editing common discipline, modify `contracts/agent-entry.yaml` and rerender this region.
- Put Claude-only file discovery, tool behavior, or context constraints here; do not copy common rules here.
