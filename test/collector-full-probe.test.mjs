'use strict'
// 完整方法采集插针（原版边界全覆盖）——**真实来源 + 真引擎 + 真 ESM 加载** 定向断言（单具名，一次跑完）：
// 期望标签＝原版冻结 `run-7IY4Xc-baseline-extract.json` 的 `coverage`（26 条，读文件当权威，不硬编第二份）；
// 真源＝新鲜实际文件 `index-full-188.js`、`scoped-messages-188.js`、`chat-persistence-188.js`、插件 `chat-sqlite-store.js`；
// 引擎＝既有 `tools/collectors/perf-probe.cjs` 的 `createProbe`；只验机制与透明性，不读业务/真实库/远端。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'

const NAME = '完整方法采集：原版边界全覆盖且包装不改变行为'
const require = createRequire(import.meta.url)
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const probe = require(path.join(root, 'tools', 'collectors', 'module-probe.cjs'))
const { createProbe } = require(path.join(root, 'tools', 'collectors', 'perf-probe.cjs'))
const ACTUAL = {
  index: path.join(root, 'tmp/collect-042-20261010/index-full-188.js'),
  'chat-persistence': path.join(root, 'tmp/collect-042-20261010/chat-persistence-188.js'),
  'scoped-messages': path.join(root, 'tmp/collect-042-20261010/scoped-messages-188.js'),
  'chat-store': path.join(root, 'plugins/dsh-tavern-sqlite-v2/chat-sqlite-store.js'),
}
const AUTHOR_LIB = path.join(root, 'tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib')
const EXPECTED = JSON.parse(readFileSync(path.join(root, 'tmp/collect-20261005/run-7IY4Xc-baseline-extract.json'), 'utf8')).coverage

test(NAME, async () => {
  // 1) 期望标签：原版冻结 JSON 为唯一权威；变换声明的核心标签必须与之逐条对应。
  assert.equal(EXPECTED.length, 26, '原版 coverage 必须 26 条')
  assert.deepEqual([...probe.CORE_LABELS].sort(), [...EXPECTED].sort(), '核心标签必须与原版 26 完全一致（4 投影 + 20 chat + 2 scoped）')
  assert.equal(probe.CHAT_METHODS.length, 20, 'chat API 必须 20 个')
  assert.equal(probe.PROJECTIONS.length, 4, '投影必须 4 个')
  assert.ok(!probe.LABELS.includes('rpc.other'), '不得预注册固定 rpc 假名（rpc.* 由实际调用生成）')

  // 2) 四个真实源：literal 锚点唯一命中、变换后可被 Node 自身 ESM 解析器解析、每处改动都能定位。
  const shapes = {}
  for (const [kind, file] of Object.entries(ACTUAL)) {
    const source = readFileSync(file, 'utf8')
    assert.ok(source.length > 0, `真实源必须存在且非空：${file}`)
    const result = probe.transformForProbe(source, kind)
    assert.equal(result.ok, true, `真实源必须可变换：${kind}（${result.reason || ''}）`)
    new vm.SourceTextModule(result.source, { identifier: `${kind}.mjs` })   // 语法必须由 Node 自己验
    assert.ok(result.source.length > source.length, `必须注入包装：${kind}`)
    assert.ok(!result.source.includes('__dshTavernProbeOriginal_appendMessages.measure'), '包装不得自我递归')
    shapes[kind] = result
  }
  assert.deepEqual(shapes.index.anchors, [...probe.PROJECTIONS, 'dispatch'], 'index 必须包 4 投影 + dispatch')
  assert.deepEqual(shapes.index.capabilityLabels, [probe.RPC_CAPABILITY_LABEL], 'index 必须注册 rpc capability 标签')
  assert.deepEqual(shapes.index.dynamicLabels, ['rpc.<method>'], 'RPC 必须是动态 label')
  assert.deepEqual(shapes['chat-persistence'].dynamicLabels, ['chat.<method>'], 'chat API 必须是按真实 keys 动态 label')
  assert.deepEqual(shapes['scoped-messages'].labels, ['scoped.ownedRead', 'scoped.baseRead'], 'scoped 必须两条真实入口')
  assert.deepEqual(shapes['chat-store'].extraLabels, [probe.SQL_EXTRA_LABEL], 'SQL 追加标签必须单列、不冒充原版别名')
  // 原函数体必须原样保留（只被改名，不改内容）：逐条核对声明后的签名/参数表仍在变换结果里。
  const renamed = name => `function __dshTavernProbeOriginal_${name}`
  assert.ok(shapes.index.source.includes(renamed('projectCachedSessionView') + '(chat, previous, activity)'), '原投影签名必须保留')
  assert.ok(shapes.index.source.includes(renamed('projectFullSessionView') + '(chat, { windowHelperMessages = false, inputChanges, deferResources } = {})'), '原 full 投影参数表必须保留')
  assert.ok(shapes.index.source.includes(renamed('dispatch') + '(method, args)'), '原 dispatch 签名必须保留')
  assert.ok(shapes['chat-store'].source.includes(renamed('appendMessages') + '(chatId, expectedRevision'), '原 appendMessages 签名必须保留')
  assert.ok(shapes['scoped-messages'].source.includes('const read = () => owned.has(key) ? owned.get(key) : readBase?.(Number(key))'), 'scoped 原读逻辑必须原样保留')
  assert.ok(shapes['chat-persistence'].source.includes('const api = { read, readWindow'), 'chat API 字面量必须原样搬入 api')

  // 3) 运行时透明性（真引擎 + 真加载）：chat API 冻结对象、scoped 代理、RPC dispatch 的 this/返回/异常/async
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tavern-full-probe-'))
  const scratchApp = path.join(dir, 'app')
  const scratchPkg = path.join(dir, 'pkg')
  try {
    mkdirSync(path.join(scratchApp, 'lib', 'domain'), { recursive: true })
    mkdirSync(scratchPkg, { recursive: true })
    // 真 import 需要真实相对依赖：拷贝作者 lib 目录，再用本轮 actual 覆盖目标两件（只为本测试临时用）。
    cpSync(AUTHOR_LIB, path.join(scratchApp, 'lib'), { recursive: true })
    const chatDest = path.join(scratchApp, 'lib', 'domain', 'chat-persistence.js')
    const scopedDest = path.join(scratchApp, 'lib', 'domain', 'scoped-messages.js')
    writeFileSync(chatDest, readFileSync(ACTUAL['chat-persistence'], 'utf8'), 'utf8')
    writeFileSync(scopedDest, readFileSync(ACTUAL['scoped-messages'], 'utf8'), 'utf8')
    const realProbe = createProbe({ file: path.join(dir, 'methods.json') })
    globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] = realProbe
    process.env[probe.ENABLE_ENV] = '1'
    const deregister = probe.installModuleProbe({ appDir: scratchApp, packageDir: scratchPkg })
    try {
      // chat-persistence：20 个 API 被 wrap 且对象仍冻结；调用透明（this/返回）、错误透传、async 身份保持
      const chat = await import(`${pathToFileURL(chatDest).href}?full=${Date.now()}`)
      assert.equal(typeof chat.createChatPersistence, 'function', 'chat-persistence 必须可加载')
      const store = {
        readWindow: (chatId, options) => ({ chatId, options, thisTag: 'store' }),
        read: async () => ({}), update: async () => ({ changed: false }), remove: async () => {}, version: async () => '',
      }
      const api = chat.createChatPersistence({ store })
      assert.ok(Object.isFrozen(api), 'chat API 必须仍是冻结对象')
      const chatKeys = Object.keys(api).filter(key => /^[a-z][A-Za-z0-9]*$/.test(key))
      assert.equal(chatKeys.length, 20, `chat API 必须暴露 20 个方法（实际 ${chatKeys.length}）`)
      const coveredAfterWrap = realProbe.snapshot().coverage
      for (const name of probe.CHAT_METHODS) assert.ok(coveredAfterWrap.includes(`chat.${name}`), `wrap 后必须已注册 chat.${name}`)
      const before = coveredAfterWrap.length
      const out = await api.readWindow('chat-1', { limit: 2 })
      assert.deepEqual(out, { chatId: 'chat-1', options: { limit: 2 }, thisTag: 'store' }, 'readWindow 返回值必须原样透传')
      const after = realProbe.snapshot()
      assert.ok(after.coverage.includes('chat.readWindow'), '真引擎必须记录 chat.readWindow（动态 label）')
      assert.ok(after.coverage.length >= before, '覆盖只增不减')
      assert.ok(!after.coverage.includes('chat.other'), '不得注册不存在的假 chat 标签')
      // readRevision 在最小 store 下必须原样抛真实错误（不吞、不改写），且计数仍被记到
      await assert.rejects(() => api.readRevision('chat-1'), /当前 Chat Store 不支持按 revision 读取/, '错误必须原样抛出')
      assert.ok(realProbe.snapshot().coverage.includes('chat.readRevision'), '抛错路径的 label 也必须被记到')

      // scoped：真实 proxy 入口两条都透明（owned 命中 / base 回退），异常原样抛
      const scoped = await import(`${pathToFileURL(scopedDest).href}?full=${Date.now()}`)
      const built = scoped.createScopedMessages(3, [[1, { id: 1, value: 'owned-row' }]], index => ({ id: index, value: 'base-row' }))
      assert.deepEqual(built[1], { id: 1, value: 'owned-row' }, 'scoped owned 读取必须原样返回')
      assert.deepEqual(built[2], { id: 2, value: 'base-row' }, 'scoped base 回退必须原样返回')
      const scopedCoverage = realProbe.snapshot().coverage
      assert.ok(scopedCoverage.includes('scoped.ownedRead') && scopedCoverage.includes('scoped.baseRead'), '两条 scoped 入口都必须被记到')
      assert.throws(() => scoped.createScopedMessages(-1, []), /Invalid message count/, '错误必须原样抛出（不吞异常）')

      // RPC dispatch 合成等价 wrapper：验证动态 label 逻辑本身（不加载整棵 index 依赖树）
      const dynamicLabel = method => 'rpc.' + (/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(method) ? method : 'other')
      const calls = []
      const originalDispatch = async function (m, a) { calls.push([this && this.tag, m, a]); if (m === 'boom') throw new Error('dispatch 原始错误'); return { method: m, args: a } }
      const wrappedDispatch = async function (m, a) {
        const PROBE = globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)]
        if (!PROBE || typeof PROBE.measure !== 'function') return originalDispatch.call(this, m, a)
        return PROBE.measure(dynamicLabel(m), () => originalDispatch.call(this, m, a))
      }
      const result = await wrappedDispatch.call({ tag: 'receiver' }, 'getUpdateStatus', { any: 'args' })
      assert.deepEqual(result, { method: 'getUpdateStatus', args: { any: 'args' } }, `dispatch 返回值必须原样透传（实际 ${JSON.stringify(result)}）`)
      assert.deepEqual(calls[0][0], 'receiver', 'dispatch 必须保留 this')
      const labeled = realProbe.snapshot().methods.map(row => row.method)
      assert.ok(labeled.includes('rpc.getUpdateStatus'), 'RPC 动态 label 必须由实际方法名生成（记在 methods，不预注册 coverage）')
      await assert.rejects(() => wrappedDispatch.call({ tag: 'receiver' }, 'boom', {}), /dispatch 原始错误/, 'dispatch 异常必须原样透传')
      await wrappedDispatch.call({ tag: 'receiver' }, 'bad name!', {})
      assert.ok(realProbe.snapshot().methods.map(row => row.method).includes('rpc.other'), '非法方法名必须归入 rpc.other（不伪造具体名）')
      assert.ok(!labeled.some(name => /args|payload|content/i.test(name)), '不得记录任何 args/正文')
      // 引擎缺失时必须完全透明（不注册、不抛、原样返回）
      delete globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)]
      const passthrough = await wrappedDispatch.call({ tag: 'receiver' }, 'getUpdateStatus', { any: 'args' })
      assert.deepEqual(passthrough, { method: 'getUpdateStatus', args: { any: 'args' } }, '无引擎时必须原样透传')
      globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] = realProbe
    } finally { deregister(); delete globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
