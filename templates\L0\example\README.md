# example 规格库（最小 L0 示例）

一套已填好的最小规格库：checker 为 0 error，canonical Agent Entry Contract 能确定性渲染 Claude adapter，并且 dictionary 能生成 language-neutral bundle。它也是本 skill 的回归夹具。

**开工前先读 [CLAUDE.md](./CLAUDE.md)。**

## 目录

```
example/
├─ CLAUDE.md                    ← Claude adapter（共同生成区 + 平台手写区）
├─ .spec-suite/unresolved.yaml  ← 已迁移后的空轻量 registry
├─ 10-why/02-业务规则.md         ★ 唯一业务真相源（BR-*）
├─ contracts/agent-entry.yaml   ★ canonical 共同 Agent Entry Contract
├─ contracts/dictionary.yaml    ★ 枚举 / 状态机 / 缺口（机器可读，权威）
├─ decisions/gaps.md            ★ 规则缺口台账（G-*，§1 由 dictionary.yaml 生成）
├─ generated/                   ← contract-bundle.json + manifest.json
└─ spec-suite.config.json       ← checker 配置
```

## 运行检查

```bash
node ../../../scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json
node ../../../scripts/generate-contract-bundle.mjs --specs-root . --config spec-suite.config.json
```

真实项目把 guard、migration、checker、generator、consumer verifier 与 config 一并拷入规格库，由 CI 每次 push 验证投影和 bundle（见 `templates/L0/ci/spec-check.yml`）。
