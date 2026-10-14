// 计划器纯单元：引用映射（含真实 startSeq/endSeq 与多 step 工具链）与异档/后继输入零计划。
import test from 'node:test'
import assert from 'node:assert/strict'
import { planRegenerationEvents } from '../lib/regeneration-events.js'

const CHAT = 'chat-plan'
const ev = (seq, type, data, surfaceOp, sourceEventSeqs) => ({ seq, type, time: 1, data, ...(surfaceOp ? { surfaceOp } : {}), ...(sourceEventSeqs ? { sourceEventSeqs } : {}) })
const user = () => ev(1, 'user/message', { id: 'u53', role: 'user', content: [{ type: 'text', text: '原输入' }], source: { kind: 'user' } })
const oldAssistant = () => ev(2, 'assistant/message', { turn: 53, step: 1, message: { id: 'a53', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model', provider: 'p', model: 'm' } } })
const head = turn => ev(0, 'turn/start', { turn })
const base = () => [head(53), user(), oldAssistant()]
const tail = (start = 8) => [ev(start, 'turn/end', { turn: 54, reason: { kind: 'completed' } }), ev(start + 1, 'session/end-seed', {})]
const opts = () => ({ oldTurn: 53, syntheticTurn: 54, eventStart: 3, oldAssistantSeq: 2, chatId: CHAT })

test('重生成计划：多 step 工具链引用映射，replace 用真实 startSeq/endSeq 且 turn 归原轮', () => {
  const events = [...base(),
    ev(3, 'turn/start', { turn: 54 }),
    ev(4, 'step/start', { turn: 54, step: 1 }),
    ev(5, 'tool/call', { turn: 54, name: 'read', args: {} }),
    ev(6, 'tool/result', { turn: 54, ok: true }, undefined, [5]),
    ev(7, 'assistant/message', { turn: 54, step: 1, message: { id: 'a54', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [{ chunk: 1 }] }, { op: 'replace', startSeq: 4, endSeq: 5 }, [4, 5]),
    ...tail(8)]
  const plan = planRegenerationEvents({ events, ...opts() })
  assert.equal(plan.keep, 2, '前缀固定到原 user 之后')
  assert.deepEqual(plan.events.map(e => e.type), ['step/start', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'])
  assert.deepEqual(plan.events.map(e => e.data.turn), [53, 53, 53, 53, 53], '所有输出 turn 必须归原轮')
  assert.deepEqual(plan.events[2].sourceEventSeqs, [3], '工具引用必须映射到 keep + 重放下标')
  assert.deepEqual(plan.events[3].sourceEventSeqs, [2, 3])
  assert.deepEqual(plan.events[3].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 }, 'replace 区间按 startSeq/endSeq 严格映射')
  assert.deepEqual(plan.events[3].data.stream, [{ chunk: 1 }], 'stream 等字段不得删除')
  assert.equal(plan.events[4].data.reason.kind, 'completed', '收尾保留真实 reason')
  assert.equal(plan.originalTail.some(e => e.seq === 2), true, 'originalTail 供本次恢复')
})

test('重生成计划：异档 trace、后继真实 user、未知控制事件一律零计划', () => {
  const foreign = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'assistant/message', { turn: 54, step: 1, message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 't' }], source: { kind: 'plugin', plugin: 'other-plugin', trace: { chatId: 'other-chat' } } } }), ...tail(5)]
  assert.throws(() => planRegenerationEvents({ events: foreign, ...opts() }), /其它档/, '异档 trace 必须拒')
  const followUp = [...base(), ev(3, 'user/message', { id: 'u54', role: 'user', content: [{ type: 'text', text: '后继输入' }], source: { kind: 'user' } }), ev(4, 'turn/start', { turn: 54 }), ...tail(5)]
  assert.throws(() => planRegenerationEvents({ events: followUp, ...opts() }), /真实玩家输入/, '后继真实 user 必须拒（eventStart=4）')
  const injectedUser = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'user/message', { id: 'u54', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }), ev(5, 'assistant/message', { turn: 54, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 't' }], source: { kind: 'model', provider: 'p', model: 'm' } } }), ...tail(6)]
  assert.throws(() => planRegenerationEvents({ events: injectedUser, ...opts() }), /真实玩家输入/, '临时轮内真实 user 必须拒')
  const unknown = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'control/edit', { turn: 54 }), ...tail(5)]
  assert.throws(() => planRegenerationEvents({ events: unknown, ...opts() }), /未列举的事件类型/, '未知控制事件必须拒')
  const badRef = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'tool/result', { turn: 54 }, undefined, [2]), ev(5, 'assistant/message', { turn: 54, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 't' }], source: { kind: 'model', provider: 'p', model: 'm' } } }), ...tail(6)]
  assert.throws(() => planRegenerationEvents({ events: badRef, ...opts() }), /引用指向被删除的事件/, '指向已删旧输出的引用必须拒')
})
