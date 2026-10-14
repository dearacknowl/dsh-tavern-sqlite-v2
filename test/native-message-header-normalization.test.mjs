// 原生消息追加**头归一 + timeline 子行同事务**（真实消费者路径）：
//   · 真作者 2.5.0 `turn-orchestration.js` → 真 `applyNativeMessageTransform` → 取替换后的 `finalizeAppend(input)` 整段真 body：
//     `new Function('store','diffJson','captureChatHeader','lastTavernHelperVariables','finalizeSnapshot', …)`（不用 global eval、依赖全为形参）。
//   · store＝真同连接 store（`createChatSqliteStore`）；`readChatSlice`→真 `store.read`、`appendMessages`→真 `store.appendMessages`
//     （真 `chat-command-service.appendMessages` 同事务写头/正文/timeline 子行）。
//   · 边界 stub 只做本地不能做的那一步（LLM/模板）：按**真作者 story-timeline** 的 `apply(body.begin)`→`complete(...)`
//     产出真完成态（真 checkpoint / 真 status='completed'），使 nativeCommits 与 timeline 差量都真实存在。
//   · 真库断言走 SQL（`archive.db` 的 timeline 子行/头字段/正文），不用调用参数自证。轮号匿名泛化（4/17/63）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { applyNativeMessageTransform, MESSAGE_MARKER } from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'

const AUTHOR = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
const authorFile = rel => readFileSync(new URL(rel, AUTHOR), 'utf8')
const { diffJson, applyJsonChangesShared } = await import(new URL('lib/domain/json-mutation.js', AUTHOR))
const { copyJsonTree } = await import(new URL('lib/domain/copy-json-tree.js', AUTHOR))
const { captureChatHeader } = await import(new URL('lib/domain/chat-persistence.js', AUTHOR))
const { createStoryTimeline } = await import(new URL('lib/domain/story-timeline.js', AUTHOR))
const NAME = '原生消息追加头归一：真实收尾多轮字典差量保持 CAS 与纯尾'
const TURNS = [4, 17, 63]
const helpers = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const key of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[key] = value => value

function extractFinalizeAppend (transformed) {
  const start = transformed.indexOf('  async function finalizeAppend(input) {')
  assert.ok(start > 0, '替换后必须仍有 finalizeAppend 定义')
  const open = transformed.indexOf('{', start)
  let depth = 0, end = -1
  for (let index = open; index < transformed.length; index++) {
    if (transformed[index] === '{') depth++
    else if (transformed[index] === '}') { depth--; if (depth === 0) { end = index; break } }
  }
  assert.ok(end > open, 'finalizeAppend 大括号必须平衡')
  // 保留完整函数头（`async function finalizeAppend(input) {…}`）；调用方用 `const finalizeAppend = ` + 本串（函数表达式）。
  return transformed.slice(start + '  '.length, end + 1)
}

function finalizeAppendFactory () {
  const transformed = applyNativeMessageTransform(authorFile('lib/domain/turn-orchestration.js'), 'appendMessages')
  assert.equal(transformed.split(MESSAGE_MARKER.appendMessages).length, 2, '施缝后标记必须恰 1')
  const body = extractFinalizeAppend(transformed)
  assert.equal(body.startsWith('async function finalizeAppend(input)'), true, 'hoist 串必须是完整函数表达式')
  return new Function('store', 'diffJson', 'captureChatHeader', 'lastTavernHelperVariables', 'finalizeSnapshot',
    'return (async () => { const finalizeAppend = ' + body + '; return finalizeAppend })()')
}

async function harness (options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-append-header-'))
  const store = createChatSqliteStore({ dataRoot: root, helpers })
  const chatId = 'fixture-chat'
  const timeline = createStoryTimeline({ now: () => 1700000000000 })
  const base = { id: chatId, sessionId: 'fixture-session', _storageRevision: 7, mode: 'story', messages: [], nativeCommits: { 4: { commit: 'c4' }, 17: { commit: 'c17' } }, variables: { hp: 4 }, presentationWarnings: [{ turn: 3, text: '警告3' }] }
  const begun = timeline.apply({ chat: { ...copyJsonTree(base), messages: [] }, intent: { kind: 'body.begin', turn: TURNS[2], userText: '泛化输入' } })
  const operationId = begun.value.operationId
  const seed = { ...copyJsonTree(begun.chat), messages: [] }
  await store.update(chatId, () => seed)
  const current = await store.read(chatId)
  const calls = { appendMessages: [], patchChat: [], updateChat: [], readSlice: [] }
  const storeArg = {
    readChatSlice: async (sessionId, indexes, keys) => {
      calls.readSlice.push({ sessionId, indexes, keys })
      const chat = await store.read(chatId)
      return { chat, denseMessages: Array.isArray(chat?.messages), messageCount: (chat?.messages || []).length }
    },
    patchChat: async (...args) => { calls.patchChat.push(args); return false },
    updateChat: async (...args) => { calls.updateChat.push(args); return { changed: true } },
    appendMessages: async (id, revision, payload, metadata) => {
      // mutatePayload：真实本轮回填的 payload 经此改写后再交给真命令（用于晚事务失败/早校验负例）。
      const mutated = options.mutatePayload ? options.mutatePayload(payload, { id, revision, metadata }) : payload
      calls.appendMessages.push({ id, revision, payload: mutated, metadata })
      return store.appendMessages(id, revision, mutated, metadata)
    },
  }
  // 边界：本地不能跑的 LLM/模板换成真 timeline 完成流程（seed 已做真 body.begin，这里做真 complete）。
  const finalizeSnapshot = async (input, chat, writeChat, _expectedTimeline, _history) => {
    const operation = chat.timeline.operations[operationId]
    const done = timeline.complete({ chat: { ...chat, messages: [] }, operationId, basedOn: operation.basedOn, outcome: { status: 'success' } })
    const next = { ...copyJsonTree(done.chat), messages: options.messages ?? [
      { role: 'user', turn: input.turn, text: '用户输入' },
      { role: 'assistant', turn: input.turn, text: '助手输出', swipeId: 0, swipes: ['助手输出'] },
    ] }
    next.nativeCommits = { ...next.nativeCommits, [String(input.turn)]: { commit: 'c' + input.turn, variables: { hp: input.turn } } }
    // 头数组字段的真 diff 形状：作者 diffValue 对数组增长给**根级 splice**（path=[key], index=旧长, deleteCount=0, items=新增项）。
    next.presentationWarnings = [...(next.presentationWarnings || []), { turn: input.turn, text: '警告' + input.turn }]
    const result = { ok: true, requestId: input.requestId, timelineStatus: done.value?.status }
    await writeChat(next, { source: 'fixture', requestId: input.requestId })
    return result
  }
  const finalizeAppend = await finalizeAppendFactory()(storeArg, diffJson, captureChatHeader, () => undefined, finalizeSnapshot)
  const archivePath = () => path.join(root, 'chats', chatId, 'archive.db')
  const tableCounts = () => {
    const db = new DatabaseSync(archivePath())
    try {
      return {
        revision: Number(db.prepare('SELECT revision FROM archive_head WHERE id=1').get()?.revision),
        messages: Number(db.prepare('SELECT COUNT(*) AS n FROM archive_messages').get()?.n),
        headFields: Number(db.prepare('SELECT COUNT(*) AS n FROM archive_head_fields').get()?.n),
        timelineNodes: Number(db.prepare('SELECT COUNT(*) AS n FROM archive_timeline_nodes').get()?.n),
      }
    } finally { db.close() }
  }
  const nodes = () => {
    if (!existsSync(archivePath())) return []
    const db = new DatabaseSync(archivePath())
    try { return db.prepare('SELECT node_key, value_json FROM archive_timeline_nodes ORDER BY ord').all() } finally { db.close() }
  }
  /** 全值快照（变量/正文/头/时间线）：用于「整笔回滚 ⇒ 逐值相等」断言，不做 counts-only。 */
  const dbState = () => {
    if (!existsSync(archivePath())) return null
    const db = new DatabaseSync(archivePath())
    try {
      return {
        snapshots: db.prepare('SELECT message_index, swipe_id, turn, slot_count, selected, source, mvu_ready, tree_json, operations_json, uid, created_at FROM variable_snapshots ORDER BY message_index, swipe_id').all(),
        state: db.prepare('SELECT id, tree_json, turn, message_index, swipe_id, updated_at FROM variable_state ORDER BY id').all(),
        messages: db.prepare('SELECT message_index, message_json FROM archive_messages ORDER BY message_index').all(),
        headFields: db.prepare('SELECT key, kind, ord, value_json FROM archive_head_fields ORDER BY ord').all(),
        head: db.prepare('SELECT revision, updated_at FROM archive_head WHERE id=1').get(),
        nodes: db.prepare('SELECT node_key, ord, value_json FROM archive_timeline_nodes ORDER BY ord').all(),
      }
    } finally { db.close() }
  }
  const headField = key => {
    const db = new DatabaseSync(archivePath())
    try { return db.prepare('SELECT value_json FROM archive_head_fields WHERE key=?').get(key)?.value_json } finally { db.close() }
  }
  return { root, store, chatId, current, calls, finalizeAppend, operationId, nodes, headField, tableCounts, archivePath, dbState, cleanup: async () => { store.dispose(); rmSync(root, { recursive: true, force: true }) } }
}

/** 取出 transform 注入的**追加块本体**（可独立调用：传入 store/changes/head/before/count），用于块级护栏断言。 */
function generatedHeaderBlock () {
  const transformed = applyNativeMessageTransform(authorFile('lib/domain/turn-orchestration.js'), 'appendMessages')
  const marker = transformed.indexOf(MESSAGE_MARKER.appendMessages)
  assert.ok(marker > 0, '施缝后必须能找到追加块标记')
  const open = transformed.indexOf('if (await (async () => {', marker)
  assert.ok(open > 0, '追加块必须仍是 IIFE 形状')
  const braceStart = transformed.indexOf('{', open)
  let depth = 0, end = -1
  for (let index = braceStart; index < transformed.length; index++) {
    if (transformed[index] === '{') depth++
    else if (transformed[index] === '}') { depth--; if (depth === 0) { end = index; break } }
  }
  assert.ok(end > braceStart, '追加块大括号必须平衡')
  const body = transformed.slice(braceStart + 1, end)
  return new Function('store', 'changes', 'head', 'before', 'count',
    'return (async () => {' + body + '})()')
}

test(NAME, async t => {
  const f = await harness()
  t.after(async () => { await f.cleanup() })
  // 写前预热投影 timeline 行缓存（真同连接 store 的读口；否则写后读走冷路径，掩盖行缓存未失效）。
  const warm = await f.store.read(f.chatId)
  assert.equal(warm.timeline.operations[f.operationId].status, 'running', '写前预热：该轮必须仍是 running')
  const warmRevision = Number(warm.timeline.revision)
  const result = await f.finalizeAppend({ sessionId: 'fixture-session', turn: TURNS[2], requestId: 'req-63' })
  assert.equal(result?.requestId, 'req-63', '真收尾返回原 result')
  assert.equal(result?.timelineStatus, 'committed', '边界 stub 必须走真 timeline committed 分支')
  assert.equal(f.calls.patchChat.length, 0, '不得回退整档 patchChat')
  assert.equal(f.calls.updateChat.length, 0, '不得回退整档 updateChat')
  assert.equal(f.calls.appendMessages.length, 1, '真 store 追加出口必须恰一次')
  const call = f.calls.appendMessages[0]
  assert.equal(call.id, f.chatId, 'CAS：真档 id')
  assert.equal(call.revision, f.current._storageRevision, 'CAS：读到的 _storageRevision 原样转交')
  assert.equal(call.metadata?.requestId, 'req-63', '真收尾元数据透传')
  assert.deepStrictEqual(call.payload.items.map(item => item.role), ['user', 'assistant'], 'items 纯尾两条')
  assert.equal('messages' in (call.payload.headerSets || {}), false, 'messages 不得进 headerSets')
  assert.equal('timeline' in (call.payload.headerSets || {}), false, 'timeline 不得进 headerSets（子行另传）')
  assert.equal('_storageRevision' in (call.payload.headerSets || {}), false, 'revision 自管键不得进 headerSets')
  assert.deepStrictEqual(Object.keys(call.payload.headerSets.nativeCommits).sort(), ['17', '4', '63'], 'nativeCommits 顶层整值必须含旧键 4/17 + 新键 63')
  assert.deepStrictEqual(call.payload.headerSets.presentationWarnings, [{ turn: 3, text: '警告3' }, { turn: TURNS[2], text: '警告' + TURNS[2] }], '头数组字段必须按顶层整值归并（真 head 结果）')
  assert.equal(Array.isArray(call.payload.timelineUpdate?.changes) && call.payload.timelineUpdate.changes.length > 0, true, '必须带 timelineUpdate（真 timeline 差量）')
  assert.equal(call.payload.timelineUpdate.changes.every(change => change.path[0] === 'timeline' && change.path.length >= 2), true, 'timelineUpdate.changes 必须全为 timeline 深路径')
  assert.equal(call.payload.timelineUpdate.expected.branchId, f.current.timeline.branchId, 'expected.branchId 必须来自读到的 before')
  // 真 SQL 回读：头字典 / 正文 / timeline 子行（含权威 checkpoint）。
  const after = await f.store.read(f.chatId)
  assert.deepStrictEqual(Object.keys(after.nativeCommits || {}).sort(), ['17', '4', '63'], '真库 nativeCommits 旧键保留 + 新键落库')
  assert.deepStrictEqual((after.messages || []).map(item => item.role), ['user', 'assistant'], '真库正文纯尾两条')
  // 热/冷一致：写前已预热 timeline 行缓存 ⇒ 写后同连接读必须看到新完成态（缓存不得留 ghost）。
  assert.equal(after.timeline.operations[f.operationId].status, 'completed', '写后投影必须看到 completed（行缓存不得 ghost）')
  assert.equal(Number(after.timeline.revision) > warmRevision, true, '写后投影 timeline.revision 必须推进')
  const rows = f.nodes()
  const meta = JSON.parse(rows.find(row => row.node_key === '@meta').value_json)
  const op = JSON.parse(rows.find(row => row.node_key === 'operations:' + f.operationId).value_json)
  assert.equal(op.status, 'completed', '真库 timeline 子行该操作必须已被真 complete 落成 completed')
  assert.equal(meta.branchId, call.payload.timelineUpdate.expected.branchId, '真库 @meta 分支必须保持')
  assert.equal(Number(meta.revision) > Number(call.payload.timelineUpdate.expected.revision), true, '真库 @meta revision 必须随本次真完成推进')
  assert.equal(rows.some(row => row.node_key.startsWith('checkpoints#')), true, '真库必须落权威 checkpoint 子行')
  assert.equal(String(f.headField('nativeCommits')).includes('"63"'), true, '头字段行必须真含新键 63')
  assert.deepStrictEqual(after.presentationWarnings, [{ turn: 3, text: '警告3' }, { turn: TURNS[2], text: '警告' + TURNS[2] }], '真库头数组必须含旧尾与新项（真 diff 根级 splice → 顶层整值归并）')

  // ② CAS 隔离：真命令 + 过期 revision（不做整条 finalize 人造 undefined，也不 mock 生产 3 次 retry）。
  const staleRevision = Number(call.revision) - 1
  const staleResult = await f.store.appendMessages(f.chatId, staleRevision, call.payload, { sessionId: 'fixture-session', requestId: 'req-stale' })
  assert.equal(staleResult, undefined, '过期 revision 必须让真命令返回 undefined')
  const afterStaleCall = await f.store.read(f.chatId)
  assert.deepStrictEqual(afterStaleCall.nativeCommits, after.nativeCommits, 'CAS 不符：真库头字典零写')
  assert.equal((afterStaleCall.messages || []).length, (after.messages || []).length, 'CAS 不符：真库正文零写')

  // ③ 晚事务失败回滚（真 late 路径：早校验通过，命令内头/正文已写点之后才抛 ⇒ 全库零改）。
  //    payload 先由真实 finalizeAppend 回填一次（真 before/current ctx），再按 case 改写交给真命令；每次用 fresh seed（未预 commit）。
  const probe = await harness()
  let rawPayload
  try {
    await probe.finalizeAppend({ sessionId: 'fixture-session', turn: TURNS[2], requestId: 'req-probe' })
    rawPayload = probe.calls.appendMessages.at(-1).payload
  } finally { await probe.cleanup() }
  assert.equal(rawPayload.timelineUpdate.expected.revision >= 0, true, '真实回填 payload 必须带 expected.revision')
  const lateCases = [
    ['timeline 版本不符', (payload, metaRevision) => ({
      ...payload,
      timelineUpdate: { ...payload.timelineUpdate,
        expected: { ...payload.timelineUpdate.expected, revision: metaRevision + 1 },
        value: { ...payload.timelineUpdate.value, revision: metaRevision + 2 } },
    }), /版本不符/],
    ['timeline 分支不符', (payload, metaRevision) => ({
      ...payload,
      timelineUpdate: { ...payload.timelineUpdate,
        expected: { ...payload.timelineUpdate.expected, branchId: 'other-branch' },
        value: { ...payload.timelineUpdate.value, branchId: 'other-branch' } },
    }), /分支不符/],
  ]
  for (const [label, mutate, pattern] of lateCases) {
    const fresh = await harness({ mutatePayload: payload => mutate(payload, rawPayload.timelineUpdate.expected.revision) })
    try {
      const before = fresh.tableCounts()
      const beforeHead = String(fresh.headField('nativeCommits'))
      await assert.rejects(() => fresh.finalizeAppend({ sessionId: 'fixture-session', turn: TURNS[2], requestId: 'req-late' }), pattern, label + '：必须按该分支抛')
      assert.equal(fresh.calls.patchChat.length, 0, label + '：不得回退整档 patchChat')
      assert.deepStrictEqual(fresh.tableCounts(), before, label + '：真库各表行数/revision 零改（事务回滚）')
      assert.equal(String(fresh.headField('nativeCommits')), beforeHead, label + '：头字段文本零改')
    } finally { await fresh.cleanup() }
  }

  // ④ transform 生成块：整根 timeline 变更（path=['timeline']）不得被静默丢弃 ⇒ 块内必须抛，且绝不触达 store。
  const guardCall = await harness()
  try {
    const block = generatedHeaderBlock()
    const before = guardCall.tableCounts()
    // 生成块本体是 async IIFE ⇒ 用 rejects 断言（不是同步 throws）。
    await assert.rejects(() => block(
      { appendMessages: async () => { throw new Error('整根 timeline 变更绝不能交给 store') } },
      [{ op: 'splice', path: ['messages'], index: (guardCall.current.messages || []).length, deleteCount: 0, items: [{ role: 'user', turn: TURNS[2], text: 'x' }] },
        { op: 'set', path: ['timeline'], value: {} }],
      { timeline: guardCall.current.timeline },
      guardCall.current,
      (guardCall.current.messages || []).length,
    ), /整根 timeline 变更/, '整根 timeline 变更必须被生成块响亮拒（不得静默丢弃）')
    assert.deepStrictEqual(guardCall.tableCounts(), before, '整根 timeline 变更：真库零写')
  } finally { await guardCall.cleanup() }
})

// 新增独立具名：同一事务里「正文/头/变量 UPSERT」之后，timeline 晚校验失败 ⇒ 变量快照与当前态一并整笔回滚。
const TX_NAME = '原生追加事务拒绝：MVU快照与当前态随时间线整笔回滚'
test(TX_NAME, async t => {
  const baseTree = { stat_data: { hp: 41 }, schema: { hp: 'number' }, initialized_lorebooks: {} }
  const newTree = { stat_data: { hp: 63 }, schema: { hp: 'number' }, initialized_lorebooks: {} }
  const seedRow = { role: 'assistant', turn: 41, text: '前轮输出', swipeId: 0, swipes: ['前轮输出'], variables: [baseTree] }
  const nextRow = { role: 'assistant', turn: TURNS[2], text: '本轮输出', swipeId: 0, swipes: ['本轮输出'], variables: [newTree] }
  // 1) 真落基线：把 41 轮 assistant(variables:[baseTree]) 真写进 SQL（不是放 harness 种子里当假态），
  //    这样变量快照/当前态的「回滚要回到的基线」是真实存在的。
  const g = await harness({ messages: [seedRow] })
  try {
    const baseChat = await g.store.read(g.chatId)
    await g.store.update(g.chatId, current => ({ ...current, _storageRevision: Number(baseChat._storageRevision) + 1, messages: [seedRow] }))
    const warmChat = await g.store.read(g.chatId)
    assert.deepStrictEqual(g.store.variables.snapshotAt(g.chatId, 41), baseTree, '前置：真落基线后 41 轮快照必须是 base 树')
    const b = g.dbState()
    assert.equal(b.state.length, 1, '前置：当前态必须恰一行')
    assert.equal(b.snapshots.filter(row => row.turn === 41).length, 1, '前置：41 轮变量快照必须恰一行')
    const rev = Number(warmChat._storageRevision)
    const expected = warmChat.timeline.revision
    const payload = {
      items: [
        { role: 'user', turn: TURNS[2], text: '本轮输入' },
        nextRow,
      ],
      headerSets: { nativeCommits: { [String(TURNS[2])]: { commit: 'late' } } },
      timelineUpdate: { value: { ...warmChat.timeline, revision: expected + 2 }, changes: [{ op: 'set', path: ['timeline', 'revision'], value: expected + 2 }], expected: { branchId: warmChat.timeline.branchId, revision: expected + 1 } },
    }
    // 2) 真实晚失败：CAS 通过（用当前 revision），正文/头/变量 UPSERT 之后 timeline 版本校验失败 ⇒ 整笔回滚。
    await assert.rejects(() => g.store.appendMessages(g.chatId, rev, payload, { sessionId: 'fixture-session', requestId: 'req-var-late' }), /版本不符/, '晚 timeline 版本不符必须在事务内被拒')
    // 3) SQL 全值：整笔回滚 ⇒ 变量快照/当前态（含 created_at/updated_at）/正文/头/时间线逐值相等
    assert.deepStrictEqual(g.dbState(), b, '整笔回滚：SQL 各表（含时间戳）必须与失败前逐值相等')
    assert.equal(g.calls.patchChat.length, 0, '不得回退整档 patchChat')
    assert.equal(g.dbState().snapshots.filter(row => row.turn === TURNS[2]).length, 0, '失败事务不得留下被拒轮的变量快照行')
    // 4) 热/冷一致（核心）：被拒轮 API 必须 undefined（SQL 零行），基线与当前态仍必须是 base 树（不得被未提交缓存污染）。
    assert.equal(g.store.variables.snapshotAt(g.chatId, TURNS[2]), undefined, '失败事务后 snapshotAt(被拒轮) 必须是 undefined（非 undefined 即 hot-cache ghost）')
    assert.deepStrictEqual(g.store.variables.snapshotAt(g.chatId, 41), baseTree, '失败事务后 snapshotAt(41) 必须仍是 base 树')
    assert.deepStrictEqual(g.store.readCurrentVariableSnapshot(warmChat).tree, baseTree, '失败事务后 readCurrentVariableSnapshot 必须仍是 base 树')
  } finally { await g.cleanup() }
})
