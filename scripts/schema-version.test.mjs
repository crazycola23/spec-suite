#!/usr/bin/env node
/**
 * 版本策略与迁移注册表的测试。
 *
 * 重点不是「1 能通过」，而是四条 fail-closed 性质：
 *   - 缺版本永不产生「通过 + 版本=current」的判定（这是原来的隐藏 fallback）
 *   - 未来未知版本一律拒绝，且文案明说不猜测
 *   - 未注册的迁移一律不支持，绝不退化成恒等迁移
 *   - 未注册的 kind 是 throw，不是静默通过
 *
 * 前三条对**每一个**已注册 kind 穷举，而不是抽样一个 —— 新加一行策略
 * 就自动被覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SCHEMA_POLICY, VERDICT, assertSchemaVersion, checkSchemaVersion, schemaVersionHint } from '../src/shared/schema-version.mjs'
import { MIGRATIONS, migrationKey, planMigration } from '../migrations/index.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KINDS = Object.keys(SCHEMA_POLICY)

/** 按 versionPath 造一份最小文档。 */
function docWith(kind, version) {
  const keys = SCHEMA_POLICY[kind].versionPath
  const doc = {}
  let node = doc
  for (const k of keys.slice(0, -1)) { node[k] = {}; node = node[k] }
  node[keys[keys.length - 1]] = version
  return doc
}

// ---------------------------------------------------------------------------
// 策略表自身的完整性
// ---------------------------------------------------------------------------

test('策略表每一行都自洽（新加一行若写坏会在这里红）', () => {
  assert.ok(KINDS.length > 0, '策略表不能是空的')
  for (const kind of KINDS) {
    const p = SCHEMA_POLICY[kind]
    assert.ok(Number.isInteger(p.current) && p.current >= 1, `${kind}.current 必须是 ≥1 的整数`)
    assert.ok(Array.isArray(p.supported) && p.supported.length > 0, `${kind}.supported 不能为空`)
    assert.ok(p.supported.includes(p.current), `${kind}.current 必须在 supported 里`)
    assert.ok(p.supported.every((v) => Number.isInteger(v) && v >= 1), `${kind}.supported 只能是 ≥1 的整数`)
    assert.ok(p.supported.every((v) => v <= p.current), `${kind}.supported 不能含高于 current 的版本`)
    assert.ok(Array.isArray(p.deprecated), `${kind}.deprecated 必须是数组`)
    for (const v of p.deprecated) {
      assert.ok(p.supported.includes(v), `${kind} 把 ${v} 标为 deprecated 却不在 supported 里 —— 该用 unsupported`)
    }
    assert.ok(!p.deprecated.includes(p.current), `${kind} 不能把 current 标为 deprecated`)
    assert.equal(typeof p.requiredNow, 'boolean', `${kind}.requiredNow 必须是布尔`)
    assert.equal(p.migrationDirection, 'forward-only', `${kind}.migrationDirection 目前只支持 forward-only`)
    assert.ok(Array.isArray(p.versionPath) && p.versionPath.length > 0, `${kind}.versionPath 不能为空`)
    assert.ok(typeof p.label === 'string' && p.label.length > 0, `${kind}.label 必须非空`)
  }
})

test('dictionary 的版本字段在 meta 下，不在顶层（buildModel 会拒绝顶层非数组键）', () => {
  assert.deepEqual(SCHEMA_POLICY.dictionary.versionPath, ['meta', 'schemaVersion'])
  // 放顶层不算数
  assert.equal(checkSchemaVersion('dictionary', { schemaVersion: 1 }).status, VERDICT.MISSING)
  assert.equal(checkSchemaVersion('dictionary', { meta: { schemaVersion: 1 } }).status, VERDICT.OK)
})

// ---------------------------------------------------------------------------
// fail-closed 性质，对全部 kind 穷举
// ---------------------------------------------------------------------------

test('当前版本通过（全部 kind）', () => {
  for (const kind of KINDS) {
    const v = checkSchemaVersion(kind, docWith(kind, SCHEMA_POLICY[kind].current))
    assert.equal(v.status, VERDICT.OK, `${kind} 的 current 应当通过`)
    assert.equal(v.severity, 'ok')
    assert.equal(v.migration, null)
  }
})

test('缺版本永不变成 current —— 隐藏 fallback 的回归锁（全部 kind）', () => {
  for (const kind of KINDS) {
    for (const doc of [{}, { meta: {} }, docWith(kind, undefined), docWith(kind, null)]) {
      const v = checkSchemaVersion(kind, doc)
      assert.equal(v.status, VERDICT.MISSING, `${kind}: ${JSON.stringify(doc)} 应判 missing`)
      assert.equal(v.version, null, `${kind}: 缺版本时 version 必须是 null，绝不能是 ${v.expected}`)
      assert.notEqual(v.severity, 'ok', `${kind}: 缺版本不能算通过`)
      assert.equal(v.severity, SCHEMA_POLICY[kind].requiredNow ? 'error' : 'warn')
    }
  }
})

test('未来未知版本一律拒绝，且明说不猜测（全部 kind）', () => {
  for (const kind of KINDS) {
    const future = SCHEMA_POLICY[kind].current + 1
    for (const v of [future, future + 97]) {
      const r = checkSchemaVersion(kind, docWith(kind, v))
      assert.equal(r.status, VERDICT.FUTURE, `${kind} 版本 ${v} 应判 future`)
      assert.equal(r.severity, 'error')
      assert.match(r.detail, /不猜测/, `${kind}: future 的说明必须明确写不猜测`)
      assert.match(r.detail, /不支持/, `${kind}: future 的说明必须明确写不支持`)
    }
  }
})

test('非 ≥1 整数一律拒绝（全部 kind）', () => {
  for (const kind of KINDS) {
    for (const bad of ['1', 1.5, 0, -1, true, [], {}, NaN, Infinity, '']) {
      const r = checkSchemaVersion(kind, docWith(kind, bad))
      assert.equal(r.severity, 'error', `${kind}: ${JSON.stringify(bad)} 应当报错`)
      assert.ok(
        r.status === VERDICT.NOT_INTEGER || r.status === VERDICT.MISSING,
        `${kind}: ${JSON.stringify(bad)} 得到意外 status ${r.status}`)
    }
  }
})

test('未注册的 kind 是 throw，不是静默通过', () => {
  assert.throws(() => checkSchemaVersion('no-such-kind', { schemaVersion: 1 }), /未注册的 schema kind/)
  assert.throws(() => assertSchemaVersion('no-such-kind', { schemaVersion: 1 }), /未注册的 schema kind/)
})

test('历史文案逐字保留 —— 现有测试按它断言', () => {
  assert.equal(
    checkSchemaVersion('agent-entry', { schemaVersion: 2 }).message,
    'Agent Entry Contract 的 `schemaVersion` 必须是 1')
  assert.equal(
    checkSchemaVersion('unresolved-registry', { schemaVersion: 2 }).message,
    'unresolved registry 必须是 schemaVersion 1 且包含 facts 数组')
  assert.equal(
    checkSchemaVersion('generated-manifest', { schemaVersion: 2 }).message,
    'generated manifest 必须是 schemaVersion 1 且包含 outputs 数组')
  // control-plane 的文案由 label 参数化
  assert.equal(
    checkSchemaVersion('control-plane-document', { schemaVersion: 2 }, { label: 'lease' }).message,
    'lease.schemaVersion must be 1')
})

test('assertSchemaVersion 只在 error 时 throw，warn 不 throw', () => {
  assert.throws(() => assertSchemaVersion('agent-entry', { schemaVersion: 99 }),
    /Agent Entry Contract 的 `schemaVersion` 必须是 1/)
  // dictionary 的 requiredNow=false，缺字段只是 warn
  const v = assertSchemaVersion('dictionary', {})
  assert.equal(v.severity, 'warn')
  assert.equal(v.status, VERDICT.MISSING)
  // throw 出来的错误要带上完整判定，便于调用方做 provenance
  try {
    assertSchemaVersion('agent-entry', { schemaVersion: 99 })
    assert.fail('应当 throw')
  } catch (e) {
    assert.equal(e.schemaVerdict.status, VERDICT.FUTURE)
    assert.equal(e.schemaVerdict.version, 99)
  }
})

test('抛出的 message 保持单行简短，解释只走 schemaVersionHint（分层锁）', () => {
  // 为什么锁这条：`message` 会流进结构化数据 —— control-plane-ipc.mjs:10 把它
  // 放进 JSONL 的 error 字段，两个 daemon 写进 stderr 的 readiness 行，denial
  // provenance 也依赖它稳定。谁要是「顺手」把 detail 拼进 message，provenance
  // 就变成随文案漂移的自由文本，且 JSONL 里会出现转义换行。
  for (const kind of KINDS) {
    const cur = SCHEMA_POLICY[kind].current
    let thrown = null
    try { assertSchemaVersion(kind, docWith(kind, cur + 1)) } catch (e) { thrown = e }
    assert.ok(thrown, `${kind}: 未来版本应当 throw`)
    assert.ok(!thrown.message.includes('\n'),
      `${kind}: message 必须单行，实际含换行：${JSON.stringify(thrown.message)}`)
    assert.ok(!thrown.message.includes('不猜测'),
      `${kind}: detail 不允许拼进 message —— 它要流进 JSONL 与 provenance`)
    // 解释必须确实可取到，否则这条锁就成了「鼓励不解释」
    const hint = schemaVersionHint(thrown)
    assert.match(hint, /不猜测/, `${kind}: hint 里必须明说不猜测`)
    assert.match(hint, /升级工具/, `${kind}: hint 要指向升级工具，而不是降级文档`)
  }
})

test('schemaVersionHint 对非版本错误返回空串，调用方可以无条件拼接', () => {
  for (const notVersion of [new Error('随便一个错'), null, undefined, {}, { schemaVerdict: {} },
    { schemaVerdict: { detail: null } }, { schemaVerdict: { detail: '   ' } }]) {
    assert.equal(schemaVersionHint(notVersion), '')
  }
  // ok 判定不 throw，也不该有提示可打印
  assert.equal(
    schemaVersionHint({ schemaVerdict: checkSchemaVersion('agent-entry', { schemaVersion: 1 }) }), '')
})

// ---------------------------------------------------------------------------
// 迁移注册表：空 + fail-closed（D7）
// ---------------------------------------------------------------------------

test('注册表当前为空 —— 空是有意的，不是待办', () => {
  assert.deepEqual(MIGRATIONS, {}, 'MIGRATIONS 应当为空；加迁移时请连带更新 README 的四步')
})

test('未注册的迁移一律不支持，绝不退化成恒等迁移（全部 kind）', () => {
  for (const kind of KINDS) {
    const cur = SCHEMA_POLICY[kind].current
    for (const [from, to] of [[1, 2], [cur, cur + 1], [1, 99], [2, 3]]) {
      const r = planMigration(kind, from, to)
      assert.equal(r.supported, false, `${kind} ${from}→${to} 不该被支持`)
      assert.equal(r.migrate, undefined, `${kind} ${from}→${to} 不该返回可执行的迁移函数`)
      assert.ok(r.reason, '不支持时必须给出原因')
      assert.equal(r.key, migrationKey(kind, from, to))
    }
  }
})

test('迁移方向是 forward-only：降级被拒绝', () => {
  const r = planMigration('agent-entry', 2, 1)
  assert.equal(r.supported, false)
  assert.match(r.reason, /forward-only/)
  assert.match(r.reason, /降级/)
})

test('同版本不是迁移', () => {
  const r = planMigration('agent-entry', 1, 1)
  assert.equal(r.supported, false)
  assert.match(r.reason, /不是迁移/)
})

test('未注册 kind / 非法版本号的迁移请求被拒绝', () => {
  assert.equal(planMigration('no-such-kind', 1, 2).supported, false)
  assert.match(planMigration('no-such-kind', 1, 2).reason, /未注册的 schema kind/)
  for (const [from, to] of [[0, 1], [1.5, 2], ['1', 2], [1, null]]) {
    const r = planMigration('agent-entry', from, to)
    assert.equal(r.supported, false, `${JSON.stringify(from)}→${JSON.stringify(to)} 应被拒绝`)
    assert.match(r.reason, /整数/)
  }
})

test('空注册表下不存在任何被支持的迁移 —— 穷举 1..5 的全部组合', () => {
  for (const kind of KINDS) {
    for (let from = 1; from <= 5; from++) {
      for (let to = 1; to <= 5; to++) {
        assert.equal(planMigration(kind, from, to).supported, false,
          `空注册表下 ${kind} ${from}→${to} 竟然被支持`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 仓库级：版本默认值不得以 `?? ` 形式回来
// ---------------------------------------------------------------------------

test('全仓库没有 schemaVersion 的 `??` 默认值（隐藏 fallback 的源级锁）', () => {
  // 本文件自己要跳过：上面那行标题里就带着字面的 `??`，扫自己必然自命中。
  // 只跳这一个文件，其余测试文件照样在扫描范围内。
  const self = fileURLToPath(import.meta.url)
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (!e.name.endsWith('.mjs') || abs === self) continue
      const src = fs.readFileSync(abs, 'utf8')
      src.split('\n').forEach((line, i) => {
        // 只查版本相关的 ?? 默认值；loadConfig 的配置默认值按 D13 保留
        if (/schemaVersion[^\n]*\?\?/.test(line) || /\?\?[^\n]*schemaVersion/.test(line)) {
          offenders.push(`${path.relative(REPO, abs).split(path.sep).join('/')}:${i + 1}  ${line.trim()}`)
        }
      })
    }
  }
  for (const root of ['src', 'scripts', 'migrations']) {
    const abs = path.join(REPO, root)
    if (fs.existsSync(abs)) walk(abs)
  }
  assert.deepEqual(offenders, [], `版本号不允许有 ?? 默认值：\n${offenders.join('\n')}`)
})
