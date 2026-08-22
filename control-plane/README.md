# V2/V2.5 control-plane vertical slice

本目录是在 V1 Truth Integrity 之上的独立控制面纵切。现有 V1 checker、`source = exactly one authoritative ID`、No Alias、unresolved、deterministic bundle 和 fail-closed generator 不变；这里不引入 evidence DAG，也不把 provider/legacy 字段映射塞回 core spec。

## 已闭合的机器链

纵切只包含一个 source-backed Fact `F-CUSTOMER-001`、一个 unresolved record `G-17`、一个 Stripe Adapter Spec、固定 Global Safety Kernel、deterministic projector、隔离 issuer/enforcer daemon、短期 Ed25519 Lease、三个 effect class 和结构化 JSONL audit。

Projection 明确带 `knowledgeOnly: true` 和 `grantsPrivilege: false`。Issuer 用固定受信输入重算 projection；只有 canonical revision、graph digest、policy epoch、active constraints 和精确 task scope 全部一致时才签名。Enforcer 独立重验这些字段，并使用：

```text
Allowed(E) = Baseline(E) OR LeaseAuthorizes(E)
Protected(E) AND NOT LeaseAuthorizes(E) => Deny(E)
```

`G-17.blocks` 现在直接引用 `network.mock.live-stripe` 的 canonical effect。只要 `gap:G-17` active 且 authority state 为 `unresolved`，issuer 即使在 policy 允许、request 明确请求时也拒签；enforcer 即使收到签名正确且包含该 effect 的 Lease 也拒绝执行。`mock://protected.local/...` 仍是可授权的 protective default，不连接真实 Stripe。

File protection 是一等分类。Policy 用 `protectedFilePrefixes` 标记 `out/protected/`，并在加载时验证 `baseline ∩ protected = ∅`；任何重叠都会让 issuer 和 enforcer fail closed，而不是依赖 baseline 恰好未覆盖。

每个 denial 都带统一的机器字段：

```json
{
  "cause": {
    "type": "unresolved",
    "constraint": "NO_LIVE_STRIPE",
    "blockingRecord": "G-17",
    "authorityState": "unresolved",
    "authoritativeSource": null,
    "unresolvedSource": "CP-G17-001",
    "detail": "Whether live Stripe customer mutation is permitted"
  }
}
```

因此 audit 可以稳定表达 `Effect → Constraint → Authority / Unresolved / Infrastructure failure`，无需解析 `reason` 字符串。

## Isolated daemon boundary

`lease-issuer-daemon.mjs` 与 `effect-enforcer-daemon.mjs` 只在启动时接受一个绝对 `--config` 路径。由 supervisor 在另一个非 root OS identity 下启动 daemon，并把 stdin/stdout JSONL 管道交给 Agent。Daemon 启动会拒绝：

- Agent UID 与 daemon UID 相同，或 Agent UID 为 root；
- config、snapshot、policy/state/graph/key/revocation/audit parent 位于 Agent workspace；
- Agent identity 对任何 trust root 有写权限；
- Agent identity 可读 issuer private key；
- symlink trust roots 或不符合要求的文件类型。

Snapshot、路径和 key 在 config 加载后固定。Agent 不能经 IPC 提交任何 path、TTL、epoch、revision 或 signer-owned 字段。Issuer IPC 的完整请求面只有：

```json
{
  "schemaVersion": 1,
  "op": "requestLease",
  "taskId": "task:customer-update",
  "subject": "agent:harness",
  "requestedEffects": [
    {
      "kind": "network.mock.protected",
      "resource": "mock://protected.local/stripe/customers/cus_demo"
    }
  ]
}
```

Enforcer IPC 只接受 `schemaVersion`、`op: executeEffect`、`effect` 和 `lease`。两端都把 `subject` 固定到 config 中的 Agent identity；未知顶层字段直接拒绝。旧的 `lease-issuer.mjs` 和 `enforce-effect.mjs` CLI 仍保留给单进程协议测试，但它们本身不构成权限隔离边界。

部署仍必须让 enforcer adapter 成为受保护写入/网络 effect 的唯一出口。此纵切验证 POSIX identity 和 mode-bit 隔离前提，不替代容器、MAC policy、ACL/capability 审计或可信时间源。

## effect 类型暂停扩大

Control Plane effect 类型暂停扩大：现有 3 类（`file.write`、`network.mock.protected`、`network.mock.live-stripe`）之外不加新类。

理由不是"以后也不加"，而是**现在加的代价是隐性的**。授权判定目前是 per-kind 的 if 链，同一个 kind 分散在三处手写分支，谁都不保证它们同步：

| 位置 | 每个 kind 在这里手写什么 | 只改这一处的后果 |
|---|---|---|
| `classifyEffect` | resource 归一化、`protected` 布尔、protection 三元组 | 新 kind 落不进任何分支 → `effect kind is not classified`（fail closed，但要到分类那一刻才炸） |
| `executeAuthorizedEffect` | 真正的副作用怎么做 | 只在这边加 = 死代码，读的人却以为该 kind 已被支持 |
| `baselineAuthorizes` | 是否可以免 lease | 顺手放宽 = 一条 `resourcePrefix` 意外授权一整类全新副作用 |

最要紧的一处不对称在第一格：`file.write` 的 `protected` 是**从 policy 的 protected 前缀推导**出来的（命中多于一条按歧义拒绝），而两个 mock kind 是**硬编码** `protected: true` 并连 protection 三元组一起写死。两个先例互相矛盾，于是"第四类的 `protected` 从哪来"没有唯一答案 —— 而写错的方向只差一个键：硬编码成 `protected: false` 的新 kind 会全程绿灯地绕过整条授权链。

解除条件（四条全部满足才考虑加第四类）：

1. 授权判定改成**数据驱动**：某个 kind 的 protected 来源、执行方式、能否被 baseline 免检，由一张声明表决定，而不是三条 if 链各写一遍。
2. 新 kind 默认落在"必须持 lease"一侧。`baselineAuthorizes` 现在硬编码只认 `file.write`，这个方向不能反过来。
3. 有对抗性测试证明该 kind 在 unauthorized、over-authorizing lease、cross-task replay 三种形状下都被拒。
4. 该 effect 的真实副作用在纵切里可被隔离 —— 现有 3 类全部是 mock 或 workspace 内写入，不触达外部世界。

机器侧现状：`kind` 集合恰好是这 3 个、分类链与执行链集合相等、`baselineAuthorizes` 只认 `file.write`，这三件事由 `tests/adversarial/v2-control-plane.test.mjs` 的源码普查在每次 `npm test` 时核对。这些锁**不能**阻止新增 —— 改断言与改 if 链可以在同一个 commit 里完成。它们买到的是"不可能悄悄发生"：新增一类必然在 diff 里撞上一条写着上面这些条件的测试。

## Projection 的准确边界

依赖图 digest 不匹配、图声明不完整、root/edge/surface 无法解析或 canonical input 漂移时，projector 会把 context 扩到全图，同时输出 `leaseEligible: false` 和 `privilegeCeiling: none`。这验证的是 **declared incompleteness 与 graph drift detection**。

它不证明 semantic graph completeness：`complete: true` 仍是受信声明。如果有人删除 edge、同步更新 digest/state 并继续声明 complete，当前纵切无法推导该 edge 本应存在。

## Multi-Agent task contract

task 可以额外携带并发字段；没有这些字段的旧 task 保持兼容，但不能通过 merge gate：

| 字段 | 约束 | 用途 |
|---|---|---|
| `baseRevision` | `git:<7–64 位 hex>` | Agent 启动时观察到的 immutable 基线 |
| `readSet` | 仓库相对 glob 数组（可以为空） | 调度器判断写入对其他 Agent 的依赖 |
| `writeSet` | 非空的仓库相对 glob 数组 | 合并门检查实际改动的写权限范围 |
| `subject` / `role` | 可选非空字符串 | 把任务和具体 Agent / 角色绑定到 projection 与 Lease |

`readSet` 与 `writeSet` 必须成对出现。调度器对两个 task 的 `write-write` overlap 直接串行化；`write-read` / `read-write` 可以并行，但读者在写者合并后必须重新投影和验证。glob overlap 判定对 wildcard 采用保守策略：误报只会少并行，漏报会隐藏 lost update，因此不接受“看起来大概不重叠”作为放行理由。

`readSet` 是 Agent 声明的读取意图，不是工具观测到的实际读操作轨迹。

## Integration coordinator

`node scripts/orchestrate.mjs --tasks <manifest>` consumes completed Agent branches
(`headRef`) and emits a deterministic conflict graph plus greedy execution batches.
Write-write overlap serializes tasks; read/write overlap remains a post-merge
revalidation obligation. The command does not launch Agents. `--apply` integrates
completed heads into a checked-out, clean target branch and reruns the merge gate
before every merge. It fails closed on stale, conflicting, or out-of-scope results.

`--allow-declared-disjoint` enables an explicit validated-disjoint path for target
changes that match neither the task's declared `readSet` nor `writeSet`. This is
still based on declared intent, not observed read tracing, and the result records
that distinction; it must not be treated as a runtime capability grant.

`merge-gate.mjs` 只读 Git 历史，不执行 merge/rebase，也不替 Agent 修改工作树。它的 fast path 要求：

1. `targetRef == baseRevision`；
2. Agent 的实际 `baseRevision..headRef` 文件集合全部落在 `writeSet`；
3. 目标分支从基线以来没有改过 Agent 要提交的同一文件。

任一条件不满足都返回机器可读的 `stale-base`、`write-conflict` 或 `out-of-scope`，并以非零状态退出。

## Eval

隔离 operator 先把 `control-plane/` 复制成 Agent 不可写的 snapshot，在 snapshot 外生成 Ed25519 key、revocation store、audit sink 和两个 daemon config。然后由 supervisor 启动：

```bash
node scripts/lease-issuer-daemon.mjs --config /isolated/issuer-daemon.json
node scripts/effect-enforcer-daemon.mjs --config /isolated/enforcer-daemon.json
```

两个进程都从 stdin 逐行读取上面的 JSON request，并在 stdout 逐行返回 JSON response；ready/status 写到 stderr。`npm test` 会临时构造完整隔离目录并攻击 trust-path 注入、workspace policy self-authorization、篡改、cross-task replay、expiry、old epoch、revocation、canonical/graph drift、G-17 bypass、baseline/protected overlap、symlink escape、classifier ambiguity、issuer/revocation/audit failure，以及 denial provenance 完整性。

仍然没有 `init/adopt` CLI、Ajv、真实 Stripe、eBPF、容器 framework 或 trusted/monotonic clock。
