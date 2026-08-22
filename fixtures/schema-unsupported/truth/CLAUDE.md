# schema-unsupported · Claude adapter

冻结语料，不要改。见 `fixtures/README.md`。

禁令小节与断言表在这里是**必需**的：`checkBanCoverage` 对任何套件都会跑，
没有断言表本身就是缺陷。这份语料要断言的缺陷只有一条（字典版本 99），
所以其余部分必须干净。

## 禁令

### N-01 不许把未知版本当成默认版本

读到不认识的 `schemaVersion` 时，拒绝执行；不允许 `?? 1` 之类的兜底。

## 禁令 → 断言覆盖表

| 禁令 | 强制方式 | 状态 | 在哪跑 |
| --- | --- | --- | --- |
| N-01 | 版本策略表单点判定，高于 current 即拒绝 | ✅ | `scripts/compatibility.test.mjs` |
