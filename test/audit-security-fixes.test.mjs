import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createCardScriptRuntime } from '../lib/mvu/mvu-card-runtime.js'
import { parseCommandValue, setMathjs } from '../lib/mvu/mvu-update-core.js'

const logger = { info() {}, warn() {}, error() {} }

test('audit-security：变量命令对象解析不执行宿主表达式', () => {
  globalThis.__dshAuditPwned = 0
  const value = parseCommandValue('{constructor: (globalThis.__dshAuditPwned = 1)}')
  assert.equal(globalThis.__dshAuditPwned, 0, '对象字面量解析不得执行宿主副作用')
  assert.equal(value?.constructor, '(globalThis.__dshAuditPwned = 1)', '安全解析器可以保留对象数据，但不得执行表达式副作用')
  delete globalThis.__dshAuditPwned
})

test('audit-security：卡脚本context禁止realm构造器逃逸与字符串代码生成', async () => {
  const rt = createCardScriptRuntime({
    cardPath: '/audit/security',
    sources: [{ name: 'escape.js', code: `
      eventOn('escape', function () {
        result = {
          globalCtor: typeof globalThis.constructor,
          functionCtor: typeof globalThis.constructor?.constructor,
          windowCtor: typeof window.constructor?.constructor,
          process: (() => { try { return typeof globalThis.constructor?.constructor('return process')() } catch { return 'blocked' } })(),
          codegen: (() => { try { return Function('return 1')() } catch { return 'blocked' } })(),
          hostValueCtor: (() => { try { return typeof hostValue.constructor?.constructor('return process')() } catch { return 'blocked' } })(),
        }
      })
    ` }],
    hostApi: { result: null, hostValue: () => 'host' },
    timeoutMs: 500,
    logger,
  })
  const outcome = await rt.dispatchEvent({ strict: true }, 'escape')
  assert.equal(outcome.ok, true)
  const result = rt.sandbox.result
  assert.notEqual(result.process, 'object', JSON.stringify(result))
  assert.equal(result.codegen, 'blocked', JSON.stringify(result))
  assert.equal(result.hostValueCtor, 'blocked', JSON.stringify(result))
  assert.notEqual(result.globalCtor, 'function', JSON.stringify(result))
  assert.notEqual(result.functionCtor, 'function', JSON.stringify(result))
  assert.notEqual(result.windowCtor, 'function', JSON.stringify(result))
  rt.dispose()
})

test('audit-security：受控host API仍能修改context内权威树并回传普通值', async () => {
  const seen = []
  const rt = createCardScriptRuntime({
    cardPath: '/audit/bridge',
    sources: [{ name: 'bridge.js', code: `
      eventOn('bridge', function () {
        const value = readValue()
        result = { value, nested: { ok: true } }
        writeValue(value + 1)
      })
    ` }],
    hostApi: {
      readValue: () => 4,
      writeValue: value => { seen.push(value); return Promise.resolve({ accepted: true }) },
      result: null,
    },
    timeoutMs: 500,
    logger,
  })
  const outcome = await rt.dispatchEvent({ strict: true }, 'bridge')
  assert.equal(outcome.ok, true)
  assert.equal(rt.sandbox.result.value, 4)
  assert.deepEqual(seen, [5])
  rt.dispose()
})

test('audit-security：context数组/对象修改回写宿主对象', async () => {
  const trace = []
  const rt = createCardScriptRuntime({
    cardPath: '/audit/sync-back',
    sources: [{ name: 'sync.js', code: `eventOn('sync', function () { payload.items.push('context'); payload.meta.ok = true })` }],
    hostApi: { payload: { items: trace, meta: { ok: false } } },
    timeoutMs: 500,
    logger,
  })
  await rt.dispatchEvent({ strict: true }, 'sync')
  assert.deepEqual(trace, ['context'], JSON.stringify(trace))
  assert.equal(rt.sandbox.payload.meta.ok, true, JSON.stringify(rt.sandbox.payload))
  rt.dispose()
})

test('audit-security：宿主同步异常与访问器异常不暴露宿主构造器', async () => {
  const payload = { get fail() { throw Object.assign(new Error('getter failed'), { code: 'GETTER' }) } }
  const rt = createCardScriptRuntime({ cardPath: '/audit/errors', logger, timeoutMs: 500,
    hostApi: { payload, fail() { throw Object.assign(new Error('host failed'), { code: 'HOST' }) } },
    sources: [{ name: 'errors.js', code: `
      eventOn('errors', () => {
        checks = []
        for (const run of [() => fail(), () => payload.fail]) {
          try { run() } catch (e) {
            let escaped = false
            try { escaped = !!e.constructor.constructor('return process')() } catch {}
            checks.push({escaped, code:e.code, message:e.message})
          }
        }
      })
    ` }],
  })
  try {
    await rt.dispatchEvent({ strict: true }, 'errors')
    assert.equal(rt.sandbox.checks.length, 2)
    for (const check of rt.sandbox.checks) assert.equal(check.escaped, false)
    assert.equal(rt.sandbox.checks[0].code, 'HOST')
    assert.equal(rt.sandbox.checks[1].code, 'GETTER')
  } finally { rt.dispose() }
})

test('audit-security：业务回调保持同一权威对象与函数返回身份', async () => {
  const tree = { hp: 1 }
  const rt = createCardScriptRuntime({ cardPath: '/audit/callback', logger,
    hostApi: { tree, call: fn => fn(tree), echo: fn => fn },
    sources: [{ name: 'callback.js', code: `
      eventOn('callback', () => {
        const cb = value => { value.hp += 1; return value }
        result = { identity: echo(cb) === cb, sameTree: call(cb) === tree, stableMethod: tree.toString === tree.toString }
      })
    ` }],
  })
  try {
    await rt.dispatchEvent({ strict: true }, 'callback')
    assert.equal(tree.hp, 2)
    assert.equal(rt.sandbox.result.identity, true)
    assert.equal(rt.sandbox.result.sameTree, true)
    assert.equal(rt.sandbox.result.stableMethod, true)
  } finally { rt.dispose() }
})

test('audit-security：typed array随机数调用与宿主晚变更仍可用', async () => {
  const tree = { hp: 1 }
  const rt = createCardScriptRuntime({ cardPath: '/audit/freshness', logger, hostApi: {tree},
    sources: [{name:'fresh.js',code:`
      const held = tree
      eventOn('fresh', () => {
        const bytes = new Uint8Array(4)
        const returned = crypto.getRandomValues(bytes)
        result = { hp: held.hp, size: returned.length, cloneHp: structuredClone(held).hp }
      })
    `}],
  })
  try {
    tree.hp = 5
    await rt.dispatchEvent({strict:true}, 'fresh')
    assert.equal(rt.sandbox.result.hp, 5)
    assert.equal(rt.sandbox.result.size, 4)
    assert.equal(rt.sandbox.result.cloneHp, 5)
  } finally { rt.dispose() }
})

test('audit-security：内部待办登记不复制拒绝promise', async () => {
  const rt = createCardScriptRuntime({ cardPath: '/audit/pending', sources: [], logger })
  let reject
  const pending = new Promise((_resolve, rejectValue) => { reject = rejectValue })
  pending.catch(() => {})
  try {
    assert.equal(rt.sandbox._dshTrackPending(pending, 'fixture'), undefined)
    reject(new Error('tracked failure'))
    await pending.catch(() => {})
    await assert.rejects(() => rt.drainPendingTasks({timeoutMs:500}), /tracked failure/)
  } finally { rt.dispose() }
})

test('audit-security：原始VM基线仍说明没有codeGeneration选项就会逃逸，负例确实测到修复边界', () => {
  const context = vm.createContext({})
  assert.equal(typeof vm.runInContext("globalThis.constructor.constructor('return process')()", context), 'object')
})

test('audit-security：DOM context 反射/描述符不触 host 错误且不放宽 strict DOM 拒绝', async () => {
  const rt = createCardScriptRuntime({ cardPath: '/audit/dom-reflect', logger, timeoutMs: 500,
    sources: [{ name: 'dom.js', code: `
      eventOn('domReflect', () => {
        result = {}
        // ① 反射面：ownKeys/描述符必须合法（context Proxy 的箭头 target 无不可配置 prototype，
        //    函数 target 会因 ownKeys 未列 prototype 触发 invariant TypeError），且不得抛宿主错误。
        try { result.keys = Object.keys(document) } catch (e) { result.keysError = String(e && e.message) }
        try {
          const descriptors = Object.getOwnPropertyDescriptors(document)
          result.descriptorKeys = Object.keys(descriptors).join(',')
          result.descriptorValue = descriptors.dshDomProbe && descriptors.dshDomProbe.value
          result.descriptorEscaped = (() => {
            try { return typeof descriptors.dshDomProbe.constructor.constructor('return process')() } catch { return 'blocked' }
          })()
        } catch (e) { result.descriptorError = String(e && e.message) }
        // ② 读取探针：strict 下抛出，错误必须带 code 与 dom metadata，且不暴露宿主构造器。
        try { document.foo } catch (e) {
          result.domError = {
            code: e.code,
            prop: e.domProbe && e.domProbe.prop,
            op: e.domProbe && e.domProbe.op,
            source: e.domProbe && e.domProbe.source,
            escaped: (() => { try { return typeof e.constructor.constructor('return process')() } catch { return 'blocked' } })(),
          }
        }
      })
      eventOn('domEscape', () => { document.bar })
    ` }],
  })
  try {
    const outcome = await rt.dispatchEvent({ strict: true }, 'domReflect')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    const result = rt.sandbox.result
    assert.equal(result.keysError, undefined, 'Object.keys(document) 不得抛错：' + String(result.keysError))
    assert.equal(Array.isArray(result.keys), true, 'Object.keys(document) 必须返回数组')
    assert.equal(result.keys.length, 0, 'document 只暴露不可枚举探针键 ⇒ keys 必为空，实际：' + JSON.stringify(result.keys))
    assert.equal(result.descriptorError, undefined, 'Object.getOwnPropertyDescriptors(document) 不得抛错：' + String(result.descriptorError))
    assert.equal(result.descriptorKeys, 'dshDomProbe')
    assert.equal(result.descriptorValue, 'card-script-dom')
    assert.notEqual(result.descriptorEscaped, 'object', '描述符对象不得携带宿主构造器（realm escape）')
    assert.equal(result.domError.code, 'card-script-dom')
    assert.equal(result.domError.prop, 'document.foo')
    assert.equal(result.domError.op, 'read')
    assert.equal(result.domError.source, 'dom.js')
    assert.notEqual(result.domError.escaped, 'object', 'DOM 探针错误不得暴露宿主构造器')

    // ③ 不放宽 DOM 拒绝：未 catch 的 DOM 读取在 strict 下必须让本次派发失败（抛 strictError）。
    await assert.rejects(() => rt.dispatchEvent({ strict: true }, 'domEscape'), error => {
      assert.equal(error.kind, 'dom', 'strict 必须按 DOM 拒绝：' + JSON.stringify({ kind: error.kind, code: error.code }))
      assert.equal(error.code, 'card-script-dom')
      assert.equal(error.domProbe && error.domProbe.prop, 'document.bar')
      assert.equal(error.domProbe && error.domProbe.source, 'dom.js')
      assert.equal(error.outcome && error.outcome.ok, false)
      return true
    })
    assert.equal(rt.lastDomAccess.source, 'dom.js')
    assert.equal(rt.domAccessed, true)
  } finally { rt.dispose() }
})

test('audit-security：rejected host promise 的 catch 不暴露宿主构造器且保留 code/dom metadata', async () => {
  const rt = createCardScriptRuntime({ cardPath: '/audit/async-reject', logger, timeoutMs: 500,
    hostApi: { failAsync: () => Promise.reject(Object.assign(new Error('host async failed'), { code: 'ASYNC_HOST' })) },
    sources: [{ name: 'async.js', code: `
      eventOn('asyncReject', async () => {
        result = {}
        const escapedOf = e => { try { return typeof e.constructor.constructor('return process')() } catch { return 'blocked' } }
        await failAsync().catch(e => { result.host = { code: e.code, message: e.message, escaped: escapedOf(e) } })
        await Promise.resolve().then(() => document.zone).catch(e => {
          result.dom = { code: e.code, prop: e.domProbe && e.domProbe.prop, source: e.domProbe && e.domProbe.source, escaped: escapedOf(e) }
        })
      })
    ` }],
  })
  try {
    const outcome = await rt.dispatchEvent({ strict: true }, 'asyncReject')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    const result = rt.sandbox.result
    assert.equal(result.host.code, 'ASYNC_HOST', '宿主 async 拒绝必须保留 code')
    assert.equal(result.host.message, 'host async failed', '宿主 async 拒绝必须保留 message')
    assert.notEqual(result.host.escaped, 'object', 'rejected host promise 的 e 不得暴露宿主构造器')
    assert.equal(result.dom.code, 'card-script-dom', 'DOM metadata 必须随 async 拒绝保留 code')
    assert.equal(result.dom.prop, 'document.zone')
    assert.equal(result.dom.source, 'async.js')
    assert.notEqual(result.dom.escaped, 'object', 'DOM 错误经 async 路径也不得暴露宿主构造器')
  } finally { rt.dispose() }
})

test('audit-security：可选 mathjs 数学解析的作用域不含宿主 Math/完整模块（受控 spy 证合同）', () => {
  // 受控 spy 只证明**我们与 mathjs 的接口合同**（evaluate(expr, scope) 的 scope 为空、
  // 不注入宿主 Math / 完整 math 模块，且返回值按数值合同解析）；不声称真 mathjs 包完全安全。
  const calls = []
  const spy = {
    evaluate(expr, scope) {
      calls.push({
        expr,
        scopeKeys: scope && typeof scope === 'object' ? Object.keys(scope) : null,
        hasMath: Boolean(scope && typeof scope === 'object' && 'Math' in scope),
        hasMathModule: Boolean(scope && typeof scope === 'object' && 'math' in scope),
        scopeIsFreshObject: Boolean(scope) && typeof scope === 'object' && !Array.isArray(scope),
      })
      return 12
    },
    isComplex: () => false,
    isMatrix: () => false,
  }
  const source = readFileSync(new URL('../lib/mvu/mvu-update-core.js', import.meta.url), 'utf8')
  globalThis.__dshAuditMathPwned = 0
  try {
    assert.equal(/new Function/.test(source), false, 'parseCommandValue 不得再动态生成函数（new Function 已删）')
    assert.match(source, /mathjs\.evaluate\(trimmed, \{\}\)/, 'mathjs 调用必须是空作用域字面量')

    setMathjs(spy)
    const value = parseCommandValue('6*2')
    assert.equal(value, 12, '受控 evaluate 返回 12 必须按数值解析（isComplex/isMatrix=false 路径）')
    assert.equal(calls.length, 1, '数学表达式必须恰好走一次可选 evaluate，实际：' + calls.length)
    assert.equal(calls[0].expr, '6*2', 'evaluate 必须收到表达式原文')
    assert.equal(calls[0].scopeIsFreshObject, true, 'evaluate 第二参必须是普通对象')
    assert.deepEqual(calls[0].scopeKeys, [], 'evaluate 作用域必须是空对象（只有 mathjs 自身语法/内建）')
    assert.equal(calls[0].hasMath, false, '不得向输入作用域注入宿主 Math')
    assert.equal(calls[0].hasMathModule, false, '不得向输入作用域注入完整 math 模块')

    // 对象表达式不再走动态求值：恢复默认（不可选）后必须落包内 parseString，且无副作用。
    setMathjs(null)
    const object = parseCommandValue('{constructor: (globalThis.__dshAuditMathPwned = 1)}')
    assert.equal(globalThis.__dshAuditMathPwned, 0, '对象表达式不得执行宿主副作用')
    assert.equal(object?.constructor, '(globalThis.__dshAuditMathPwned = 1)', '必须保留为数据字面量')
  } finally {
    setMathjs(null) // 恢复默认不可选：防止本用例污染其它 parse 用例
    delete globalThis.__dshAuditMathPwned
  }
})
