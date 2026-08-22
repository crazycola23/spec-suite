// registry 的自证测试。
//
// 这个文件存在的理由，比它测的东西更重要：**registry 是一份关于代码的断言**
// （"这条规则由 check 3 强制"、"check 1 实现在这三个文件里"）。断言写在
// 数据里不会自动成真。若没人核对，registry 就退化成第七份手抄副本 ——
// 而且是最危险的那份，因为它看起来像权威。
//
// 所以这里测的不是"registry 语法正确"，而是：
//   1. 它对代码的每条断言都能在代码里被找到（双向：声明的模块真的发那个
//      check id；发 check id 的模块真的被声明了）
//   2. 它对文档的每条断言都能在文档里被找到（生成区逐字节 + 边界句逐字）
//   3. 它的校验器**真的会拦下坏数据**（用合成的坏记录反证，否则校验器与
//      `return []` 无从区分）

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CHECKS, DEFAULT_SCHEMA_KIND, ENFORCEMENT, INVARIANTS,
  checkById, checkIds, checkNames, groupByEnforcement, invariantsOfKind, validateRegistry,
} from '../registry/invariants.mjs'
import { SCHEMA_POLICY } from '../src/shared/schema-version.mjs'
import { blankComments } from './check-architecture.mjs'
import { maskFences, planDocs, ZONE_RENDERERS, DOC_TARGETS } from './render-docs.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

test('registry 通过自身的结构校验', () => {
  assert.deepEqual(validateRegistry(), [])
})

// ---------------------------------------------------------------------------
// 对代码的断言
// ---------------------------------------------------------------------------

/**
 * 一个文件里出现的 check id —— 只认 `col.add(N,` / `col.stat(N,` 这两种真实
 * 发出点。先剥注释，否则注释里提到的编号会被当成实现证据（那正好是"文档说
 * 有、代码其实没有"的形状）。
 */
function emittedCheckIds(src) {
  const clean = blankComments(src)
  const ids = new Set()
  for (const m of clean.matchAll(/\bcol\s*\.\s*(?:add|stat)\s*\(\s*(\d+)\s*,/g)) ids.add(Number(m[1]))
  return ids
}

test('CHECKS[].modules 里的文件都存在，且真的发出那个 check id', () => {
  for (const c of CHECKS) {
    for (const rel of c.modules) {
      const abs = path.join(REPO, rel)
      assert.ok(fs.existsSync(abs), `check ${c.id} 声明的模块不存在：${rel}`)
      const ids = emittedCheckIds(fs.readFileSync(abs, 'utf8'))
      assert.ok(
        ids.has(c.id),
        `${rel} 被登记为 check ${c.id}（${c.name}）的实现，但文件里没有任何 col.add(${c.id}, …) / col.stat(${c.id}, …)。`
        + `registry 对代码的断言必须能在代码里被找到，否则它就是一份看起来权威的猜测。`,
      )
    }
  }
})

test('反向：发出 check id 的模块都被登记在 CHECKS[].modules 里', () => {
  // 这条锁的是"新增实现却忘了登记"。缺了它，registry 只能保证"声明的是真的"，
  // 不能保证"真的都被声明" —— 于是 CHECKS[].modules 会慢慢变成过时的子集。
  const declared = new Map(CHECKS.map((c) => [c.id, new Set(c.modules)]))
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) return walk(abs)
    return e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') ? [abs] : []
  })

  for (const abs of walk(path.join(REPO, 'src'))) {
    const rel = path.relative(REPO, abs).split(path.sep).join('/')
    for (const id of emittedCheckIds(fs.readFileSync(abs, 'utf8'))) {
      const set = declared.get(id)
      assert.ok(set, `${rel} 发出了 check ${id}，但 registry 的 CHECKS 里没有这个 id`)
      assert.ok(
        set.has(rel),
        `${rel} 发出 col.add(${id}, …) 却没被登记进 CHECKS[${id}].modules。`
        + `新增一处实现就要在 registry 里登记 —— 这是让 registry 保持完整的唯一办法。`,
      )
    }
  }
})

test('machine-enforced 的 evidence 路径都存在', () => {
  for (const r of INVARIANTS) {
    for (const rel of r.evidence ?? []) {
      assert.ok(fs.existsSync(path.join(REPO, rel)), `${r.id} 的 evidence 指向不存在的文件：${rel}`)
    }
  }
})

test('report 的小节名与顺序完全由 registry 决定', () => {
  // diagnostics/report.mjs 从这两个函数派生小节；这里锁住它们的形状，
  // 顺便证明"七类检查"这个数字没有被悄悄改变。
  assert.deepEqual(checkIds(), [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(checkNames(), {
    1: 'schema 符合性',
    2: '状态机闭合',
    3: 'ID 引用完整性',
    4: '两区制比对',
    5: 'N-xx 禁令覆盖',
    6: '禁止复制中文标签',
    7: '覆盖矩阵完整性',
  })
  assert.equal(checkById(4).name, '两区制比对')
  assert.equal(checkById(99), null)
})

// ---------------------------------------------------------------------------
// 对文档的断言
// ---------------------------------------------------------------------------

test('文档生成区与 registry 逐字节一致', () => {
  const { problems, files } = planDocs(REPO)
  assert.deepEqual(problems, [])
  const drifted = files.filter((f) => f.changed).map((f) => f.file)
  assert.deepEqual(
    drifted, [],
    `这些文件的生成区与 registry 不一致：${drifted.join(', ')}。`
    + `改 registry/invariants.mjs，然后跑 node scripts/render-docs.mjs --write —— 不要手改生成区。`,
  )
})

test('每个 boundary 的规范句逐字出现在它声明的文档里', () => {
  // 设计边界的 canonical 文本在 README（人读的入口），registry 只负责上 id
  // 与分类。两边都存着同一句话，所以必须有一条锁 —— 否则"只改一边"就是
  // 静默漂移，而这类漂移正是 registry 要消灭的东西。
  //
  // 比对首段（第一个 `；` 之前）：registry 允许在句末补充说明，但开头那句
  // 必须与文档逐字相同。
  const boundaries = invariantsOfKind('boundary')
  assert.ok(boundaries.length >= 5, 'boundary 记录不该凭空变少')
  for (const r of boundaries) {
    const head = r.statement.split('；')[0]
    const docs = r.docRefs.map((d) => d.split(/\s/)[0]).filter((f) => f.endsWith('.md'))
    assert.ok(docs.length > 0, `${r.id} 的 docRefs 里没有可定位的 .md 文件`)
    const hit = docs.some((f) => fs.existsSync(path.join(REPO, f)) && read(f).includes(head))
    assert.ok(
      hit,
      `${r.id} 的规范句在 ${docs.join(' / ')} 里找不到：\n  ${head}\n`
      + `registry 与文档存着同一句话，两者必须逐字一致；改一边就要改另一边。`,
    )
  }
})

test('N-01～N-04 的 id 与 DISCIPLINES 的命名空间一致', () => {
  const bans = invariantsOfKind('ban')
  assert.deepEqual(bans.map((r) => r.id), ['N-01', 'N-02', 'N-03', 'N-04'])
  for (const r of bans) assert.match(r.id, /^N-\d{2}$/)
})

// ---------------------------------------------------------------------------
// 围栏屏蔽：render-docs 正确性的关键前提
// ---------------------------------------------------------------------------

test('围栏里的生成区标记被当作示例，不被当作真标记', () => {
  // SCHEMA.md 里有一段 ```markdown 围栏，内容是"标记长什么样"的示例。
  // 若屏蔽失效，planDocs 会把它报成"未登记的生成区 agent-entry.common" ——
  // 也就是说上面那条 planDocs 测试同时是这条屏蔽逻辑的回归锁。这里再直接
  // 测一次原语，避免将来有人改了 SCHEMA.md 就悄悄失去覆盖。
  const src = [
    '<!-- BEGIN GENERATED: real -->',
    'body',
    '<!-- END GENERATED: real -->',
    '```markdown',
    '<!-- BEGIN GENERATED: example -->',
    '<!-- END GENERATED: example -->',
    '```',
  ]
  const masked = maskFences(src)
  assert.equal(masked.unclosed, null)
  assert.equal(masked.lines.length, src.length, '屏蔽必须保留行数，否则下标对不上')
  assert.deepEqual(masked.lines.slice(0, 3), src.slice(0, 3))
  assert.deepEqual(masked.lines.slice(3), ['', '', '', ''])
})

test('未闭合的围栏被报出来，而不是静默吞掉文件剩余部分', () => {
  const masked = maskFences(['a', '```', 'b', '<!-- BEGIN GENERATED: x -->'])
  assert.equal(masked.unclosed, 2)
})

test('~~~ 围栏与更长的 ``` 围栏都被识别', () => {
  assert.deepEqual(maskFences(['~~~', 'x', '~~~', 'after']).lines, ['', '', '', 'after'])
  // 内层的三反引号不该闭合外层的四反引号。
  assert.deepEqual(maskFences(['````', '```', '````', 'after']).lines, ['', '', '', 'after'])
})

// ---------------------------------------------------------------------------
// 版本与取值集合
// ---------------------------------------------------------------------------

test('ENFORCEMENT 恰好是四分法，取值冻结', () => {
  // trust-report 按这四类分组。悄悄加第五类会让新类别从报告里消失 ——
  // 那是"未覆盖的东西看起来已覆盖"，正是四分法要防的误读。
  assert.deepEqual(ENFORCEMENT, {
    MACHINE: 'machine-enforced',
    TRUSTED: 'trusted-assertion',
    EXTERNAL: 'external-assumption',
    NOT_PROVEN: 'not-proven',
  })
  const used = new Set(INVARIANTS.map((r) => r.enforcement))
  for (const v of used) assert.ok(Object.values(ENFORCEMENT).includes(v), `用了四分法之外的取值：${v}`)
})

test('registry 声明的 schemaVersion 不超过它那类 artifact 的 current', () => {
  // 按 schemaKind 分别比对，不是一律拿 dictionary 的 current 当上限：V2 记录
  // 用的是 control-plane-document，两类将来会各自演进。写死一类会让另一类的
  // 越界声明从这条断言里溜过去。
  for (const r of INVARIANTS) {
    const kind = r.schemaKind ?? DEFAULT_SCHEMA_KIND
    const policy = SCHEMA_POLICY[kind]
    assert.ok(
      policy,
      `${r.id} 的 schemaKind \`${kind}\` 不在 SCHEMA_POLICY 里 —— `
      + `registry 不能为不存在的 artifact 类别声明规则`,
    )
    for (const v of r.schemaVersions) {
      assert.ok(Number.isInteger(v) && v >= 1, `${r.id} 的 schemaVersions 含非法值：${v}`)
      assert.ok(
        v <= policy.current,
        `${r.id} 声称适用于 ${kind} schemaVersion ${v}，但工具当前只到 ${policy.current} —— `
        + `不为还不存在的版本预先声明规则（那就是 invent unknown fact）`,
      )
    }
  }
})

test('四分法分组是划分：不重、不漏、无 unclassified', () => {
  // trust-report 直接消费这个分组。少一条会让某条规则从报告里静默消失，
  // 而报告的读者没有任何办法察觉 —— 所以在 registry 侧也锁一次。
  const { groups, unclassified } = groupByEnforcement()
  assert.deepEqual(unclassified, [], '有记录落在四分法之外，它会从 trust-report 的每一节里消失')
  assert.deepEqual(
    Object.keys(groups).sort(), Object.values(ENFORCEMENT).slice().sort(),
    '分组的键必须恒定是四类 —— 空类别本身就是信息，不能被省略',
  )
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0)
  assert.equal(total, INVARIANTS.length)
  const ids = Object.values(groups).flat().map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不得跨组重复')
})

test('每条记录都写了 residualRisk，且不是敷衍占位', () => {
  // 这是 registry 携带的、别处不存在的信息：代码说自己做了什么，从不说
  // 自己**没**做什么。允许占位就等于允许把这一列糊过去。
  const cheap = new Set(['无', '没有', '暂无', '待补', 'TODO', 'TBD', 'N/A', '-', '—'])
  const lazy = INVARIANTS.filter(
    (r) => typeof r.residualRisk !== 'string'
      || cheap.has(r.residualRisk.trim())
      || r.residualRisk.trim().length < 8,
  )
  assert.deepEqual(
    lazy.map((r) => r.id), [],
    '写不出残余风险通常意味着还没核对过强制点，而不是意味着风险为零',
  )
})

test('每条记录的 docRefs 指向真实存在的文件', () => {
  const missing = []
  for (const r of INVARIANTS) {
    for (const ref of r.docRefs) {
      // docRefs 的形状是 `<文件> <小节>`，例如 `SCHEMA.md §1`、
      // `control-plane/README.md Isolated daemon boundary`。取第一个空白前的
      // token 当路径；`#anchor` / `:line` 后缀一并剥掉。
      const file = ref.split(/\s+/)[0].split('#')[0].split(':')[0]
      if (!fs.existsSync(path.join(REPO, file))) missing.push(`${r.id} → ${file}`)
    }
  }
  assert.deepEqual(missing, [], 'docRefs 悬空 —— 引用不存在的文档等于没有 docRefs')
})

// ---------------------------------------------------------------------------
// 反证：校验器与生成器真的会拦下坏数据
// ---------------------------------------------------------------------------

const OK = {
  id: 'X-OK', kind: 'invariant', title: 't', statement: 's',
  severity: 'error', schemaVersions: [1],
  enforcement: ENFORCEMENT.MACHINE, checks: [1],
  residualRisk: '这条 fixture 的残余风险占位', docRefs: ['README.md'],
}
const has = (problems, needle) => problems.some((p) => p.includes(needle))

test('校验器拦下：非 machine-enforced 却挂了 check', () => {
  const p = validateRegistry([{ ...OK, enforcement: ENFORCEMENT.TRUSTED, severity: null, checks: [1] }], CHECKS)
  assert.ok(has(p, '有机器强制就该标 machine-enforced'), p.join(' | '))
})

test('校验器拦下：machine-enforced 却既无 check 也无 evidence', () => {
  // 这是最重要的一条：一条谁都验不了的 machine-enforced 比不写更糟，
  // 因为它让读的人以为已经覆盖。
  const p = validateRegistry([{ ...OK, checks: [] }], CHECKS)
  assert.ok(has(p, '不可证伪的断言'), p.join(' | '))
})

test('校验器接受：machine-enforced 无 check 但有 evidence', () => {
  const p = validateRegistry([{ ...OK, checks: [], evidence: ['scripts/project-context.mjs'] }], CHECKS)
  assert.deepEqual(p, [])
})

test('校验器拦下：非 machine-enforced 却编造 severity', () => {
  const p = validateRegistry([{ ...OK, enforcement: ENFORCEMENT.NOT_PROVEN, checks: [], severity: 'error' }], CHECKS)
  assert.ok(has(p, '不编造严重度'), p.join(' | '))
})

test('校验器拦下：machine-enforced 缺 severity', () => {
  const p = validateRegistry([{ ...OK, severity: null }], CHECKS)
  assert.ok(has(p, '没有 severity'), p.join(' | '))
})

test('校验器拦下：指向不存在的 check、重复 id、四分法之外的取值、缺 docRefs', () => {
  assert.ok(has(validateRegistry([{ ...OK, checks: [42] }], CHECKS), '不存在的 check 42'))
  assert.ok(has(validateRegistry([OK, OK], CHECKS), '记录 id 重复：X-OK'))
  assert.ok(has(validateRegistry([{ ...OK, enforcement: 'sort-of' }], CHECKS), '不在四分法里'))
  assert.ok(has(validateRegistry([{ ...OK, docRefs: [] }], CHECKS), '没有 docRefs'))
  assert.ok(has(validateRegistry([{ ...OK, statement: '  ' }], CHECKS), 'statement 为空'))
  assert.ok(has(validateRegistry([{ ...OK, schemaVersions: [] }], CHECKS), '没有声明适用的 schemaVersions'))
})

test('校验器拦下：缺 residualRisk 或写成空白', () => {
  // residualRisk 是必填的，理由见 registry 文件头：一份只复述规则的 registry
  // 迟早变成第 N 份副本。这条断言保证"没写"会被拦下，而不是渲染成空白单元格。
  for (const bad of [{}, { residualRisk: '' }, { residualRisk: '   ' }, { residualRisk: null }]) {
    const r = { ...OK, ...bad }
    if (!('residualRisk' in bad)) delete r.residualRisk
    assert.ok(has(validateRegistry([r], CHECKS), '缺 residualRisk'), JSON.stringify(bad))
  }
})

test('校验器拦下：schemaKind 写成空字符串', () => {
  assert.ok(has(validateRegistry([{ ...OK, schemaKind: '' }], CHECKS), 'schemaKind 不是非空字符串'))
})

test('校验器拦下坏 CHECKS：缺实现模块、id 重复', () => {
  const bad = [{ id: 1, name: 'n', errorMeaning: 'e', modules: [] }]
  assert.ok(has(validateRegistry([], bad), '没有列出实现模块'))
  const dup = [{ id: 1, name: 'n', errorMeaning: 'e', modules: ['x'] }, { id: 1, name: 'm', errorMeaning: 'f', modules: ['y'] }]
  assert.ok(has(validateRegistry([], dup), 'CHECKS 里 id 重复'))
})

test('render-docs 拒绝在 registry 有问题时渲染', () => {
  // 顺序很重要：先自检 registry，再动文档。反过来会把错误固化进 canonical 文本。
  const src = read('scripts/render-docs.mjs')
  assert.match(src, /validateRegistry\(\)\.map/, 'planDocs 必须先跑 validateRegistry')
  assert.match(src, /if \(problems\.length > 0\) return 1/, '有结构性问题时必须直接退出，不能被 --write 盖过去')
})

test('每个渲染器都有文档区消费，每个文档区都有渲染器', () => {
  const declared = new Set(DOC_TARGETS.flatMap((t) => t.zones))
  assert.deepEqual([...declared].sort(), Object.keys(ZONE_RENDERERS).sort())
})
