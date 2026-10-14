// 发送接受接缝的生命周期定向测试（独占新文件；**执行等你通知 registry 改完**）。
//   叶①：installSendAcceptance(Session) 必须先 capture 后 native；卸载后不再 capture 且原型还原到原函数（身份相等）。
//   叶②：同一 dataRoot 重复 registerSendCapture 必须**响亮拒绝**（主即将改），dispose 只卸自己的注册，正负零破坏。
// 说明：叶② 按"目标语义"写（当前实现是覆盖式注册）⇒ 在 registry 改动落地前预期失败，切勿据此改实现迎合。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { installSendAcceptance, captureAcceptedSend, registerSendCapture, activeSendCapture } from '../lib/send-acceptance.js'
import { invalidateLinkMap } from '../lib/tavern-chat-state.js'

const HOME_BEFORE = process.env.DSH_HOME
// 微 Session：只实现接缝真正读取的表面（append/seq/id/snapshotEvents），用于验证安装器机制本身。
function microSession(id = 'session-lifecycle') {
  const events = [{ seq: 0, type: 'session/end-seed', data: {} }]
  return {
    id,
    events,
    get seq() { return events.at(-1).seq + 1 },
    snapshotEvents() { return events.slice() },
    append(type, data) { events.push({ seq: this.seq, type, data }); return this },
  }
}
function withHome(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-send-lifecycle-'))
  const home = path.join(root, 'dsh-home')
  const dataRoot = path.join(root, 'tavern-data')
  mkdirSync(path.join(home, 'profiles', 'tavern'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'tavern', 'package.json'), JSON.stringify({ dshTavern: { dataRoot } }), 'utf8')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path.join(dataRoot, 'sessions.json'), JSON.stringify({ 'session-lifecycle': 'chat-lifecycle' }), 'utf8')
  process.env.DSH_HOME = home
  invalidateLinkMap()
  return Promise.resolve(run({ root, home, dataRoot })).finally(() => {
    if (HOME_BEFORE === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = HOME_BEFORE
    invalidateLinkMap()
    rmSync(root, { recursive: true, force: true })
  })
}

test('发送接受安装器：先capture后native且卸载后不再capture、原型还原', async () => {
  await withHome(async ({ dataRoot }) => {
    // 微 Session 类：状态在实例上，安装器 patch 的正是同一原型（capture 收到的 this 必须能读 events/seq）。
    class Session {
      constructor(id = 'session-lifecycle') { this.id = id; this.events = [{ seq: 0, type: 'session/end-seed', data: {} }] }
      get seq() { return this.events.at(-1).seq + 1 }
      snapshotEvents() { return this.events.slice() }
      append(type, data) { this.events.push({ seq: this.seq, type, data }); return this }
    }
    const originalAppend = Session.prototype.append
    const seen = []
    const uninstall = installSendAcceptance(Session, (self, type, data) => {
      // capture 必须在 native append 之前：此刻这条事件还没进 log。
      seen.push({ type, logLength: self.events.length, lastType: self.events.at(-1).type })
    })
    assert.notEqual(Session.prototype.append, originalAppend, '安装后原型必须被接线')
    const target = new Session()
    target.append('turn/start', { turn: 6 })
    target.append('user/message', { id: 'u6', role: 'user', content: [], source: { kind: 'user' } })
    target.append('assistant/message', { turn: 6 })
    assert.equal(target.events.filter(event => event.type === 'turn/start').length, 1, 'native append 必须照常执行')
    const contractSeen = seen.filter(item => item.type === 'turn/start' || item.type === 'user/message')
    assert.deepEqual(contractSeen.map(item => item.lastType), ['session/end-seed', 'turn/start'],
      'capture 必须在 native append 之前：user/message 的 capture 只应看到此前的 turn/start，而不是 user/message 本身')
    assert.deepEqual(contractSeen.map(item => item.logLength), [1, 2], 'capture 看到的是 append 之前的 log 长度')
    uninstall()
    assert.equal(Session.prototype.append, originalAppend, '卸载必须把原型还原成原函数（身份相等，不是等价包装）')
    target.append('turn/start', { turn: 7 })
    assert.equal(seen.filter(item => item.type === 'turn/start' || item.type === 'user/message').length, 2, '卸载后不得再 capture')
    assert.equal(target.events.filter(event => event.type === 'turn/start').length, 2, '卸载后 native append 仍必须工作')
    // 接口契约（现状：安装器把 custom capture 接到**所有** type，类型过滤只在缺省 captureAcceptedSend 内）：
    // 该断言在主把类型过滤移到安装器之后通过；在此之前它以"安装器未过滤"的明确信息失败，本测试不为迎合实现改期待。
    assert.deepEqual([...new Set(seen.map(item => item.type))], ['turn/start', 'user/message'],
      '安装器只应把 turn/start 与 user/message 交给 capture（其余 type 由安装器过滤）')
    // 真实 callback（captureAcceptedSend）经同一安装器：注册写口后必须收到既有身份契约。
    const received = []
    const dispose = registerSendCapture(dataRoot, (chatId, input) => received.push({ chatId, ...input }))
    try {
      const uninstall2 = installSendAcceptance(Session)   // 缺省＝真实 captureAcceptedSend
      const live = new Session()
      live.append('turn/start', { turn: 8 })
      assert.equal(received.length, 1, '真实 captureAcceptedSend 必须经安装器触发')
      assert.equal(received[0].chatId, 'chat-lifecycle', 'chatId 必须来自作者链接表')
      assert.equal(received[0].sessionId, 'session-lifecycle')
      assert.equal(received[0].turn, 8)
      assert.equal(received[0].type, 'turn/start')
      assert.equal(received[0].seq, live.events.at(-1).seq, 'seq 必须等于该轮 turn/start 事件的 seq（capture 看到的是 append 之前的值）')
      uninstall2()
      assert.equal(Session.prototype.append, originalAppend, '缺省安装器卸载后也必须原型还原')
    } finally { dispose() }
  })
})

test('发送接受注册表：同根可多注册按到达序保留最后者生效、卸载只摘自己且回落前一个注册', async () => {
  await withHome(async ({ dataRoot }) => {
    const calls = []
    const seen = []
    const firstCapture = (chatId, input) => seen.push({ who: 'first', chatId, input })
    const secondCapture = (chatId, input) => seen.push({ who: 'second', chatId, input })
    const first = registerSendCapture(dataRoot, firstCapture)
    assert.equal(typeof first, 'function', '注册必须返回卸载函数')
    assert.equal(activeSendCapture(dataRoot), firstCapture, '唯一注册即生效者')
    // 新合同：同 dataRoot 可合法并存多个注册（冷读/维护第二实例）⇒ 不抛错，按到达序保留，捕获交最后注册者。
    const second = registerSendCapture(dataRoot, secondCapture)
    assert.equal(activeSendCapture(dataRoot), secondCapture, '同根多注册时最后注册者生效')
    assert.equal(activeSendCapture(), secondCapture, '缺省根（tavernDataRoot）必须解析到同一注册表')
    captureAcceptedSend(microSession(), 'turn/start', { turn: 6 })
    assert.deepEqual(seen.map(item => item.who), ['second'], '捕获只交最后注册者，前一个注册不重复收')
    // 卸载只摘自己那条：摘掉最后注册者后回落到前一个注册。
    second()
    assert.equal(activeSendCapture(dataRoot), firstCapture, '卸载后必须回落到前一个注册')
    captureAcceptedSend(microSession(), 'turn/start', { turn: 7 })
    assert.deepEqual(seen.map(item => item.who), ['second', 'first'], '回落后的注册必须接住捕获')
    // 陈旧 disposer（重复调用已摘除的那条）不得误删当前生效者。
    second()
    captureAcceptedSend(microSession(), 'turn/start', { turn: 8 })
    assert.deepEqual(seen.map(item => item.who), ['second', 'first', 'first'], '陈旧 disposer 不得摘掉当前注册')
    // 换一个根注册互不影响（不是全局单例）。
    const otherRoots = []
    const other = registerSendCapture(dataRoot + '-other', (chatId, input) => otherRoots.push({ chatId, input }))
    assert.equal(activeSendCapture(dataRoot), firstCapture, '别的根注册不得影响本根')
    assert.equal(activeSendCapture(dataRoot + '-other') !== firstCapture, true, '别的根有自己的生效者')
    other()
    assert.equal(activeSendCapture(dataRoot + '-other'), null, '别的根卸载后为空')
    // 全部摘净后：没有写口时必须**响亮抛错**（失败关闭语义保留），不是静默跳过。
    first()
    assert.equal(activeSendCapture(dataRoot), null, '全部卸载后本根注册表必须清空')
    assert.throws(() => captureAcceptedSend(microSession(), 'turn/start', { turn: 9 }), /尚未装配/, '无写口必须响亮拒绝而不是静默跳过')
    assert.deepEqual(seen.map(item => item.who), ['second', 'first', 'first'], '卸载后不得再捕获')
  })
})
