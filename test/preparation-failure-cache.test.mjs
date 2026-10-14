// T4 共享准备的**失败/计数**契约（只读；不碰 product、不真实施缝）：
//  A. 两个工厂各自注入独立 metrics：真实有限复制后、apply 之前抛错 ⇒ 只准备一次、失败一次、第二次命中缓存且**同一 error 对象**；
//     默认全局 nativeS4Metrics 与 native-data 自身计数都保持 0（证明不共用全局）。
//  B. 源码组合失败：不重读、不重试；同一 promise/同一 error；缺失路径同样按 path 缓存同一 error。
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeS4Prepare, nativeS4Metrics } from './support/native-s4-prepare.mjs'
import { nativeDataMetrics } from './support/native-data-prepare.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
const VIEW_REL = 'tavern-plugin/lib/domain/chat-session-state.js'
const FIXTURE = '../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425'

test('共享准备：独立计数与失败同错误缓存', async () => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), FIXTURE)
  assert.equal(existsSync(path.join(source, 'tavern-plugin', 'package.json')), true, '真实作者 fixture 必须存在：' + source)
  const cleanups = []
  const make = (label, metrics) => createNativeS4Prepare({
    index: INDEX,
    authorVersion: '2.5.0',
    // 真实有限复制会先发生；此处在 apply 之前抛错（故障点确定、不真实施缝）
    isNativeDataApplied: () => { throw new Error('preparation-fault:' + label) },
    registerCleanup: fn => cleanups.push({ label, fn }),
    label,
    metrics,
  })
  const metricsA = { preparations: 0, cacheHits: 0, failures: 0, cleanups: 0 }
  const metricsB = { preparations: 0, cacheHits: 0, failures: 0, cleanups: 0 }
  const factoryA = make('A', metricsA)
  const factoryB = make('B', metricsB)
  const before = { s4: { ...nativeS4Metrics }, data: { ...nativeDataMetrics } }
  try {
    let first = null, second = null
    try { factoryA.seamSource() } catch (error) { first = error }
    try { factoryA.seamSource() } catch (error) { second = error }
    assert.ok(first instanceof Error && first.message === 'preparation-fault:A', '第一次必须真实抛错：' + String(first && first.message))
    assert.equal(second, first, '第二次必须拿到**同一个 error 对象**（按失败缓存，不重新准备）')
    assert.equal(metricsA.preparations, 1, '同一工厂只允许准备一次')
    assert.equal(metricsA.failures, 1, '失败只记一次')
    assert.equal(metricsA.cacheHits, 1, '第二次必须命中失败缓存')
    let other = null
    try { factoryB.seamSource() } catch (error) { other = error }
    assert.equal(other.message, 'preparation-fault:B', '第二个工厂的失败必须独立（不串错误）')
    assert.equal(metricsB.preparations, 1, '第二个工厂自己计一次准备')
    assert.deepEqual({ s4: { ...nativeS4Metrics }, data: { ...nativeDataMetrics } }, before, '默认 nativeS4Metrics 与 native-data 自身计数都不得被注入实例改动')
    assert.equal(nativeS4Metrics.preparations, 0, '默认全局 nativeS4Metrics 必须保持 0')
    assert.equal(nativeDataMetrics.preparations, 0, 'native-data 自身计数必须保持 0（不与 S4 共用）')
  } finally {
    for (const { fn } of cleanups) fn()          // 真复制过 ⇒ 必须清掉各自的 mkdtemp
    assert.equal(cleanups.length, 2, '两个工厂各注册一次清理')
    assert.equal(metricsA.cleanups, 1, 'A 的清理计数为 1')
    assert.equal(metricsB.cleanups, 1, 'B 的清理计数为 1')
  }
})

test('共享准备：源码组合失败不重读不重试', async () => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), FIXTURE)
  const root = mkdtempSync(path.join(tmpdir(), 'preparation-fault-app-'))
  const previous = process.env.DSH_TAVERN_TEST_APP
  try {
    // 有限复制：作者 package.json + 真实 view 源码（只读源，改的是副本）
    mkdirSync(path.join(root, 'tavern-plugin', 'lib', 'domain'), { recursive: true })
    copyFileSync(path.join(source, 'tavern-plugin', 'package.json'), path.join(root, 'tavern-plugin', 'package.json'))
    const viewSource = readFileSync(path.join(source, ...VIEW_REL.split('/')), 'utf8')
    assert.notEqual(viewSource.length, 0, '真实 view 源码不得为空')
    // 真实变异：删掉 pending 组合的**唯一真实 anchor**（先核 count==1，再核确实变了），其余 view 源码原样保留
    const PENDING_ANCHOR = '  function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {'
    assert.equal(viewSource.split(PENDING_ANCHOR).length - 1, 1, '前置：真实 view 里该 anchor 必须恰一处')
    const mutatedView = viewSource.replace(PENDING_ANCHOR, '')
    assert.notEqual(mutatedView, viewSource, '必须真的删掉一个完整 anchor')
    writeFileSync(path.join(root, ...VIEW_REL.split('/')), mutatedView, 'utf8')
    process.env.DSH_TAVERN_TEST_APP = root

    const { applyRollbackPendingViewTransform } = await import('../deploy/rollback-pending-view-transform.mjs')
    assert.throws(() => applyRollbackPendingViewTransform(mutatedView), /锚点|不完整|缺失/,
      '前置核实：真实变异后的 view 确实让组合变换抛错（同一 mutated 文本，不是假期待）')

    const lifecycleSource = await import('./support/latest-failure-source.mjs')
    const readsBefore = lifecycleSource.metrics.sourceReads
    const first = lifecycleSource.composedFailureViewText()
    const second = lifecycleSource.composedFailureViewText()
    assert.equal(first, second, '并发/重复调用必须拿到同一 promise（不重复组合）')
    let errorA = null, errorB = null
    try { await first } catch (error) { errorA = error }
    try { await second } catch (error) { errorB = error }
    assert.ok(errorA instanceof Error, '组合必须失败：' + String(errorA && errorA.message))
    assert.equal(errorB, errorA, '第二次必须拿到同一个 error（失败终身缓存，不重试）')
    assert.equal(lifecycleSource.metrics.sourceReads - readsBefore, 1, '同一输入只允许读盘一次（路径读计数 1）')
    assert.equal(lifecycleSource.metrics.composedBuilds, 0, '失败不得计入成功组合次数')

    // 缺失路径：同一 error 按 path 缓存
    let missA = null, missB = null
    try { lifecycleSource.readLatestFailureSource('tavern-plugin/lib/domain/__missing__.js') } catch (error) { missA = error }
    try { lifecycleSource.readLatestFailureSource('tavern-plugin/lib/domain/__missing__.js') } catch (error) { missB = error }
    assert.ok(missA instanceof Error && missB === missA, '缺失路径第二次必须拿到同一 error')
    assert.equal(lifecycleSource.metrics.sourceReads - readsBefore, 1, '失败路径不得增加读盘次数')
  } finally {
    if (previous === undefined) delete process.env.DSH_TAVERN_TEST_APP
    else process.env.DSH_TAVERN_TEST_APP = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('共享准备：ACTIVE投影校验失败仍缓存同一错误', async () => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), FIXTURE)
  assert.equal(existsSync(path.join(source, 'tavern-plugin', 'package.json')), true, '真实作者 fixture 必须存在：' + source)
  const metrics = { preparations: 0, cacheHits: 0, failures: 0, cleanups: 0 }
  let calls = 0
  const cleanups = []
  const factory = createNativeS4Prepare({
    index: INDEX,
    authorVersion: '2.5.0',
    // 调用序：① 前置（期望 false）② 装配后实际文件（期望 true）③ ACTIVE 投影校验 ⇒ 抛错
    isNativeDataApplied: () => {
      calls += 1
      if (calls === 1) return false
      if (calls === 2) return true
      throw new Error('active-projection-fault')
    },
    registerCleanup: fn => cleanups.push(fn),
    label: 'active-projection',
    metrics,
  })
  try {
    let first = null, second = null
    try { factory.seamSource() } catch (error) { first = error }
    assert.ok(first instanceof Error && first.message === 'active-projection-fault', '首次必须因 ACTIVE 校验抛错：' + String(first && first.message))
    const returned = (() => { try { return factory.seamSource() } catch (error) { return error } })()
    assert.equal(returned, first, '第二次必须拿到同一 error（不得因 cached 半成品假通过）')
    assert.equal(calls, 3, '校验只应发生三次（真实 apply 后再无重复）')
    assert.equal(metrics.preparations, 1, '只准备一次')
    assert.equal(metrics.cacheHits, 1, '第二次命中失败缓存')
    assert.equal(metrics.failures, 1, '失败只记一次')
  } finally {
    for (const fn of cleanups) fn()
    assert.equal(metrics.cleanups, 1, '真复制过 ⇒ 清理恰一次')
  }
})
