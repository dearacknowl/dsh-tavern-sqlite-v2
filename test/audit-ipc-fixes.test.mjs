// 运行时 IPC（配对协议）与共享活动计数的**负例/回归**测试。
//
// 覆盖本次修复的失效模式（全部为具名断言，逐条对应 ipc-fix.md 的验收项）：
//   ① 请求序号写入槽、响应把请求号写进**独立回显字段** `S_RESP_SEQ`（下方①②…为协议族，
//      其中"槽按 seq 轮转"只在显式 slotCount>1 时成立——默认 1 槽，安全性不依赖槽数）；
//   ② 未配对/重复/越界的 hostcall **不执行宿主 API**，也不写坏槽；
//   ③ 错序响应不采信（响亮失败 + 作废通道）；
//   ④ 同步超时 ⇒ 通道作废，第二次调用响亮失败（不消费陈旧响应、不 busy spin）；
//   ⑤ ticket 带请求序号，错配 ticket 拒绝结算、未知 ticket 忽略；
//   ⑥ 响应长度非法（超 payload 容量）响亮失败；
//   ⑦ 虚假/重复 notify 只累计同一 deadline（不重置、不无限重等）；
//   ⑧ 活动计数跨线程原子 add/sub（精确计数）+ plain `{pending}` 对象兼容；
//   ⑨ 源码守卫：bridge/worker 不再自带计数器视图；调用方不再写活动计数 RMW；
//   ⑩ hookBudget cancel 后不留 waiter 定时器。
//
// `audit-ipc2：` 前缀 = 协议**收口**新增的精确断言（宿主作废唤醒 wait、响应回显、int32 越界
// fail-closed、then-getter 抛、不可克隆 ticket 结果、释放/退出结算不悬挂）。
//
// 只跑本文件（`--file test/audit-ipc-fixes.test.mjs --pattern audit-`）即覆盖全部改动；
// 不触碰 `mvu-card-runtime.js`（主侧 WIP），因此不做 Worker 完整集成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createSharedSlot, createHostChannel, createWorkerChannel,
  createActivityCounter, createSharedActivityCounter, bumpActivity, encodeValue, inspectChannel,
  CONTROL_BYTES_EXPORT, SLOT_BYTES_EXPORT, SLOT_INTS_EXPORT,
  SLOT_INDEX_SEQ, SLOT_INDEX_STATE, SLOT_INDEX_LENGTH, SLOT_INDEX_RESP_SEQ,
  STATE_REQUEST, STATE_IDLE, STATE_VALUE, STATE_ERROR, MAX_REQUEST_SEQ, IPC_ERRORS,
} from '../lib/mvu/runtime-ipc.js'
import { hookBudget } from '../lib/sandbox-policy.js'
import { createSharedActivity } from '../lib/mvu/card-runtime-bridge.js'

const ipcUrl = pathToFileURL(fileURLToPath(new URL('../lib/mvu/runtime-ipc.js', import.meta.url))).href
const PAYLOAD = 256 * 1024
const SLOT_COUNT = 2

const slotHeader = (sab, slot, payloadBytes = PAYLOAD) =>
  new Int32Array(sab, CONTROL_BYTES_EXPORT + slot * (SLOT_BYTES_EXPORT + payloadBytes), SLOT_INTS_EXPORT)
const slotPayload = (sab, slot, payloadBytes = PAYLOAD) =>
  new Uint8Array(sab, CONTROL_BYTES_EXPORT + slot * (SLOT_BYTES_EXPORT + payloadBytes) + SLOT_BYTES_EXPORT, payloadBytes)

/** 起一个真 Worker（eval 模式），把 runtime-ipc 模块 URL 与共享环传进去。 */
function spawnWorker(code, workerData = {}) {
  return new Worker(code, { eval: true, workerData: { ipcUrl, ...workerData } })
}

/** 收 Worker 的 done/failed 终态（含看门狗，避免测试自身挂死）。 */
function terminal(worker, { timeoutMs = 15000, onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试 Worker 超时 ' + timeoutMs + 'ms')), timeoutMs)
    worker.on('message', message => {
      if (onMessage) onMessage(message)
      if (message && (message.type === 'done' || message.type === 'failed')) {
        clearTimeout(timer)
        resolve(message)
      }
    })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

test('audit-ipc：请求序号写入槽、响应独立回显、槽按 seq 轮转（真 Worker 值/错误/ticket）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(async ({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 10000 });
  // ticket 结算消息必须回喂给通道（生产入口 card-runtime-worker.js 同此接线）。
  parentPort.on('message', message => { ch.handleMessage(message) });
  const steps = [];
  try {
    const a = ch.call({ member: 'syncValue', args: [21] });
    steps.push(['value', a.kind, a.value, a.seq, a.slot]);
    let thrown = null;
    try { ch.call({ member: 'boom' }); } catch (error) { thrown = { message: error.message, code: error.code }; }
    steps.push(['boom', thrown]);
    const t = ch.call({ member: 'asyncWrite' });
    steps.push(['ticket', t.kind, Number.isSafeInteger(t.ticket) && t.ticket > 0, t.seq, t.slot]);
    steps.push(['settled', await ch.awaitTicket(t.ticket, t.seq)]);
    parentPort.postMessage({ type: 'done', steps });
  } catch (error) {
    parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code, steps });
  }
});
`
  const invoke = request => {
    if (request.member === 'syncValue') return request.args[0] * 2
    if (request.member === 'boom') throw Object.assign(new Error('宿主炸弹'), { code: 'BOOM' })
    if (request.member === 'asyncWrite') return Promise.resolve('written')
    throw new Error('未知成员：' + request.member)
  }
  const worker = spawnWorker(workerCode, { sab })
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (message && message.type === 'hostcall') channel.serve(message, invoke, m => worker.postMessage(m))
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'done', 'worker 报告失败：' + JSON.stringify(outcome))
  const steps = new Map(outcome.steps.map(([name, ...rest]) => [name, rest]))
  assert.deepEqual(steps.get('value'), ['value', 42, 1, 0], '同步值必须原样回传，且请求序号=1 落在槽 0')
  assert.deepEqual(steps.get('boom'), [{ message: '宿主炸弹', code: 'BOOM' }], '宿主异常必须带 code 传回')
  assert.deepEqual(steps.get('ticket'), ['ticket', true, 3, 0], 'ticket 必须带请求序号，且轮转回槽 0')
  assert.deepEqual(steps.get('settled'), ['written'], 'ticket 必须按序号匹配后结算')
  const snapshot = inspectChannel(sab)
  assert.equal(snapshot.invalid, false, '正常路径不得作废通道')
  assert.equal(snapshot.spurious, 0, '正常路径不得有未配对通知')
  assert.equal(snapshot.mispaired, 0, '正常路径不得有 ticket 错配')
  assert.equal(snapshot.slots.some(slot => slot.state === STATE_REQUEST), false, '不得有槽停在 REQUEST')
})

test('audit-ipc：未配对/重复/越界 hostcall 一律不执行宿主 API（也不写坏槽）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  let calls = 0
  const invoke = () => { calls += 1; return 'ok' }
  const rejected = []
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 8000 });
  try {
    const r = ch.call({ member: 'probe' });
    parentPort.postMessage({ type: 'done', value: r.value, seq: r.seq, slot: r.slot });
  } catch (error) {
    parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code });
  }
});
`
  const worker = spawnWorker(workerCode, { sab })
  let pairedSlot = null
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      pairedSlot = message.slot
      const other = (message.slot + 1) % SLOT_COUNT
      // ① 序号错（+100）② 槽号越界 ③ 槽错配（换一个没写过请求的槽）④ 正确配对 ⑤ 同 seq 重复
      rejected.push(channel.serve({ type: 'hostcall', seq: message.seq + 100, slot: message.slot }, invoke, () => {}))
      rejected.push(channel.serve({ type: 'hostcall', seq: message.seq, slot: 9 }, invoke, () => {}))
      rejected.push(channel.serve({ type: 'hostcall', seq: message.seq, slot: other }, invoke, () => {}))
      const ok = channel.serve(message, invoke, m => worker.postMessage(m))
      rejected.push(channel.serve(message, invoke, () => {}))
      assert.equal(ok.ok, true, '正确配对的 hostcall 必须被服务')
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'done', 'worker 报告失败：' + JSON.stringify(outcome))
  assert.equal(outcome.value, 'ok', '配对成功必须回值')
  assert.equal(calls, 1, '只有配对成功那一次可以执行宿主 API（重复/错配一律不执行）')
  assert.deepEqual(rejected.slice(0, 3).map(item => item.reason), ['unpaired', 'unpaired', 'unpaired'], '三类错配必须被拒')
  assert.equal(rejected[3].reason, 'unpaired', '同 seq 的重复 hostcall 必须被拒（请求已被消费）')
  const snapshot = inspectChannel(sab)
  assert.equal(snapshot.spurious, 4, '四次非法通知必须计入 spurious 计数，实际：' + snapshot.spurious)
  assert.equal(snapshot.slots[pairedSlot].state, STATE_VALUE, '配对槽最终必须是 VALUE（seq=' + snapshot.slots[pairedSlot].seq + '）')
  const untouched = snapshot.slots.filter(slot => slot.slot !== pairedSlot)
  assert.equal(untouched.every(slot => slot.state === STATE_IDLE && slot.seq === 0), true, '错配写入不得触碰其他槽：' + JSON.stringify(untouched))
})

test('audit-ipc：错序响应不采信——响亮失败并作废通道（迟到响应不可能被当成结果）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 8000 });
  try { parentPort.postMessage({ type: 'done', value: ch.call({ member: 'probe' }).value }); }
  catch (error) { parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code }); }
});
`
  const worker = spawnWorker(workerCode, { sab })
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      // 敌意/陈旧宿主：往**同一个槽**写一个值，但把 S_SEQ 换成别的请求号。
      const header = slotHeader(sab, message.slot)
      const payload = slotPayload(sab, message.slot)
      const bytes = encodeValue('EVIL')
      payload.set(bytes, 0)
      Atomics.store(header, SLOT_INDEX_LENGTH, bytes.length)
      Atomics.store(header, SLOT_INDEX_SEQ, message.seq + 101)
      Atomics.store(header, SLOT_INDEX_STATE, STATE_VALUE)
      Atomics.notify(header, SLOT_INDEX_STATE)
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'failed', '错序响应必须响亮失败，不得采信：' + JSON.stringify(outcome))
  assert.equal(outcome.code, 'RUNTIME_IPC_PROTOCOL', '必须是协议错代码')
  assert.match(String(outcome.error), /序号被替换/, '错误信息必须指明序号被替换')
  assert.equal(outcome.value, undefined)
  assert.equal(inspectChannel(sab).invalid, true, '协议错必须作废通道')
})

test('audit-ipc：同步超时后第二次调用响亮失败（不消费陈旧响应、不继续复用）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 300 });
  const codes = [];
  try { ch.call({ member: 'never' }); } catch (error) { codes.push(error.code); }
  try { const r = ch.call({ member: 'never' }); codes.push('unexpected:' + JSON.stringify(r)); }
  catch (error) { codes.push(error.code); }
  parentPort.postMessage({ type: 'done', codes });
});
`
  const worker = spawnWorker(workerCode, { sab })
  // 收到 hostcall **故意不服务**：模拟宿主卡死；也绝不写任何响应。
  const outcome = await terminal(worker, { timeoutMs: 10000 })
  await worker.terminate()
  assert.equal(outcome.type, 'done', 'worker 报告失败：' + JSON.stringify(outcome))
  assert.deepEqual(outcome.codes, ['RUNTIME_IPC_TIMEOUT', 'RUNTIME_IPC_INVALID'],
    '第一次必须超时，第二次必须因通道作废而响亮失败（不得复用通道）')
  assert.equal(inspectChannel(sab).invalid, true, '超时必须置位作废标记')
})

test('audit-ipc：ticket 带请求序号——错配拒绝结算、未知忽略、正确才结算', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const notified = []
  const channel = createWorkerChannel({ sab, notify: message => notified.push(message), timeoutMs: 1000 })
  const promise = channel.awaitTicket(7, 3)
  let settled = null
  promise.then(value => { settled = value }, error => { settled = 'rejected:' + String(error && error.code) })

  const mispaired = channel.handleMessage({ type: 'ticket', id: 7, ticket: 7, seq: 99, ok: true, value: 'wrong' })
  assert.equal(mispaired, false, '请求序号不配对的 ticket 必须被拒')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(settled, null, '错配 ticket 不得结算在飞 Promise')
  assert.equal(channel.pendingTickets(), 1, '错配后仍应等待正确 ticket')
  assert.equal(inspectChannel(sab).mispaired, 1, '错配必须计入 mispaired 计数')
  assert.equal(channel.invalidated, false, '单次错配不得直接作废通道')

  assert.equal(channel.handleMessage({ type: 'ticket', ticket: 7, seq: 3, ok: true, value: 'right' }), true, '正确 ticket 必须被消费')
  assert.equal(await promise, 'right', '正确 ticket 必须结算')
  assert.equal(channel.pendingTickets(), 0)
  assert.equal(channel.handleMessage({ type: 'ticket', ticket: 999, seq: 3, ok: true, value: 'late' }), false, '未知/迟到 ticket 必须忽略')
  assert.equal(channel.invalidated, false, '忽略迟到 ticket 不得作废通道')
})

test('audit-ipc：响应长度非法（超载荷容量）必须响亮失败，不越界读', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 8000 });
  try { parentPort.postMessage({ type: 'done', value: ch.call({ member: 'probe' }).value }); }
  catch (error) { parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code }); }
});
`
  const worker = spawnWorker(workerCode, { sab })
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      const header = slotHeader(sab, message.slot)
      Atomics.store(header, SLOT_INDEX_SEQ, message.seq)
      Atomics.store(header, SLOT_INDEX_RESP_SEQ, message.seq) // 回显号正确：本用例只针对长度护栏
      Atomics.store(header, SLOT_INDEX_LENGTH, PAYLOAD + 1) // 越界长度
      Atomics.store(header, SLOT_INDEX_STATE, STATE_VALUE)
      Atomics.notify(header, SLOT_INDEX_STATE)
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'failed', '非法长度必须响亮失败：' + JSON.stringify(outcome))
  assert.equal(outcome.code, 'RUNTIME_IPC_PROTOCOL')
  assert.match(String(outcome.error), /响应长度非法/)
})

test('audit-ipc：虚假/重复 notify 只累计同一 deadline（有界，不 busy spin）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 400 });
  const started = Date.now();
  try { parentPort.postMessage({ type: 'done', value: ch.call({ member: 'never' }).value }); }
  catch (error) { parentPort.postMessage({ type: 'failed', code: error.code, elapsed: Date.now() - started }); }
});
`
  const worker = spawnWorker(workerCode, { sab })
  let spam = null
  const outcome = await terminal(worker, {
    timeoutMs: 10000,
    onMessage: message => {
      if (!message || message.type !== 'hostcall' || spam) return
      const header = slotHeader(sab, message.slot)
      // 只发通知、不写任何响应状态：虚假唤醒必须消耗同一个 deadline，而不是重置它。
      spam = setInterval(() => { try { Atomics.notify(header, SLOT_INDEX_STATE) } catch { /* 通道作废后忽略 */ } }, 40)
    },
  })
  if (spam) clearInterval(spam)
  await worker.terminate()
  assert.equal(outcome.type, 'failed', '宿主不响应时必须超时失败：' + JSON.stringify(outcome))
  assert.equal(outcome.code, 'RUNTIME_IPC_TIMEOUT', '虚假 notify 不得被当成响应')
  assert.ok(outcome.elapsed >= 350, '必须真的等满预算，实际 ' + outcome.elapsed + 'ms')
  assert.ok(outcome.elapsed < 2000, '虚假 notify 不得重置 deadline（否则会远超预算）：' + outcome.elapsed + 'ms')
})

test('audit-activity：跨线程原子 add/sub 精确计数 + plain 对象兼容 + 桥导出同源', async () => {
  const { sab: activitySab, activity } = createSharedActivityCounter()
  const perThread = 5000
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createActivityCounter, bumpActivity }) => {
  const counter = createActivityCounter(workerData.activitySab);
  for (let index = 0; index < workerData.perThread; index += 1) bumpActivity(counter, 1);
  parentPort.postMessage({ type: 'done', pending: counter.pending });
});
`
  const worker = spawnWorker(workerCode, { activitySab, perThread })
  const outcome = terminal(worker)
  for (let index = 0; index < perThread; index += 1) bumpActivity(activity, 1)
  const done = await outcome
  await worker.terminate()
  assert.equal(done.type, 'done')
  assert.equal(activity.pending, perThread * 2, '两线程各 ' + perThread + ' 次自增必须精确相加（原子 RMW），实际：' + activity.pending)
  assert.equal(done.pending, perThread * 2, 'Worker 侧读到的必须是同一个数')
  assert.equal(bumpActivity(activity, -1000), perThread * 2 - 1000, 'sub 必须原子生效')
  assert.equal(bumpActivity(activity, -1e9), 0, '计数不得为负（钳到 0）')

  const plain = { pending: 0 }
  assert.equal(bumpActivity(plain, 3), 3, 'plain `{pending}` 对象必须兼容')
  assert.equal(bumpActivity(plain, -5), 0, 'plain 对象同样钳到 0')
  assert.equal(bumpActivity(null, 1), 0, 'null 计数必须安全 no-op')

  const shared = createSharedActivity()
  assert.equal(shared.activity.pending, 0, '桥导出的共享计数必须是同一实现（初始 0）')
  shared.activity.pending = 3
  assert.equal(Atomics.load(new Int32Array(shared.sab, 0, 1), 0), 3, '桥导出写的必须是 SAB 上的可见值')
  assert.equal(bumpActivity(shared.activity, 1), 4, '桥导出的计数器必须支持原子 add')
})

test('audit-activity：源码守卫——不得再有本地计数器视图或活动计数 RMW', () => {
  const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
  const bridge = read('../lib/mvu/card-runtime-bridge.js')
  const worker = read('../lib/mvu/card-runtime-worker.js')
  assert.doesNotMatch(bridge, /new Int32Array\(/, '桥不得自带活动计数视图（应走 runtime-ipc 的工厂）')
  assert.match(bridge, /createSharedActivityCounter/, '桥必须用共享工厂')
  assert.doesNotMatch(worker, /new Int32Array\(/, 'Worker 入口不得自带活动计数视图')
  assert.match(worker, /createActivityCounter/, 'Worker 入口必须用共享工厂')
  const rmw = /(?:activity|current\.activity)(?:\?)?\.pending\s*(?:\+=|-=|\+\+|--)/
  for (const file of ['../lib/sandbox-policy.js', '../lib/helper-generation-api.js', '../lib/server-execution.js', '../lib/mvu/card-runtime-worker.js']) {
    const source = read(file)
    assert.doesNotMatch(source, rmw, file + ' 不得再写活动计数读改写（必须走 bumpActivity）')
    assert.match(source, /bumpActivity/, file + ' 必须显式用 bumpActivity 增减')
  }
})

test('audit-sandbox-policy：hookBudget cancel 必须清掉 tick 与 waiter 的全部定时器', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const live = new Set()
  globalThis.setTimeout = (fn, ms, ...args) => {
    // 触发即从 live 摘掉（只统计**仍然挂着**的定时器）；清理路径必须靠 clearTimeout 摘。
    const handle = realSetTimeout(() => { live.delete(handle); fn() }, ms, ...args)
    live.add(handle)
    return handle
  }
  globalThis.clearTimeout = handle => {
    live.delete(handle)
    return realClearTimeout(handle)
  }
  try {
    let cancelled = null
    const budget = hookBudget({
      isSettled: () => false, timeoutMs: 60000, awaitTimeoutMs: 60000, tickMs: 20,
      onCancel: error => { cancelled = error },
    })
    budget.catch(() => {}) // 本用例不 await：先挂兜底，避免 unhandledRejection
    await new Promise(resolve => realSetTimeout(resolve, 90))
    assert.ok(live.size >= 2, '在飞预算必须同时持有 tick 与 waiter 定时器，实际：' + live.size)
    budget.cancel('audit-cancel')
    assert.equal(live.size, 0, 'cancel 必须清掉全部定时器（含 waiter 自带定时器），实际残留：' + live.size)
    assert.ok(cancelled && /audit-cancel/.test(String(cancelled.message)), 'onCancel 必须收到取消原因')
    await new Promise(resolve => realSetTimeout(resolve, 60))
    assert.equal(live.size, 0, '取消后不得再排新定时器')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

// ─────────────── 协议收口（audit-ipc2：）───────────────

test('audit-ipc2：宿主作废必须 notify 唤醒阻塞中的 wait（不等 deadline 才失败）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 30000 });
  const started = Date.now();
  try { parentPort.postMessage({ type: 'done', value: ch.call({ member: 'never' }).value }); }
  catch (error) { parentPort.postMessage({ type: 'failed', code: error.code, elapsed: Date.now() - started }); }
});
`
  const worker = spawnWorker(workerCode, { sab })
  const outcome = await terminal(worker, {
    timeoutMs: 10000,
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      // 宿主侧释放：只作废通道（不写任何响应），必须靠 notify 把阻塞的 Atomics.wait 唤醒。
      channel.invalidate('audit-dispose')
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'failed', '宿主作废后同步调用必须失败：' + JSON.stringify(outcome))
  assert.equal(outcome.code, 'RUNTIME_IPC_INVALID', '必须是"通道作废"错误，而不是等到 30s 超时')
  assert.ok(outcome.elapsed < 2000, '作废必须唤醒等待（不得等满 deadline 30s），实际 ' + outcome.elapsed + 'ms')
  assert.equal(inspectChannel(sab).invalid, true, '宿主侧作废必须置 C_INVALID')
})

test('audit-ipc2：响应独立回显——正常路径回显号等于请求号', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  const echoed = []
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 8000 });
  try { const r = ch.call({ member: 'probe' }); parentPort.postMessage({ type: 'done', value: r.value, seq: r.seq, slot: r.slot }); }
  catch (error) { parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code }); }
});
`
  const worker = spawnWorker(workerCode, { sab })
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      channel.serve(message, () => 'ok', () => {})
      const slot = inspectChannel(sab).slots[message.slot]
      echoed.push({ requestSeq: message.seq, respSeq: slot.respSeq, state: slot.state })
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'done', 'worker 报告失败：' + JSON.stringify(outcome))
  assert.equal(outcome.value, 'ok')
  assert.deepEqual(echoed, [{ requestSeq: 1, respSeq: 1, state: STATE_VALUE }],
    '响应必须在**独立字段** S_RESP_SEQ 回显请求号（而不仅仅复用请求号字段）：' + JSON.stringify(echoed))
})

test('audit-ipc2：响应回显号不匹配 ⇒ 响亮失败（即使请求号正确）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 8000 });
  try { parentPort.postMessage({ type: 'done', value: ch.call({ member: 'probe' }).value }); }
  catch (error) { parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code }); }
});
`
  const worker = spawnWorker(workerCode, { sab })
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      const header = slotHeader(sab, message.slot)
      const payload = slotPayload(sab, message.slot)
      const bytes = encodeValue('EVIL')
      payload.set(bytes, 0)
      Atomics.store(header, SLOT_INDEX_LENGTH, bytes.length)
      Atomics.store(header, SLOT_INDEX_SEQ, message.seq)        // 请求号"看起来正确"
      Atomics.store(header, SLOT_INDEX_RESP_SEQ, message.seq + 9) // 但回显号不对
      Atomics.store(header, SLOT_INDEX_STATE, STATE_VALUE)
      Atomics.notify(header, SLOT_INDEX_STATE)
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'failed', '回显号不匹配必须响亮失败：' + JSON.stringify(outcome))
  assert.equal(outcome.code, 'RUNTIME_IPC_PROTOCOL')
  assert.match(String(outcome.error), /回显序号不匹配/, '错误必须指明回显号不匹配')
  assert.equal(inspectChannel(sab).invalid, true, '必须作废通道')
})

test('audit-ipc2：int32 越界序号 fail-closed（宿主拒收 + Worker 不采信 + 常量守卫）', async () => {
  assert.equal(MAX_REQUEST_SEQ, 2147483647, 'int32 上限常量必须暴露且正确')
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  let calls = 0
  const invoke = () => { calls += 1; return 'ok' }
  const send = () => {}
  for (const seq of [MAX_REQUEST_SEQ + 1, MAX_REQUEST_SEQ + 1024, 0, -1, -2147483648]) {
    const result = channel.serve({ type: 'hostcall', seq, slot: 0 }, invoke, send)
    assert.equal(result.ok, false, `越界序号必须被拒：${seq}`)
    assert.equal(result.reason, 'unpaired', `越界序号必须按未配对处理：${seq}`)
  }
  assert.equal(calls, 0, '越界序号一律不得执行宿主 API')
  assert.equal(inspectChannel(sab).spurious, 5, '每次越界都必须计入 spurious，实际：' + inspectChannel(sab).spurious)

  // Worker 侧：int32 回绕后的负序号响应绝不能被采信（fail-closed，而不是当成合法序号）。
  const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const ch = createWorkerChannel({ sab: workerData.sab, notify: m => parentPort.postMessage(m), timeoutMs: 8000 });
  try { parentPort.postMessage({ type: 'done', value: ch.call({ member: 'probe' }).value }); }
  catch (error) { parentPort.postMessage({ type: 'failed', error: String(error && error.message), code: error && error.code }); }
});
`
  const ring = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const worker = spawnWorker(workerCode, { sab: ring })
  const outcome = await terminal(worker, {
    onMessage: message => {
      if (!message || message.type !== 'hostcall') return
      const header = slotHeader(ring, message.slot)
      Atomics.store(header, SLOT_INDEX_SEQ, -1)      // 回绕后的请求号
      Atomics.store(header, SLOT_INDEX_RESP_SEQ, -1)
      Atomics.store(header, SLOT_INDEX_STATE, STATE_VALUE)
      Atomics.notify(header, SLOT_INDEX_STATE)
    },
  })
  await worker.terminate()
  assert.equal(outcome.type, 'failed', '负序号响应不得被采信：' + JSON.stringify(outcome))
  assert.equal(outcome.code, 'RUNTIME_IPC_PROTOCOL')

  // 请求号自增到 int32 上限的守卫无法在测试里跑满 2^31 次调用 ⇒ 用源码守卫补（静态断言）。
  const workerSource = readFileSync(new URL('../lib/mvu/card-runtime-worker.js', import.meta.url), 'utf8')
  const ipcSource = readFileSync(new URL('../lib/mvu/runtime-ipc.js', import.meta.url), 'utf8')
  assert.match(ipcSource, /MAX_REQUEST_SEQ/, 'runtime-ipc 必须持有 int32 上限常量')
  assert.match(ipcSource, /seqCounter >= MAX_REQUEST_SEQ/, '请求号自增前必须 fail-closed 守卫')
  assert.match(ipcSource, /ticketSeq >= MAX_REQUEST_SEQ/, 'ticket 号签发前必须 fail-closed 守卫')
  assert.equal(/MAX_REQUEST_SEQ/.test(workerSource), false, 'Worker 入口不重复定义上限（走共享常量）')
})

test('audit-ipc2：then-getter 抛 ⇒ 转为错误响应（不打死宿主事件循环）', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  let calls = 0
  const broken = { get then() { throw new Error('bad-then') } }
  // 手工发布一个合法请求（等价于 Worker 侧 call 的发布段）。
  const header = slotHeader(sab, 0)
  const payload = slotPayload(sab, 0)
  const bytes = encodeValue({ member: 'broken' })
  payload.set(bytes, 0)
  Atomics.store(header, SLOT_INDEX_LENGTH, bytes.length)
  Atomics.store(header, SLOT_INDEX_SEQ, 1)
  Atomics.store(header, SLOT_INDEX_RESP_SEQ, 0)
  Atomics.store(header, SLOT_INDEX_STATE, STATE_REQUEST)
  let thrown = null
  let result = null
  try {
    result = channel.serve({ type: 'hostcall', seq: 1, slot: 0 }, () => { calls += 1; return broken }, () => {})
  } catch (error) { thrown = error }
  assert.equal(thrown, null, 'then-getter 抛不得从 serve 抛出（否则打死宿主事件循环）：' + String(thrown && thrown.message))
  assert.equal(result.ok, false, '必须转为失败回执')
  assert.equal(result.reason, 'then-getter')
  assert.equal(calls, 1, '宿主 API 只执行一次')
  const slot = inspectChannel(sab).slots[0]
  assert.equal(slot.state, STATE_ERROR, '必须写回错误响应（Worker 才不会干等）')
  assert.equal(slot.respSeq, 1, '错误响应同样必须回显请求号')
})

test('audit-ipc2：不可克隆的 ticket 结果 ⇒ 失败 ticket，不产生 unhandledRejection', async () => {
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  const recorded = []
  const rejections = []
  const onUnhandled = reason => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const header = slotHeader(sab, 0)
  const payload = slotPayload(sab, 0)
  const bytes = encodeValue({ member: 'uncloneable' })
  payload.set(bytes, 0)
  Atomics.store(header, SLOT_INDEX_LENGTH, bytes.length)
  Atomics.store(header, SLOT_INDEX_SEQ, 1)
  Atomics.store(header, SLOT_INDEX_STATE, STATE_REQUEST)
  try {
    // invoke 返回 thenable，其结算值是**函数**（不可结构化克隆）⇒ send 抛 DataCloneError。
    const result = channel.serve({ type: 'hostcall', seq: 1, slot: 0 }, () => Promise.resolve(() => 1), message => {
      structuredClone(message) // 模拟 postMessage：不可克隆即抛
      recorded.push(message)
    })
    assert.equal(result.ok, true, '同步前缀成功 ⇒ 已发 ticket')
    assert.equal(channel.pendingTickets(), 1, 'ticket 必须先登记')
    await new Promise(resolve => setTimeout(resolve, 30)) // 让异步尾部结算
    assert.equal(recorded.length, 1, '必须只发一条兜底的失败 ticket，实际：' + JSON.stringify(recorded.map(m => m.ok)))
    assert.equal(recorded[0].ok, false, '不可克隆的结果必须改判为失败 ticket')
    assert.match(String(recorded[0].value && recorded[0].value.message), /无法跨线程回传/)
    assert.equal(channel.pendingTickets(), 0, '兜底结算后不得残留悬挂 ticket')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(rejections, [], '不得产生 unhandledRejection：' + rejections.map(String).join(' | '))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('audit-ipc2：释放/退出必须结算在飞 ticket 与 pendingOps（不悬挂）', async () => {
  // ① 宿主 ticket：宿主侧在飞 ticket 必须在作废时按失败结算并通知 Worker。
  const sab = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const channel = createHostChannel({ sab, payloadBytes: PAYLOAD, slotCount: SLOT_COUNT })
  const recorded = []
  const header = slotHeader(sab, 0)
  const payload = slotPayload(sab, 0)
  const bytes = encodeValue({ member: 'never' })
  payload.set(bytes, 0)
  Atomics.store(header, SLOT_INDEX_LENGTH, bytes.length)
  Atomics.store(header, SLOT_INDEX_SEQ, 1)
  Atomics.store(header, SLOT_INDEX_STATE, STATE_REQUEST)
  channel.serve({ type: 'hostcall', seq: 1, slot: 0 }, () => new Promise(() => {}), message => recorded.push(message))
  assert.equal(channel.pendingTickets(), 1, '未结算的宿主写必须先登记')
  channel.invalidate('audit-dispose')
  assert.equal(channel.pendingTickets(), 0, 'invalidate 必须清空在飞 ticket（不得悬挂）')
  assert.equal(recorded.length, 1, '必须给 Worker 发一条失败 ticket')
  assert.equal(recorded[0].ok, false)
  assert.equal(recorded[0].seq, 1, '失败 ticket 必须带请求序号')
  assert.equal(recorded[0].value.code, IPC_ERRORS.invalid)

  // ② Worker 侧在飞 ticket：作废必须立刻 reject，不得等到永远。
  const workerRing = createSharedSlot(PAYLOAD, SLOT_COUNT)
  const workerChannel = createWorkerChannel({ sab: workerRing, notify: () => {}, timeoutMs: 60000 })
  const pending = workerChannel.awaitTicket(1, 1)
  const settled = pending.then(() => 'resolved', error => 'rejected:' + String(error && error.code))
  workerChannel.invalidate('audit-worker-exit')
  assert.equal(await settled, 'rejected:' + IPC_ERRORS.invalid, 'Worker 侧在飞 ticket 必须被响亮拒绝')
  assert.equal(workerChannel.pendingTickets(), 0)
  let afterExit = null
  try { workerChannel.call({ member: 'x' }) } catch (error) { afterExit = error.code }
  assert.equal(afterExit, IPC_ERRORS.invalid, '作废后 call 必须响亮失败')

  // ③ 桥的 pendingOps：释放/终止/线程退出三条路径都必须结算（真机 Worker 集成待 mvu-card-runtime
  //    稳定后再跑，这里先用源码守卫固定接线，避免"释放后 dispatch 悬挂"回潮）。
  const bridgeSource = readFileSync(new URL('../lib/mvu/card-runtime-bridge.js', import.meta.url), 'utf8')
  const settleCalls = bridgeSource.match(/settlePendingOps\(/g) || []
  assert.ok(settleCalls.length >= 4, 'settlePendingOps 必须在定义之外被调用（fail/dispose/terminate/exit），实际 ' + settleCalls.length)
  assert.match(bridgeSource, /worker\.on\('exit'[\s\S]{0,200}settlePendingOps\(/, '线程退出路径必须结算在飞 op')
  assert.match(bridgeSource, /dispose\(\)[\s\S]{0,600}settlePendingOps\(/, 'dispose 必须结算在飞 op')
  assert.match(bridgeSource, /async terminate\(\)[\s\S]{0,400}settlePendingOps\(/, 'terminate 必须结算在飞 op')
})
