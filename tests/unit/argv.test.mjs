// src/shared/argv.mjs 的行为测试。
//
// 存在理由与 atomic-write.test.mjs 同源：合并 12 份手写解析器时，我在两处
// **即将发布的注释**里写下了承诺 ——
//
//   * `src/shared/argv.mjs`：「argv.test.mjs 有一条测试要求所有已注册的
//     validate 都拒绝 undefined —— 否则这个入口就成了绕过缺值检测的后门」
//   * `scripts/trust-report.mjs`：同一句话的第二份
//
// 未被测试的承诺就是未被证明的承诺。它比没有承诺更糟：下一个人会依赖它。
//
// 除那条承诺之外，这里刻意钉住三类**今天正确、明天会被"顺手改好"的东西** ——
// 它们的共同点是：改坏之后现有测试全绿。
//
//   1. 两个**有意没做**的收紧（值允许长得像参数、不支持 `--flag=value`）。
//      argv.mjs 的注释声明它们是决定而非疏漏；没有测试，下一个人会把它们
//      当漏洞补掉，那是改语义。
//   2. `'set' in entry` 而不是 `entry.set` 的真值判断。差别只在常量为假值时
//      显现，而现有两个 set 常量（`'check'` / `'write'`）都是真值 —— 所以这条
//      差别今天**不可能**被任何 CLI 的测试发现。
//   3. `hasOwnProperty` 而不是 `spec[arg]`。差别只在参数名恰好是
//      Object.prototype 的成员时显现。
//
// 最后一组测试是**源级锁**：文案单一来源、没有第三种方言、带 validate 的 spec
// 必须可被本文件触及。它们锁的不是行为而是结构 —— 合并的价值全在"以后不会再
// 长出第 13 份"，而那件事只能在源码层面证明。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  MESSAGES_EN, MESSAGES_ZH, parseExactConfigFlag, parseFlags, parseFlagsOrThrow,
} from '../../src/shared/argv.mjs'
import { ROOTS, blankComments } from '../../scripts/check-architecture.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')

// 源级锁扫描的根：单一来源在 check-architecture.mjs。本文件里有两条 sweep，原先
// 各抄一份这个数组 —— 两份必须同步才有意义，而没有任何东西强制它们同步。
//
// 复用 ROOTS 意味着 `tests` 也在范围内，而下面两条 sweep 都跳过 `.test.mjs`，
// 所以今天扫到的文件一个不多一个不少（tests/ 下 13 个文件全是 `.test.mjs`）。
// 将来 tests/ 下出现非测试的辅助模块时，它会**自动**进入扫描范围 —— 一份藏在
// 测试辅助代码里的 `未知参数：` 副本正是这两条锁要抓的东西。

/**
 * 走一遍 ROOTS 下的非测试 .mjs，并证明**确实扫到了东西**。
 *
 * 为什么需要这个证明：下面两条 sweep 的结论都是「offenders 为空」，而一个扫不到
 * 任何文件的 walker 同样给出空 —— 那种绿灯什么都没证明。`REPO` 算错一级、某个
 * 根被改名、递归断掉，三种情况都是这个形状。测试文件从 scripts/ 搬进 tests/ 时
 * `REPO` 的层级正好变了，所以这不是假想风险。
 *
 * 两条断言各管一种失效：逐根 `> 0` 抓「某个根不再有文件」，总量下限抓「进了根
 * 目录但没递归进子目录」—— src/ 顶层只有 layers.mjs，光看逐根会漏过后者。
 */
function sweepSourceRoots(visit) {
  let scanned = 0
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (!e.isFile() || !e.name.endsWith('.mjs') || e.name.endsWith('.test.mjs')) continue
      scanned += 1
      visit(abs, path.relative(REPO, abs).split(path.sep).join('/'))
    }
  }
  for (const root of ROOTS) {
    const abs = path.join(REPO, root)
    const before = scanned
    if (fs.existsSync(abs)) walk(abs)
    // tests/ 目前全是 `.test.mjs`，被上面的过滤器排掉，所以它一个都不贡献 ——
    // 这是预期的，不能要求它 > 0。
    if (root === 'tests') continue
    assert.ok(scanned > before, `${root}/ 下一个非测试 .mjs 都没扫到 —— REPO 层级算错了，或这个根已改名/被删`)
  }
  assert.ok(scanned >= 30, `全仓库只扫到 ${scanned} 个非测试 .mjs —— 递归可能断了，源级锁正在空过`)
}

/** 覆盖四种条目的样板 spec。逐个测试就地改造它，避免共享可变状态。 */
const SPEC = {
  '--out': { key: 'out' },
  '--quiet': { key: 'quiet', flag: true },
  '--check': { key: 'mode', set: 'check' },
  '--write': { key: 'mode', set: 'write' },
  '--tag': { key: 'tags', list: true },
}

// ---------------------------------------------------------------------------
// 四种条目
// ---------------------------------------------------------------------------

test('取值型吃掉下一个 argv；flag / set 型不吃', () => {
  const { options, error } = parseFlags(['--out', 'x.json', '--quiet', '--check'], SPEC, MESSAGES_ZH)
  assert.equal(error, undefined)
  assert.deepEqual(options, { tags: [], out: 'x.json', quiet: true, mode: 'check' })
})

test('list 型累积，且 key 恒被预置成 []（返回形状与 argv 内容无关）', () => {
  assert.deepEqual(parseFlags([], SPEC, MESSAGES_ZH).options, { tags: [] })
  assert.deepEqual(
    parseFlags(['--tag', 'a', '--tag', 'b'], SPEC, MESSAGES_ZH).options.tags,
    ['a', 'b'],
  )
  // 预置的意义：调用方可以无条件 `options.tags.map(...)`。若改成"出现才建数组"，
  // 每个调用方都得自己 `?? []` —— 那是把缺省值扩散到 10 个地方。
  assert.deepEqual(Object.keys(parseFlags([], { '--t': { key: 'v' } }, MESSAGES_ZH).options), [])
})

test('同一 key 的两个 set 字面量 = 后者胜（render-docs 的模式对语义）', () => {
  const mode = (argv) => parseFlags(argv, SPEC, MESSAGES_ZH).options.mode
  assert.equal(mode(['--write', '--check']), 'check')
  assert.equal(mode(['--check', '--write']), 'write')
  assert.equal(mode([]), undefined, '没给模式就不该有 mode —— 缺省值属于调用方')
})

test('set 的常量为假值时依然是 set 型 —— 锁住 `in` 而不是真值判断', () => {
  // 这条是本文件里最"没必要"也最必要的一条：现有两个常量都是真值，所以把
  // `'set' in entry` 改成 `entry.set` 今天不会让任何测试变红。而一旦有人登记
  // 一个 `set: false` 或 `set: ''`，那份实现会掉进取值分支，把**下一个参数**
  // 当成它的值吃掉 —— 静默吃参数，没人看得见。
  const spec = {
    '--off': { key: 'flag', set: false },
    '--none': { key: 'text', set: '' },
    '--rest': { key: 'rest' },
  }
  const { options, error } = parseFlags(['--off', '--none', '--rest', 'kept'], spec, MESSAGES_ZH)
  assert.equal(error, undefined)
  assert.deepEqual(options, { flag: false, text: '', rest: 'kept' })
})

// ---------------------------------------------------------------------------
// 未知参数
// ---------------------------------------------------------------------------

test('未知参数按方言报错，且在第一个错误处立即返回', () => {
  assert.equal(parseFlags(['--bogus'], SPEC, MESSAGES_ZH).error, '未知参数：--bogus')
  assert.equal(parseFlags(['--bogus'], SPEC, MESSAGES_EN).error, 'unknown argument: --bogus')
  // 只报第一个：合并前 9 份实现都是"遇到就 throw"，一次一条。改成汇总会让
  // 各 CLI 那句单行前缀（`检查器无法运行：…`）变成多行。
  assert.equal(parseFlags(['--first', '--second'], SPEC, MESSAGES_ZH).error, '未知参数：--first')
  assert.equal(parseFlags(['--bogus'], SPEC, MESSAGES_ZH).options, undefined, '出错时不返回半份 options')
})

test('原型链上的名字算未知参数 —— 锁住 hasOwnProperty 而不是 spec[arg]', () => {
  // `spec['__proto__']` 会拿到 Object.prototype：真值，于是 `entry.flag` /
  // `'set' in entry` 都为假，实现会走取值分支，把下一个 argv 当成它的值，
  // 并写进 `options[undefined]`。也就是说没有这层保护，`__proto__` 是一个
  // **可用的、能吃参数的、还会污染 options 的**参数名。
  for (const name of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    const r = parseFlags([name, 'value'], SPEC, MESSAGES_ZH)
    assert.equal(r.error, `未知参数：${name}`, `${name} 必须被当作未知参数`)
    assert.equal(r.options, undefined)
  }
})

// ---------------------------------------------------------------------------
// 缺值
// ---------------------------------------------------------------------------

test('取值型与 list 型在 argv 末尾缺值 ⇒ 按方言报错', () => {
  // 这是合并时**新增**的检测：12 份里有 11 份没有它，后果从"静默少干活"
  // （check --report ⇒ 不写报告却退出 0）到"污染 canonical"
  // （migrate --block ⇒ 往 dictionary.yaml 里写一个 null）。
  assert.equal(parseFlags(['--out'], SPEC, MESSAGES_ZH).error, '缺少 --out 的值')
  assert.equal(parseFlags(['--out'], SPEC, MESSAGES_EN).error, 'missing value for --out')
  assert.equal(parseFlags(['--tag'], SPEC, MESSAGES_ZH).error, '缺少 --tag 的值')
  assert.equal(parseFlags(['--tag', 'a', '--tag'], SPEC, MESSAGES_ZH).error, '缺少 --tag 的值')
})

test('值长得像参数照样被收下 —— 这是**有意**不做的收紧', () => {
  // argv.mjs 声明：只检测"值不存在"，因为那个无歧义；拒绝以 `-` 开头的值会
  // 误伤合法的负数与破折号开头的值，属于改语义。没有这条测试，下一个人会把
  // 它当漏洞补掉，而补掉会让今天成功的调用开始失败。
  assert.equal(parseFlags(['--out', '--quiet'], SPEC, MESSAGES_ZH).options.out, '--quiet')
  assert.deepEqual(parseFlags(['--out', '-1'], SPEC, MESSAGES_ZH).options.out, '-1')
  // 且被当成值的那个字面量**不再**作为参数解析：`--quiet` 没有变成 true。
  assert.equal(parseFlags(['--out', '--quiet'], SPEC, MESSAGES_ZH).options.quiet, undefined)
})

test('`--flag=value` 是未知参数 —— 另一处**有意**不做的收紧', () => {
  // 支持这个语法是新功能，且会把"报错"变成"接受"。
  assert.equal(parseFlags(['--out=x.json'], SPEC, MESSAGES_ZH).error, '未知参数：--out=x.json')
})

// ---------------------------------------------------------------------------
// validate：唯一被允许自己处理缺值的入口
// ---------------------------------------------------------------------------

test('validate 收到的缺值实参恰好是 undefined，且它的返回串原样成为 error', () => {
  const seen = []
  const spec = { '--fmt': { key: 'fmt', validate: (v) => { seen.push(v); return v === 'ok' ? null : `bad: ${v ?? '(缺失)'}` } } }

  assert.equal(parseFlags(['--fmt', 'ok'], spec, MESSAGES_ZH).options.fmt, 'ok')
  assert.equal(parseFlags(['--fmt', 'no'], spec, MESSAGES_ZH).error, 'bad: no')
  // 缺值时**不**走通用文案：那句会覆盖掉 trust-report 被测试钉住的
  // `--format 只接受 json 或 md，收到：(缺失)`。
  assert.equal(parseFlags(['--fmt'], spec, MESSAGES_ZH).error, 'bad: (缺失)')
  assert.deepEqual(seen, ['ok', 'no', undefined])
})

test('全仓库每一个已注册的 validate 都拒绝 undefined', async () => {
  // 这就是 argv.mjs 与 trust-report.mjs 两处注释承诺的那条测试。
  //
  // 逻辑：带 validate 的条目豁免了通用缺值检测 —— 豁免本身是必要的（见上一条），
  // 但它同时是一个后门：一个接受 undefined 的 validate 会让该参数在 argv 末尾
  // 静默变成 `options[key] = undefined`，正好回到合并前那 11 份的缺陷形状。
  // 所以豁免必须配一条全局义务。
  const consumers = argvConsumers()
  const withValidate = consumers.filter((f) => /\bvalidate\s*:/.test(f.clean))
  assert.ok(withValidate.length > 0, '没扫到任何带 validate 的 spec —— 扫描器可能失效了')

  for (const file of withValidate) {
    const mod = await import(pathToFileURL(file.abs).href)
    assert.ok(
      mod.SPEC && typeof mod.SPEC === 'object',
      `${file.rel} 的 spec 里有 validate，但模块没有导出 \`SPEC\`。`
      + `带 validate 的条目豁免了通用缺值检测，所以它必须能被本测试触及 ——`
      + `藏在未导出的表里就成了没人看守的后门。请 \`export const SPEC\`。`,
    )
    const validators = Object.entries(mod.SPEC).filter(([, e]) => typeof e?.validate === 'function')
    assert.ok(validators.length > 0, `${file.rel} 源码里有 validate: 却没在导出的 SPEC 里 —— 还有第二张表？`)
    for (const [flag, entry] of validators) {
      const problem = entry.validate(undefined)
      assert.equal(
        typeof problem === 'string' && problem !== '', true,
        `${file.rel} 的 ${flag} 的 validate 接受了 undefined。`
        + `于是 \`${flag}\` 出现在 argv 末尾时会静默变成 undefined，而不是报错。`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// 没有默认方言
// ---------------------------------------------------------------------------

test('messages 缺失或不完整 ⇒ TypeError，不是 error 串', () => {
  // 给一个默认方言等于让新 CLI 静默继承我随手选的语言 —— 隐藏 fallback 的形状。
  // 抛 TypeError 而不是返回 error：这是调用方的 bug，该在开发期炸掉，不该
  // 伪装成一条用户看得懂的参数错误。
  for (const messages of [undefined, null, {}, { unknown: MESSAGES_ZH.unknown }, { missing: MESSAGES_ZH.missing }, { unknown: '不是函数', missing: MESSAGES_ZH.missing }]) {
    assert.throws(
      () => parseFlags([], SPEC, messages),
      (e) => e instanceof TypeError && /没有默认方言/.test(e.message),
      `messages=${JSON.stringify(messages)} 应抛 TypeError`,
    )
  }
})

test('两种方言各自完整，且 unknown 文案逐字沿用合并前的形态', () => {
  assert.equal(MESSAGES_ZH.unknown('--x'), '未知参数：--x')
  assert.equal(MESSAGES_EN.unknown('--x'), 'unknown argument: --x')
  for (const [name, m] of [['ZH', MESSAGES_ZH], ['EN', MESSAGES_EN]]) {
    for (const key of ['unknown', 'missing']) {
      assert.equal(typeof m[key], 'function', `MESSAGES_${name}.${key} 必须是函数`)
      assert.match(m[key]('--x'), /--x/, `MESSAGES_${name}.${key} 必须带上参数名，否则报错指不出是谁`)
    }
  }
})

// ---------------------------------------------------------------------------
// 两个包装
// ---------------------------------------------------------------------------

test('parseFlagsOrThrow：错误串原样成为 Error.message，成功则返回 options', () => {
  // 合并前 9 份都是"未知参数就 throw"，各自的 main 在 try 里打印带前缀的一行。
  // 这个包装让那 9 处的控制流一字不改 —— 所以 message 必须**恰好**是那个串，
  // 多一个字都会改掉九个 CLI 的 stderr。
  //
  // 用谓词而不是正则：`assert.throws(fn, /re/)` 匹配的是 `String(err)`，也就是
  // 带 `Error: ` 前缀的那一版。于是 `/^unknown argument/` 会**永远失败**，而
  // 去掉锚点的 `/unknown argument/` 又会连"message 里多了前缀"都发现不了。
  // 各 CLI 打印的是 `error.message`，所以断言也必须落在 message 上。
  const msg = (fn) => { try { fn(); return null } catch (e) { return e.message } }
  assert.equal(msg(() => parseFlagsOrThrow(['--bogus'], SPEC, MESSAGES_EN)), 'unknown argument: --bogus')
  assert.equal(msg(() => parseFlagsOrThrow(['--out'], SPEC, MESSAGES_EN)), 'missing value for --out')
  assert.equal(msg(() => parseFlagsOrThrow(['--bogus'], SPEC, MESSAGES_ZH)), '未知参数：--bogus')
  assert.deepEqual(parseFlagsOrThrow(['--quiet'], SPEC, MESSAGES_EN), { tags: [], quiet: true })
})

test('parseExactConfigFlag：定长 argv，多一个少一个都拒绝', () => {
  const usage = 'usage: node scripts/x.mjs --config <isolated absolute path>'
  const abs = path.resolve(REPO, 'x.json')

  assert.equal(parseExactConfigFlag(['--config', abs], usage), abs)
  for (const argv of [[], ['--config'], ['--config', abs, '--extra'], ['-c', abs], [abs], ['--conf', abs]]) {
    assert.throws(() => parseExactConfigFlag(argv, usage), new RegExp(usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${JSON.stringify(argv)} 应被拒绝并打印 usage`)
  }
  // 相对路径单独一条文案：daemon 的 config 必须是隔离快照里的绝对路径，
  // 相对路径会随 cwd 变化而指向别处。
  assert.throws(() => parseExactConfigFlag(['--config', 'relative.json'], usage), /--config must be an absolute isolated path/)
})

// ---------------------------------------------------------------------------
// 源级锁：文案单一来源、没有第三种方言、纯函数
// ---------------------------------------------------------------------------

/**
 * 全仓库 import 了 `shared/argv.mjs` 的非测试模块。
 *
 * 用 `blankComments` 剥注释后再匹配 —— 否则本次合并写下的那几段注释
 * （它们大量引用 `未知参数：` 与 `unknown argument: `）会被当成实现证据，
 * 正好是"文档说有、代码其实没有"的反面形状。
 */
function argvConsumers() {
  const out = []
  sweepSourceRoots((abs, rel) => {
    const clean = blankComments(fs.readFileSync(abs, 'utf8'))
    if (!/from\s*['"][^'"]*shared\/argv\.mjs['"]/.test(clean)) return
    out.push({ rel, abs, clean })
  })
  return out
}

test('两句 unknown 文案在全仓库只有一份定义', () => {
  // 合并的全部价值就在这一条上：从 10 份文案降到 2 份。若哪天又有人在自己的
  // CLI 里手写 `未知参数：${arg}`，这里会红 —— 那正是第 13 份解析器的起点。
  const offenders = []
  sweepSourceRoots((abs, rel) => {
    if (rel === 'src/shared/argv.mjs') return
    const clean = blankComments(fs.readFileSync(abs, 'utf8'))
    for (const literal of ['未知参数', 'unknown argument']) {
      if (clean.includes(literal)) offenders.push(`${rel}：${literal}`)
    }
  })
  assert.deepEqual(offenders, [], `unknown 文案只能定义在 src/shared/argv.mjs：\n${offenders.join('\n')}`)
})

test('没有第三种方言：每个消费者都用两个导出之一，且两个都在用', () => {
  const consumers = argvConsumers()
  assert.ok(consumers.length >= 10, `只扫到 ${consumers.length} 个消费者 —— 扫描器可能失效了`)

  const used = new Set()
  for (const f of consumers) {
    const dialects = ['MESSAGES_ZH', 'MESSAGES_EN'].filter((d) => f.clean.includes(d))
    // parseExactConfigFlag 的两个 daemon 不带 messages：它们的 usage 文案是
    // 自己的契约，不属于任何方言。
    const exact = f.clean.includes('parseExactConfigFlag')
    assert.equal(
      dialects.length + (exact ? 1 : 0) >= 1, true,
      `${f.rel} import 了 argv.mjs 却既没用 MESSAGES_ZH/EN 也没用 parseExactConfigFlag ——`
      + `是不是自带了一份内联文案？那就是第三种方言的起点。`,
    )
    assert.ok(dialects.length <= 1, `${f.rel} 同时引用了两种方言：${dialects.join(', ')}`)
    for (const d of dialects) used.add(d)
  }
  assert.deepEqual([...used].sort(), ['MESSAGES_EN', 'MESSAGES_ZH'], '两个方言导出都必须有人用，否则是死代码')
})

test('parseFlags 是纯函数：不改 argv、不改 spec、不写流', () => {
  const argv = ['--out', 'x', '--tag', 'a']
  const frozenSpec = Object.freeze({ ...SPEC })
  const before = [...argv]
  const first = parseFlags(argv, frozenSpec, MESSAGES_ZH)
  const second = parseFlags(argv, frozenSpec, MESSAGES_ZH)
  assert.deepEqual(argv, before, 'argv 不能被就地修改')
  assert.deepEqual(first.options, second.options, '同一输入必须得到同一结果')
  assert.notEqual(first.options.tags, second.options.tags, '两次调用不能共享同一个数组')
})

test('argv.mjs 只依赖 node:path —— 它被 trust-report 的"不落盘"源级断言间接覆盖', () => {
  // trust-report.test.mjs 断言 trust-report.mjs 的源码里没有 node:fs。那条断言
  // 只看单个文件，所以 argv.mjs 一旦 import 了 fs，它会**静默失效**：写文件的
  // 能力从依赖链进来，而那条正则看不见。这里把缺口补上。
  const src = fs.readFileSync(path.join(REPO, 'src/shared/argv.mjs'), 'utf8')
  const specs = [...blankComments(src).matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.deepEqual(specs, ['node:path'], 'argv.mjs 的依赖必须恰好是 node:path')
})
