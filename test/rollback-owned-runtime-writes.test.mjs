// 归属写口回归（独占新文件；真实 import，不用库/不 mock）：
//   ① 基准52 的未知运行根 + 新增根 + messages[0] 文本，按 metadata.rollbackOwner 精确身份记录，恢复各归其位
//   ② configuration.edit 的独立 guides/unknownControl 改动不被归属记录 ⇒ 恢复后保留
//   ③ foreground.commit 记录未知根且 body/cp 携同一累计前像；before 不得被就地修改（copy-on-write）
import test from 'node:test'
import assert from 'node:assert/strict'
import { captureRollbackBusinessState, recordRollbackBusinessWrites, restoreRollbackBusinessState } from '../lib/rollback-business-state.js'

const ID = 'chat-owned', SESSION = 'session-owned', BRANCH = 'branch-owned'
const BIZ52 = { version: 1, fields: {}, messageCount: 1, participants: {}, operationIds: [], operationStates: {}, operationPreimages: {} }

// 52 轮业务状态：未知运行根 runtimeRoot='old'、尚无 newRoot、messages[0].text='old'、独立未知块。
function chat52() {
  return {
    id: ID, sessionId: SESSION, mode: 'story', runtimeRoot: 'old', unknownBlock: { keep: true },
    messages: [{ role: 'user', text: 'old' }],
    timeline: { schemaVersion: 1, branchId: BRANCH, revision: 52, participants: { left: {} }, operations: { body52: { kind: 'body', role: 'body', status: 'completed', turn: 52, userText: 'x' } }, checkpoints: [] },
  }
}
// 53 轮写前状态：body53 已带 v1 前像（累计器），并含同轮 checkpoint。
function before53(baseline) {
  const chat = chat52()
  chat.timeline = {
    ...chat.timeline, revision: 53,
    operations: { ...chat.timeline.operations, body53: { kind: 'body', role: 'body', status: 'running', turn: 53, userText: 'x', businessBefore: structuredClone(baseline) } },
    checkpoints: [{ id: 'cp53', turn: 53, businessBefore: structuredClone(baseline) }],
  }
  return chat
}
const owner = { chatId: ID, sessionId: SESSION, branchId: BRANCH, operationId: 'body53', turn: 53 }

test('归属写口①：基准52未知运行根与新增根、消息文本按精确身份记录并在恢复时各归其位', () => {
  const baseline = captureRollbackBusinessState(chat52())
  const before = before53(baseline)
  const next = structuredClone(before)
  next.runtimeRoot = 'new'
  next.newRoot = { added: 1 }
  next.messages[0].text = 'new'
  const id = recordRollbackBusinessWrites(before, next, { source: 'foreground.commit', rollbackOwner: owner })
  assert.equal(id, 'body53', '必须归属到同轮 body 操作')
  const roots = next.timeline.operations.body53.businessBefore.runtimeFields
  assert.deepEqual(roots.runtimeRoot, { present: true, value: 'old' }, '未知运行根必须记录旧值')
  assert.deepEqual(roots.newRoot, { present: false }, '新增根必须记录"原本不存在"')
  assert.deepEqual(next.timeline.operations.body53.businessBefore.messagePreimages['0'], { role: 'user', text: 'old' }, '被改写的历史行必须留有行前像')
  assert.ok(!Object.hasOwn(baseline, 'runtimeFields'), '原基准不得被就地写入')
  const after = restoreRollbackBusinessState(next, next.timeline.operations.body53.businessBefore)
  assert.equal(after.runtimeRoot, 'old', '恢复：未知运行根必须回 old')
  assert.equal(Object.hasOwn(after, 'newRoot'), false, '恢复：新增根必须被删除')
  assert.equal(after.messages[0].text, 'old', '恢复：消息文本必须回 old')
  assert.deepEqual(after.unknownBlock, { keep: true }, '未被归属写口触碰的块必须原样保留')
  assert.equal(Object.hasOwn(after.timeline.operations, 'body53'), false, '恢复：基准外的操作必须删除')
})

test('归属写口②：configuration.edit 的独立 guides/unknownControl 改动不被归属记录，恢复后保留', () => {
  const baseline = captureRollbackBusinessState(chat52())
  const before = before53(baseline)
  const next = structuredClone(before)
  next.guides = { style: 'new' }
  next.unknownControl = { mode: 'new' }
  const id = recordRollbackBusinessWrites(before, next, { source: 'configuration.edit' })
  assert.equal(id, undefined, '独立配置编辑不是归属写口，必须不记录')
  assert.equal(Object.hasOwn(next.timeline.operations.body53.businessBefore, 'runtimeFields'), false, '不得把配置改动记进运行时根')
  const after = restoreRollbackBusinessState(next, next.timeline.operations.body53.businessBefore)
  assert.deepEqual(after.guides, { style: 'new' }, '独立配置写入必须保留（不被归属恢复）')
  assert.deepEqual(after.unknownControl, { mode: 'new' }, '未知独立控制根同样必须保留')
})

test('归属写口③：foreground.commit 记录未知根且 body/cp 携同一累计前像，before 不被就地修改', () => {
  const baseline = captureRollbackBusinessState(chat52())
  const before = before53(baseline)
  const snapshot = structuredClone(before)
  const next = structuredClone(before)
  next.runtimeRoot = 'third'
  const id = recordRollbackBusinessWrites(before, next, { source: 'foreground.commit' })
  assert.equal(id, 'body53', '兼容写口必须按 source 归属')
  const accumulated = next.timeline.operations.body53.businessBefore
  assert.deepEqual(accumulated.runtimeFields.runtimeRoot, { present: true, value: 'old' })
  assert.deepEqual(next.timeline.checkpoints.find(cp => cp.turn === 53).businessBefore, accumulated, '同轮 checkpoint 必须携同一累计前像')
  assert.deepEqual(before, snapshot, 'before 不得被就地修改（copy-on-write）')
  assert.equal(Object.hasOwn(before.timeline.operations.body53.businessBefore, 'runtimeFields'), false, 'before 的基准不得被追加字段')
})

test('归属保护新增：错误owner零改写与重生成完成凭据回退清除', () => {
  // ① owner 存在但身份不符（branchId 错误）＋ 非 runtime source ⇒ 必须**先**响亮拒绝，且 before/next 逐字未改。
  const baseline = captureRollbackBusinessState(chat52())
  const before = before53(structuredClone(baseline))
  const next = structuredClone(before)
  next.runtimeRoot = 'changed'
  const beforeSnapshot = structuredClone(before)
  const nextSnapshot = structuredClone(next)
  assert.throws(() => recordRollbackBusinessWrites(before, next, { source: 'unknown-source', rollbackOwner: { ...owner, branchId: 'branch-other' } }),
    /归属已变化/, 'owner 存在但非精确身份必须拒绝（不得因 source 非 runtime 就静默放行）')
  assert.deepEqual(before, beforeSnapshot, '拒绝时 before 必须逐字未改')
  assert.deepEqual(next, nextSnapshot, '拒绝时 next 必须逐字未改（零改写）')
  // ② 现代物理采用留下的完成凭据：恢复到旧基准必须清掉这两根（STORY_FIELDS 已含），并删除基准外的 53 op。
  const after = before53(structuredClone(baseline))
  after.regenRecovery = { id: 'op53', phase: 'committed', adoption: { turn: 53 } }
  after.regenerationCompletion = { turn: 53, syntheticTurn: 53 }
  after.messages = [...after.messages, { role: 'assistant', turn: 53, text: '新正文' }]
  const restored = restoreRollbackBusinessState(after, structuredClone(baseline))
  assert.equal(Object.hasOwn(restored, 'regenRecovery'), false, '回退必须清除 regenRecovery（否则 recover 旧同步）')
  assert.equal(Object.hasOwn(restored, 'regenerationCompletion'), false, '回退必须清除 regenerationCompletion')
  assert.equal(Object.hasOwn(restored.timeline.operations, 'body53'), false, '基准外的 53 op 必须删除（op 状态为既知语义）')
  assert.equal(restored.messages[0].text, 'old', '基准内的第 0 行必须保持基准值')
  assert.equal(restored.messages.length, after.messages.length, '本 helper 只恢复行前像、不截断消息（截断属纯尾回退职责）')
})
