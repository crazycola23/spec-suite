import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { blankComments, buildImportGraph, checkArchitecture, checkLayers, findCycles, staticSpecifiers } from './check-architecture.mjs'
import { loadAuthorityRecords } from './control-plane-common.mjs'
import { layerOf } from '../src/layers.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('import 图无环，且相对 import 全部解析到真实文件', () => {
  const r = checkArchitecture(repoRoot)
  assert.deepEqual(r.violations, [], `架构违规：\n${r.violations.join('\n')}`)
  assert.ok(r.fileCount > 30, `扫到的文件太少（${r.fileCount}），扫描器可能没工作`)
  assert.ok(r.edgeCount > 40, `扫到的边太少（${r.edgeCount}），扫描器可能没工作`)
})

test('环检测不是空过：合成的环必须被抓到', () => {
  const cycles = findCycles(new Map([
    ['a.mjs', ['b.mjs']],
    ['b.mjs', ['c.mjs']],
    ['c.mjs', ['a.mjs']],
    ['d.mjs', ['a.mjs']],
  ]))
  assert.equal(cycles.length, 1)
  assert.equal(cycles[0][0], cycles[0][cycles[0].length - 1], '环路径首尾必须是同一节点')
  assert.deepEqual([...cycles[0]].slice(0, 3).sort(), ['a.mjs', 'b.mjs', 'c.mjs'])

  // 自环也是环
  assert.equal(findCycles(new Map([['a.mjs', ['a.mjs']]])).length, 1)
  // 无环图必须报 0
  assert.equal(findCycles(new Map([['a.mjs', ['b.mjs']], ['b.mjs', []]])).length, 0)
})

test('扫描器覆盖跨行 import、re-export、裸 import，并忽略注释掉的 import', () => {
  const src = [
    "import fs from 'node:fs'",
    'import {',
    '  alpha,',
    '  beta,',
    "} from './multi-line.mjs'",
    "export { gamma } from './re-export.mjs'",
    "export * from './star.mjs'",
    "export * as ns from './star-ns.mjs'",
    "import './side-effect.mjs'",
    "// import ghost from './commented-out.mjs'",
    "/* import block from './block-comment.mjs' */",
    "const url = 'https://example.com/not-a-comment'",
    "const notAnImport = `from './template.mjs'`",
  ].join('\n')

  const specs = staticSpecifiers(src)
  for (const want of ['node:fs', './multi-line.mjs', './re-export.mjs', './star.mjs', './star-ns.mjs', './side-effect.mjs']) {
    assert.ok(specs.includes(want), `漏掉 specifier：${want}`)
  }
  for (const never of ['./commented-out.mjs', './block-comment.mjs']) {
    assert.ok(!specs.includes(never), `注释里的 import 被当成真实边：${never}`)
  }
})

test('blankComments 保留字符串内容与行号', () => {
  const src = "const a = 'http://x' // tail\n/* two\nlines */\nconst b = 1\n"
  const out = blankComments(src)
  assert.equal(out.split('\n').length, src.split('\n').length, '行数必须不变')
  assert.ok(out.includes("'http://x'"), '字符串里的 // 不能被当注释截断')
  assert.ok(!out.includes('tail'), '行注释必须被清掉')
  assert.ok(!out.includes('two'), '块注释必须被清掉')
})

test('facade 的 re-export 边与跨行 import 边都进了图', () => {
  const { graph, problems } = buildImportGraph(repoRoot)
  assert.deepEqual(problems, [])

  // facade 通过 `export … from` 指向 src/，这类边必须被收进来
  const facade = graph.get('scripts/check-spec-suite.mjs')
  assert.ok(facade, 'facade 不在图里')
  assert.ok(facade.some((e) => e.startsWith('src/')), 'facade 的 re-export 边没被收集')
  assert.ok(facade.includes('src/truth/cli/check.mjs'))

  // 测试文件用的是跨行 `import {`，按行扫会漏
  const unitTest = graph.get('scripts/check-spec-suite.test.mjs')
  assert.ok(unitTest?.includes('scripts/check-spec-suite.mjs'), '跨行 import 边没被收集')
})

test('依赖方向：shared 不许回指上层，truth 不许指向 control', () => {
  const { graph } = buildImportGraph(repoRoot)
  for (const [file, edges] of graph) {
    if (file.startsWith('src/shared/')) {
      for (const e of edges) {
        assert.ok(e.startsWith('src/shared/'), `${file} → ${e}：shared 只能依赖 shared`)
      }
    }
    // 按**层**判定，不按路径前缀。原先这里写的是 `!e.startsWith('src/control/')`
    // —— 而仓库里根本没有 src/control/ 目录（V2 住在 scripts/control-plane-*.mjs），
    // 所以那条断言恒真、什么也没守住。层名来自 src/layers.mjs 的单一声明，
    // 将来 V2 搬家也不会让这条断言重新变空。
    if (layerOf(file) === 'truth' || layerOf(file) === 'truth-cli') {
      for (const e of edges) {
        assert.notEqual(layerOf(e), 'control', `${file} → ${e}：Truth Integrity 不能依赖 Control Plane`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 分层策略（Phase 3）
// ---------------------------------------------------------------------------

test('仓库里每个 .mjs 都有归属层', () => {
  const { graph } = buildImportGraph(repoRoot)
  const unmapped = [...graph.keys()].filter((f) => layerOf(f) === null)
  assert.deepEqual(unmapped, [], `以下文件未归类，请在 src/layers.mjs 里显式归类：\n${unmapped.join('\n')}`)

  // 每一层都真的有文件。某层空掉通常意味着归类规则写错了前缀，
  // 而"全归到一层"照样能让违规数为 0 —— 那种绿灯毫无意义。
  const r = checkArchitecture(repoRoot)
  for (const [layer, n] of Object.entries(r.layerCounts)) {
    assert.ok(n > 0, `层 ${layer} 一个文件都没有 —— FILE_LAYERS 的前缀可能写错了`)
  }
  assert.ok(r.crossEdges.length > 20, `跨层边只有 ${r.crossEdges.length} 条，分层可能被压成了一层`)
})

test('层检查不是空过：三类违规都必须被抓到', () => {
  // 1. 未归类文件
  const unmapped = checkLayers(new Map([['nowhere/thing.mjs', []]]))
  assert.equal(unmapped.violations.length, 1)
  assert.match(unmapped.violations[0], /没有归属层/)

  // 2. 反方向边：truth → control（用户约束的核心）
  const wrongWay = checkLayers(new Map([
    ['src/truth/model/build.mjs', ['scripts/enforce-effect.mjs']],
    ['scripts/enforce-effect.mjs', []],
  ]))
  assert.equal(wrongWay.violations.length, 1)
  assert.match(wrongWay.violations[0], /truth 不允许依赖 control/)

  // 正方向必须仍然放行，否则上面那条只是"两边都禁"
  const rightWay = checkLayers(new Map([
    ['scripts/enforce-effect.mjs', ['src/truth/model/build.mjs']],
    ['src/truth/model/build.mjs', []],
  ]))
  assert.deepEqual(rightWay.violations, [], 'control → truth 是被允许的方向，不该报违规')

  // 3. 入口脚本互相 import
  const cliToCli = checkLayers(new Map([
    ['scripts/guard-unresolved-fact.mjs', ['scripts/migrate-unresolved.mjs']],
    ['scripts/migrate-unresolved.mjs', []],
  ]))
  assert.equal(cliToCli.violations.length, 1)
  assert.match(cliToCli.violations[0], /cli 不允许依赖 cli/)

  // 边指向未归类文件也要报（相对 import 逃出被归类的目录树）
  const escaped = checkLayers(new Map([['src/shared/text.mjs', ['templates/helper.mjs']]]))
  assert.equal(escaped.violations.length, 1)
  assert.match(escaped.violations[0], /import 了未归类的/)
})

test('layerOf 用最长前缀，不用先匹配', () => {
  // src/truth/cli/ 与 src/truth/ 同时匹配；必须选更长的那条。
  assert.equal(layerOf('src/truth/cli/check.mjs'), 'truth-cli')
  assert.equal(layerOf('src/truth/model/build.mjs'), 'truth')
  assert.equal(layerOf('src/layers.mjs'), 'policy')
  assert.equal(layerOf('scripts/check-spec-suite.mjs'), 'facade')
  assert.equal(layerOf('scripts/enforce-effect.mjs'), 'control')
  assert.equal(layerOf('scripts/effect-enforcer-daemon.mjs'), 'cli')
  // 测试文件按后缀归类，与所在目录无关
  assert.equal(layerOf('scripts/v2-control-plane.test.mjs'), 'test')
  // 没有任何规则匹配 ⇒ null，调用方必须当违规处理
  assert.equal(layerOf('scripts/brand-new-script.mjs'), null)
})

test('facade 是唯一的库门面：入口脚本只经它复用库代码', () => {
  const { graph } = buildImportGraph(repoRoot)
  const entries = [...graph.keys()].filter((f) => layerOf(f) === 'cli')
  assert.ok(entries.length >= 6, `入口脚本只找到 ${entries.length} 个`)

  for (const entry of entries) {
    for (const e of graph.get(entry) ?? []) {
      assert.notEqual(layerOf(e), 'cli', `${entry} → ${e}：入口脚本之间不得互相 import`)
    }
  }

  // 四个 V1 脚本确实经由 facade 复用库函数 —— 这条断言让上面那条不至于
  // 在"根本没人复用"的情况下空过。
  for (const v1 of ['generate-contract-bundle', 'guard-unresolved-fact', 'migrate-unresolved', 'verify-consumer-contracts']) {
    assert.ok(
      graph.get(`scripts/${v1}.mjs`)?.includes('scripts/check-spec-suite.mjs'),
      `${v1}.mjs 没经过 facade`,
    )
  }
})

// ---------------------------------------------------------------------------
// V1 / V2 记录形状相互独立（Phase 3）
// ---------------------------------------------------------------------------
//
// 两侧都有一个"未决事实"记录，都叫 gap，必填键却不同。看起来像重复，
// 于是很容易被"顺手合并"。它们不能合并：
//   V1 gaps 描述**规格里的空洞**，要 owner / rollbackCost / protectiveDefault
//     —— 这些是给人看的、要人负责的字段。
//   V2 authority records 描述**授权状态**，要 authorityState /
//     protectiveDefaultSource，且 blocks[] 是 {constraint, effect} 结构，
//     因为 enforcer 要拿它去判定某个 effect 该不该被拦。
// 合并任何一侧都会让另一侧要么放宽（丢掉必填校验），要么收紧（拒绝合法语料）。
//
// 下面三条是**行为**断言而不是文本比对：V2 的必填集合是
// control-plane-common.mjs:192 里的内联字面量，不是导出常量，文本比对会
// 因为换个格式就假失败，而行为断言只对"谁被接受、谁被拒绝"负责。

const V1_GAP = {
  code: 'G-01', missing: '退款截止时间未定', source: 'BR-REFUND-001',
  blocks: ['BR-REFUND-002'], protectiveDefault: '一律拒绝退款', rollbackCost: 'high',
  owner: '平台组', status: 'open',
}

const V2_RECORD = {
  code: 'G-01', missing: '退款截止时间未定', status: 'open',
  authorityState: 'unresolved', protectiveDefaultSource: 'rules.md#refund', blocks: [],
}

function authorityRecordsIn(gaps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-boundary-'))
  fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify({ schemaVersion: 1, gaps }), 'utf8')
  return { dir, state: { authorityRecords: 'facts.json', activeConstraints: [] } }
}

test('V2 拒绝 V1 形状的 gap 记录', () => {
  const { dir, state } = authorityRecordsIn([V1_GAP])
  assert.throws(
    () => loadAuthorityRecords(dir, state),
    /authority records gaps\[0\]\.authorityState must be non-empty/,
    'V1 形状被 V2 接受了 —— 两侧必填集合可能被合并了',
  )
  fs.rmSync(dir, { recursive: true, force: true })
})

test('V2 接受恰好只有自己那 5 个必填键的记录', () => {
  // 这条守的是反方向的合并：若有人把 V1 的 owner / rollbackCost /
  // protectiveDefault 加进 V2 的必填清单，这份合法的 V2 语料就会被拒。
  const { dir, state } = authorityRecordsIn([V2_RECORD])
  const records = loadAuthorityRecords(dir, state)
  assert.equal(records.gaps.length, 1)
  assert.equal(records.gaps[0].code, 'G-01')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('V1 拒绝 V2 形状的 gap 记录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-boundary-'))
  fs.cpSync(path.join(repoRoot, 'fixtures', 'v1'), dir, { recursive: true })

  // 只换掉字典里的 gaps 段，其余（meta / errors）照旧，这样报出来的缺陷
  // 一定来自记录形状，而不是"顺手把套件弄坏了"。
  const dict = path.join(dir, 'contracts', 'dictionary.yaml')
  const original = fs.readFileSync(dict, 'utf8')
  const v2Shaped = [
    'gaps:',
    `  - code: ${V2_RECORD.code}`,
    `    missing: ${V2_RECORD.missing}`,
    `    status: ${V2_RECORD.status}`,
    `    authorityState: ${V2_RECORD.authorityState}`,
    `    protectiveDefaultSource: ${V2_RECORD.protectiveDefaultSource}`,
    '    blocks: []',
    '',
  ].join('\n')
  fs.writeFileSync(dict, original.replace(/\ngaps:[\s\S]*?\n(?=errors:)/, `\n${v2Shaped}`), 'utf8')

  const r = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'check-spec-suite.mjs'),
    '--specs-root', dir, '--config', path.join(dir, 'spec-suite.config.json'),
  ], { cwd: repoRoot, encoding: 'utf8' })

  assert.equal(r.status, 1, `期望 exit 1，实际 ${r.status}\n${r.stdout}\n${r.stderr}`)
  for (const key of ['protectiveDefault', 'rollbackCost', 'owner']) {
    assert.match(r.stdout, new RegExp(`缺必填键 \\\`${key}\\\``), `V1 没要求 \`${key}\` —— 两侧必填集合可能被合并了`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

