#!/usr/bin/env node

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadYamlLib } from '../../scripts/check-spec-suite.mjs'
import { generateContractBundle } from '../../scripts/generate-contract-bundle.mjs'

// 搬到 tests/integration/ 之后，原来那个 `HERE` 的三种用法各自指向不同深度：
// 仓库根（`HERE/..`）、被 spawn 的 CLI（`HERE/<script>`）、以及语料目录
// （`HERE/fixtures/...`）。语料**没有**跟着搬 —— 它是 scripts/fixtures/ 下的
// 一棵树，被 SCHEMA.md 与 fixtures/README.md 按路径引用。所以这里三者都写清楚。
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = path.join(SKILL_ROOT, 'scripts')
const FIXTURE_ROOT = path.join(SCRIPTS, 'fixtures', 'v1-vertical-slice')
const YAML = await loadYamlLib(SKILL_ROOT)

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-v1-'))
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true })
  return root
}

function runCli(script, args, cwd) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function renderEntry(specsRoot) {
  const result = runCli('check-spec-suite.mjs', [
    '--specs-root', specsRoot,
    '--config', path.join(specsRoot, 'spec-suite.config.json'),
    '--write-generated-regions',
    '--quiet',
  ], process.cwd())
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('轻量 unresolved 单向升级为同一条 G-*，重复迁移不产生第二条记录', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const dictionary = path.join(specsRoot, 'contracts', 'dictionary.yaml')
  const unresolved = path.join(specsRoot, '.spec-suite', 'unresolved.yaml')
  const args = [
    '--specs-root', specsRoot,
    '--fact', 'retry_count',
    '--block', 'src/retry-policy.ts',
    '--protective-default', 'do_not_retry',
    '--rollback-cost', 'change one policy value before any retry is emitted',
    '--owner', 'product',
  ]

  const first = runCli('migrate-unresolved.mjs', args, process.cwd())
  assert.equal(first.status, 0, first.stderr || first.stdout)

  const dictionaryAfterFirst = fs.readFileSync(dictionary, 'utf8')
  const unresolvedAfterFirst = fs.readFileSync(unresolved, 'utf8')
  const dictionaryDoc = YAML.parse(dictionaryAfterFirst)
  const unresolvedDoc = YAML.parse(unresolvedAfterFirst)

  assert.equal(dictionaryDoc.gaps.length, 1)
  assert.equal(dictionaryDoc.gaps[0].code, 'G-01')
  assert.equal(dictionaryDoc.gaps[0].provenance.unresolvedFact, 'retry_count')
  assert.deepEqual(dictionaryDoc.gaps[0].provenance.sourceSearch, ['config', 'docs', 'code'])
  assert.deepEqual(unresolvedDoc.facts, [])

  const second = runCli('migrate-unresolved.mjs', args, process.cwd())
  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.equal(fs.readFileSync(dictionary, 'utf8'), dictionaryAfterFirst)
  assert.equal(fs.readFileSync(unresolved, 'utf8'), unresolvedAfterFirst)
})

test('canonical entry 同时重写 CLAUDE.md / AGENTS.md 公共区并保留各自手写区', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const entries = [
    {
      path: path.join(specsRoot, 'CLAUDE.md'),
      handwritten: /Claude-specific handwritten region/,
      stale: /stale common content/,
    },
    {
      path: path.join(specsRoot, 'AGENTS.md'),
      handwritten: /Codex-specific handwritten region/,
      stale: /stale Codex common content/,
    },
  ]
  const args = [
    '--specs-root', specsRoot,
    '--config', path.join(specsRoot, 'spec-suite.config.json'),
    '--write-generated-regions',
    '--quiet',
  ]

  const first = runCli('check-spec-suite.mjs', args, process.cwd())
  assert.equal(first.status, 0, first.stderr || first.stdout)
  const rendered = entries.map((entry) => fs.readFileSync(entry.path, 'utf8'))
  entries.forEach((entry, index) => {
    assert.match(rendered[index], /Unknown stays unknown\./)
    assert.match(rendered[index], entry.handwritten)
    assert.doesNotMatch(rendered[index], entry.stale)
  })

  const commonZone = /(<!-- BEGIN GENERATED: agent-entry\.common -->\n)([\s\S]*?)(<!-- END GENERATED: agent-entry\.common -->)/
  assert.equal(rendered[0].match(commonZone)?.[2], rendered[1].match(commonZone)?.[2],
    'Claude 与 Codex adapter 没有得到 byte-identical common region')

  const second = runCli('check-spec-suite.mjs', args, process.cwd())
  assert.equal(second.status, 0, second.stderr || second.stdout)
  entries.forEach((entry, index) => assert.equal(fs.readFileSync(entry.path, 'utf8'), rendered[index]))
})

test('canonical contracts 确定性生成 language-neutral bundle 与边界 manifest', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const config = path.join(specsRoot, 'spec-suite.config.json')
  const generated = path.join(specsRoot, 'generated')
  const args = ['--specs-root', specsRoot, '--config', config]
  renderEntry(specsRoot)

  const first = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.equal(first.status, 0, first.stderr || first.stdout)

  const bundlePath = path.join(generated, 'contract-bundle.json')
  const manifestPath = path.join(generated, 'manifest.json')
  const bundleBytes = fs.readFileSync(bundlePath, 'utf8')
  const manifestBytes = fs.readFileSync(manifestPath, 'utf8')
  const bundle = JSON.parse(bundleBytes)
  const manifest = JSON.parse(manifestBytes)

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    inputs: ['contracts/dictionary.yaml'],
    outputs: ['contract-bundle.json'],
  })
  assert.equal(bundle.schemaVersion, 1)
  assert.equal(bundle.suite, 'v1-vertical-slice')
  assert.deepEqual(Object.keys(bundle.contracts), ['enums', 'stateMachines'])
  assert.deepEqual(bundle.contracts.enums[0].values.map((value) => value.code), ['MANUAL_ONLY', 'DISABLED'])
  assert.equal(Object.hasOwn(bundle.contracts, 'gaps'), false)

  const second = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.equal(second.status, 0, second.stderr || second.stdout)
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), bundleBytes)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBytes)
})

test('未决 G-* 不能被洗成 canonical fact，失败时保留旧 bundle', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const config = path.join(specsRoot, 'spec-suite.config.json')
  const dictionaryPath = path.join(specsRoot, 'contracts', 'dictionary.yaml')
  const bundlePath = path.join(specsRoot, 'generated', 'contract-bundle.json')
  const manifestPath = path.join(specsRoot, 'generated', 'manifest.json')
  const args = ['--specs-root', specsRoot, '--config', config]
  renderEntry(specsRoot)

  const baseline = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout)
  const oldBundle = fs.readFileSync(bundlePath, 'utf8')
  const oldManifest = fs.readFileSync(manifestPath, 'utf8')

  const dictionary = fs.readFileSync(dictionaryPath, 'utf8')
    .replace('source: BR-RETRY-001', 'source: G-01')
    .replace('gaps: []', `gaps:\n  - code: G-01\n    missing: retry_count\n    blocks: [src/retry-policy.ts]\n    protectiveDefault: do_not_retry\n    rollbackCost: change one policy value\n    owner: product\n    status: open`)
  fs.writeFileSync(dictionaryPath, dictionary, 'utf8')

  const failed = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /未决事实/)
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), oldBundle)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), oldManifest)
})

test('canonical source 缺失时生成失败且不覆盖旧 bundle', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const config = path.join(specsRoot, 'spec-suite.config.json')
  const bundlePath = path.join(specsRoot, 'generated', 'contract-bundle.json')
  const manifestPath = path.join(specsRoot, 'generated', 'manifest.json')
  const args = ['--specs-root', specsRoot, '--config', config]
  renderEntry(specsRoot)

  const baseline = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout)
  const oldBundle = fs.readFileSync(bundlePath, 'utf8')
  const oldManifest = fs.readFileSync(manifestPath, 'utf8')
  fs.rmSync(path.join(specsRoot, '10-why', '02-rules.md'))

  const failed = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /canonical checker 失败/)
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), oldBundle)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), oldManifest)
})

test('canonical input 无法解析时生成失败且不覆盖旧 bundle', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const config = path.join(specsRoot, 'spec-suite.config.json')
  const dictionaryPath = path.join(specsRoot, 'contracts', 'dictionary.yaml')
  const bundlePath = path.join(specsRoot, 'generated', 'contract-bundle.json')
  const manifestPath = path.join(specsRoot, 'generated', 'manifest.json')
  const args = ['--specs-root', specsRoot, '--config', config]
  renderEntry(specsRoot)

  const baseline = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout)
  const oldBundle = fs.readFileSync(bundlePath, 'utf8')
  const oldManifest = fs.readFileSync(manifestPath, 'utf8')
  fs.writeFileSync(dictionaryPath, 'meta:\n  suite: broken\nenums: [\n', 'utf8')

  const failed = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /canonical checker 失败/)
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), oldBundle)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), oldManifest)
})

test('派生产物不能反向充当 authoritative source', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const config = path.join(specsRoot, 'spec-suite.config.json')
  const dictionaryPath = path.join(specsRoot, 'contracts', 'dictionary.yaml')
  const bundlePath = path.join(specsRoot, 'generated', 'contract-bundle.json')
  const manifestPath = path.join(specsRoot, 'generated', 'manifest.json')
  const args = ['--specs-root', specsRoot, '--config', config]
  renderEntry(specsRoot)

  const baseline = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout)
  const oldBundle = fs.readFileSync(bundlePath, 'utf8')
  const oldManifest = fs.readFileSync(manifestPath, 'utf8')
  const dictionary = fs.readFileSync(dictionaryPath, 'utf8')
    .replace('source: BR-RETRY-001', 'source: generated/contract-bundle.json')
  fs.writeFileSync(dictionaryPath, dictionary, 'utf8')

  const failed = runCli('generate-contract-bundle.mjs', args, process.cwd())
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /派生产物/)
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), oldBundle)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), oldManifest)
})

test('consumer verifier 只接受 manifest、文件集合与生成字节完全一致的副本', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const config = path.join(specsRoot, 'spec-suite.config.json')
  const generated = path.join(specsRoot, 'generated')
  const consumerRoot = path.join(root, 'consumer-contracts')
  const generateArgs = ['--specs-root', specsRoot, '--config', config]
  const verifyArgs = [
    '--specs-root', specsRoot,
    '--config', config,
    '--consumer-root', consumerRoot,
  ]
  renderEntry(specsRoot)
  const generatedResult = runCli('generate-contract-bundle.mjs', generateArgs, process.cwd())
  assert.equal(generatedResult.status, 0, generatedResult.stderr || generatedResult.stdout)
  fs.mkdirSync(consumerRoot, { recursive: true })
  fs.copyFileSync(path.join(generated, 'manifest.json'), path.join(consumerRoot, 'manifest.json'))
  fs.copyFileSync(path.join(generated, 'contract-bundle.json'), path.join(consumerRoot, 'contract-bundle.json'))

  const current = runCli('verify-consumer-contracts.mjs', verifyArgs, process.cwd())
  assert.equal(current.status, 0, current.stderr || current.stdout)

  fs.appendFileSync(path.join(consumerRoot, 'manifest.json'), '\n')
  const manifestMismatch = runCli('verify-consumer-contracts.mjs', verifyArgs, process.cwd())
  assert.notEqual(manifestMismatch.status, 0)
  assert.match(manifestMismatch.stderr, /字节不一致：manifest\.json/)
  fs.copyFileSync(path.join(generated, 'manifest.json'), path.join(consumerRoot, 'manifest.json'))

  fs.appendFileSync(path.join(consumerRoot, 'contract-bundle.json'), '\n')
  const stale = runCli('verify-consumer-contracts.mjs', verifyArgs, process.cwd())
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /字节不一致/)

  fs.copyFileSync(path.join(generated, 'contract-bundle.json'), path.join(consumerRoot, 'contract-bundle.json'))
  fs.writeFileSync(path.join(consumerRoot, 'extra.json'), '{}\n', 'utf8')
  const extra = runCli('verify-consumer-contracts.mjs', verifyArgs, process.cwd())
  assert.notEqual(extra.status, 0)
  assert.match(extra.stderr, /文件集合不一致/)

  fs.rmSync(path.join(consumerRoot, 'extra.json'))
  fs.rmSync(path.join(consumerRoot, 'contract-bundle.json'))
  const missing = runCli('verify-consumer-contracts.mjs', verifyArgs, process.cwd())
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /文件集合不一致/)
})

test('未解决事实跨重复任务仍返回 unresolved，不产生默认值', () => {
  const root = copyFixture()
  const specsRoot = path.join(root, 'spec')
  const unresolvedPath = path.join(specsRoot, '.spec-suite', 'unresolved.yaml')
  const dictionaryPath = path.join(specsRoot, 'contracts', 'dictionary.yaml')
  const args = ['--specs-root', specsRoot, '--fact', 'retry_count']
  const unresolvedBytes = fs.readFileSync(unresolvedPath, 'utf8')
  const dictionaryBytes = fs.readFileSync(dictionaryPath, 'utf8')

  const first = runCli('guard-unresolved-fact.mjs', args, process.cwd())
  const second = runCli('guard-unresolved-fact.mjs', args, process.cwd())
  assert.equal(first.status, 3, first.stderr || first.stdout)
  assert.equal(second.status, 3, second.stderr || second.stdout)
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout))
  assert.equal(JSON.parse(first.stdout).status, 'unresolved')
  assert.equal(fs.readFileSync(unresolvedPath, 'utf8'), unresolvedBytes)
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), dictionaryBytes)
  assert.doesNotMatch(dictionaryBytes, /retry_count/)
})

test('发布的 L0 example adapter 与 bundle 是 canonical inputs 的当前字节', async () => {
  const source = path.join(SKILL_ROOT, 'templates', 'L0', 'example')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-suite-example-'))
  fs.cpSync(source, root, { recursive: true })
  const config = path.join(root, 'spec-suite.config.json')
  const entries = [path.join(root, 'CLAUDE.md'), path.join(root, 'AGENTS.md')]
  const tracked = [
    ...entries,
    path.join(root, 'generated', 'contract-bundle.json'),
    path.join(root, 'generated', 'manifest.json'),
  ]
  const before = tracked.map((file) => fs.readFileSync(file))
  const entriesBefore = entries.map((entry) => fs.readFileSync(entry))

  // 先把派生物清掉，再重新派生。不清掉的话，「两个工具都退化成 no-op」这类缺陷
  // 会让下面的比对**空过**：文件还是 cpSync 复制进来的那份字节，逐字节相等，
  // 绿灯。`fixed.status === 0` 只证明检查器没报错，不证明它写过任何东西。
  // compatibility.test.mjs 的同类断言一直是先删再生成（那里写着「先删掉，否则
  // 『没重新生成』也能让下面的比对通过 —— 那种绿灯什么也不证明」），这条漏了
  // 同一道防线。
  //
  // 两类派生物要分开处理：generated/ 整个删掉；两个 adapter **不能**删 ——
  // 生成区寄生在手写文档里，删掉整份文件等于连宿主一起删。所以只清空两个
  // common region 的正文、留下 BEGIN/END 标记，逼重写器逐个把它们填回来。
  fs.rmSync(path.join(root, 'generated'), { recursive: true, force: true })
  const zoneBody = /(<!-- BEGIN GENERATED: agent-entry\.common -->\n)[\s\S]*?(<!-- END GENERATED: agent-entry\.common -->)/
  entries.forEach((entry) => {
    fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(zoneBody, '$1$2'), 'utf8')
  })

  // 清空动作自己也要被证明：一个没匹配上的正则会静默什么都不改，于是「先删」
  // 这道防线自己空掉，而测试照样绿 —— 那正是这次要堵的形状，不能在堵它的路上
  // 重新引入一遍。
  assert.equal(fs.existsSync(path.join(root, 'generated')), false)
  entries.forEach((entry, index) => {
    assert.notDeepEqual(fs.readFileSync(entry), entriesBefore[index],
      `${path.basename(entry)} 生成区没被清空 —— 「先删」这道防线正在空过`)
  })

  const fixed = runCli('check-spec-suite.mjs', [
    '--specs-root', root,
    '--config', config,
    '--write-generated-regions',
    '--quiet',
  ], process.cwd())
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout)
  await generateContractBundle({ specsRoot: root, config })

  tracked.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]))
})
