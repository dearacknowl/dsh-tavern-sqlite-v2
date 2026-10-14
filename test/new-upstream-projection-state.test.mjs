// 新上游（f3/2.5.0）字段适配：imageModelSelection 进背景投影键池、ledgerInjection 进本档运行业务根。
// 只断言本次两个字段改动；不动其它既有断言、不跑全量。夹具接线复用既有定向实码闸同款作者投影工具（只读源码，不读存档）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { captureRollbackBusinessState, restoreRollbackBusinessState } from '../lib/rollback-business-state.js'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const author = path.resolve(process.env.TAVERN_PROJECTION_AUTHOR_ROOT || path.join(workspace, 'tmp/sql-test-kit/author-Jhnday/dsh-tavern-5173c8d593d1a4edc704cbb3da736ce1226e791b/tavern-plugin/lib/domain'))
const load = name => import(pathToFileURL(path.join(author, name + '.js')).href)
const [json, copy, scoped, lazy] = await Promise.all(['json-mutation', 'copy-json-tree', 'scoped-messages', 'lazy-history-read'].map(load))
const source = readFileSync(path.join(author, 'chat-session-state.js'), 'utf8')
const exact = source.slice(source.indexOf('export function pendingMvuSettlementState'), source.indexOf('export function settlementTurn')) + '\n' + source.slice(source.indexOf('export function projectDisplayRuntimeState'))
const names = ['projectChatSessionState', 'projectSessionMessage', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint', 'projectSceneImageState']
const projection = Function('copyJsonTree', 'copyLazyHistoryHeader', exact.replaceAll('export function ', 'function ') + ';return {' + names.join(',') + '}')(copy.copyJsonTree, lazy.copyLazyHistoryHeader)
// 背景投影必须用 fresh（f3/2.5.0）作者函数：其选择键列表含 imageModelSelection（chat-session-state.js:213-215）；
// 旧 kit 作者（2.4）的选择键不含该键，用它会把本断言变成假阴性。仍取**真实源码**，不做 chat=>chat 伪证。
const freshAuthor = path.resolve(workspace, 'tmp/upstream-construction-20261010-42852b0/dsh-tavern-42852b0d160fc8d165faf291ddc779b71fc429ef/tavern-plugin/lib/domain/chat-session-state.js')
const freshSource = existsSync(freshAuthor) ? readFileSync(freshAuthor, 'utf8') : ''
const freshBg = freshSource
  ? Function('structuredClone', freshSource.slice(freshSource.indexOf('export function projectChatBackgroundConfig'), freshSource.indexOf('export function projectSettlementCheckpoint')).replace('export function ', 'function ') + ';return projectChatBackgroundConfig')(structuredClone)
  : undefined
const helpers = { ...projection, ...json, ...copy, ...scoped, ...lazy, ...(freshBg ? { projectChatBackgroundConfig: freshBg } : {}) }
const root = () => mkdtempSync(path.join(os.tmpdir(), 'upstream-proj-state-'))
const chatBase = (id, sessionId) => ({ id, sessionId, mode: 'story', backgroundConfigVersion: 3, webSearchEnabled: false, messages: [], timeline: { checkpoints: [], operations: {} } })

test('最新上游：后台模型选择投影', async () => {
  assert.ok(existsSync(path.join(author, 'chat-session-state.js')), '需要本机核准作者源码（只读）')
  const dir = root()
  let store = createChatSqliteStore({ dataRoot: dir, helpers, legacyData: undefined })
  try {
    // 真窄读：走 store 导出的 readBackgroundConfig（投影键池），不是整档 read。
    await store.update('chat-a', () => ({ ...chatBase('chat-a', 's-a'), imageModelSelection: { model: 'image-x' } }))
    await store.update('chat-b', () => chatBase('chat-b', 's-b'))
    const projectedA = await store.readBackgroundConfig('chat-a')
    assert.deepEqual(projectedA.imageModelSelection, { model: 'image-x' }, 'imageModelSelection 必须在背景投影内出现（BACKGROUND_FIELDS）')
    const projectedB = await store.readBackgroundConfig('chat-b')
    assert.equal(Object.hasOwn(projectedB, 'imageModelSelection'), false, '未设置的档不得在投影里凭空出现该字段（隔离）')
    // 写后失效：改值后同一窄读必须看到新值（缓存不得留旧投影）。第二笔写走真 CAS：返回体必须带递增的 _storageRevision。
    await store.update('chat-a', current => ({ ...current, imageModelSelection: { model: 'image-y' }, _storageRevision: Number(current._storageRevision || 0) + 1 }))
    assert.deepEqual((await store.readBackgroundConfig('chat-a')).imageModelSelection, { model: 'image-y' }, '写后窄读必须失效重建')
    // 冷开仅验证这条新字段路径：新实例仍能从库读回该投影字段。
    store.dispose()
    store = createChatSqliteStore({ dataRoot: dir, helpers, legacyData: undefined })
    assert.deepEqual((await store.readBackgroundConfig('chat-a')).imageModelSelection, { model: 'image-y' }, '冷开后 imageModelSelection 投影仍在')
  } finally {
    try { store.dispose() } catch { /* 已释放 */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }) } catch { /* Windows EPERM */ }
  }
})

test('最新上游：台账注入业务基准', () => {
  const chat = { id: 'chat-a', sessionId: 's-a', ledgerInjection: { through: 7, requestedAt: 11 }, variables: { v: 1 }, messages: [] }
  const baseline = captureRollbackBusinessState(chat)
  assert.deepEqual(baseline.fields.ledgerInjection, { through: 7, requestedAt: 11 }, 'ledgerInjection 必须进 business capture（STORY_FIELDS）')
  const live = { id: 'chat-a', sessionId: 's-a', ledgerInjection: { through: 9, requestedAt: 12 }, variables: { v: 2 }, webSearchEnabled: true, messages: [] }
  restoreRollbackBusinessState(live, baseline)
  assert.deepEqual(live.ledgerInjection, { through: 7, requestedAt: 11 }, '回退必须恢复 ledgerInjection 的旧值')
  assert.equal(live.webSearchEnabled, true, '用户配置不属业务根 ⇒ 回退不得改写')
  const legacyBaseline = { version: 1, legacyFormat: 'row-v1', fields: { variables: { v: 3 } }, participants: {}, operationIds: [] }
  const untouched = { id: 'chat-a', sessionId: 's-a', ledgerInjection: { through: 9 }, variables: { v: 9 }, webSearchEnabled: true, messages: [] }
  restoreRollbackBusinessState(untouched, legacyBaseline)
  assert.deepEqual(untouched.ledgerInjection, { through: 9 }, '旧 row-v1 基线缺该字段 ⇒ 不得删除/改写现值（不能当作当时不存在）')
  assert.equal(untouched.webSearchEnabled, true, '配置在旧基线回退下同样保持不变')
})
