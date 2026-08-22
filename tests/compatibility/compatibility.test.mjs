// 兼容性回归：冻结语料 → 当前工具。
//
// 这个文件回答三个问题，且只回答这三个：
//   1. 写于过去的文档，今天的工具还读得懂吗（accepted）
//   2. 派生物今天重新生成，还是同样的字节吗（derived stays reproducible）
//   3. 遇到未来未知版本，工具是拒绝，还是猜（fail-closed）
//
// 它**不**回答「一套好套件长什么样」——那是 templates/L0/example 与
// check-spec-suite.test.mjs 的职责。见 fixtures/README.md。
//
// 为什么断言常量写死在这个文件里而不是放进 fixtures/：
// 期望值属于断言，不属于语料。把它塞进 fixtures/ 会让语料自己声明自己正确，
// 那样锁就自证了 —— 改语料的人顺手改掉期望值，锁一声不响地通过。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { jsonDigest } from '../../scripts/control-plane-common.mjs'
import { projectContext } from '../../scripts/project-context.mjs'
import { planMigration, MIGRATIONS } from '../../migrations/index.mjs'
import { SCHEMA_POLICY, VERDICT, checkSchemaVersion } from '../../src/shared/schema-version.mjs'

// 搬到 tests/compatibility/ 之后，原来那个 `HERE` 的两种用法（scripts 目录 /
// 仓库根的下一级）不再重合，所以拆成两个显式常量，不留 HERE。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = path.join(REPO_ROOT, 'scripts')
const FIXTURES = path.join(REPO_ROOT, 'fixtures')
const CHECKER = path.join(SCRIPTS, 'check-spec-suite.mjs')
const GENERATOR = path.join(SCRIPTS, 'generate-contract-bundle.mjs')

// ---------------------------------------------------------------------------
// 冻结的期望值
// ---------------------------------------------------------------------------

// fixtures/v2 是 control-plane/ 的逐字节复制，所以这两个值与 canonical-state.json
// 里存着的值相同 —— 断言它们「仍然相同」就是断言复制没有破坏 digest 有效性。
const V2_CANONICAL_REVISION = 'sha256:ee66d0cbb5a7d82a6cd6a554760064b1e725798fc774e98eb0a7a2b80ae71757'
const V2_GRAPH_DIGEST = 'sha256:f75c433961bc94c440241973801e42b3dd22ef423ca1f45db2a0f9dbe89d0a73'

// projectionDigest 覆盖整个 projection，包括每份 canonical document 的**全文**。
// 冻结这一个数字，等于冻结那 6 份文档的全部字节 —— 而且不用把文档内容再抄一遍。
const V2_PROJECTION_DIGEST = 'sha256:f65cfcfd168728065b862df9633fc2af66b0381a0be55826e70e7bd48bd011ec'

// 默认 projection 不选中 control-plane/README.md（它是图里的节点，但不在
// roots 的闭包里），所以它的字节不被上面那个 digest 覆盖。补一个把它拉进
// documents 的变体，把这个洞堵上。手法与 v2-control-plane.test.mjs:343 一致。
const V2_PROJECTION_DIGEST_WITH_RUNBOOK = 'sha256:1dec2be2be3ddf3c28d5d37af570055e29681ee377e0d5bf82b31b7729d69342'

// 整树锁：fixtures/ 下每个文件的 {path, sha256}，排序后求一个 digest。
// 任何文件任何一个字节变了，这个值就变。更新它的正确流程见 fixtures/README.md
// ——重点是必须在 commit message 里说明「为什么冻结语料需要变」。
const FIXTURES_TREE_DIGEST = 'sha256:090fe526f7553368817295c47e3742583a3dcdac8c39affbb2ab62d97140e76c'

// 唯一被排除在锁外的路径。被复制过来的 .gitignore 忽略它，且它是派生输出的
// 落点（谁在本地跑一次 projection --output 就会生成）。清单被下面的测试断言
// 「恰好只有这一项」，防止它慢慢长大成"什么都能不锁"。
const TREE_LOCK_EXCLUSIONS = ['v2/control-plane/example/generated']

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function walkFiles(root, relative = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (TREE_LOCK_EXCLUSIONS.includes(rel)) continue
    if (entry.isDirectory()) out.push(...walkFiles(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

// 对原始字节做摘要，不经过任何文本归一化。BOM、换行符都必须改变摘要 ——
// 冻结的是字节，不是"看起来一样的内容"。
function fileSha256(absolute) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`
}

// 用码元序排，**不用** localeCompare：后者走 ICU 排序表，不同 Node 构建的
// 结果可能不同，那会让这把锁在别人机器上无故变红。锁必须只对字节负责。
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

function treeInventory() {
  return walkFiles(FIXTURES)
    .map((rel) => ({ path: rel, sha256: fileSha256(path.join(FIXTURES, rel)) }))
    .sort(byPath)
}

function runNode(script, args, { cwd = REPO_ROOT } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function tempCopyOfV1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-compat-'))
  fs.cpSync(path.join(FIXTURES, 'v1'), dir, { recursive: true })
  return dir
}

const v2Projection = (extra = {}) => projectContext({
  specsRoot: path.join(FIXTURES, 'v2'),
  graph: 'control-plane/example/context-graph.json',
  task: 'control-plane/example/task.json',
  state: 'control-plane/example/canonical-state.json',
  policy: 'control-plane/example/issuer-policy.json',
  ...extra,
})

// ---------------------------------------------------------------------------
// 1. 旧语料仍然被接受
// ---------------------------------------------------------------------------

test('frozen v1 corpus is still accepted by the current checker', () => {
  const r = runNode(CHECKER, [
    '--specs-root', 'fixtures/v1',
    '--config', 'fixtures/v1/spec-suite.config.json',
  ])
  assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /缺陷 0 \/ 警告 0/)
})

// ---------------------------------------------------------------------------
// 2. 派生物逐字节可复现
// ---------------------------------------------------------------------------

test('frozen v1 derived artifacts reproduce byte-for-byte', () => {
  const dir = tempCopyOfV1()
  const frozen = {}
  for (const name of ['contract-bundle.json', 'manifest.json']) {
    frozen[name] = fs.readFileSync(path.join(FIXTURES, 'v1', 'generated', name))
  }

  // 先删掉，否则「没重新生成」也能让下面的比对通过 —— 那种绿灯什么也不证明。
  fs.rmSync(path.join(dir, 'generated'), { recursive: true, force: true })
  assert.equal(fs.existsSync(path.join(dir, 'generated')), false)

  const r = runNode(GENERATOR, ['--specs-root', dir, '--config', path.join(dir, 'spec-suite.config.json')])
  assert.equal(r.code, 0, `生成失败：\n${r.stdout}\n${r.stderr}`)

  for (const [name, expected] of Object.entries(frozen)) {
    const actual = fs.readFileSync(path.join(dir, 'generated', name))
    assert.deepEqual(actual, expected, `${name} 与冻结字节不一致 —— 派生物不再可复现`)
  }

  // 冻结的 bundle 必须真的有内容。生成器只跳过 meta/gaps 两个键；若字典里
  // 只剩 gaps，contracts 就是 {}，上面的比对会对着空 artifact 通过。
  const bundle = JSON.parse(frozen['contract-bundle.json'].toString('utf8'))
  assert.ok(Object.keys(bundle.contracts).length > 0, '冻结的 bundle 是空的，这条测试会变空洞')

  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 3. 未来未知版本 —— fail closed
// ---------------------------------------------------------------------------

test('frozen unsupported dictionary version is refused, not guessed', () => {
  const r = runNode(CHECKER, [
    '--specs-root', 'fixtures/schema-unsupported/truth',
    '--config', 'fixtures/schema-unsupported/truth/spec-suite.config.json',
  ])
  assert.equal(r.code, 1, `期望 exit 1，实际 ${r.code}\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /dictionary 的 `meta\.schemaVersion` 是 99，本工具只支持到 1/)
  // 恰好一条缺陷：断言必须指名道姓落在版本上，不能被别的问题顶上。
  assert.match(r.stdout, /缺陷 1 \//)
})

test('frozen unsupported config version stops the checker and writes no report', () => {
  const reportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-compat-')), 'report.md')
  const r = runNode(CHECKER, [
    '--specs-root', 'fixtures/schema-unsupported/truth',
    '--config', 'fixtures/schema-unsupported/truth/config-unsupported.json',
    '--report', reportPath,
  ])
  assert.equal(r.code, 2, `期望 exit 2（无法运行），实际 ${r.code}`)
  assert.match(r.stderr, /检查器无法运行：spec-suite config 的 `schemaVersion` 是 99/)
  // 不猜测 = 也不要留下半份产物。
  assert.equal(fs.existsSync(reportPath), false, '拒绝执行却写了报告 —— 那不是 fail-closed')
  // 文案必须把人指向「升级工具」，而不是字面上的「把版本改成 1」。
  assert.match(r.stderr, /请升级工具，而不是降级文档/)
})

test('frozen unsupported control-plane version is classified as future, not merely "not 1"', () => {
  assert.throws(
    () => projectContext({
      specsRoot: path.join(FIXTURES, 'schema-unsupported', 'control'),
      graph: 'context-graph.json',
      task: 'task.json',
      state: 'canonical-state.json',
      policy: 'issuer-policy.json',
    }),
    (error) => {
      assert.equal(error.message, 'canonical state.schemaVersion must be 1')
      // 关键：不是「不等于 1」，而是被判定为**未来未知**版本。
      assert.equal(error.schemaVerdict.status, VERDICT.FUTURE)
      assert.equal(error.schemaVerdict.version, 99)
      assert.match(error.schemaVerdict.detail, /不猜测其含义/)
      return true
    },
  )
})

test('every registered artifact kind refuses a future version', () => {
  for (const [kind, policy] of Object.entries(SCHEMA_POLICY)) {
    const future = policy.current + 1
    const doc = {}
    let node = doc
    policy.versionPath.forEach((key, index) => {
      if (index === policy.versionPath.length - 1) node[key] = future
      else { node[key] = {}; node = node[key] }
    })
    const v = checkSchemaVersion(kind, doc)
    assert.equal(v.status, VERDICT.FUTURE, `${kind} 没把 ${future} 判成未来未知版本`)
    assert.equal(v.severity, 'error', `${kind} 对未来未知版本不是 error`)
    assert.match(v.detail, /不猜测其含义/, `${kind} 的说明没写明不猜测`)
  }
})

// ---------------------------------------------------------------------------
// 4. 迁移注册表：未注册即不支持
// ---------------------------------------------------------------------------

test('empty migration registry never degrades into an identity migration', () => {
  assert.deepEqual(Object.keys(MIGRATIONS), [], '注册表不再为空 —— 请同时补冻结语料与幂等性测试，见 migrations/index.mjs 文件头')

  const plan = planMigration('dictionary', 1, 2)
  assert.equal(plan.supported, false)
  assert.equal(plan.migrate, undefined, '不支持的迁移却给了 migrate 函数')
  assert.match(plan.reason, /无法证明迁移正确 ⇒ 阻止该动作/)

  // 降级方向也必须被拒（forward-only）。
  const down = planMigration('dictionary', 2, 1)
  assert.equal(down.supported, false)
  assert.match(down.reason, /forward-only/)
})

// ---------------------------------------------------------------------------
// 5. V2 冻结语料
// ---------------------------------------------------------------------------

test('frozen v2 corpus keeps its digests valid after being copied', () => {
  const p = v2Projection()
  // canonicalRevision 是对 canonicalInputs 的**原始字节**求 sha256，并在
  // project-context.mjs:206 重新计算后比对。它仍然等于 canonical-state.json
  // 里存的值，说明整目录复制没有破坏任何 digest —— 复制是纯字节复制。
  assert.equal(p.canonicalRevision, V2_CANONICAL_REVISION)
  assert.equal(p.contextGraphDigest, V2_GRAPH_DIGEST)
  assert.equal(p.projectionDigest, V2_PROJECTION_DIGEST)
  assert.equal(p.leaseEligible, true)
  assert.deepEqual(p.uncertainty, { increased: false, reasons: [] })
})

test('frozen v2 projection is idempotent', () => {
  assert.equal(v2Projection().projectionDigest, v2Projection().projectionDigest)
})

test('frozen v2 runbook variant covers the document the default projection omits', () => {
  const v = v2Projection({ candidateRoots: ['file:operator-runbook'] })
  assert.equal(v.projectionDigest, V2_PROJECTION_DIGEST_WITH_RUNBOOK)
  assert.ok(
    v.documents.some((d) => d.path === 'control-plane/README.md'),
    '变体没把 README.md 拉进 documents —— 它的字节就没被任何 digest 覆盖',
  )
  // 候选 root 只增不减，不该动摇确定性。
  assert.equal(v.leaseEligible, true)
})

// ---------------------------------------------------------------------------
// 6. 整树冻结锁
// ---------------------------------------------------------------------------

test('fixtures tree is frozen', () => {
  const inventory = treeInventory()
  assert.ok(inventory.length > 0, 'fixtures/ 是空的')

  const actual = jsonDigest(inventory)
  if (actual !== FIXTURES_TREE_DIGEST) {
    const lines = inventory.map((e) => `  ${e.sha256}  ${e.path}`).join('\n')
    assert.fail(
      `fixtures/ 下有文件被改动了。\n`
      + `期望树摘要：${FIXTURES_TREE_DIGEST}\n`
      + `实际树摘要：${actual}\n`
      + `冻结语料本不该改动。若这次改动确实必要，请按 fixtures/README.md 的流程：\n`
      + `在 commit message 里写明为什么，然后把上面的「实际树摘要」填回本测试。\n`
      + `当前逐文件清单：\n${lines}`,
    )
  }
})

test('tree lock exclusion list has not grown', () => {
  // 排除清单每多一项，锁就少覆盖一片。所以它自己也要被锁住。
  assert.deepEqual(TREE_LOCK_EXCLUSIONS, ['v2/control-plane/example/generated'])
})
