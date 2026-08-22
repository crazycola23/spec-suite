# 消费仓库的 Agent adapter 与 contract copy

代码仓库不是业务规则来源。它只保留：

1. 当前平台能自动发现的薄 adapter；
2. 该仓库平台特有的本地约定；
3. 从规格库 `generated/` 同步并签入的 contract copy；
4. consumer verifier 闸门。

## 1. Adapter 模型

```text
spec repo contracts/agent-entry.yaml
              |
              +-- render common region --> consumer CLAUDE.md
              +-- render common region --> consumer AGENTS.md
              +-- render common region --> consumer GEMINI.md
              +-- render common region --> consumer .github/copilot-instructions.md
```

只生成当前平台实际会加载的文件，不预先维护四份副本。共同区机器同步；平台或仓库特有内容留在 marker 外手写。

V1 的 Claude adapter：

```markdown
# <consumer-repository> · Claude adapter

<!-- BEGIN GENERATED: agent-entry.common -->
<从规格库 canonical Agent Entry Contract 渲染>
<!-- END GENERATED: agent-entry.common -->

## Claude-specific handwritten region

- 规格库位置：`<相对路径，例如 ../project-specs>`
- 本仓库 contract copy：`<本地目录>`
- 本仓库专属验证命令：`<命令>`
```

相对路径是部署配置，不是权威 source；CI 中也应通过 checkout 布局或显式参数提供。若消费仓库无法访问规格仓库，CI 应从可信 artifact 恢复同一份 generated bundle，而不是复制业务描述。

V1 的 Codex adapter 使用同一共同区，只替换宿主文件与平台手写区：

```markdown
# <consumer-repository> · Codex adapter

<!-- BEGIN GENERATED: agent-entry.common -->
<从规格库 canonical Agent Entry Contract 渲染>
<!-- END GENERATED: agent-entry.common -->

## Codex-specific handwritten region

- 规格库位置：`<相对路径，例如 ../project-specs>`
- 本仓库 contract copy：`<本地目录>`
- 本仓库专属验证命令：`<命令>`
- 若存在更深层 `AGENTS.md`，只放该目录专属规则，不复制共同区
```

Codex 从项目根向当前工作目录逐层加载 `AGENTS.md`，更靠近工作目录的指令后加载并覆盖上层；因此 canonical 共同区通常只放根 adapter，目录级文件保持局部。平台发现规则见 [OpenAI 官方 AGENTS.md 文档](https://developers.openai.com/codex/agent-configuration/agents-md)。

## 2. 本地约定只写平台特有内容

adapter 手写区可以包含：

- 当前平台的文件发现规则；
- 本仓库构建、测试和 lint 命令；
- 工具权限或上下文限制；
- consumer copy 的本地目录。

不得包含：

- 枚举值、状态迁移、阈值、错误码或权限码定义；
- canonical 纪律的手抄版本；
- consumer bundle 内已经存在的描述。

## 3. Consumer copy 与 verifier

规格库 generator 只写规格库自己的 `generated/`，不直接修改相邻仓库。消费仓库同步 manifest 所列文件并签入，然后在自己的 CI 运行：

```bash
node <spec-suite-tools>/verify-consumer-contracts.mjs \
  --specs-root <spec-repository> \
  --config <spec-repository>/spec-suite.config.json \
  --consumer-root <checked-in-contract-directory>
```

V1 verifier 要求三件事全部相等：

- manifest 字节；
- 文件集合；
- 每个 output 的字节。

它不判断版本兼容，也不允许 consumer 多放一个“临时修正版”。任何差异都表示副本不是规格库真正生成的那一份。

## 4. Consumer CI 最小形状

```yaml
- name: Verify checked-in contract copy
  run: |
    node tools/verify-consumer-contracts.mjs \
      --specs-root ../project-specs \
      --config ../project-specs/spec-suite.config.json \
      --consumer-root contracts/generated
```

CI 必须先以可复现方式取得规格仓库或其可信 generated artifact。若取不到，验证应失败或明确跳过并阻塞发布，不能把“没有比对对象”报告成通过。
