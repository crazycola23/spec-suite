import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { blankComments, buildImportGraph, checkArchitecture, findCycles, staticSpecifiers } from './check-architecture.mjs'

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
    if (file.startsWith('src/truth/')) {
      for (const e of edges) {
        assert.ok(!e.startsWith('src/control/'), `${file} → ${e}：truth 不能依赖 control`)
      }
    }
  }
})
