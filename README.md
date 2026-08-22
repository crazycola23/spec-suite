# spec-suite

[![test](https://github.com/crazycola23/spec-suite/actions/workflows/test.yml/badge.svg)](https://github.com/crazycola23/spec-suite/actions/workflows/test.yml)

一个面向多 Agent、多仓库协作的可机器检查规格治理 skill。它的核心不是生成更多文档，而是让三条不变量可执行：

- **Unknown stays unknown**：没有权威依据的事实被持久化为 unresolved，不会在下一轮上下文里变成默认值。
- **Canonical stays canonical**：共同纪律与业务契约只有一个 canonical source；adapter、bundle、manifest 和消费副本都没有裁决权。
- **Derived stays reproducible**：相同输入确定性地产生相同的 Agent adapter、language-neutral bundle 和 consumer 验证结果。

## P0 onboarding 与 trigger eval

面对陌生仓库时，当前版本的 adoption assessment 全程只读：

```bash
node scripts/adopt.mjs --repo-root . --dry-run
node scripts/adopt.mjs --repo-root . --format json --no-input
```

它只报告可观察 artifact，把未知回答保持为 `unknown`，并推荐 `no-op`、`lightweight`、
`full` 或 `needs-input`；不会创建 `L0`、`CLAUDE.md`、`AGENTS.md` 或
`.spec-suite/unresolved.yaml`。

trigger eval 把 skill discovery 与 mode routing 分开。可以只验证签入的 corpus，
也可以接入任何遵守 stdin/stdout 协议的外部 Node adapter：

```bash
node scripts/eval-trigger.mjs --validate
node scripts/eval-trigger.mjs --adapter ./path/to/adapter.mjs
```

adapter run 的绿灯只证明「这份 corpus × 这个 adapter/model」的结果，不证明所有宿主或模型都会同样触发。

## V1 已实现的纵切片

```text
lightweight unresolved
        |
        | idempotent migration
        v
       G-*

canonical agent entry             canonical contracts
        |                                 |
  +-----+-----+                           v
  v           v              contract-bundle.json + manifest.json
CLAUDE.md   AGENTS.md                     |
  |           |                           |
  +-----+-----+----------- checked -------+
                                            |
                                            v
                                  verified consumer copy
```

V1 特意只证明边界和确定性：Claude/Codex 两个真实 adapter、一个语言无关 JSON bundle、一个按 manifest / 文件集合 / 字节工作的 consumer verifier。两个 adapter 的共同区来自同一份 canonical Agent Entry Contract；checker 会逐个验证声明文件存在、marker 唯一且内容逐字节一致。它不提前承诺多语言代码生成、SemVer 兼容、`specHash` 或 breaking-change 语义。

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

## Multi-Agent 并发纵切

在 V2 control plane 之上，task 现在可以声明一份向后兼容的并发合同：

```json
{
  "schemaVersion": 1,
  "taskId": "task:frontend",
  "subject": "agent:frontend-1",
  "role": "frontend-implementer",
  "baseRevision": "git:<agent-start-commit>",
  "readSet": ["src/**"],
  "writeSet": ["src/frontend/**"]
}
```

`baseRevision` 是 Agent 开始任务时冻结的 Git commit；`writeSet` 是它允许提交的仓库相对 glob。合并前的 `merge-gate` 会同时检查实际改动是否越出 `writeSet`、目标分支是否仍停在 `baseRevision`，以及目标分支在这期间是否改过同一文件。目标分支哪怕只发生了无碰撞更新，也会返回 `stale-base`，要求先 rebase / 重新投影 / 重新检查，不把旧世界默默当成新世界。

机器合同：merge gate 只在 target revision 等于 baseRevision、实际改动全在 writeSet 且没有同文件碰撞时放行 fast path。

```bash
node scripts/merge-gate.mjs \
  --repo-root . \
  --task tasks/frontend.json \
  --target-ref main \
  --head-ref agent/frontend
```

退出码 `0` 只表示当前 revision 上可以走 fast path；`2` 表示需要串行化、rebase 或处理越界写入；`1` 表示任务或仓库输入本身不可用。旧 task 没有并发字段时仍能用于现有 projection/Lease 流程，但不能通过这个 merge gate —— 未声明不等于安全。

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

# 检查 Agent 分支是否仍可合并
node scripts/merge-gate.mjs --repo-root . --task tasks/frontend.json \
  --target-ref main --head-ref agent/frontend
```

generator 是 fail-closed：canonical input 缺失、无法解析、source 指向 gap/generated 或 checker 有缺陷时，命令失败并保留上一份正确 bundle。

## 仓库结构

文档 —— 人读的入口，也是若干规范句的 canonical 文本：

- [`SKILL.md`](./SKILL.md)：轻量/完整模式、三条不变量、A–F 状态机与 router。
- [`INTERVIEW.md`](./INTERVIEW.md)：证据抽取、source 资格、unresolved 与 decision 的边界。
- [`DISCIPLINES.md`](./DISCIPLINES.md)：Canonical Agent Entry Contract、Claude/Codex adapter 与两区制。
- [`SCHEMA.md`](./SCHEMA.md)：持久化协议、canonical schema、bundle/manifest、config 与 audit。
- [`templates/`](./templates/)：lightweight、L0–L3 与 contract scaffolds。
- [`control-plane/`](./control-plane/)：V2/V2.5 projection、Lease、authority blocker 与 protected effect 纵切。

代码 —— 分层，方向由 `npm run arch` 每次强制：

- [`src/`](./src/)：库代码。`shared/`（与产品层无关的叶子：文本、glob、遍历、canonical JSON、原子写、argv、版本策略）、`adoption/`（只读仓库观察与 mode recommendation，不依赖 Truth/Control）、`truth/`（V1 的字典、模型、schema 规则、ID 引用、投影、两区制、诊断）、`truth/cli/`（argv 解析与输出渲染；它**返回** exit code，不自己 exit）。
- [`src/layers.mjs`](./src/layers.mjs)：allowed-edge 的声明式清单。未归类的文件是违规，不是默认放行。
- [`scripts/`](./scripts/)：CLI 入口、V2 daemon、检查与报告工具，以及 `fixtures/v1-vertical-slice/` —— 纵切集成测试 spawn 的那棵夹具，它跟随 HEAD，与冻结的 [`fixtures/`](./fixtures/) 是两回事。`check-spec-suite.mjs` 是 facade：逐名 re-export `src/` 的公开面并持有 CLI guard，所以既有的 import 路径与 flag 都没变。库代码一律返回值或抛异常，**进程退出码只在这一层决定**。
- [`registry/invariants.mjs`](./registry/invariants.mjs)：规则的机器可读单一真相源。`CHECK_NAMES` 与可生成的文档表格都从它派生，每条记录必填「这条规则**没有**证明什么」。
- [`migrations/`](./migrations/)：schema migration registry，**目前真的是空的**。所有 artifact 都还是 `schemaVersion: 1`；凭空造一个 v2 格式等于发明未知事实。未注册的 `(kind, from→to)` 一律 unsupported 并 fail closed。

语料与测试：

- [`fixtures/`](./fixtures/)：冻结语料，被整树 digest 锁住 —— 改任何一个字节都会让测试变红，这是设计目标。目录名是**产品层**（`v1`/`v2`），文件里的 `schemaVersion` 才是版本；`schema-unsupported/` 字面写着 `99`，用来证明 fail-closed 不是靠测试临时改写版本号得到的。
- [`tests/`](./tests/)：`unit`（按模块）、`integration`（两条纵切）、`compatibility`（旧 schema、幂等迁移、未知版本、冻结树锁）、`golden`（字节精确）、`adversarial`（V2 攻击面）。

## 验证

```bash
npm install
npm test                              # 全量测试
npm run arch                          # 静态架构约束
npm run docs -- --check               # 文档生成区与 registry 的漂移检查
npm run trust-report -- --format md   # 每条规则「没有证明什么」（也可 json）
```

测试覆盖只读 adoption recommendation、trigger corpus/adapter 协议、幂等迁移、重复任务保持 unresolved、双 adapter 同源投影、声明路径 fail-closed、平台手写区保护、确定性生成、三类 V1 fail-closed 路径、consumer 副本校验，以及 V2 的 trust-root 注入、self-authorization、Lease tampering/replay/expiry/revocation、G-17 bypass、protected/baseline overlap、symlink escape、classifier/audit failure 和 denial provenance。

`npm run arch` 强制四件事：import 图无环；每条跨层边符合 `src/layers.mjs` 的声明；每个 `.mjs` 都有归属层（未归类 = 违规）；**没有绕过 import 图的动态加载**。第四条堵的是前三条共同的前提 —— 静态扫描看不见 `import(expr)` 与 `createRequire()`，所以在加上它之前，任何被层策略禁止的边只要改写成动态形式就能全程绿灯通过。字面量 `import('./x.mjs')` 被收成图里的真实边照常受约束；无法静态分析的形态默认违规，只有 `DYNAMIC_LOAD_EXEMPTIONS` 里按 `(文件, 形态)` 登记的放行，而**用不上的豁免同样是违规** —— 这样检测器若无声失效，豁免会一起变红而不是安静全绿。

在 Windows 上有 3 个 POSIX 隔离测试会因缺能力而**跳过**并打印所需能力。CI 上 `SPEC_SUITE_REQUIRE_POSIX_ISOLATION=1` 让同样的缺失变成硬失败：跳过的安全测试不该被记成通过。CI 矩阵是 ubuntu-latest × node 22/24，`fail-fast` 关闭，这样"到处都坏"与"只在某个版本坏"能被区分开。

## 信任边界

本仓库最想拦住的误读是把「机器检查通过」当成「语义真相已证明」。为了让这一步没法默认发生，每条规则在 [`registry/invariants.mjs`](./registry/invariants.mjs) 里都被归入四类之一，并且**必填**一行「这条规则没有证明什么」：

| 分类 | 含义 | 例子 |
| --- | --- | --- |
| `machine-enforced` | 有检查每次运行都验证，违规必然被拦 | 派生物逐字节可复现；`source` 恰好指向一个可解析的权威 ID；Lease 的 Ed25519 签名 |
| `trusted-assertion` | 工具接受但不验证内容，绿灯 ≠ 已证明 | source 指向的文档是否**真的**规定了该事实；`complete: true` |
| `external-assumption` | 依赖工具之外的东西成立 | POSIX identity 与 mode bit 隔离；enforcer 是受保护 effect 的唯一出口；supervisor 配置正确 |
| `not-proven` | 已知没人验证，登记在案而不假装已覆盖 | config 的未知键被静默忽略；audit 没有 append-only 保证；`keyId` 与公钥之间没有绑定 |

上表的例子是举例，完整清单由 `npm run trust-report` 输出 —— 那份报告的全部目的就是让这句话有具体内容，而不只是一句免责声明。最典型的一对：checker 能证明 `source: BR-REFUND-001` 这个 ID 可解析，却**读不懂**那份文档是否规定了该数字。前者 machine-enforced，后者 trusted-assertion；混为一谈就会把「出处可解析」记成「事实正确」。

## 设计边界

- `sourceSearch` 是 provenance，不是“事实不存在”的证据。
- 只冻结 authoritative source 支持的事实；依赖未决选择的值保持 unresolved。
- 共同 Agent 纪律从一个 canonical source 投影；平台特有规则留在 adapter 手写区。
- regex/heuristic checker 保持便宜和透明；只有真实误报/漏报案例足够多时才升级 parser。
- Action SHA pinning 属于 hardening，不冒充 V1 correctness。
- Context projection 只增加知识，不授予权限；dependency uncertainty 增加时 privilege 只能保持或下降。
- `complete: true` 是受信声明；同步修改 graph 与 digest 不等于证明依赖图语义完备。
- Control Plane effect 类型暂停扩大；现有 3 类之外不加新类，直到授权判定从三处手写的 per-kind if 链变成数据驱动。
