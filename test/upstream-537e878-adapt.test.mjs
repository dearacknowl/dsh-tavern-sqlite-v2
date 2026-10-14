// 上游 537e878（#196 对账/锚点）三项新合同的定向断言：
//   ① saveBodyEdit 第四形态（reconcileStory）注入与四形态互斥；
//   ② 对账补记 adopt:true 经正文提交护栏放行/拒绝（真实 537e878 turn-orchestration 施缝执行）；
//   ③ 物理重生成计划返回原轮真实 nativeAnchor 坐标。
// 只用缓存上游树与自有合成库；无模型、无真实档、无网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { applyBodyEditEventTransform } from '../deploy/core-host-transform.mjs'
import { applyRollbackBodyCommitTurnTransform } from '../deploy/rollback-body-commit-transform.mjs'
import { applyRowTimelineTransform } from '../deploy/row-rollback-transform.mjs'
import { applyRollbackBusinessTimelineTransform } from '../deploy/rollback-business-transform.mjs'
import { applySettlementRoundTransform } from '../deploy/settlement-round-transform.mjs'
import { planRegenerationEvents } from '../lib/regeneration-events.js'

// ── 叶①：saveBodyEdit 第四形态 ──────────────────────────────────────────────
const SAVE_RECONCILE = `      case 'saveBodyEdit': {
        await reconcileStory(args && args.sessionId)
        const view = await bodyEditor.save(args && args.sessionId, args)
        notifyPluginTimeline(args && args.sessionId, 'edit', { settled: true })
        return { view }
      }`
test('上游537e878正文编辑：reconcileStory第四形态注入保作者对账且四形态互斥', () => {
  const installed = applyBodyEditEventTransform(SAVE_RECONCILE)
  assert.ok(installed.includes('await reconcileStory(sessionId)'), '作者对账调用必须在注入体内保留')
  assert.ok(installed.includes('// [dsh-tavern-body-edit-event:v1]'), '接缝标记必须在场')
  assert.ok(installed.includes('MESSAGE_EDITED'), '插件编辑事件派发必须在场')
  assert.equal(applyBodyEditEventTransform(installed), installed, '二次应用必须幂等')
  const EDIT_TEXT = `    editText: async (material, text) => {
      await bodyEditor.replaceText(material.sessionId, text)
      notifyPluginTimeline(material.sessionId, 'edit', { settled: true })
    },`
  const withText = applyBodyEditEventTransform(SAVE_RECONCILE + EDIT_TEXT + '\n')
  assert.ok(withText.includes('// [dsh-tavern-body-edit-text-event:v1]'), 'editText 接缝必须随新形态注入')
  // 互斥：同一文本出现两个形态必须拒绝，不得猜其一。
  const SAVE_ADOPTION = `      case 'saveBodyEdit': {
        await adoptUncommittedRounds(args && args.sessionId)
        const view = await bodyEditor.save(args && args.sessionId, args)
        notifyPluginTimeline(args && args.sessionId, 'edit', { settled: true })
        return { view }
      }`
  assert.throws(() => applyBodyEditEventTransform(SAVE_RECONCILE + '\n' + SAVE_ADOPTION), /锚点缺失或重复/)
})

// ── 叶②：对账补记 adopt 通道（真实 537e878 turn-orchestration）──────────────
const testRequire = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/upstream-537e878-review/') || specifier.startsWith('.') || specifier.startsWith('node:')) throw error
  return next(pathToFileURL(testRequire.resolve(specifier)).href, context)
} } })
const author = new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/tavern-plugin/lib/domain/', import.meta.url)
const [copy, mutation, persistence, helperContext, roundAnchorModule] = await Promise.all(['copy-json-tree.js', 'json-mutation.js', 'chat-persistence.js', 'tavern-helper-context.js', 'round-anchor.js'].map(file => import(new URL(file, author))))
const { resolveRoundAnchor } = roundAnchorModule
// 生产接缝链上的 story-timeline（row → business → settlement）：补记轮业务基准与装机一致；
// 原始 timeline 不写 businessBefore，测不到 messageCount 合同。storage-rollback-business 重写到本包实现。
const businessStateUrl = new URL('../lib/rollback-business-state.js', import.meta.url).href
const timelineSource = applySettlementRoundTransform(applyRollbackBusinessTimelineTransform(applyRowTimelineTransform(readFileSync(new URL('story-timeline.js', author), 'utf8'))))
  .replace(/from '(\.[^']+)'/g, (_, name) => 'from ' + JSON.stringify(name === './storage-rollback-business.js' ? businessStateUrl : new URL(name, author).href))
const story = await import('data:text/javascript;base64,' + Buffer.from(timelineSource, 'utf8').toString('base64'))
const memorySource = readFileSync(new URL('../../packages/dsh-tavern-card-memory/index.js', author), 'utf8')
const memoryConstant = memorySource.split('\n').find(line => line.startsWith('export const CARD_MEMORY_TOOLS = '))
assert.ok(memoryConstant)
const memoryImport = "import { CARD_MEMORY_TOOLS } from '../../packages/dsh-tavern-card-memory/index.js'"
let turnSource = readFileSync(new URL('turn-orchestration.js', author), 'utf8'); assert.equal(turnSource.split(memoryImport).length, 2)
turnSource = turnSource.replace(memoryImport, memoryConstant.replace('export const', 'const'))
const transformed = applyRollbackBodyCommitTurnTransform(turnSource)
assert.equal(applyRollbackBodyCommitTurnTransform(transformed), transformed, '正文提交护栏施缝必须幂等')
assert.ok(transformed.includes('!rollbackBodyAdoptMatches(current,input)'), '补记护栏必须在提交路径在场')
const seamSource = transformed.replace(/from '(\.[^']+)'/g, (_, name) => 'from ' + JSON.stringify(new URL(name, author).href))
const { createTurnOrchestrator } = await import('data:text/javascript;base64,' + Buffer.from(seamSource, 'utf8').toString('base64'))
async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-537e878-adopt-')), helpers = { ...copy, ...mutation, ...helperContext }
  for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[name] = value => value === undefined ? undefined : structuredClone(value)
  const store = createChatSqliteStore({ dataRoot: root, helpers }), id = 'synthetic-adopt'
  t.after(() => { store.dispose(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('tavern-537e878-adopt-')); rmSync(root, { recursive: true, force: true }) })
  let seq = 0; const timeline = story.createStoryTimeline({ now: () => 10, id: prefix => prefix + '-' + (++seq) })
  let chat = { id, sessionId: 'synthetic-session', mode: 'story', _storageRevision: 1, messages: [{ role: 'user', text: '前轮输入' }, { role: 'assistant', turn: 1, text: '前轮正文' }] }
  const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 1, userText: '前轮输入' } })
  chat = begun.chat
  // 前轮必须完整提交：在当前 branch 上留下已提交 checkpoint（补记护栏的 branch 链判据依赖它）。
  const operation = chat.timeline.operations[begun.value.operationId]
  const done = timeline.complete({ chat, operationId: operation.id, basedOn: operation.basedOn, outcome: { status: 'success' }, apply() {} })
  chat = done.chat
  assert.equal(done.value.status, 'committed', '前轮提交必须成功')
  await store.update(id, () => chat)
  const records = persistence.createChatPersistence({ store, now: () => 11 })
  const counts = { slice: 0, patch: 0, full: 0, update: 0 }
  const facade = {
    readChatSlice: async (_session, indices, fields) => { counts.slice++; return records.readSlice(id, indices, fields) },
    chatForSession: async () => { counts.full++; return records.read(id) },
    patchChat: async (...args) => { counts.patch++; return records.patch(...args) },
    updateChat: async (...args) => { counts.update++; return records.update(...args) },
  }
  const orchestrator = createTurnOrchestrator({ store: facade, timeline, frameBuilder: { build() {} }, now: () => 10,
    projectReply: text => ({ sourceText: text, projectionText: text, sessionText: text, displayText: text, warnings: [] }) })
  const adoptInput = { sessionId: chat.sessionId, turn: 2, userText: '漏记输入', userContent: [{ type: 'text', text: '漏记输入' }], assistantText: '漏记正文', requestId: 'adopt-request', adopt: true, nativeAnchor: { turn: 2, input: 3, reply: 5 } }
  return { store, id, records, counts, orchestrator, timeline, adoptInput }
}
test('上游537e878对账补记：adopt走完整快照路径、业务基准记真实楼数并保锚点', async t => {
  const f = await fixture(t)
  const saved = await f.orchestrator.finalize(f.adoptInput)
  assert.equal(saved.saved, true)
  assert.equal(f.counts.update, 1, '补记必须走完整快照路径（全量 updateChat）')
  assert.equal(f.counts.patch, 0, '快路径不得用于补记：header-only chat 会把业务基准记成 messageCount=0，干净回退将按 0 截空正文')
  const chat = await f.records.read(f.id)
  assert.equal(chat.messages.length, 4, '补记必须追加本轮 user/assistant 两行')
  assert.equal(chat.messages.at(-1).turn, 2); assert.equal(chat.messages.at(-1).text, '漏记正文')
  assert.deepEqual(chat.messages.at(-1).nativeAnchor, { turn: 2, input: 3, reply: 5 }, '补记行必须保留对账器给的原生锚点')
  assert.equal(chat.nativeCommits?.['2']?.requestId, 'adopt-request')
  const cp = (chat.timeline?.checkpoints || []).filter(item => Number(item.turn) === 2).pop()
  assert.equal(cp?.businessBefore?.messageCount, 2, '补记轮业务回退基准必须记补记前真实楼数（2）')
})
test('上游537e878对账补记负例：回退后branch、纯空输入、异session、重复补记零写拒绝；附件-only放行', async t => {
  const f = await fixture(t)
  const expectZeroWrite = async input => { const before = await f.records.read(f.id); assert.deepEqual(await f.orchestrator.finalize(input), { saved: false, reason: 'stale-body-owner' }); assert.equal(f.counts.patch, 0, '拒绝时不得走 patch 写'); assert.deepEqual(await f.records.read(f.id), before, '拒绝必须零写：存档逐字节不变（完整路径回调返回 undefined 不落盘，update 调用计数不作零写证据）') }
  // 异 session / 纯空输入（空文本且无附件——上游 turn-lifecycle 根本不会产出这种轮）
  await expectZeroWrite({ ...f.adoptInput, sessionId: 'other-session' })
  await expectZeroWrite({ ...f.adoptInput, userText: '', userContent: [] })
  // rollbackPending 中：存储写屏障先于编排护栏直接拒绝（半态禁写是干净回退的第一道闸）
  await f.store.update(f.id, current => ({ ...current, _storageRevision: Number(current._storageRevision || 0) + 1, rollbackPending: { version: 1, id: 'pending', cuts: [] } }), { source: 'rollback.prepare' })
  const beforePending = await f.records.read(f.id)
  await assert.rejects(f.orchestrator.finalize(f.adoptInput), /物理回退未完成/, '半态写入必须被存储屏障拒绝')
  assert.deepEqual(await f.records.read(f.id), beforePending)
  await f.store.update(f.id, current => { const next = { ...current, _storageRevision: Number(current._storageRevision || 0) + 1 }; delete next.rollbackPending; return next }, { source: 'rollback.complete' })
  // 附件-only（上游 #196 合法玩家轮：空文本 + 附件）必须放行
  const attach = await f.orchestrator.finalize({ ...f.adoptInput, userText: '', userContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] })
  assert.equal(attach.saved, true, '附件-only 轮必须能补记')
  const attachChat = await f.records.read(f.id)
  assert.ok(Array.isArray(attachChat.messages.at(-2)?.inputAttachments) && attachChat.messages.at(-2).inputAttachments.length === 1, '附件轮 user 行必须保留 inputAttachments')
  // 同轮重复补记：已有 completed body operation，不得再写
  await expectZeroWrite(f.adoptInput)
  // 干净回退后态：回退必换 branch 且存档无回退轮痕迹；过期对账 report 的补记必须被拒，已删轮不可复活
  await f.store.update(f.id, current => ({ ...current, _storageRevision: Number(current._storageRevision || 0) + 1, timeline: { ...current.timeline, branchId: 'branch-after-rollback', revision: Number(current.timeline?.revision || 0) + 1 } }), { source: 'rollback.complete' })
  const turnThree = { ...f.adoptInput, turn: 3, requestId: 'adopt-3', nativeAnchor: { turn: 3, input: 7, reply: 9 } }
  await expectZeroWrite(turnThree)
})

// ── 叶③：重生成计划的原生锚点坐标 ──────────────────────────────────────────
const CHAT = 'chat-anchor'
const ev = (seq, type, data, surfaceOp, sourceEventSeqs) => ({ seq, type, time: 1, data, ...(surfaceOp ? { surfaceOp } : {}), ...(sourceEventSeqs ? { sourceEventSeqs } : {}) })
const user = () => ev(1, 'user/message', { id: 'u53', role: 'user', content: [{ type: 'text', text: '原输入' }], source: { kind: 'user' } })
const oldAssistant = () => ev(2, 'assistant/message', { turn: 53, step: 1, message: { id: 'a53', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model', provider: 'p', model: 'm' } } })
const newAssistant = (seq, turn) => ev(seq, 'assistant/message', { turn, step: 1, message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { kind: 'model', provider: 'p', model: 'm' } } })
test('上游537e878重生成锚点：计划返回原轮真实坐标input与重放reply，供采用覆盖临时锚点', () => {
  const events = [ev(0, 'turn/start', { turn: 53 }), user(), oldAssistant(),
    ev(3, 'turn/start', { turn: 54 }), ev(4, 'step/start', { turn: 54, step: 1 }),
    ev(5, 'tool/call', { turn: 54, name: 'read', args: {} }),
    ev(6, 'tool/result', { turn: 54, ok: true }, undefined, [5]),
    newAssistant(7, 54), ev(8, 'turn/end', { turn: 54, reason: { kind: 'completed' } }), ev(9, 'session/end-seed', {})]
  const plan = planRegenerationEvents({ events, oldTurn: 53, syntheticTurn: 54, eventStart: 3, oldAssistantSeq: 2, chatId: CHAT })
  // keep=2：replay=[step,tool,toolres,assistant,end]，assistant 是 replay[3] ⇒ reply=2+3=5。
  assert.deepEqual(plan.anchor, { turn: 53, input: 1, reply: 5 }, 'input=原轮真实user序号(keep-1)，reply=重放输出的assistant新序号(keep+重放下标)')
  assert.equal(events[plan.anchor.input].type, 'user/message', '锚点input必须落在原轮真实输入事件')
  assert.equal(plan.events[plan.anchor.reply - plan.keep].type, 'assistant/message', '锚点reply必须落在重放输出的assistant事件')
  // 多 assistant 尝试时取最后一个（与最终正文对应）；此场景 replay=[a,a,end] ⇒ 最后 a= replay[1] ⇒ reply=3
  const multi = [ev(0, 'turn/start', { turn: 53 }), user(), oldAssistant(),
    ev(3, 'turn/start', { turn: 54 }), newAssistant(4, 54), newAssistant(5, 54), ev(6, 'turn/end', { turn: 54, reason: { kind: 'completed' } })]
  const multiPlan = planRegenerationEvents({ events: multi, oldTurn: 53, syntheticTurn: 54, eventStart: 3, oldAssistantSeq: 2, chatId: CHAT })
  assert.equal(multiPlan.anchor.reply, 3, '多个assistant时锚点取最后一个非空正文')
})
test('上游537e878重生成锚点：末楼为replace时锚点取血缘根且真实resolver可解析', () => {
  // 真实 hook 常态：正则/宏使投影变化 ⇒ replaceAssistantReply 在临时轮末追加 replace 引用 append。
  const events = [ev(0, 'turn/start', { turn: 53 }), user(), oldAssistant(),
    ev(3, 'turn/start', { turn: 54 }), ev(4, 'step/start', { turn: 54, step: 1 }),
    newAssistant(5, 54),
    ev(6, 'assistant/message', { turn: 54, step: 1, message: { id: 'a54r', role: 'assistant', content: [{ type: 'text', text: '投影正文' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, { op: 'replace', startSeq: 5, endSeq: 5 }, [5]),
    ev(7, 'turn/end', { turn: 54, reason: { kind: 'completed' } }), ev(8, 'session/end-seed', {})]
  const plan = planRegenerationEvents({ events, oldTurn: 53, syntheticTurn: 54, eventStart: 3, oldAssistantSeq: 2, chatId: CHAT })
  // replay=[step(2),A(3),R(4,source=[3]),end(5)]：锚点必须落 append 根 3，指向 replace 自身(4)则 resolver 永远 reply=null。
  assert.deepEqual(plan.anchor, { turn: 53, input: 1, reply: 3 }, '末个assistant是replace时reply必须取血缘根')
  const assembled = [...events.slice(0, plan.keep), ...plan.events.map((event, index) => ({ ...event, seq: plan.keep + index }))]
  const shadowed = new Set(assembled.flatMap(event => Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []))
  const visible = assembled.filter(event => !shadowed.has(event.seq)).map(event => event.seq)
  const resolved = resolveRoundAnchor({ events: assembled, nodes: visible }, plan.anchor)
  assert.equal(resolved?.input, 1, '真实resolver必须命中input')
  assert.equal(resolved?.reply, 4, '真实resolver必须经replace命中当前reply节点（anchors.lost不再误报）')
})
