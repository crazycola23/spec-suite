# fixtures/ —— 冻结语料（compatibility corpora）

**这里的每一个文件都是冻结的。不要"顺手更新"。**

如果你因为改了别处的代码或文档，觉得这里也"应该跟着改一下"——那正是本目录
存在要拦住的事。`fixtures/` 下的文件不是当前版本的示例，是**历史记录**：
它们回答的问题是「一份写于过去的文档，今天的工具还读得懂吗」。把它们同步到
HEAD 会让这个问题永远回答"是"，而且是空洞的"是"。

## `v1` / `v2` 指的是产品层，不是 schemaVersion

这是本目录最容易被误读的一点，所以放在最前面：

| 目录 | 含义 | 里面文档的 `schemaVersion` |
| --- | --- | --- |
| `v1/` | **V1 Truth Integrity** 层的冻结套件 | 全部是 **1** |
| `v2/` | **V2 Control Plane** 层的冻结语料 | 全部是 **1** |
| `schema-unsupported/` | 声明了不受支持版本的文档 | 字面写着 **99** |

`v1/` 和 `v2/` 是**同一个 schemaVersion（1）的两个不同产品层**。截至目前，
仓库里所有 artifact 都还是 schemaVersion 1 —— 还没有第二个 schema 版本存在。
`migrations/index.mjs` 的 registry 是真的空的，这是有意的：凭空造一个
schema v2 格式就是"发明一个未知事实"，违反仓库第一条 invariant
（unknown stays unknown）。等真的有 v2 schema 时，再加 `fixtures/` 下按
schemaVersion 命名的子目录，并在这张表里补一行说明命名含义。

> 一句话记法：**目录名 = 哪一层，文件里的 `schemaVersion` = 哪一版。**

## 各目录的来历与覆盖面

### `v1/` —— 手写，刻意与 `templates/L0/example` 不同形

手写而非从 `templates/L0/example` 复制，原因是：`templates/L0/example` **已经**
是 checker 自己的**活**夹具（`scripts/check-spec-suite.test.mjs:902` 断言它
缺陷为 0，`scripts/v1-vertical-slice.test.mjs:298` 从它复制）。活夹具跟随 HEAD
演进，冻结语料必须不演进 —— 把它复制过来，等于给同一份内容造出第二个权威，
正好是本次重构要消除的「多真相源」问题，还顶着"修复它"的名义。

所以 `v1/` 只覆盖**带版本字段的 artifact 面**：dictionary（`meta.schemaVersion`）、
agent-entry（顶层 `schemaVersion`）、config（顶层 `schemaVersion`）、
unresolved registry、生成物 manifest。它**不**演示两区制（`agentEntry.adapters`
是空数组、`projections` 是空对象）——那由 `templates/L0/example` 与
`scripts/zones.test.mjs` 覆盖，这里不重复。

字典里有一个非 `gaps` 集合（`errors`）是**必需的**，不是凑数：生成器只跳过
`meta`/`gaps` 两个键，若字典里只有 `gaps`，`contract-bundle.json` 的
`contracts` 就是空对象 `{}`，「派生物逐字节可复现」这条断言就会对着一个空
artifact 通过 —— 绿灯，但什么也没证明。

### `v2/` —— 从 `control-plane/` **整目录逐字节复制**

不手写。原因是 `canonical-state.json` 里的 `canonicalRevision` 是对
`canonicalInputs` 所列文件的**原始字节**做 sha256，`contextGraphDigest` 是对
整个 graph 做 JSON digest；这两个值在 `project-context.mjs:206` 会被重新计算
并比对。手写这两个数字只能靠猜，猜出来的 digest 不是"派生"，是"发明"。

复制的是整个 `control-plane/`（含 `global-safety-kernel.md` 与 `README.md`），
不是只有 `example/`。因为 `canonicalInputs` 和 graph 的 `node.path` 都是
**仓库根相对路径**（`control-plane/example/…`、`control-plane/global-safety-kernel.md`）。
保持这一层目录结构，用 `--specs-root fixtures/v2` 就能让所有路径原样解析，
于是复制可以是**纯字节复制、零改写**，digest 依然有效。这也正是
`scripts/v2-control-plane.test.mjs` 的 `makeHarness()` 的做法（它把整个
`control-plane/` 复制进临时目录）。

冻结之后，`fixtures/v2/` 与 `control-plane/` 会随着后者演进而**分叉**。
分叉是**预期信号**，不是故障：它意味着"当年那份语料今天的工具仍然读得懂"。
**不要把它们同步回去。**

### `schema-unsupported/` —— 字面写着 99 的文档

`schemaVersion: 99` 是**写死在文件里**的，不是测试运行时改出来的。
理由是 fail-closed 的测试最怕自己变空洞：如果由测试临时改写版本号，
那么改写逻辑一旦失效（改错字段、改了副本、根本没落盘），测试会因为
"没触发错误"而变绿。版本号写死在冻结文件里，这条路就堵住了。

一个 `truth/` 目录同时服务两条断言，靠两份 config：
- `spec-suite.config.json`（版本合法）→ 走到字典，字典是 99 → 缺陷 + exit 1
- `config-unsupported.json`（版本 99）→ 连字典都读不到 → exit 2

`control/` 目录只放 `project-context` 的四份必需输入，其中 canonical state 是 99。
它刻意**不**带 canonical documents：`assertSchemaVersion` 在
`validateBase()` 里、早于 `canonicalRevision` 比对，所以根本走不到读文档那一步。

## 冻结是怎么强制的

`scripts/compatibility.test.mjs` 里有一个**整树 digest 锁**：把 `fixtures/`
下每个文件的 `{path, sha256}` 排序后求一个 digest，与写死在测试里的期望值比对。
任何文件的任何一个字节变了，这个断言就会失败并打印出变动的文件。

也就是说：**改这里的任何文件都会让测试变红**。这是设计目标，不是障碍。
如果你确实需要改（例如新增一份冻结语料），流程是：

1. 改完之后跑测试，它会打印出实际的 digest 和逐文件差异；
2. **在 commit message 里写清为什么这份"冻结"语料需要变**；
3. 把新 digest 填回测试里的期望常量。

第 2 步是重点。锁的作用不是禁止改动，是让改动无法**悄悄**发生。

唯一被排除在锁外的路径是 `v2/control-plane/example/generated/`——它被复制过来的
`.gitignore` 忽略，是派生输出的落点（有人本地跑一次 projection 就会生成它）。
排除清单在测试里被断言"恰好只有这一项"，防止它慢慢长大。

## 换行符

digest 覆盖原始字节，所以 CRLF 与 LF 是**不同**内容。仓库根的
`.git/config` 有 repo-local 的 `core.autocrlf=false` / `core.eol=lf`；这不是
风格偏好，是让 13 个字节精确测试在 Windows 上不假失败的前提。克隆后如果这两项
没生效，本目录的锁会整体失败——那是配置问题，不要靠改 fixture 去"修"。
