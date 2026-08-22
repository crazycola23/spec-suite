# Trigger Eval

这套语料评估两件不同的事：

1. `discovery`：宿主 agent 只看到 skill 的 `name + description` 时，是否应该加载 `spec-suite`。
2. `routing`：skill 已经加载后，是否选择 `lightweight` 或 `full`。

`cases.jsonl` 是稳定语料。每行包含：

- `id`：唯一 case id；
- `phase`：`discovery` 或 `routing`；
- `prompt`：交给被测 agent 的用户请求；
- `expected`：discovery 的 `{ "activate": boolean }`，或 routing 的 `{ "mode": "lightweight" | "full" }`；
- `category`：`no-trigger` / `lightweight` / `full`，用于报告 false positive、over-escalation 等错误；
- `severity`：`critical` 失败阻断 runner，`exploratory` 只报告；
- `why`：该 expected 的测试理由。

## Adapter protocol

adapter 是一个独立的 Node 程序。runner 每个 case 启动一次 adapter，把一个 JSON 对象写入 stdin；adapter 必须在 stdout 只写一个 JSON 对象：

```json
{
  "protocolVersion": 1,
  "phase": "discovery",
  "caseId": "TR-D-004",
  "prompt": "...",
  "skill": {
    "name": "spec-suite",
    "description": "..."
  }
}
```

`routing` request 的 `skill` 还会包含完整 `content`。response 只能依 phase 提供 `activate: boolean` 或 `mode: lightweight|full`；runner 不接受 Markdown 或供应商特有格式。

运行：

```bash
node scripts/eval-trigger.mjs --validate
node scripts/eval-trigger.mjs --adapter ./evals/trigger/adapters/codex.mjs
node scripts/eval-trigger.mjs --adapter ./evals/trigger/adapters/codex.mjs --format json
```

runner 不把 accuracy 阈值写死。当前 merge gate 是：`criticalFailures > 0` 才失败；exploratory cases 用于积累真实误判数据。
