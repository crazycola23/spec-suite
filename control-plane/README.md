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

## Projection 的准确边界

依赖图 digest 不匹配、图声明不完整、root/edge/surface 无法解析或 canonical input 漂移时，projector 会把 context 扩到全图，同时输出 `leaseEligible: false` 和 `privilegeCeiling: none`。这验证的是 **declared incompleteness 与 graph drift detection**。

它不证明 semantic graph completeness：`complete: true` 仍是受信声明。如果有人删除 edge、同步更新 digest/state 并继续声明 complete，当前纵切无法推导该 edge 本应存在。

## Eval

隔离 operator 先把 `control-plane/` 复制成 Agent 不可写的 snapshot，在 snapshot 外生成 Ed25519 key、revocation store、audit sink 和两个 daemon config。然后由 supervisor 启动：

```bash
node scripts/lease-issuer-daemon.mjs --config /isolated/issuer-daemon.json
node scripts/effect-enforcer-daemon.mjs --config /isolated/enforcer-daemon.json
```

两个进程都从 stdin 逐行读取上面的 JSON request，并在 stdout 逐行返回 JSON response；ready/status 写到 stderr。`npm test` 会临时构造完整隔离目录并攻击 trust-path 注入、workspace policy self-authorization、篡改、cross-task replay、expiry、old epoch、revocation、canonical/graph drift、G-17 bypass、baseline/protected overlap、symlink escape、classifier ambiguity、issuer/revocation/audit failure，以及 denial provenance 完整性。

仍然没有 `init/adopt` CLI、Ajv、真实 Stripe、eBPF、容器 framework 或 trusted/monotonic clock。
