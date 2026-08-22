<!-- 模板：拷贝到规格库根目录后替换所有 <尖括号> 占位符。
     README 是给**人**看的落地页，Agent Entry Contract 是共同纪律真相源，
     CLAUDE.md 与 AGENTS.md 是两个平台 adapter。
     未关闭缺口清单一律不在本文重复 —— 只指向 decisions/gaps.md。
     （这两条就是本套件的铁律 4：有唯一台账的东西，别处只许引用文件名。） -->

# <项目代号> 规格库

<一句话说明这个库是什么。例：GEO 平台的业务规则、机器可读契约与页面规格的唯一来源。代码不在本库。>

**开工前先读当前平台的根入口文件**（Claude 用 [CLAUDE.md](./CLAUDE.md)，Codex 用 [AGENTS.md](./AGENTS.md)）。共同纪律来自 `contracts/agent-entry.yaml`；不要在 adapter 里手抄修改。

---

## 1. 目录

```
<项目代号>/                        ← 不写绝对路径。任何位置的克隆都成立
├─ README.md                      ← 本文
├─ CLAUDE.md                      ← Claude adapter：共同生成区 + 平台手写区
├─ AGENTS.md                      ← Codex adapter：同一共同生成区 + 平台手写区
├─ .spec-suite/unresolved.yaml    ← 轻量未知迁移进完整 suite 前的持久化状态
├─ <10-why/>                      ← 参考层（为什么）
│   └─ <02-业务规则说明.md>        ★ 唯一业务真相源
├─ decisions/
│   ├─ gaps.md                    ★ 规则缺口台账（G-*）
│   └─ <register.md + D-*.md>     ← L1：产品决策裁决单
├─ contracts/                     ★ 开发主入口
│   ├─ agent-entry.yaml           ★ canonical 共同 Agent Entry Contract
│   ├─ dictionary.yaml            ← 枚举 / 状态机 / 缺口（机器可读，权威）
│   ├─ <errors.yaml / permissions.yaml / conventions.md>
│   └─ <ddl/ 或 openapi.yaml>
├─ generated/                     ← 由 contracts/ 生成，不许手改
│   ├─ contract-bundle.json       ← V1 language-neutral bundle
│   └─ manifest.json              ← 输入与输出边界（V1 不含 specHash）
└─ scripts/
    ├─ guard-unresolved-fact.mjs
    ├─ migrate-unresolved.mjs
    ├─ check-spec-suite.mjs
    ├─ generate-contract-bundle.mjs
    └─ verify-consumer-contracts.mjs
```

---

## 2. 运行检查

```bash
npm run check            # 七类检查，CI 跑的就是这条
npm run fix:generated-regions  # 只重写 Markdown / adapter 生成区
npm run generate:bundle        # 只生成 contract-bundle.json + manifest.json
npm test                 # node --test
```

`npm run check` 红了不要绕过。它检查的七类问题（schema、状态机闭合、ID 引用、生成区一致、禁令覆盖、复制中文标签、覆盖矩阵完整性）每一类都对应一种已经发生过的漂移。

消费仓库各自调用 `verify-consumer-contracts.mjs`，按 manifest、文件集合和字节比对其签入副本与本库 `generated/`。V1 不判断 SemVer 或 breaking change。

---

## 3. 现在卡在哪

<这一节是本文唯一的"状态"内容，且只写决策级阻塞。>
<未关闭的规则缺口不在此列举 —— 见 decisions/gaps.md，那是唯一台账。>
<实施进度不在此列举 —— L3 有进度台账时见那份。>

| 待办 | 阻塞什么 | Owner |
|---|---|---|
| <D-01 定案> | <被卡住的交付物> | <产品 + 技术> |
| <某外部信息未到（如平台正式名）> | <被卡住的交付物> | <商务> |

**不要等所有决策都关闭才做无关的可逆工作。** 只冻结已有 authoritative source 支持的字典事实；依赖未决选择的值保持 unresolved。只有负责人明确授权且无不可撤销后果时，才采用临时基线，并在裁决单记录迁移代价。
