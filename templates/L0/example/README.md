# example 规格库（最小 L0 示例）

一套已填好的最小规格库，`node scripts/check-spec-suite.mjs` 对它跑出 0 error。用来演示「一套合格的最小 L0 长什么样」，也是 checker 自己的回归夹具。

**开工前先读 [CLAUDE.md](./CLAUDE.md)。**

## 目录

```
example/
├─ CLAUDE.md                    ← 协作纪律（执行面）
├─ 10-why/02-业务规则.md         ★ 唯一业务真相源（BR-*）
├─ contracts/dictionary.yaml    ★ 枚举 / 状态机 / 缺口（机器可读，权威）
├─ decisions/gaps.md            ★ 规则缺口台账（G-*，§1 由 dictionary.yaml 生成）
└─ spec-suite.config.json       ← checker 配置
```

## 运行检查

```bash
node ../../../scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json
```

真实项目里把 `scripts/check-spec-suite.mjs` 与 `spec-suite.config.json` 拷进规格库自身，由 CI 每次 push 跑（见 `templates/L0/ci/spec-check.yml`）。
