#!/usr/bin/env node
/** check-spec-suite.mjs 的单元测试。node --test scripts/check-spec-suite.test.mjs */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readText, globToRegExp, matchesAny, walkFiles,
  makeCollector, loadConfig, buildModel, loadYamlLib,
  checkSchema, checkIdempotencyTuples, checkStateMachines, checkIdRefs,
  ID_TOKEN_RE, extractIdTokens, isDefinitionSite,
  checkZones, checkBanCoverage, checkLabelCopy, collectLabels, scalarValues,
  checkCoverageMatrix, run,
  RENDERERS, resolveProjection, enumerateProjections, findZones,
  parseBanCoverage, renderReportMd,
} from './check-spec-suite.mjs'

import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
// 复用 checker 自己的解析链（本目录 → --specs-root → cwd），失败时给的是那条可执行的
// 错误信息（`npm i yaml@^2`），而不是裸的 ERR_MODULE_NOT_FOUND。本 skill 目录**不签入**
// node_modules，所以跑测试前先在 skill 根执行一次 `npm i`。
const YAML = await loadYamlLib(path.join(HERE, '..'))

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-test-'))
}

/** 在临时目录里搭一个最小规格库。 */
function buildFixture(files) {
  const root = tmpDir()
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return root
}

const BASE_CONFIG = {
  dictionaries: ['contracts/dictionary.yaml', 'contracts/errors.yaml'],
  generatedDir: 'generated',
  claudeMd: 'CLAUDE.md',
  idNamespaces: [
    { prefix: 'BR', pattern: '^BR-[A-Z]+-\\d{3}$', kind: 'rule', definedIn: ['10-why/02-*.md'] },
    { prefix: 'G', pattern: '^G-\\d{2}$', kind: 'gap', definedIn: ['contracts/dictionary.yaml'] },
    { prefix: 'N', pattern: '^N-\\d{2}$', kind: 'ban', definedIn: ['CLAUDE.md'] },
    { prefix: 'RL', pattern: '^RL-\\d{2}$', kind: 'redline', definedIn: ['contracts/errors.yaml'] },
  ],
  projections: {
    'stateMachines.*.transitions': 'transitionTable',
    'enums.*.values': 'enumTable',
    'errors': 'errorTable',
    'gaps': 'gapTable',
  },
  structuredFileGlobs: ['**/*.yaml', '**/*.yml', '**/*.json', '**/*.csv'],
  markdownGlobs: ['**/*.md'],
  ddlGlobs: ['**/*.sql'],
  excludeFromScan: ['node_modules/**', 'generated/**', '90-prototype/**'],
  labelCopyAllowlist: [],
}

function loadCfg(root, overrides = {}) {
  const cfgPath = path.join(root, 'spec-suite.config.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ ...BASE_CONFIG, ...overrides }), 'utf8')
  return loadConfig({ specsRoot: root, configPath: cfgPath })
}

const DICT_OK = `
meta:
  suite: demo
  truthSource: 10-why/02-业务规则.md
enums:
  - code: AuditAction
    label: 审计动作
    source: BR-AUDIT-001
    values:
      - code: CREATED
        label: 创建
        source: BR-AUDIT-001
stateMachines:
  - code: PublishRecord
    label: 发布记录
    source: BR-PUBLISH-002
    states:
      - code: draft
        label: 草稿
        source: BR-PUBLISH-002
        terminal: false
        transitions:
          - to: published
            trigger: submit
            source: BR-PUBLISH-003
      - code: published
        label: 已发布
        source: BR-PUBLISH-002
        terminal: true
        transitions: []
gaps:
  - code: G-01
    missing: 重试次数
    blocks: [T-09]
    protectiveDefault: 只允许一次
    rollbackCost: 删一个唯一索引
    owner: 产品
    status: open
`

const ERRORS_OK = `
errors:
  - code: GEO-40301
    httpStatus: 403
    class: permission
    label: 无权限
    source: BR-RBAC-001
    frontendAction: 提示
`

function errorsOf(col, check) {
  return col.findings.filter((f) => f.severity === 'error' && (check === undefined || f.check === check))
}

// ---------------------------------------------------------------------------
// glob / walk
// ---------------------------------------------------------------------------

test('globToRegExp: ** / * / ? 语义', () => {
  assert.ok(globToRegExp('**/*.yaml').test('a.yaml'))
  assert.ok(globToRegExp('**/*.yaml').test('x/y/a.yaml'))
  assert.ok(!globToRegExp('**/*.yaml').test('a.yml'))
  assert.ok(globToRegExp('10-why/02-*.md').test('10-why/02-业务规则.md'))
  assert.ok(!globToRegExp('10-why/02-*.md').test('10-why/03-x.md'))
  assert.ok(globToRegExp('a?c').test('abc'))
  assert.ok(!globToRegExp('a?c').test('ac'))
  assert.ok(globToRegExp('a/**').test('a/b/c'))
  assert.ok(!globToRegExp('a/**').test('a'))
})

test('walkFiles 裁剪 node_modules / .git，路径 posix 化', () => {
  const root = buildFixture({
    'a.md': 'x',
    'node_modules/pkg/b.md': 'x',
    '.git/c.md': 'x',
    'sub/d.yaml': 'x',
  })
  assert.deepEqual(walkFiles(root), ['a.md', 'sub/d.yaml'])
})

test('readText 去除 BOM', () => {
  const root = buildFixture({ 'a.txt': String.fromCharCode(0xfeff) + 'BOM内容' })
  const t = readText(path.join(root, 'a.txt'))
  assert.ok(!t.startsWith(String.fromCharCode(0xfeff)))
})

// ---------------------------------------------------------------------------
// 检查 1：schema
// ---------------------------------------------------------------------------

test('检查 1：合规字典零 error', () => {
  const root = buildFixture({ 'contracts/dictionary.yaml': DICT_OK, 'contracts/errors.yaml': ERRORS_OK })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  assert.deepEqual(errorsOf(col, 1), [])
})

test('检查 1：裸字符串集合报 error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
enums:
  - code: AuditAction
    label: 审计动作
    source: BR-AUDIT-001
    values: [CREATED, APPROVED]
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  assert.ok(errorsOf(col, 1).some((f) => /裸字符串/.test(f.message)))
})

test('检查 1：缺 source 报 error（N-01 的机器后盾）', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
enums:
  - code: AuditAction
    label: 审计动作
    values:
      - code: CREATED
        label: 创建
        source: BR-AUDIT-001
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  assert.ok(errorsOf(col, 1).some((f) => /缺必填键 `source`/.test(f.message)))
})

test('检查 1：source 为空等同缺失', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
enums:
  - code: AuditAction
    label: 审计动作
    source: ""
    values: []
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  assert.ok(errorsOf(col, 1).some((f) => /source.*为空/.test(f.message)))
})

test('检查 1：残留 <占位符> 报 error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
gaps:
  - code: G-01
    missing: <缺什么>
    blocks: [T-09]
    protectiveDefault: 只允许一次
    rollbackCost: 删一个唯一索引
    owner: 产品
    status: open
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  assert.ok(errorsOf(col, 1).some((f) => /占位符/.test(f.message)))
})

test('检查 1：顶层非数组节点报 error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
enums:
  notAnArray: true
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  assert.ok(errorsOf(col, 1).some((f) => /不是数组/.test(f.message)))
})

// ---------------------------------------------------------------------------
// 检查 1e：幂等键
// ---------------------------------------------------------------------------

test('检查 1e：DDL 提取 GENERATED 列元组；无声明时报 info 不报 error', () => {
  const root = buildFixture({
    'contracts/ddl/V1__baseline.sql': `
CREATE TABLE publish_record (
  id BIGINT PRIMARY KEY,
  active_key VARCHAR(64) GENERATED ALWAYS AS (CONCAT(provider, '_', intent)),
  tenant_id BIGINT
);
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const { extracted } = checkIdempotencyTuples({ specsRoot: root, config, model, col })
  assert.equal(extracted.length, 1)
  assert.equal(extracted[0].table, 'publish_record')
  assert.deepEqual(extracted[0].columns, ['provider', 'intent'])
  assert.deepEqual(errorsOf(col, 1), [])
  assert.ok(col.findings.some((f) => f.severity === 'info' && /idempotencyKeys/.test(f.message)))
})

test('检查 1e：有声明时元组不一致报 error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
idempotencyKeys:
  - code: IDK-PUBLISH
    table: publish_record
    columns: [provider, intent, tenant_id]
    source: BR-PUBLISH-002
`,
    'contracts/ddl/V1.sql': `
CREATE TABLE publish_record (
  active_key VARCHAR(64) GENERATED ALWAYS AS (CONCAT(provider, '_', intent))
);
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkIdempotencyTuples({ specsRoot: root, config, model, col })
  assert.ok(errorsOf(col, 1).some((f) => /幂等键列元组不一致/.test(f.message)))
})

test('检查 1e：声明与 DDL 一致时零 error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
idempotencyKeys:
  - code: IDK-PUBLISH
    table: publish_record
    columns: [provider, intent]
    source: BR-PUBLISH-002
`,
    'contracts/ddl/V1.sql': `
CREATE TABLE publish_record (
  active_key VARCHAR(64) GENERATED ALWAYS AS (CONCAT(provider, '_', intent))
);
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const { compared } = checkIdempotencyTuples({ specsRoot: root, config, model, col })
  assert.equal(compared, 1)
  assert.deepEqual(errorsOf(col, 1), [])
})

// ---------------------------------------------------------------------------
// 检查 2：状态机
// ---------------------------------------------------------------------------

test('检查 2：to 指向不存在的状态报 error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
stateMachines:
  - code: M
    label: 机器
    source: BR-X-001
    states:
      - code: draft
        label: 草稿
        source: BR-X-001
        terminal: false
        transitions:
          - to: ghost
            trigger: submit
            source: BR-X-002
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkStateMachines({ model, col })
  assert.ok(errorsOf(col, 2).some((f) => /ghost/.test(f.message)))
})

test('检查 2：terminal:true 却有出边 / terminal:false 却无出边', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
stateMachines:
  - code: M
    label: 机器
    source: BR-X-001
    states:
      - code: a
        label: 甲
        source: BR-X-001
        terminal: true
        transitions:
          - to: b
            trigger: go
            source: BR-X-002
      - code: b
        label: 乙
        source: BR-X-001
        terminal: false
        transitions: []
`,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkStateMachines({ model, col })
  const msgs = errorsOf(col, 2).map((f) => f.message)
  assert.ok(msgs.some((m) => /terminal.*true.*却有/.test(m)))
  assert.ok(msgs.some((m) => /terminal.*false.*没有出边/.test(m)))
})

// ---------------------------------------------------------------------------
// 检查 3：ID 引用完整性（含 5 个计数陷阱）
// ---------------------------------------------------------------------------

test('ID_TOKEN_RE：子串 / 无连字符 / 词边界', () => {
  assert.deepEqual(extractIdTokens('BR-PROJECT-001'), ['BR-PROJECT-001']) // T-001 不得单独抽出
  assert.deepEqual(extractIdTokens('T-001 在 BR-PROJECT-001 里'), ['T-001', 'BR-PROJECT-001'])
  assert.deepEqual(extractIdTokens('M16 8 L20 8'), [])                    // SVG path
  assert.deepEqual(extractIdTokens('M01 和 M-01'), ['M-01'])
  assert.deepEqual(extractIdTokens('T-OPEN-01'), ['T-OPEN-01'])
  assert.deepEqual(extractIdTokens('xBR-PROJECT-001x'), [])               // 词边界
})

test('isDefinitionSite：标题 / 表格首列 / 列表项算定义，行中引用不算', () => {
  assert.ok(isDefinitionSite('### BR-PUBLISH-002 发布', 'BR-PUBLISH-002'))
  assert.ok(isDefinitionSite('| BR-PUBLISH-002 | 说明 |', 'BR-PUBLISH-002'))
  assert.ok(isDefinitionSite('| **BR-PUBLISH-002** | 说明 |', 'BR-PUBLISH-002'))
  assert.ok(isDefinitionSite('- BR-PUBLISH-002：说明', 'BR-PUBLISH-002'))
  assert.ok(!isDefinitionSite('参见 BR-PUBLISH-002 的说明', 'BR-PUBLISH-002'))
})

test('检查 3：悬空引用报 error，孤儿报 warn', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    '10-why/02-业务规则.md': [
      '# 业务规则', '',
      '### BR-AUDIT-001 审计', '见 BR-PUBLISH-003 的引用。',
      '### BR-PUBLISH-002 发布', '### BR-PUBLISH-003 提交',
    ].join('\n'),
    'other.md': '引用 BR-PUBLISH-003 与悬空的 BR-GHOST-001。',
    'CLAUDE.md': 'N-01 参考。',
    'contracts/errors.yaml.placeholder': '',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkIdRefs({ specsRoot: root, config, model, col })
  assert.ok(errorsOf(col, 3).some((f) => /BR-GHOST-001/.test(f.message)))
  // BR-AUDIT-001 被字典 + 规则文件引用；BR-RBAC-001 在 errors.yaml 里
  assert.ok(!r.dangling.some((d) => d.token === 'BR-PUBLISH-003'))
})

test('检查 3：定义了但无人引用 → 孤儿 warn（BR-FACT-006 形态）', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    '10-why/02-业务规则.md': [
      '# 业务规则', '',
      '### BR-AUDIT-001 审计', '### BR-PUBLISH-002 发布', '### BR-PUBLISH-003 提交',
      '### BR-LONELY-999 无人引用',
    ].join('\n'),
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkIdRefs({ specsRoot: root, config, model, col })
  assert.ok(r.orphans.some((o) => o.token === 'BR-LONELY-999'))
  assert.ok(col.findings.some((f) => f.severity === 'warn' && f.check === 3 && /孤儿/.test(f.message)))
})

test('检查 3：命名空间歧义（token 匹配多个 pattern）报 config error', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'a.md': '引用 X-FOO-001。',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root, {
    idNamespaces: [
      { prefix: 'X1', pattern: '^X-FOO-\\d{3}$', kind: 'a', definedIn: ['a.md'] },
      { prefix: 'X2', pattern: '^X-FOO-\\d{3}$', kind: 'b', definedIn: ['a.md'] },
    ],
  })
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkIdRefs({ specsRoot: root, config, model, col })
  assert.ok(errorsOf(col, 3).some((f) => /同时匹配多个 idNamespaces/.test(f.message)))
})

test('检查 3：excludeFromScan 排除的目录不参与计数', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    '10-why/02-业务规则.md': '### BR-AUDIT-001\n### BR-PUBLISH-002\n### BR-PUBLISH-003\n',
    '90-prototype/x.md': 'BR-GHOST-001 BR-AUDIT-001',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkIdRefs({ specsRoot: root, config, model, col })
  assert.equal(r.dangling.filter((d) => d.token === 'BR-GHOST-001').length, 0)
})

test('检查 3：mayLackDefinition 命名空间的未定义引用 → warn 不是 error（T-OPEN 形态）', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    '10-why/02-业务规则.md': '### BR-AUDIT-001\n### BR-PUBLISH-002\n### BR-PUBLISH-003\n',
    'decisions/foo.md': '这条引用了尚无文件的 T-OPEN-07 与 T-OPEN-09。',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root, {
    idNamespaces: [
      { prefix: 'BR', pattern: '^BR-[A-Z]+-\\d{3}$', kind: 'rule', definedIn: ['10-why/02-*.md'] },
      { prefix: 'T-OPEN', pattern: '^T-OPEN-\\d{2}$', kind: 'tech-open', definedIn: ['decisions/T-OPEN-*.md'], mayLackDefinition: true },
    ],
  })
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkIdRefs({ specsRoot: root, config, model, col })
  assert.equal(r.dangling.filter((d) => /^T-OPEN/.test(d.token)).length, 0)
  assert.ok(errorsOf(col, 3).every((f) => !/T-OPEN/.test(f.message)))
  assert.ok(r.pending.some((p) => p.token === 'T-OPEN-07'))
  assert.ok(col.findings.some((f) => f.check === 3 && f.severity === 'warn' && /T-OPEN-07/.test(f.message) && /未决/.test(f.message)))
})

test('检查 3：记录误用 id: 而非 code: —— 检查 1 报根因，检查 3 不再重复报悬空', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK + `
frontendRedLines:
  - id: RL-01
    label: 前端红线一
    source: BR-RBAC-001
`,
    'other.md': '前端必须遵守 RL-01。',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkSchema({ model, col })
  const r = checkIdRefs({ specsRoot: root, config, model, col })
  assert.ok(errorsOf(col, 1).some((f) => /缺.*`code`/.test(f.message)))   // 根因报一次
  assert.equal(r.dangling.filter((d) => d.token === 'RL-01').length, 0)   // 不重复报悬空
})

// ---------------------------------------------------------------------------
// 渲染器与检查 4
// ---------------------------------------------------------------------------

test('transitionTable：终态渲染为 —（终态）', () => {
  const root = buildFixture({ 'contracts/dictionary.yaml': DICT_OK, 'contracts/errors.yaml': ERRORS_OK })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const rows = RENDERERS.transitionTable(model, ['', 'PublishRecord', 'transitions'])
  assert.equal(rows[0], '| 当前态 | 可迁移到 | 触发 | 依据 |')
  assert.ok(rows.some((r) => r.includes('终态')))
})

test('findZones：未闭合 / 嵌套 / 缩进 / ID 不匹配都报 error', () => {
  const col = makeCollector()
  findZones(['<!-- BEGIN GENERATED: gaps -->', 'body', 'x'], { file: 'a.md', col })
  assert.ok(errorsOf(col, 4).some((f) => /没有 END GENERATED/.test(f.message)))

  const col2 = makeCollector()
  findZones([
    '  <!-- BEGIN GENERATED: gaps -->',
    '<!-- END GENERATED: gaps -->',
  ], { file: 'a.md', col: col2 })
  assert.ok(errorsOf(col2, 4).some((f) => /缩进/.test(f.message)))

  const col3 = makeCollector()
  findZones([
    '<!-- BEGIN GENERATED: gaps -->',
    '<!-- BEGIN GENERATED: errors -->',
    '<!-- END GENERATED: errors -->',
    '<!-- END GENERATED: gaps -->',
  ], { file: 'a.md', col: col3 })
  assert.ok(errorsOf(col3, 4).some((f) => /嵌套/.test(f.message)))
})

test('检查 4：生成区与 yaml 一致 → 零 error；不一致 → error', async () => {
  const good = [
    '# 台账', '',
    '<!-- BEGIN GENERATED: gaps -->',
    ...RENDERERS.gapTable((() => {
      const col = makeCollector()
      const root = buildFixture({ 'contracts/dictionary.yaml': DICT_OK, 'contracts/errors.yaml': ERRORS_OK })
      const config = loadCfg(root)
      return buildModel({ specsRoot: root, config, YAML, col })
    })()),
    '<!-- END GENERATED: gaps -->',
  ].join('\n')

  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'gaps.md': good,
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  let r = checkZones({ specsRoot: root, config, model, col })
  assert.deepEqual(errorsOf(col, 4), [])
  assert.equal(r.mismatched, 0)

  // 手改生成区
  fs.writeFileSync(path.join(root, 'gaps.md'), good.replace('| G-01 |', '| G-99 |'), 'utf8')
  const col2 = makeCollector()
  r = checkZones({ specsRoot: root, config, model, col: col2 })
  assert.equal(r.mismatched, 1)
  assert.ok(errorsOf(col2, 4).some((f) => /不一致/.test(f.message)))

  // --write 修复
  const col3 = makeCollector()
  r = checkZones({ specsRoot: root, config, model, col: col3, write: true })
  assert.equal(r.rewritten, 1)
  assert.equal(readText(path.join(root, 'gaps.md')), good)
})

test('检查 4：yaml 有、md 无 → warn（RL-05 形态）', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK + `
frontendRedLines:
  - code: RL-05
    label: 前端红线五
    source: BR-RBAC-001
`,
    'plain.md': '# 没有任何生成区',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkZones({ specsRoot: root, config, model, col })
  // frontendRedLines 未注册投影，不会进 uncovered；gaps 注册了且 md 无 → warn
  assert.ok(col.findings.some((f) => f.check === 4 && f.severity === 'warn' && /yaml 里存在但 md 里没有生成区/.test(f.message)))
  assert.ok(r.uncovered.includes('gaps'))
})

test('检查 4：无任何生成区 → info 报迁移成本排序', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'a.md': '# a\n'.repeat(50),
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkZones({ specsRoot: root, config, model, col })
  assert.ok(col.findings.some((f) => f.check === 4 && f.severity === 'info' && /尚未迁移到两区制/.test(f.message)))
})

// ---------------------------------------------------------------------------
// 检查 5：N-xx 覆盖
// ---------------------------------------------------------------------------

const CLAUDE_WITH_TABLE = `# 纪律
### N-01 不得发明
### N-02 不得手写

## 覆盖表
| 禁令 | 强制方式 | 在哪跑 | 状态 |
|---|---|---|---|
| N-01 | 检查 1 | 规格库 CI | ⚠️ 部分 |
| N-02 | 检查 4 | 规格库 CI | ✅ |
`

test('检查 5：完整覆盖零 error', () => {
  const root = buildFixture({ 'CLAUDE.md': CLAUDE_WITH_TABLE, 'contracts/dictionary.yaml': DICT_OK, 'contracts/errors.yaml': ERRORS_OK })
  const config = loadCfg(root)
  const col = makeCollector()
  const r = checkBanCoverage({ specsRoot: root, config, col })
  assert.deepEqual(errorsOf(col, 5), [])
  assert.equal(r.covered, 2)
})

test('检查 5：禁令无覆盖行 → error；待补 → error；✅ 无位置 → error', () => {
  const root = buildFixture({
    'CLAUDE.md': `# 纪律
### N-01 不得发明
### N-02 不得手写
### N-03 孤儿禁令

## 覆盖表
| 禁令 | 强制方式 | 在哪跑 | 状态 |
|---|---|---|---|
| N-01 | 检查 1 | 规格库 CI | 待补 |
| N-02 | 检查 4 |  | ✅ |
`,
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
  })
  const config = loadCfg(root)
  const col = makeCollector()
  checkBanCoverage({ specsRoot: root, config, col })
  const msgs = errorsOf(col, 5).map((f) => f.message)
  assert.ok(msgs.some((m) => m.includes('N-03') && /没有断言表行/.test(m)))
  assert.ok(msgs.some((m) => m.includes('N-01') && /待补/.test(m)))
  assert.ok(msgs.some((m) => m.includes('N-02') && /在哪跑/.test(m)))
})

test('检查 5：缺 CLAUDE.md → error', () => {
  const root = buildFixture({ 'contracts/dictionary.yaml': DICT_OK, 'contracts/errors.yaml': ERRORS_OK })
  const config = loadCfg(root)
  const col = makeCollector()
  checkBanCoverage({ specsRoot: root, config, col })
  assert.ok(errorsOf(col, 5).some((f) => /找不到/.test(f.message)))
})

test('parseBanCoverage：容忍表后空行 + 散文', () => {
  const { rows } = parseBanCoverage(CLAUDE_WITH_TABLE + '\n表到这里为止。\n\n| 其他表格 | 列 |\n|---|---|\n| x | y |\n')
  assert.equal(rows.length, 2)
})

test('parseBanCoverage：禁令只以表格行定义（无 ### 小节）也要认', () => {
  // scrm-specs 的 12 条禁令全是 `| N-01 | … |` 表格行。只认 ### 标题的话
  // 检查 5 会报「禁令 0 条」，整道闸门静默失效。
  const { bans } = parseBanCoverage(`
## 禁令
| 编号 | 禁止做什么 |
|---|---|
| N-01 | 不得编造业务规则 |
| \`N-02\` | 不得复制中文描述 |
| **N-03** | 不得跳过缺口登记 |
| 其他 | 这行首列不是 N-xx，不算定义 |
`)
  assert.deepEqual(bans.map((b) => b.code), ['N-01', 'N-02', 'N-03'])
  assert.ok(bans[0].title.includes('编造'))
})

test('parseBanCoverage：### 小节与表格行定义同一条禁令，只算一次', () => {
  const { bans } = parseBanCoverage(`
### N-01 不得编造
| 编号 | 禁止做什么 |
|---|---|
| N-01 | 不得编造业务规则 |
`)
  assert.equal(bans.length, 1)
})

// ---------------------------------------------------------------------------
// 检查 6：禁止复制中文标签
// ---------------------------------------------------------------------------

test('检查 6：字段值整个是字典 label → error（published 形态）；散文里嵌到句子里不报', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'contracts/openapi.yaml': `
paths:
  /x:
    get:
      summary: 查询
      responses:
        '200':
          description: 状态为已发布的数据
          example:
            status: 已发布
`,
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkLabelCopy({ specsRoot: root, config, model, col })
  // `status: 已发布` 是整值 → 报
  assert.ok(errorsOf(col, 6).some((f) => /已发布/.test(f.message)))
  assert.ok(r.hits.some((h) => h.label === '已发布' && h.key === 'status'))
  // `description: 状态为已发布的数据` 是句子里的子串 → 不报（实测 scrm-specs：
  // 按子串匹配会在三份字典里造出 224 处噪声）
  assert.equal(r.hits.filter((h) => h.key === 'description').length, 0)
})

test('检查 6：allowlist 支持按键豁免（fixtures 的展示名 name）', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'fixtures.json': '{ "rows": [ { "name": "已发布", "status": "已发布" } ] }\n',
    'CLAUDE.md': 'x',
  })
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config: loadCfg(root), YAML, col })
  const before = checkLabelCopy({ specsRoot: root, config: loadCfg(root), model, col: makeCollector() })
  assert.ok(before.hits.length >= 1)

  const cfg2 = loadCfg(root, { labelCopyAllowlist: [{ key: 'name' }] })
  const after = checkLabelCopy({ specsRoot: root, config: cfg2, model, col: makeCollector() })
  assert.equal(after.hits.filter((h) => h.key === 'name').length, 0)
  assert.ok(after.hits.some((h) => h.key === 'status'))
})

test('scalarValues：整值 / flow 数组项 / 列表项 / CSV 单元', () => {
  assert.deepEqual(
    scalarValues('  - { code: draft, label: 草稿, to: [running, cancelled] }')
      .map((c) => `${c.key}=${c.value}`),
    ['code=draft', 'label=草稿', 'to=running', 'to=cancelled'])
  assert.deepEqual(scalarValues('    - 已发布').map((c) => c.value), ['已发布'])
  assert.deepEqual(scalarValues('a,已发布,c', { csv: true }).map((c) => c.value), ['a', '已发布', 'c'])
  // 句子不产出等于 label 的整值
  assert.ok(!scalarValues('  semantics: 状态为已发布的数据').some((c) => c.value === '已发布'))
})

test('检查 6：声明行（label: xxx）与 yaml 注释豁免；md 不在范围', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'contracts/dictionary2.yaml': `
# 注释里提到 已发布 不算 error
enums: []
`,
    'notes.md': '散文里写 已发布 是允许的',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const r = checkLabelCopy({ specsRoot: root, config, model, col })
  assert.deepEqual(errorsOf(col, 6), [])
})

test('检查 6：allowlist 豁免', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    'contracts/openapi.yaml': 'description: 已发布\n',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root, { labelCopyAllowlist: ['已发布'] })
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  checkLabelCopy({ specsRoot: root, config, model, col })
  assert.deepEqual(errorsOf(col, 6), [])
})

test('检查 6：同一 label 被两条记录共用 → warn', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': `
enums:
  - code: A
    label: 已发布
    source: BR-A-001
  - code: B
    label: 已发布
    source: BR-B-001
`,
    'contracts/errors.yaml': 'errors: []',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root)
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  collectLabels(model, col)
  assert.ok(col.findings.some((f) => f.check === 6 && f.severity === 'warn' && /共用/.test(f.message)))
})

// ---------------------------------------------------------------------------
// 检查 7：覆盖矩阵完整性
// ---------------------------------------------------------------------------

test('检查 7：BR 已定义但漏在追溯矩阵 → warn；补上 → 零 warn；无要求 → info', () => {
  const base = {
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    '10-why/02-业务规则.md': '### BR-AUDIT-001\n### BR-PUBLISH-002\n### BR-PUBLISH-003\n',
    'CLAUDE.md': 'x',
  }
  const cov = [{ namespace: 'BR', mustAppearIn: '50-delivery/11-*.csv', severity: 'warn' }]
  const runCheck7 = (files, overrides) => {
    const root = buildFixture(files)
    const config = loadCfg(root, overrides)
    const col = makeCollector()
    const model = buildModel({ specsRoot: root, config, YAML, col })
    const idr = checkIdRefs({ specsRoot: root, config, model, col })
    checkCoverageMatrix({ specsRoot: root, config, idRefResult: idr, col })
    return col
  }

  // 矩阵缺 BR-PUBLISH-003 → warn
  const col1 = runCheck7({ ...base, '50-delivery/11-m.csv': 'FR,BR\nx,BR-AUDIT-001\ny,BR-PUBLISH-002\n' }, { coverageRequirements: cov })
  assert.ok(col1.findings.some((f) => f.check === 7 && f.severity === 'warn' && /BR-PUBLISH-003/.test(f.message)))

  // 矩阵补全 → 零 warn
  const col2 = runCheck7({ ...base, '50-delivery/11-m.csv': 'FR,BR\nx,BR-AUDIT-001\ny,BR-PUBLISH-002\nz,BR-PUBLISH-003\n' }, { coverageRequirements: cov })
  assert.equal(col2.findings.filter((f) => f.check === 7 && f.severity === 'warn').length, 0)

  // 无 coverageRequirements → info，no-op
  const col3 = runCheck7(base, { coverageRequirements: [] })
  assert.ok(col3.findings.some((f) => f.check === 7 && f.severity === 'info'))
})

test('检查 7：矩阵文件的 glob 匹配不到任何文件 → 按声明的 severity 报', () => {
  const root = buildFixture({
    'contracts/dictionary.yaml': DICT_OK,
    'contracts/errors.yaml': ERRORS_OK,
    '10-why/02-业务规则.md': '### BR-AUDIT-001\n### BR-PUBLISH-002\n### BR-PUBLISH-003\n',
    'CLAUDE.md': 'x',
  })
  const config = loadCfg(root, { coverageRequirements: [{ namespace: 'BR', mustAppearIn: '50-delivery/11-*.csv', severity: 'error' }] })
  const col = makeCollector()
  const model = buildModel({ specsRoot: root, config, YAML, col })
  const idr = checkIdRefs({ specsRoot: root, config, model, col })
  checkCoverageMatrix({ specsRoot: root, config, idRefResult: idr, col })
  assert.ok(errorsOf(col, 7).some((f) => /没有文件匹配/.test(f.message)))
})

// ---------------------------------------------------------------------------
// A：生成模式自洽 —— 已填好的最小 L0 示例跑 checker 必须 0 error
// 审计模式（合成夹具）之外的另一半：模板实例化后不能悄悄违反自己强制的 schema。
// ---------------------------------------------------------------------------

test('A：templates/L0/example 跑完整 run() → 0 error', async () => {
  const exampleDir = path.join(HERE, '..', 'templates', 'L0', 'example')
  const r = await run({
    specsRoot: exampleDir,
    config: path.join(exampleDir, 'spec-suite.config.json'),
  })
  // 出错时把每条 error 打出来，方便定位是模板哪里偏离了 schema
  assert.deepEqual(r.col.findings.filter((f) => f.severity === 'error').map((f) => `检查${f.check}: ${f.message}`), [])
  assert.equal(r.errors, 0)
})

// SKILL.md §0 与 SCHEMA.md §5.2 声明"编号目录只是门风，换 flat 布局机制一样成立"。
// 这条测试就是那句声明的断言（铁律 3：每条声明配一条断言，别只在文档里断言）。
// 复用 example 的 CLAUDE.md 与 dictionary，只把路径换成 flat —— 这样测的是布局，
// 不是把 example 已经覆盖过的 schema / 禁令覆盖再测一遍。
test('flat 布局（无编号目录）跑完整 run() → 0 error', async () => {
  const ex = path.join(HERE, '..', 'templates', 'L0', 'example')
  const flatten = (s) => s.replaceAll('10-why/02-业务规则.md', 'rules.md')

  const root = buildFixture({
    'CLAUDE.md': flatten(fs.readFileSync(path.join(ex, 'CLAUDE.md'), 'utf8')),
    'rules.md': fs.readFileSync(path.join(ex, '10-why', '02-业务规则.md'), 'utf8'),
    'contracts/dictionary.yaml': flatten(fs.readFileSync(path.join(ex, 'contracts', 'dictionary.yaml'), 'utf8')),
    'gaps.md': '# 规则缺口\n\n<!-- BEGIN GENERATED: gaps -->\n<!-- END GENERATED: gaps -->\n',
    // 追溯矩阵也放在根上，验证 coverageRequirements 的 mustAppearIn 不依赖 50-delivery/
    'traceability.csv': 'ruleId,acceptance,owner\nBR-MEMBER-001,手工验收,产品\nBR-MEMBER-002,手工验收,产品\n' +
      'BR-MEMBER-003,手工验收,产品\nBR-MEMBER-004,手工验收,产品\n',
    'spec-suite.config.json': JSON.stringify({
      dictionaries: ['contracts/dictionary.yaml'],
      generatedDir: 'generated',
      claudeMd: 'CLAUDE.md',
      idNamespaces: [
        { prefix: 'BR', pattern: '^BR-[A-Z]+-\\d{3}$', kind: 'rule', definedIn: ['rules.md'] },
        { prefix: 'G', pattern: '^G-\\d{2}$', kind: 'gap', definedIn: ['contracts/dictionary.yaml'] },
      ],
      projections: { gaps: 'gapTable' },
      structuredFileGlobs: ['**/*.yaml', '**/*.yml', '**/*.json', '**/*.csv'],
      markdownGlobs: ['**/*.md'],
      excludeFromScan: ['node_modules/**', 'generated/**'],
      labelCopyAllowlist: [],
      coverageRequirements: [{ namespace: 'BR', mustAppearIn: 'traceability.csv', severity: 'error' }],
    }, null, 2),
  })
  const cfg = path.join(root, 'spec-suite.config.json')

  await run({ specsRoot: root, config: cfg, write: true })   // 先填生成区
  const r = await run({ specsRoot: root, config: cfg })      // 再只读断言
  assert.deepEqual(r.col.findings.filter((f) => f.severity === 'error').map((f) => `检查${f.check}: ${f.message}`), [])
  assert.equal(r.errors, 0)
})

// ---------------------------------------------------------------------------
// skill 自身的可达性（本 skill 对自己执行铁律 3：文档声明配机器断言）
//
// 这两条断言各抓一个方向的漏。第二条是实战抓到的：`templates/L1/` 六个文件写好了，
// 但 SKILL.md §4 路由表从 L0 直接跳到 contracts/L2/L3，跳过 L1 ——
// 文件存在却没有任何入口指向它，等于不存在（"agent 不会主动去读它不知道存在的文件"）。
// ---------------------------------------------------------------------------

const SKILL_ROOT = path.join(HERE, '..')
const SKILL_DOCS = ['SKILL.md', 'SCHEMA.md', 'DISCIPLINES.md', 'INTERVIEW.md']
const docText = SKILL_DOCS.map((f) => fs.readFileSync(path.join(SKILL_ROOT, f), 'utf8')).join('\n')
const skillMd = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8')

test('文档里提到的每个 templates/ 路径都存在', () => {
  const cited = [...docText.matchAll(/templates\/[A-Za-z0-9/._-]+/g)]
    .map((m) => m[0].replace(/[.,)：]+$/, ''))
  const missing = [...new Set(cited)].filter((p) => !fs.existsSync(path.join(SKILL_ROOT, p)))
  assert.deepEqual(missing, [], `文档引用了不存在的模板：${missing.join(', ')}`)
})

// 必须只看 SKILL.md，不能看四文件并集。实测：漏掉 L1 路由的那一版里，
// DISCIPLINES.md 确实提到过 `templates/L1/consuming-repo-stubs.md` ——
// 用并集判定就会通过，漏洞照样发布。只有 SKILL.md 是无条件进上下文的，
// 埋在 DISCIPLINES.md 里的一句话，只有当 §4 已经把 agent 路由过去时才可达。
test('每个层目录都在 SKILL.md 里有入口（并集判定会漏，见注释）', () => {
  const tiers = fs.readdirSync(path.join(SKILL_ROOT, 'templates'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
  const unreachable = tiers.filter((t) => !skillMd.includes(`templates/${t}/`))
  assert.deepEqual(unreachable, [], `这些层目录在 SKILL.md 里没有入口：${unreachable.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

test('renderReportMd：含审计结论不等于修改授权', () => {
  const md = renderReportMd({
    specsRoot: 'C:/x',
    configPath: 'C:/x/cfg.json',
    isFallback: true,
    findings: [{ check: 1, severity: 'error', message: 'x' }],
    stats: { 1: { 记录总数: 3 } },
  })
  assert.ok(md.includes('审计结论不等于修改授权'))
  assert.ok(md.includes('示例 config'))
})
