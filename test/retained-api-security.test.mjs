// [dsh-tavern-retained-api-security:v1]
//
// 保留的旧公开 API 的两类**安全/兼容**回归（只锁合同，不测主 VM 内部实现）：
//   ① `lib/mvu/mvu-script-sandbox.js` 的 `createScriptRuntime` 兼容垫片 —— 旧签名/旧可见字段仍在、
//      **每次调用都是新实例**，且**不得**保留 realm 逃逸口：只能判"能否取得宿主 realm 对象或宿主
//      process"；context realm 自己的 `Function` 构造器**不算逃逸**（字符串编译被关，利用不成功）。
//   ② `lib/card-script-dispatch-store.js` 的**可丢弃缓存**读取 —— 合法但非 plain object 的 JSON
//      （`null` / 数字 / 字符串 / 布尔 / 数组）必须被丢弃回落空缓存，**不崩、不写坏、不改权威**；
//      解析产物必须落在 null 原型容器，`__proto__` 类卡路径不得读到祖先、不得污染 Object.prototype。
//
// ⚠ 本文件按"只实施/语法"要求编写，尚未执行（主 VM 仍在改动中）。断言只依赖**稳定合同**：
//   旧导出名与可见字段、`dispose` 回执（clearedTimers）、"不得取得宿主对象/宿主 process"，
//   不比对 `mvu-card-runtime.js` 的内部结构、不新增旧版没有的能力期待（不查内部待办表）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createScriptRuntime,
  bridgeServerEvents,
} from '../lib/mvu/mvu-script-sandbox.js'
import { createCardScriptDispatchStore } from '../lib/card-script-dispatch-store.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeTempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeTempJson(root, name, payload) {
  const file = path.join(root, name)
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  return file
}

/**
 * 等 50ms 防抖落盘**真的完成**再返回（按内容判定，不靠固定 sleep）。
 * 必要性：`persist()` 是 50ms 后写文件；若测试在防抖窗口内 `rmSync` 临时目录，写盘会失败，
 * 而 `保存计时器` 在回调里已把自己置 null ⇒ 之后不会再写，测试挂不住但也拿不到落盘证据。
 */
async function waitForFile(file, matcher, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const text = readFileSync(file, 'utf8'); if (matcher(text)) return text } catch { /* 尚未落盘 */ }
    await tick(20)
  }
  throw new Error('等待落盘超时：' + file)
}

/** 跑一个 classic 脚本源码，返回 { runtime, ok, error }。 */
async function runScript({ key, code, hostApi = {}, timeoutMs = 2000 }) {
  const runtime = createScriptRuntime({
    scriptId: key,
    sources: [{ name: key + '.js', code }],
    hostApi,
    timeoutMs,
    logger: silent,
  })
  const compiled = runtime.compiled
  return { runtime, ok: compiled[0]?.ok === true, error: compiled[0]?.error }
}

test('保留API兼容：createScriptRuntime 旧签名与可见字段（events/errors/compiled/dispatchEvent/dispose）', async () => {
  const { runtime, ok, error } = await runScript({
    key: 'retained-api-contract',
    code: [
      'eventOn("MESSAGE_RECEIVED", function (id) { globalThis.contractSeen = String(id) })',
    ].join('\n'),
    hostApi: {},
  })
  try {
    assert.equal(ok, true, '脚本必须加载成功：' + String(error))
    assert.equal(runtime.scriptId, 'retained-api-contract', 'scriptId 必须保留调用方原值')
    assert.equal(typeof runtime.timeoutMs, 'number', 'timeoutMs 必须是数字')
    assert.ok(Array.isArray(runtime.events), 'events 必须是数组')
    assert.equal(runtime.events.length, 1, '注册的钩子必须可见')
    assert.equal(runtime.events[0].event, 'MESSAGE_RECEIVED')
    assert.equal(typeof runtime.events[0].handler, 'function', '钩子 handler 必须可见')
    assert.ok(Array.isArray(runtime.errors), 'errors 必须是数组')
    assert.equal(runtime.errors.length, 0, '成功加载不应有错误记录')
    // compiled 由 runtime.sources 映射：形状 { name, ok, error }
    assert.ok(Array.isArray(runtime.compiled), 'compiled 必须是数组')
    assert.equal(runtime.compiled.length, 1)
    assert.equal(runtime.compiled[0].name, 'retained-api-contract.js')
    assert.equal(runtime.compiled[0].ok, true)
    assert.equal(runtime.compiled[0].error, null, '成功行 error 必须为 null')
    // 非 strict 派发：不抛，钩子跑得到
    const outcome = await runtime.dispatchEvent('MESSAGE_RECEIVED', 42)
    assert.equal(typeof outcome, 'object', '非 strict 派发必须返回 outcome 而不是 undefined')
    assert.equal(runtime.sandbox?.contractSeen, '42', '钩子必须被真正调用：' + String(runtime.sandbox?.contractSeen))
    // 旧兼容：bridgeServerEvents 不改监听协议（for...of + on(event, handler)）
    const listeners = new Map()
    const serverEvents = {
      [Symbol.iterator]: function* () { yield 'MESSAGE_RECEIVED' },
      on(event, handler) { listeners.set(event, handler); return handler },
    }
    assert.equal(bridgeServerEvents(serverEvents, [runtime]), undefined, 'bridgeServerEvents 返回值必须保持 undefined')
    assert.equal(typeof listeners.get('MESSAGE_RECEIVED'), 'function', '必须按原协议注册监听')
    await listeners.get('MESSAGE_RECEIVED')(7)
    assert.equal(runtime.sandbox.contractSeen, '7', '桥接派发必须打到钩子')
  } finally {
    const result = runtime.dispose()
    assert.equal(typeof result, 'object', 'dispose 必须返回释放回执')
    assert.equal(runtime.events.length, 0, 'dispose 后 events 必须清空（旧可见合同）')
    assert.deepEqual(runtime.compiled, [], 'dispose 后 compiled 必须清空（旧可见合同）')
    assert.equal(runtime.dispose().alreadyDisposed, true, '重复 dispose 必须幂等')
    assert.equal(await runtime.dispatchEvent('MESSAGE_RECEIVED', 1), undefined, '已释放后派发必须拒绝且不伪造 outcome')
  }
})

test('保留API安全：不得取得宿主函数/宿主process（context Function 本身不算逃逸）', async () => {
  const hostRealm = {
    marker: 'host-realm-marker',
    Function: Function,
    globalObject: globalThis,
    process: process,
  }
  const hostFn = function hostLeakProbe() { return hostRealm }
  const { runtime, ok, error } = await runScript({
    key: 'realm-escape-probe',
    code: [
      'const probe = { escapes: [], denied: [], typeofProcess: undefined, typeofRequire: undefined, isHostFunctionCtor: undefined, contextCtorIsFunction: undefined }',
      // 只有"拿到宿主 realm 对象 / 宿主 process"才算逃逸；context realm 自己的构造器**不算**
      // （它无法用字符串编译，利用不成功），但它的身份必须与宿主 Function 不同。
      'function probeCall(label, fn) { try { const v = fn(); if (v && v.hostRealm === hostRealm) probe.escapes.push(label + ":hostRealm"); else if (v && typeof v.version === "string" && v.versions) probe.escapes.push(label + ":hostProcess") } catch (e) { probe.denied.push(label) } }',
      'probeCall("globalThis.constructor(code)", function () { return globalThis.constructor("return globalThis")() })',
      'probeCall("hostFn.constructor(code)", function () { return hostFn.constructor("return hostRealm")() })',
      'probeCall("proto.constructor(code)", function () { return Object.getPrototypeOf(hostFn).constructor("return hostRealm")() })',
      'probeCall("Function(code)", function () { return Function("return hostRealm")() })',
      'probeCall("eval(code)", function () { const e = eval; return e("return hostRealm") })',
      'probeCall("this.constructor.constructor", function () { return (function () { return this })().constructor.constructor("return hostRealm")() })',
      'probe.typeofProcess = typeof process',
      'probe.typeofRequire = typeof require',
      'probe.isHostFunctionCtor = hostFn.constructor === hostRealm.Function',
      'probe.contextCtorIsFunction = typeof Function === "function"',
      'globalThis.escapeProbe = probe',
    ].join('\n'),
    hostApi: { hostRealm, hostFn },
  })
  try {
    assert.equal(ok, true, '探针脚本必须加载成功（不得靠脚本抛错来"挡住"）：' + String(error))
    const probe = runtime.sandbox.escapeProbe
    assert.ok(probe && typeof probe === 'object', '探针结果必须可回读')
    // ① 真正不可接受的只有两类：拿到宿主 realm 对象，或拿到宿主 process
    //    ⚠ probe.escapes 是 **context realm** 的数组：不能直接与宿主 `[]` 做 deepEqual
    //    （跨 realm 数组的原型不同，deepEqual 会判不等）；只比长度 + 逐项字符串化。
    assert.equal(probe.escapes.length, 0, '不得有路径取得宿主 realm 对象/宿主 process：' + JSON.stringify([...probe.escapes]))
    // ② 宿主函数自身的 constructor 不得是宿主 realm 的 Function（这是可判定的硬边界）
    assert.equal(probe.isHostFunctionCtor, false, 'hostFn.constructor 命中宿主 Function（realm 逃逸口）')
    // ③ context 侧存在自己的 Function 构造器是**允许**的（利用不成功即可），但必须有被拒路径为证
    assert.equal(probe.contextCtorIsFunction, true, 'context realm 自己有 Function 构造器属允许情形，不能当成逃逸')
    assert.ok(probe.denied.length > 0, '至少应有一条构造器/代码生成路径被明确拒绝：' + JSON.stringify([...probe.denied]))
    // ④ 沙箱内不得出现宿主 node 能力
    assert.equal(probe.typeofProcess, 'undefined', '沙箱内不得有 process')
    assert.equal(probe.typeofRequire, 'undefined', '沙箱内不得有 require')
  } finally {
    runtime.dispose()
  }
})

test('保留API安全：非strict派发吞掉钩子异常并记账，不向调用方抛（旧语义）', async () => {
  const logged = []
  const record = {
    info: (...a) => logged.push(['info', a.map(String).join(' ')]),
    warn: (...a) => logged.push(['warn', a.map(String).join(' ')]),
    error: (...a) => logged.push(['error', a.map(String).join(' ')]),
    debug: (...a) => logged.push(['debug', a.map(String).join(' ')]),
  }
  const runtime = createScriptRuntime({
    scriptId: 'retained-api-warn',
    sources: [{ name: 'warn.js', code: 'eventOn("MESSAGE_SENT", function () { throw new Error("钩子故意失败") })' }],
    hostApi: {},
    timeoutMs: 2000,
    // 本用例必须用**会记账的 logger**（runScript 用的 silent 会把记账丢掉，无法验证旧语义）
    logger: record,
  })
  try {
    assert.equal(runtime.compiled[0].ok, true, '注册钩子的脚本本身必须加载成功')
    // 旧语义的核心（必须保住）：**不向调用方抛**、逐钩子失败隔离
    const outcome = await runtime.dispatchEvent('MESSAGE_SENT')
    assert.equal(typeof outcome, 'object', '非 strict 下必须返回 outcome 而非抛出')
    assert.equal(outcome.ok, false, '钩子失败必须体现在 outcome.ok=false')
    assert.equal(outcome.results[0].ok, false, '失败必须逐钩子可见（不整批吃掉）')
    // 记账级别**不再锁定 warn**：现役运行时把钩子异常记到 `logger.error`（旧垫片记 `warn`），
    // 垫片只负责把调用方 logger 原样传给运行时 ⇒ 这里只要求"钩子异常"确实被记账，不锁级别。
    assert.ok(logged.some(([, text]) => text.includes('钩子异常')),
      '钩子失败必须被记账（warn 或 error）：' + JSON.stringify(logged))
  } finally {
    runtime.dispose()
  }
})

test('保留API安全：dispose 清掉待办短定时器（回执 clearedTimers）且回调不再执行', async () => {
  const runtime = createScriptRuntime({
    scriptId: 'retained-api-timer',
    sources: [{
      name: 'timer.js',
      code: [
        'globalThis.timerTicks = 0',
        'globalThis.timerTicksAfterDispose = 0',
        // 两个短延迟：一个在 dispose 前应触发，一个应被 dispose 清掉且此后永不执行。
        // （dispose 清的是现役 `timers` Map 里的全部 handle，与传入的 ceiling 无关；ceiling 只决定
        //   短延迟是否进"待办表"、能否被 drainPendingTasks join。）
        'setTimeout(function () { globalThis.timerTicks += 1 }, 10)',
        'setTimeout(function () { globalThis.timerTicksAfterDispose += 1 }, 60)',
      ].join('\n'),
    }],
    hostApi: {},
    timeoutMs: 2000,
    logger: silent,
  })
  assert.equal(runtime.compiled[0].ok, true, '定时器脚本必须加载成功：' + String(runtime.compiled[0].error))
  // dispose 后 sandbox getter 不再暴露 ⇒ 先把 sandbox 引用留好，再读释放后的回调计数。
  const sandbox = runtime.sandbox
  try {
    await tick(30)
    assert.equal(sandbox.timerTicks, 1, '未被释放的短定时器必须触发')
    // 只用**新增的 dispose 回执**（clearedTimers/cancelledBudgets/closedPending）核对清理，
    // 不新增"待办查询"之类旧版没有的能力期待。
    const receipt = runtime.dispose()
    assert.equal(typeof receipt, 'object', 'dispose 必须返回回执')
    assert.equal(receipt.alreadyDisposed, false)
    assert.ok(Number.isSafeInteger(receipt.clearedTimers), '回执必须含 clearedTimers：' + JSON.stringify(receipt))
    assert.ok(receipt.clearedTimers >= 1, '被清的短定时器必须计入回执：' + JSON.stringify(receipt))
    await tick(120)
    assert.equal(sandbox.timerTicksAfterDispose, 0, 'dispose 后被清的定时器回调绝不能执行（旧写不得落地）')
    // 释放后的可见合同：三个旧数组一律为空
    assert.equal(runtime.compiled.length, 0, 'dispose 后 compiled 必须为空数组（不再映射 sourceList）')
    assert.equal(runtime.errors.length, 0, 'dispose 后 errors 必须为空数组')
    assert.equal(runtime.events.length, 0, 'dispose 后 events 必须为空数组')
    assert.equal(runtime.sandbox, undefined, 'dispose 后不再暴露 sandbox')
  } finally {
    runtime.dispose()
  }
})

for (const [label, payload] of [
  ['null', 'null'],
  ['数字', '123'],
  ['字符串', '"不是对象"'],
  ['布尔', 'true'],
  ['数组', '[1,2,3]'],
  ['坏 JSON', '{不是 JSON'],
]) {
  test('标量缓存不崩：' + label + ' 作为分派缓存必须被丢弃并回落空对象', async () => {
    const root = makeTempRoot('retained-api-scalar-')
    try {
      const file = writeTempJson(root, 'dispatch.json', payload)
      const original = readFileSync(file, 'utf8')
      const store = createCardScriptDispatchStore({ filePath: file, logger: silent })
      assert.equal(store.lookupCard('cards/x.json'), null, '丢弃后不得命中任何卡级标记')
      assert.equal(store.lookupScript('cards/x.json', 's1', 'code'), null, '丢弃后不得命中任何脚本级标记')
      // 只读丢弃：不得因为"读过标量"就改写文件（不改权威/不写回坏形状）
      assert.equal(readFileSync(file, 'utf8'), original, '只读丢弃不得改写缓存文件')
      // 丢弃是"可丢弃缓存"语义：仍然能正常写入（空容器上的新条目，不是对权威的改写）
      store.markCard('cards/x.json', 'probe')
      assert.ok(store.lookupCard('cards/x.json'), '标记写入必须照常工作')
      store.markScript('cards/x.json', 's1', 'code', 'probe')
      assert.ok(store.lookupScript('cards/x.json', 's1', 'code'), '脚本级标记写入必须照常工作')
      // 等 50ms 防抖**真的落盘**再断言/清理（不靠固定 sleep；避免在防抖窗口内 rm 目录）
      const persisted = await waitForFile(file, text => text.includes('browser-ui'))
      const reloaded = JSON.parse(persisted)
      assert.ok(reloaded && typeof reloaded === 'object' && !Array.isArray(reloaded),
        '落盘内容必须是 plain object（不得把标量/数组原样写回）：' + JSON.stringify(reloaded))
      assert.equal(reloaded['cards/x.json'].__card__.class, 'browser-ui', '落盘必须是可重读的标记形状')
      // 新 store 必须能从落盘内容恢复（可丢弃≠不可用）
      const reopened = createCardScriptDispatchStore({ filePath: file, logger: silent })
      assert.ok(reopened.lookupCard('cards/x.json'), '落盘后的标记必须能重读到')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('标量缓存不崩：原型键卡路径不得把祖先当 entry，也不得污染 Object.prototype', async () => {
  const root = makeTempRoot('retained-api-poison-')
  try {
    const file = writeTempJson(root, 'dispatch.json', { 'cards/ok.json': { __card__: { class: 'browser-ui', reason: 'x', markedAt: 1 } } })
    const store = createCardScriptDispatchStore({ filePath: file, logger: silent })
    assert.ok(store.lookupCard('cards/ok.json'), '正常条目必须命中')
    // 解析产物必须已拷进 null 原型容器：否则 `data['__proto__']` 读到的是 Object.prototype（祖先当 entry）
    assert.equal(store.lookupCard('__proto__'), null, '原型键不得读到祖先 Object.prototype')
    assert.equal(store.lookupCard('constructor'), null, 'constructor 键不得读到祖先成员')
    store.markCard('__proto__', 'probe')
    assert.equal(Object.hasOwn(Object.prototype, '__card__'), false, '不得把标记写到 Object.prototype 上')
    assert.ok(store.lookupCard('__proto__'), '原型键名应作为普通自有卡路径可用')
    assert.ok(store.lookupCard('cards/ok.json'), '原条目仍在，未被串档')
    // 等 50ms 防抖真的落盘再清理目录（否则写盘在已删目录上失败）
    const persisted = await waitForFile(file, text => text.includes('__proto__'))
    assert.ok(persisted.includes('cards/ok.json'), '落盘必须同时保留原条目')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('保留API兼容：同一 scriptId 两次 createScriptRuntime 必须是彼此独立的实例', async () => {
  const first = createScriptRuntime({
    scriptId: 'same-key',
    sources: [{ name: 'first.js', code: 'globalThis.who = "first"' }],
    hostApi: {},
    timeoutMs: 2000,
    logger: silent,
  })
  const second = createScriptRuntime({
    scriptId: 'same-key',
    sources: [{ name: 'second.js', code: 'globalThis.who = "second"' }],
    hostApi: {},
    timeoutMs: 2000,
    logger: silent,
  })
  try {
    assert.notEqual(first, second, '两次调用必须返回不同对象')
    assert.notEqual(first.sandbox, second.sandbox, '同一 scriptId 也不得共用同一 vm 上下文')
    assert.equal(first.sandbox.who, 'first', '实例一必须保留自己的脚本结果')
    assert.equal(second.sandbox.who, 'second', '实例二必须保留自己的脚本结果（未被实例一覆盖）')
    assert.equal(first.compiled[0].name, 'first.js', '实例一 compiled 只反映自己的 sources')
    assert.equal(second.compiled[0].name, 'second.js', '实例二 compiled 只反映自己的 sources')
    // 释放一个不得影响另一个
    first.dispose()
    assert.deepEqual(first.compiled, [], '被释放实例 compiled 必须清空')
    assert.equal(second.sandbox.who, 'second', '另一实例不得被连带释放/清空')
    assert.equal(second.compiled[0].name, 'second.js', '另一实例 compiled 仍在')
  } finally {
    first.dispose()
    second.dispose()
  }
})
