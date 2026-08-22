# spec-suite

[![test](https://github.com/crazycola23/spec-suite/actions/workflows/test.yml/badge.svg)](https://github.com/crazycola23/spec-suite/actions/workflows/test.yml)

一个面向多 Agent、多仓库协作的可机器检查规格治理 skill。它的核心不是生成更多文档，而是让三条不变量可执行：

- **Unknown stays unknown**：没有权威依据的事实被持久化为 unresolved，不会在下一轮上下文里变成默认值。
- **Canonical stays canonical**：共同纪律与业务契约只有一个 canonical source；adapter、bundle、manifest 和消费副本都没有裁决权。
- **Derived stays reproducible**：相同输入确定性地产生相同的 Agent adapter、language-neutral bundle 和 consumer 验证结果。

## V1 已实现的纵切片

```text
lightweight unresolved
        |
        | idempotent migration
        v
       G-*

canonical agent entry        canonical contracts
        |                            |
        v                            v
CLAUDE.md generated region   contract-bundle.json + manifest.json
        |                            |
        +----------- checked --------+
                                     |
                                     v
                           verified consumer copy
```

V1 特意只证明边界和确定性：一个真实 Claude adapter、一个语言无关 JSON bundle、一个按 manifest / 文件集合 / 字节工作的 consumer verifier。它不提前承诺多语言代码生成、SemVer 兼容、`specHash` 或 breaking-change 语义。

## V2/V2.5 control-plane 纵切

V1 Truth Integrity 保持冻结；新增控制面位于独立的 [`control-plane/`](./control-plane/)：

- 固定 `<500 tokens` 的 Global Safety Kernel；
- deterministic context projection：`Kernel ∪ Closure(Roots(T)) ∪ Blockers(Surface(T))`；
- 由隔离 OS identity 运行、启动时固定 trust roots 的 issuer/enforcer daemon；
- policy-owned TTL、Ed25519 短期 Lease 与 path-free JSONL IPC；
- 显式 protected file classification，以及 `baseline ∩ protected = ∅` 的 fail-closed 检查；
- `G-17 unresolved → live Stripe mock effect blocked → issuer deny → enforcer deny` 的机器链；
- 带 `constraint`、`blockingRecord`、`authorityState` 和 source 的结构化 denial provenance。

这仍是最小 adversarial vertical slice，不是真实 Stripe 或完整 sandbox framework。它检测 graph 声明不完整和 digest drift，但不声称证明 semantic graph completeness；可信时间源、ACL/capability 审计、MAC/container/eBPF 仍在边界之外。完整模型与 eval 见 [`control-plane/README.md`](./control-plane/README.md)。

## 两种模式

**轻量模式**适用于普通仓库里的单个无依据事实。只创建 `.spec-suite/unresolved.yaml`，不引入完整规格基础设施。若项目以后采用 spec-suite，同一事实可单向、幂等升级为一个 `G-*`。

**完整模式**适用于已经采用 spec-suite，或存在多 Agent、多仓库、共享契约、钱/权限/不可逆外部动作的项目。从 L0 开始，按真实触发条件再加 L1–L3。

## CLI

```bash
# 持久化未知守卫；命中 unresolved 时退出 3
node scripts/guard-unresolved-fact.mjs --specs-root . --fact retry_count

# unresolved -> G-*，重复执行不复制记录
node scripts/migrate-unresolved.mjs --specs-root . --fact retry_count \
  --block src/retry-policy.ts --protective-default do_not_retry \
  --rollback-cost "change one policy value" --owner product

# 只读检查
node scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json

# 只修 Markdown / adapter 生成区
node scripts/check-spec-suite.mjs --specs-root . --config spec-suite.config.json \
  --write-generated-regions

# 只生成 language-neutral bundle
node scripts/generate-contract-bundle.mjs --specs-root . --config spec-suite.config.json

# 验证消费仓库签入副本
node scripts/verify-consumer-contracts.mjs --specs-root . \
  --config spec-suite.config.json --consumer-root <consumer-contract-directory>
```

generator 是 fail-closed：canonical input 缺失、无法解析、source 指向 gap/generated 或 checker 有缺陷时，命令失败并保留上一份正确 bundle。

## 仓库结构

- [`SKILL.md`](./SKILL.md)：轻量/完整模式、三条不变量、A–F 状态机与 router。
- [`INTERVIEW.md`](./INTERVIEW.md)：证据抽取、source 资格、unresolved 与 decision 的边界。
- [`DISCIPLINES.md`](./DISCIPLINES.md)：Canonical Agent Entry Contract 与平台 adapter 两区制。
- [`SCHEMA.md`](./SCHEMA.md)：持久化协议、canonical schema、bundle/manifest、config 与 audit。
- [`templates/`](./templates/)：lightweight、L0–L3 与 contract scaffolds。
- [`control-plane/`](./control-plane/)：V2/V2.5 projection、Lease、authority blocker 与 protected effect 纵切。
- [`scripts/`](./scripts/)：guard、migration、checker/fixer、generator、consumer verifier 和测试夹具。

## 验证

```bash
npm install
npm test
```

测试覆盖幂等迁移、重复任务保持 unresolved、adapter 手写区保护、确定性生成、三类 V1 fail-closed 路径、consumer 副本校验，以及 V2 的 trust-root 注入、self-authorization、Lease tampering/replay/expiry/revocation、G-17 bypass、protected/baseline overlap、symlink escape、classifier/audit failure 和 denial provenance。

## 设计边界

- `sourceSearch` 是 provenance，不是“事实不存在”的证据。
- 只冻结 authoritative source 支持的事实；依赖未决选择的值保持 unresolved。
- 共同 Agent 纪律从一个 canonical source 投影；平台特有规则留在 adapter 手写区。
- regex/heuristic checker 保持便宜和透明；只有真实误报/漏报案例足够多时才升级 parser。
- Action SHA pinning 属于 hardening，不冒充 V1 correctness。
- Context projection 只增加知识，不授予权限；dependency uncertainty 增加时 privilege 只能保持或下降。
- `complete: true` 是受信声明；同步修改 graph 与 digest 不等于证明依赖图语义完备。
- Control Plane effect 类型暂停扩大；现有 3 类之外不加新类，直到授权判定从三处手写的 per-kind if 链变成数据驱动。
