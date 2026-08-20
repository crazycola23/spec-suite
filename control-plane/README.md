# V2/V2.5 control-plane vertical slice

本目录是在 V1 Truth Integrity 之上的独立控制面实验。现有 V1 checker、`source = exactly one authoritative ID`、No Alias、unresolved、deterministic bundle 和 fail-closed generator 不变；这里不引入 evidence DAG，也不把 provider/legacy 字段映射塞回 core spec。

## 最小闭环

纵切只包含：

- 一个 source-backed Fact：`F-CUSTOMER-001`；
- 一个 unresolved constraint：`G-17`，它把 live provider 保持为未知，只允许本地 mock 路径进入后续授权判断；
- 一个 Stripe Adapter Spec，把外部 `customer` 映射到 canonical `customer_id`；
- 一个固定 Global Safety Kernel；
- 一个 deterministic context projector；
- 一个隔离的 Ed25519 issuer 和短期 Context Lease；
- 两个 interceptor surface：repository-relative file write 与 `mock://protected.local/...`；
- 一个 JSONL audit event；
- adversarial tests。

Projection 明确带 `knowledgeOnly: true` 和 `grantsPrivilege: false`。Issuer 会用受信输入重算 projection；只有当前 canonical revision、graph digest、policy epoch、active constraints 和精确 task scope 全部一致时才签名。Enforcer 使用：

```text
Allowed(E) = Baseline(E) OR LeaseAuthorizes(E)
Protected(E) AND NOT LeaseAuthorizes(E) => Deny(E)
```

依赖图 digest 不匹配、图声明不完整、root/edge/surface 无法解析或 canonical input 漂移时，projector 会把 context 扩到全图，同时输出 `leaseEligible: false` 和 `privilegeCeiling: none`。这使不确定性的增加不能换来权限增加。

## Trust boundary

此纵切验证协议，不假装是 OS sandbox。生产采用时必须让 effect adapter 成为唯一写/网络出口，并把以下对象放在 agent 不可写的隔离身份或只读挂载中：issuer 私钥、canonical state、policy、public key、revocation store 和 audit sink。私钥 CLI 会拒绝 specs root 内的路径及 group/other-readable 文件。

Agent 可以提交新的 lease request；request 只能包含 task、subject、TTL 和 effect references。`leaseId`、revision、epoch、constraints、permissions、signature 等 issuer-owned 字段会被拒绝。请求超出 policy scope 也会被拒绝。

## Eval commands

先把示例复制到临时目录，并在该目录外生成 issuer key 与 revocation store。不要把私钥签入仓库。

```bash
node scripts/project-context.mjs \
  --specs-root . \
  --graph control-plane/example/context-graph.json \
  --task control-plane/example/task.json \
  --state control-plane/example/canonical-state.json \
  --policy control-plane/example/issuer-policy.json \
  --output control-plane/example/generated/projection.json

node scripts/lease-issuer.mjs \
  --specs-root . \
  --graph control-plane/example/context-graph.json \
  --task control-plane/example/task.json \
  --state control-plane/example/canonical-state.json \
  --policy control-plane/example/issuer-policy.json \
  --projection control-plane/example/generated/projection.json \
  --request control-plane/example/lease-request.json \
  --private-key /isolated/spec-suite-v2-ed25519.pem \
  --output control-plane/example/generated/lease.json

node scripts/enforce-effect.mjs \
  --specs-root . \
  --workspace-root /isolated/eval-workspace \
  --graph control-plane/example/context-graph.json \
  --state control-plane/example/canonical-state.json \
  --policy control-plane/example/issuer-policy.json \
  --revocations /isolated/revocations.json \
  --public-key /isolated/spec-suite-v2-ed25519.pub.pem \
  --effect control-plane/example/effects/protected-network.json \
  --lease control-plane/example/generated/lease.json \
  --audit /isolated/audit.jsonl \
  --mock-network-log /isolated/mock-network.jsonl
```

`npm test` 生成临时 key/store 并攻击篡改、跨 task replay、过期、旧 epoch、canonical revision 漂移、缺 edge、issuer 不可用、revocation read failure 和模糊 effect classifier。没有 `init/adopt` CLI、Ajv、eBPF、容器框架或 checker 拆分。
