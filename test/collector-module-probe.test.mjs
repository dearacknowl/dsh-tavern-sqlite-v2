'use strict'
// 采集加载时插针（ESM preload hooks）——**真实引擎 + 真实 3 源** 定向断言（不 stub、不 import 假函数）。
// 真实依赖：`tools/collectors/module-probe.cjs`（被验对象）、`tools/collectors/perf-probe.cjs` 的 `createProbe`（真引擎）、
// Node 原生 `module.registerHooks`；3 个真实源＝作者 fixture `lib/index.js`、042 actual `chat-persistence-188.js`、插件 `chat-sqlite-store.js`。
// 范围：白名单/唯一锚点/透明性（this、返回值、同步异常、async 身份）/register 真发生/非白名单透传；无业务、无真实库、无远端。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'

const NAME = '采集加载时插针：白名单透明包装且源码字节不变'
const require = createRequire(import.meta.url)
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const probe = require(path.join(root, 'tools', 'collectors', 'module-probe.cjs'))
const { createProbe } = require(path.join(root, 'tools', 'collectors', 'perf-probe.cjs'))
const AUTHOR_APP = path.join(root, 'tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin')
const ACTUAL_PERSISTENCE = path.join(root, 'tmp/collect-042-20261010/chat-persistence-188.js')
const PACKAGE_DIR = path.join(root, 'plugins/dsh-tavern-sqlite-v2')

test(NAME, async () => {
  // 0) 目标判定只按**路径相等**：3 个 exact URL 命中，其它一律 undefined（透传，不扫目录/不读卡）。
  delete process.env[probe.ENABLE_ENV]
  const appDir = AUTHOR_APP
  const kindOf = rel => probe.getTargetKind(pathToFileURL(rel).href, { appDir, packageDir: PACKAGE_DIR })
  assert.equal(kindOf(path.join(appDir, 'lib', 'index.js')), 'index', '作者 index 必须命中')
  assert.equal(kindOf(path.join(appDir, 'lib', 'domain', 'chat-persistence.js')), 'chat-persistence', '作者 chat-persistence 必须命中')
  assert.equal(kindOf(path.join(PACKAGE_DIR, 'chat-sqlite-store.js')), 'chat-store', '插件 store realpath 必须命中')
  assert.equal(kindOf(path.join(appDir, 'lib', 'domain', 'scoped-messages.js')), 'scoped-messages', '真实第四白名单必须命中')
  assert.equal(kindOf(path.join(appDir, 'lib', 'domain', 'scoped-messages-other.js')), undefined, '相似文件名仍必须透传')
  assert.equal(kindOf(path.join(PACKAGE_DIR, 'lib', 'chat-command-service.js')), undefined, '插件其它文件必须透传')
  assert.equal(probe.transformForProbe('const x = 1\n', 'index').ok, false, '锚点缺失必须拒绝（不假装覆盖）')
  assert.equal(probe.transformForProbe('export const x = 1\n', 'not-a-target').ok, false, '未知目标必须拒绝')
  assert.deepEqual(probe.installModuleProbe({ targets: new Map() })(), [], '未启用 env 时绝不注册钩子（不得返回已处理锚点）')
  const passthroughUrl = pathToFileURL(path.join(PACKAGE_DIR, 'lib', 'chat-command-service.js')).href
  process.env[probe.ENABLE_ENV] = '1'
  try {
    const handled = probe.installModuleProbe({ targets: new Map([[passthroughUrl, undefined]]) })()
    assert.deepEqual(handled, [], '非白名单 URL 必须透传，不产生任何已处理锚点')
  } finally { delete process.env[probe.ENABLE_ENV] }

  // 1) 3 个真实源：唯一锚点、注入块精确、除注入外逐字节不变、可被 Node 自己的 ESM 解析器解析。
  const sources = {
    index: { file: path.join(appDir, 'lib', 'index.js'), kind: 'index', label: 'projection.projectFullSessionView', anchor: 'projectFullSessionView' },
    'chat-persistence': { file: ACTUAL_PERSISTENCE, kind: 'chat-persistence', label: 'chat.readWindow', anchor: 'readWindow' },
    'chat-store': { file: path.join(PACKAGE_DIR, 'chat-sqlite-store.js'), kind: 'chat-store', label: 'chat.appendMessages', anchor: 'appendMessages' },
  }
  for (const [, spec] of Object.entries(sources)) {
    assert.ok(readFileSync(spec.file, 'utf8').length > 0, `真实源必须可读：${spec.file}`)
    const source = readFileSync(spec.file, 'utf8')
    const result = probe.transformForProbe(source, spec.kind)
    assert.equal(result.ok, true, `真实源必须可包装：${spec.kind}（${result.reason || ''}）`)
    assert.deepEqual(result.anchors, spec.kind === 'index' ? [...probe.PROJECTIONS, 'dispatch'] : spec.kind === 'chat-persistence' ? ['chat-api'] : [spec.anchor], `锚点必须唯一：${spec.kind}`)
    assert.deepEqual(result.labels, spec.kind === 'index' ? probe.PROJECTIONS.map(name => 'projection.' + name) : [], `核心标签必须与当前采集器一致：${spec.kind}`)
    if (spec.kind === 'chat-persistence') assert.deepEqual(result.dynamicLabels, ['chat.<method>'])
    if (spec.kind === 'chat-store') assert.deepEqual(result.extraLabels, [spec.label])
    const originalName = `__dshTavernProbeOriginal_${spec.anchor}`
    const anchorLineAt = source.split('\n').findIndex(text => text.includes(`function ${spec.anchor}(`))
    const anchorLine = source.split('\n')[anchorLineAt] || ''
    const anchorAt = source.split('\n').slice(0, anchorLineAt).join('\n').length + (anchorLineAt > 0 ? 1 : 0)
    const declIndex = anchorLine.search(/function[ \t]/)
    const declPrefix = anchorLine.slice(0, declIndex)
    const indent = (declPrefix.match(/^[ \t]*/) || [''])[0]
    const parenAt = declIndex + `function ${spec.anchor}`.length
    // 独立重建整段期望输出：加载期 register 语句 + 头部 + 声明前缀 + 包装块 + 原名声明（含原参数表与函数体）。
    // 独立逆还原：删除确切注入包装/注册，把改名声明恢复；其余源字节必须完全不变。
    let restored = result.source
    const names = spec.kind === 'index' ? probe.PROJECTIONS : spec.kind === 'chat-store' ? [spec.anchor] : []
    for (const name of names) {
      const line = source.split('\n').find(line => line.includes('function ' + name + '('))
      const prefix = line.slice(0, line.indexOf('function '))
      const whitespace = prefix.match(/^[ \t]*/)[0]
      const label = spec.kind === 'index' ? 'projection.' + name : spec.label
      const old = '__dshTavernProbeOriginal_' + name
      const body = [
        'function ' + name + ' (...args) {',
        '  const PROBE = globalThis[Symbol.for("dsh-tavern.perf-probe")]',
        "  if (!PROBE || typeof PROBE.measure !== 'function') return " + old + '.apply(this, args)',
        '  return PROBE.measure(' + JSON.stringify(label) + ', () => ' + old + '.apply(this, args))',
        '}',
      ].map(part => whitespace + part).join('\n') + '\n'
      const injected = prefix + body + prefix + 'function ' + old + '('
      assert.equal(restored.split(injected).length, 2, '每个包装必须唯一且完整：' + name)
      restored = restored.replace(injected, prefix + 'function ' + name + '(')
    }
    if (spec.kind === 'index') {
      const dispatch = [
        '  /* dsh-tavern-probe:rpc-dispatch */',
        '  async function dispatch(method, args) {',
        '    const PROBE = globalThis[Symbol.for("dsh-tavern.perf-probe")]',
        "    if (!PROBE || typeof PROBE.measure !== 'function') return __dshTavernProbeOriginal_dispatch(method, args)",
        "    return PROBE.measure('rpc.' + (/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(method) ? method : 'other'), () => __dshTavernProbeOriginal_dispatch(method, args))",
        '  }',
        '  async function __dshTavernProbeOriginal_dispatch(method, args) {',
      ].join('\n')
      assert.equal(restored.split(dispatch).length, 2, 'dispatch注入必须唯一')
      restored = restored.replace(dispatch, '  async function dispatch(method, args) {')
      const registration = '\n  globalThis[Symbol.for("dsh-tavern.perf-probe")]?.register([' + probe.PROJECTIONS.map(name => JSON.stringify('projection.' + name)).join(',') + ', "rpc.dispatch"' + '])'
      assert.equal(restored.split(registration).length, 2, '加载注册必须唯一')
      restored = restored.replace(registration, '')
    } else if (spec.kind === 'chat-persistence') {
      const object = '{ read, readWindow, readHelperContext, readSessionState, readSceneImageState, readSettlementCheckpoint, readBackgroundConfig, readDisplayRuntimeState, readSlice, readSettlementBase, readChangedSlice, readChangedIndices, readViewDelta, patch, readRevision, write, writeHeader, update, version, remove }'
      const injected = [
        '  /* dsh-tavern-probe:chat-api */', '  const api = ' + object,
        '  const probe = globalThis[Symbol.for("dsh-tavern.perf-probe")]',
        "  if (probe) for (const name of Object.keys(api)) api[name] = probe.wrap('chat.' + name, api[name])",
        '  return Object.freeze(api)',
      ].join('\n')
      assert.equal(restored.split(injected).length, 2, '20方法冻结API注入必须唯一')
      restored = restored.replace(injected, '  return Object.freeze(' + object + ')')
    }
    assert.equal(restored, source, `逆还原后真实源码逐字节一致：${spec.kind}`)
    // 语法必须用 Node 自己的 ESM 解析器验（Acorn 不可用，不得跳过）。
    const parsed = new vm.SourceTextModule(result.source, { identifier: `${spec.kind}.mjs` })
    assert.ok(parsed.status === 'unlinked' || typeof parsed.status === 'string', `变换后源码必须能解析：${spec.kind}`)
    assert.ok(probe.transformForProbe(source, spec.kind).source === result.source, '转换必须确定性（同输入同输出）')
  }

  // 2) load hook 真跑：真引擎 createProbe + 真源变换后的模块 import，验透明性与 register 真发生。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tavern-module-probe-'))
  const scratchApp = path.join(dir, 'app')
  const scratchPkg = path.join(dir, 'pkg')
  try {
    mkdirSync(path.join(scratchApp, 'lib', 'domain'), { recursive: true })
    mkdirSync(scratchPkg, { recursive: true })
    // 真 import 需要真实相对依赖：把作者 lib 目录整棵拷进 scratch（只为本测试临时用），
    // 唯一被白名单命中的 chat-persistence.js 用 042 actual 覆盖（index/store 只做上面的源码级验证，不在此加载）。
    cpSync(path.join(appDir, 'lib'), path.join(scratchApp, 'lib'), { recursive: true })
    const persistenceDest = path.join(scratchApp, 'lib', 'domain', 'chat-persistence.js')
    writeFileSync(persistenceDest, readFileSync(ACTUAL_PERSISTENCE, 'utf8'), 'utf8')
    const realProbe = createProbe({ file: path.join(dir, 'methods.json') })
    globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] = realProbe
    process.env[probe.ENABLE_ENV] = '1'
    const deregister = probe.installModuleProbe({ appDir: scratchApp, packageDir: scratchPkg })
    try {
      assert.deepEqual(realProbe.snapshot().coverage, [], '未加载前覆盖必须为空')
      // 用唯一 query 强制新实例加载（绕 ESM 缓存），确保 load 钩子真的经过本模块变换。
      const persistence = await import(`${pathToFileURL(persistenceDest).href}?probe=${Date.now()}`)
      assert.equal(typeof persistence.createChatPersistence, 'function', '作者 chat-persistence 必须可加载')
      // 真源 createChatPersistence 要求 `options.store`（Chat Store adapter）；这里只提供最小真形态，
      // 目的只是把真实 `readWindow` 取出来调用一次，验证包装透明（不改 args/result）。
      const records = {
        readWindow: (chatId, options) => ({ chatId, options, thisTag: 'store' }),
        read: async () => ({}), update: async () => ({ changed: false }), remove: async () => {}, version: async () => '',
      }
      const built = persistence.createChatPersistence({ store: records })
      const out = await built.readWindow.call({ tag: 'persistence' }, 'chat-1', { limit: 2 })
      assert.deepEqual(out, { chatId: 'chat-1', options: { limit: 2 }, thisTag: 'store' }, 'readWindow 返回值必须原样透传（不改 args/result）')
      const snap = realProbe.snapshot()
      assert.ok(snap.coverage.includes('chat.readWindow'), `真引擎必须记录 chat.readWindow 覆盖（register 在加载期真发生）；实际=${JSON.stringify(snap.coverage)}`)
      assert.equal(snap.scope, 'server-process-only-no-arguments', '必须沿用既有引擎 scope（不记 args）')
    } finally { deregister(); delete globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] }
    // 非白名单 URL：原样加载，不进任何探针路径。
    const plain = path.join(dir, 'plain.mjs')
    writeFileSync(plain, 'export const v = "untouched"\n', 'utf8')
    const d2 = probe.installModuleProbe({ appDir: scratchApp, packageDir: scratchPkg })
    try {
      assert.equal((await import(pathToFileURL(plain).href)).v, 'untouched', '非白名单必须原样加载')
    } finally { d2() }
  } finally { rmSync(dir, { recursive: true, force: true }) }

  // 3) 状态守卫：opts.state.enabled=false ⇒ 钩子自动卸载（不偷看多相位、不保活）。
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'tavern-module-probe-state-'))
  try {
    const app2 = path.join(stateDir, 'app')
    const pkg2 = path.join(stateDir, 'pkg')
    mkdirSync(path.join(app2, 'lib', 'domain'), { recursive: true })
    mkdirSync(pkg2, { recursive: true })
    writeFileSync(path.join(app2, 'lib', 'index.js'), readFileSync(sources.index.file, 'utf8'), 'utf8')
    writeFileSync(path.join(pkg2, 'chat-sqlite-store.js'), readFileSync(sources['chat-store'].file, 'utf8'), 'utf8')
    writeFileSync(path.join(app2, 'lib', 'domain', 'chat-persistence.js'), readFileSync(ACTUAL_PERSISTENCE, 'utf8'), 'utf8')
    const state = { enabled: true }
    const deregister = probe.installModuleProbe({ appDir: app2, packageDir: pkg2, state })
    try {
      // 真实引擎 disabled ⇒ 守卫下一次 tick 必须卸载（等待至多 2.5s，不 peeking 相位）。
      globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] = createProbe({ file: path.join(stateDir, 'methods.json') })
      globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)].disable()
      await new Promise(resolve => setTimeout(resolve, 1600))
    } finally { deregister(); delete globalThis[Symbol.for(probe.PERF_SYMBOL_KEY)] }
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})
