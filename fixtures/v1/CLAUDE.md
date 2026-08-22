# frozen-v1 · Claude adapter

冻结语料，不要改。见 `fixtures/README.md`。

这份文件刻意**没有**生成区（`BEGIN GENERATED` / `END GENERATED`）——
config 里 `agentEntry.adapters` 是空数组、`projections` 是空对象。两区制的行为由
`scripts/zones.test.mjs` 与 `templates/L0/example` 覆盖，这份语料不重复覆盖同一件事。

禁令小节与断言表在这里是**必需**的：`checkBanCoverage` 对任何套件都会跑，
没有断言表就是缺陷。这也顺带把「禁令必须三态之一」的规则纳入冻结面。

## 禁令

### N-01 不许凭空补事实

没有出处的值一律不写。不知道就记 gap，并给保护性默认（`protectiveDefault`），
保护性默认不是答案。

### N-02 不许把生成物当真相

`generated/` 下的任何文件都是派生物。改它不改变事实，下一次生成会覆盖。

## 禁令 → 断言覆盖表

| 禁令 | 强制方式 | 状态 | 在哪跑 |
| --- | --- | --- | --- |
| N-01 | 每条记录必带 `source`，空 source 视为没有出处 | ✅ | `check-spec-suite` 检查 1 |
| N-02 | 生成物字节可复现，消费副本逐字节校验 | ✅ | `verify-consumer-contracts` |
