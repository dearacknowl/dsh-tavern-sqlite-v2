// 定向闸：V2 存储事务审计收敛（2026-10-13）
//
// 覆盖本轮**实际改动**的断言（每条都是真实 SQLite 路径：真 archive.db + 真语句 + 真事务）：
//   ① T1-截断：局部截断后快照表越界行与热内存越界项都失效，窗口内正确数据保留
//   ② T2-deleteFrom：变量侧物理回退后 deleteFrom 的删除计数与 survivour 语义
//   ③ T3-局部写：非截断的稀疏局部写不得丢掉未触碰的既有热项（防"空 entries 就整清"回归）
//   ④ T4-helper：尾部 helper 楼不得阻断冷树回拨（旧写法在 helper 处 break ⇒ 退回更早的楼）
//   ⑤ T5-readVariables：sparse 匹配跨 2000 原始节点扫描上限，逐页收集必须等于全量真值（不漏不重）
//
// 坐标说明（实测，勿按数组下标猜）：captureRow 的 turn 取自行对象的 turn；本文件 fixture 用
// turn = message_index + 1 ⇒ 第 3 楼的 turn 是 4。snapshotAt 传的是 **turn**，不是 message_index。
//
// 纪律：不裸跑 node --test；经 tools/run-plugin-gate.mjs --file --name 精确执行本文件。
// 夹具落仓库内 tmp/（不用 os.tmpdir()：本机 TEMP 在工作区外，受限写入下 EPERM）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVariableArchive } from '../lib/variable-archive.js'
import { readVariables } from '../lib/read-variables.js'
import { SqliteSessionStore } from '../store.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE_BASE = path.join(REPO_ROOT, 'tmp', 'gate-fixtures-audit-storage')
const tempRoots = []
function freshArchiveDir() {
  mkdirSync(FIXTURE_BASE, { recursive: true })
  const root = mkdtempSync(path.join(FIXTURE_BASE, 'case-'))
  tempRoots.push(root)
  return path.join(root, 'chat-audit-1')
}
function closeAll() {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** 真 archive.db：只建本模块读写到的最小 chat 表 + 变量表（与生产 ensureTables 同形）。 */
function openArchiveFixture(dir) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'archive.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT NOT NULL)')
  db.exec('CREATE TABLE archive_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
  db.exec('INSERT INTO archive_head (id, revision, updated_at) VALUES (1, 1, 1)')
  const archive = createVariableArchive({ handle: () => db, logger: { warn() {} } })
  archive.ensureTables(db)
  return { db, archive }
}

const putRow = (db, index, row) => db.prepare('INSERT INTO archive_messages (message_index, message_json) VALUES (?, ?) ON CONFLICT(message_index) DO UPDATE SET message_json=excluded.message_json').run(index, JSON.stringify(row))
const readRow = (db, index) => JSON.parse(db.prepare('SELECT message_json FROM archive_messages WHERE message_index=?').get(index).message_json)
const treeOf = tag => ({ stat_data: { tag }, schema: { v: 1 } })
const rowOf = (index, tag) => ({ role: 'assistant', turn: index + 1, variables: [treeOf(tag)], swipeId: 0 })
const tagAtTurn = (archive, chatId, turn) => archive.snapshotAt(chatId, turn)?.stat_data?.tag

// ══════════════════════════════════════════════════════════════════════════════════
// T1：局部截断必须同时清快照表越界行与热内存越界项（保留窗口内正确数据）
// ══════════════════════════════════════════════════════════════════════════════════
test('T1-截断后已删楼的变量读口不得再返回（快照表+热内存都失效，窗口内数据保留）', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    for (const index of [1, 2, 3]) putRow(db, index, rowOf(index, 'v' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)], [3, readRow(db, 3)]]), 4)
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), 'v3', '前置：截断前第 3 楼（turn=4）变量可读')

    // 截断到 2 楼：touched 只回一个无树楼 ⇒ 第 2、3 楼（turn 3、4）的快照与热项都必须消失
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)]]), 2, { truncated: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM variable_snapshots WHERE message_index >= 2').get().n, 0, 'T1: 越界快照行必须删除')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), undefined, 'T1: 已删第 3 楼（turn=4）的变量必须读不到')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 3), undefined, 'T1: 已删第 2 楼（turn=3）的变量必须读不到')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 2), 'v1', 'T1: 窗口内第 1 楼（turn=2）变量必须保留')
  } finally { db.close(); closeAll() }
})

// ══════════════════════════════════════════════════════════════════════════════════
// T2：deleteFrom（变量侧物理回退）的删除计数与幸存语义
// ══════════════════════════════════════════════════════════════════════════════════
test('T2-deleteFrom 的删除计数与幸存读取（不得因热内存给出已删 turn 的旧值）', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    for (const index of [1, 2, 3]) putRow(db, index, rowOf(index, 'd' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)], [3, readRow(db, 3)]]), 4)
    assert.equal(archive.snapshot('chat-audit-1').stat_data.tag, 'd3', '前置：当前态是第 3 楼')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), 'd3', '前置：第 3 楼 turn=4 可读')

    const removed = archive.deleteFrom('chat-audit-1', 4)
    assert.equal(removed.deleted, 1, 'T2: 恰好删除 turn>=4 的一行（第 3 楼）')
    assert.equal(removed.state, true, 'T2: 仍有幸存快照 ⇒ state 必须为 true')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), undefined, 'T2: 已删 turn 的时间旅行必须 undefined（不得命中热内存）')
    assert.equal(archive.snapshot('chat-audit-1').stat_data.tag, 'd2', 'T2: 当前态必须回拨到幸存的最新合格楼')
    assert.equal(archive.snapshotAt('chat-audit-1', 3).stat_data.tag, 'd2', 'T2: 幸存楼（turn=3）仍可精确读取')
  } finally { db.close(); closeAll() }
})

// ══════════════════════════════════════════════════════════════════════════════════
// T3：非截断的稀疏局部写，不得丢掉未触碰的既有热项
// ══════════════════════════════════════════════════════════════════════════════════
test('T3-局部写保留未触碰既有热项（空树 touched 不得整清热内存）', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    for (const index of [1, 2, 3]) putRow(db, index, rowOf(index, 'h' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)], [3, readRow(db, 3)]]), 4)
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), 'h3', '前置：第 3 楼已进热窗口')
    // 只改一个"无树"楼（第 2 楼 turn=3 改成普通 user 楼），非截断
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[2, { role: 'user', turn: 3 }]]), 4)
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), 'h3', 'T3: 未触碰的第 3 楼热项必须仍在（不得被整清）')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 2), 'h1', 'T3: 更早的未触碰热项同样保留')
  } finally { db.close(); closeAll() }
})

// ══════════════════════════════════════════════════════════════════════════════════
// T4：尾部 helper 楼不得阻断冷树回拨（旧写法在此 break ⇒ 当前态退回更早的楼）
// ══════════════════════════════════════════════════════════════════════════════════
test('T4-尾部 helper 楼后仍能回拨到更晚的合格冷树（当前态不得退回更早楼）', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    // 第 1、2 楼都带树；随后第 2 楼被 K4 修剪成"冷树"（行内无 variables，快照表仍有 selected+mvu_ready 行）
    for (const index of [1, 2]) putRow(db, index, rowOf(index, 'cold' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)]]), 3)
    assert.ok(db.prepare('SELECT 1 AS ok FROM variable_snapshots WHERE message_index=2 AND selected=1 AND mvu_ready=1 AND tree_json IS NOT NULL').get(), '前置：第 2 楼冷树已在快照表')
    // 把当前态人为退到第 1 楼，制造"必须回拨到更晚的冷树"的局面
    db.prepare(`UPDATE variable_state SET tree_json=(SELECT tree_json FROM variable_snapshots WHERE message_index=1 AND swipe_id=0), turn=2, message_index=1, swipe_id=0 WHERE id=1`).run()
    archive.forget('chat-audit-1')   // 清热内存，强制走冷路径

    // 尾部第 3 楼是 helper（无树）：候选链必须跳过它继续找到第 2 楼冷树
    putRow(db, 3, { role: 'tavern-helper', turn: 4 })
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[3, readRow(db, 3)]]), 3)
    const state = db.prepare('SELECT tree_json, message_index FROM variable_state WHERE id=1').get()
    assert.equal(Number(state.message_index), 2, 'T4: 当前态必须回拨到第 2 楼冷树（不得停在 helper 楼或退回第 1 楼）')
    assert.equal(JSON.parse(state.tree_json).stat_data.tag, 'cold2', 'T4: 回拨到的必须是第 2 楼冷树真值')
  } finally { db.close(); closeAll() }
})

// ══════════════════════════════════════════════════════════════════════════════════
// T5：readVariables 分页「不漏不重」——稀疏匹配跨 2000 原始节点扫描上限
// ══════════════════════════════════════════════════════════════════════════════════
function needleStat() {
  const stat = {}
  for (let index = 0; index < 3000; index++) stat['k' + String(index).padStart(4, '0')] = index
  // 命中项排在第 2000 个原始节点之后（键序仍在 k 段内），必须靠游标续读才拿得到
  stat['k2998_needle_a'] = 1
  stat['k2999_needle_b'] = 2
  return stat
}
const needleChat = () => ({ id: 'chat-audit-1', mode: 'story', _storageRevision: 1, settleStatus: 'done', messages: [{ role: 'assistant', turn: 1, swipeId: 0, variables: [{ stat_data: needleStat(), schema: { v: 1 } }] }] })

test('T5-readVariables 稀疏匹配跨扫描上限翻页不漏不重（原始节点游标）', () => {
  const chat = needleChat()
  const truth = ['/k2998_needle_a', '/k2999_needle_b']
  // 单页必然被 2000 原始节点扫描上限截断（命中项在 3000 号之后）⇒ 必须靠游标续读
  const first = readVariables(chat, { action: 'search', query: 'needle', limit: 50 })
  assert.equal(first.entries.length, 0, '前置：首窗未触及命中项（说明本用例确实在考扫描上限后的续读）')
  assert.ok(first.nextCursor, '前置：首窗必须给出 nextCursor（否则无从续读）')

  const seen = []
  let cursor = first.nextCursor
  let pages = 0
  while (cursor !== null && cursor !== undefined && pages < 200) {
    const page = readVariables(chat, { action: 'search', query: 'needle', limit: 50, cursor })
    seen.push(...page.entries.map(entry => entry.path))
    pages += 1
    cursor = page.nextCursor
  }
  assert.ok(pages >= 1 && pages < 200, 'T5: 续读必须在有限页数内收敛（不得无限翻页）')
  assert.deepEqual([...seen].sort(), truth, 'T5: 逐页收集的结果集合必须等于全量真值（不跳结果、不丢命中项）')
  assert.equal(new Set(seen).size, seen.length, 'T5: 翻页不得重复返回同一路径')
})

test('T6-readVariables 每页只取 limit=1 时命中项仍能全部取到', () => {
  const chat = needleChat()
  const seen = []
  let cursor
  let pages = 0
  do {
    const page = readVariables(chat, { action: 'search', query: 'needle', limit: 1, ...(cursor ? { cursor } : {}) })
    seen.push(...page.entries.map(entry => entry.path))
    pages += 1
    cursor = page.nextCursor
  } while (cursor !== null && cursor !== undefined && pages < 200)
  assert.deepEqual([...seen].sort(), ['/k2998_needle_a', '/k2999_needle_b'], 'T6: limit=1 续读必须取到全部命中项')
  assert.equal(new Set(seen).size, seen.length, 'T6: 翻页不得重复')
  assert.ok(pages >= 2, 'T6: 命中项在扫描上限之后，必须真的翻页（否则未覆盖上限路径）')
})

// ══════════════════════════════════════════════════════════════════════════════════
// T7：SqliteSessionStore.peek / closeCached —— 连接所有权仍在 store（删局预检与回收的接口面）
// ══════════════════════════════════════════════════════════════════════════════════
test('T7-SqliteSessionStore.peek/closeCached 保持连接所有权（窥探可空、关闭后可重开）', () => {
  const root = freshArchiveDir().replace(/chat-audit-1$/, 'sessions')
  const store = new SqliteSessionStore(root)
  try {
    assert.equal(store.peek('session-audit-1'), undefined, 'T7: 未打开时 peek 必须返回 undefined（不创建库）')
    const opened = store.open('session-audit-1')
    assert.equal(store.peek('session-audit-1'), opened, 'T7: 已缓存时 peek 必须返回同一实例（不重开）')
    assert.equal(store.closeCached('session-audit-1'), true, 'T7: 关掉缓存连接必须返回 true')
    assert.equal(store.peek('session-audit-1'), undefined, 'T7: 关闭后缓存条目必须已摘除')
    assert.equal(store.closeCached('session-audit-1'), false, 'T7: 再关一次必须返回 false（幂等，不抛）')
    const reopened = store.open('session-audit-1')
    assert.notEqual(reopened, opened, 'T7: 关闭后重开必须得到新连接（所有权仍在 store）')
    assert.equal(store.closeCached('session-audit-1'), true, 'T7: 新连接同样可被回收')
  } finally { store.closeAll(); closeAll() }
})

// ══════════════════════════════════════════════════════════════════════════════════
// 补查确证用例（先写断言、后修实现；每条只锁一个真实缺口）
// ══════════════════════════════════════════════════════════════════════════════════

// T8：空 Map + truncated ⇒ variable_state 里 kept 行若已越界，当前态不得保留该旧树
test('PATCHCHECK-T8-空Map截断后当前态不得保留越界旧树（snapshot 回拨或清空）', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    for (const index of [1, 2, 3]) putRow(db, index, rowOf(index, 's' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)], [3, readRow(db, 3)]]), 4)
    assert.equal(archive.snapshot('chat-audit-1').stat_data.tag, 's3', '前置：当前态是第 3 楼（turn=4）')

    // 生产局部截断时序：空 touched Map + truncated（第 3 楼已被物理删除）
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map(), 2, { truncated: true })
    const state = db.prepare('SELECT tree_json, message_index FROM variable_state WHERE id=1').get()
    assert.ok(state === undefined || Number(state.message_index) < 2, 'T8: current state 不得停留在已被删除的越界楼（message_index=' + (state && state.message_index) + '）')
    const current = archive.snapshot('chat-audit-1')
    assert.equal(current === undefined ? undefined : current.stat_data.tag, 's1', 'T8: snapshot 必须回拨到幸存的最新合格楼（第 1 楼）')
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), undefined, 'T8: 已删楼的 turn 时间旅行必须 undefined')
  } finally { db.close(); closeAll() }
})

// T9：touched 楼"失去树"（helper 转换 / K4 冷化）⇒ 该楼旧热项必须被剔除，不得继续供出旧树
test('PATCHCHECK-T9-显式不合格槽不复活旧 swipe（快照被同事务覆盖后不得再供旧树）', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    for (const index of [1, 2, 3]) putRow(db, index, rowOf(index, 'x' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)], [3, readRow(db, 3)]]), 4)
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), 'x3', '前置：第 3 楼热项在窗口内')

    // 同一楼被改成"有变量数组但选中槽不再是合格 MVU 树"（K4 冷化/helper 转换后的落库形态）
    const coldified = { ...readRow(db, 3), variables: [null], turn: 4 }
    putRow(db, 3, coldified)
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[3, coldified]]), 4)
    assert.equal(tagAtTurn(archive, 'chat-audit-1', 4), undefined, 'T9: 已冷化楼的旧热树不得再被供出（应由快照表真值决定）')
  } finally { db.close(); closeAll() }
})

// T11：真·touched helper 转换路径（旧代码要求 messageCount-1 才是 helper 才算触及，本轮补真触及）
test('PATCHCHECK-T11-touched helper 不阻断回拨：合格楼被改成 helper 后当前态仍指向更晚冷树', () => {
  const dir = freshArchiveDir()
  const { db, archive } = openArchiveFixture(dir)
  try {
    for (const index of [1, 2]) putRow(db, index, rowOf(index, 'p' + index))
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, readRow(db, 1)], [2, readRow(db, 2)]]), 3)
    assert.equal(archive.snapshot('chat-audit-1').stat_data.tag, 'p2', '前置：当前态是第 2 楼（turn=3）')
    db.prepare(`UPDATE variable_state SET tree_json=(SELECT tree_json FROM variable_snapshots WHERE message_index=1 AND swipe_id=0), turn=2, message_index=1, swipe_id=0 WHERE id=1`).run()
    archive.forget('chat-audit-1')

    // 真·touched：把第 1 楼（较早的合格楼）改成 helper —— 候选链必须跳过它并回拨到第 2 楼冷树
    const helperRow = { role: 'tavern-helper', turn: 2 }
    putRow(db, 1, helperRow)
    archive.prepareLocalWrite(db, 'chat-audit-1', new Map([[1, helperRow]]), 3)
    const state = db.prepare('SELECT tree_json, message_index FROM variable_state WHERE id=1').get()
    assert.equal(Number(state.message_index), 2, 'T11: 当前态必须回拨到第 2 楼冷树（不得停在 helper 或被跳过）')
    assert.equal(JSON.parse(state.tree_json).stat_data.tag, 'p2', 'T11: 回拨到的必须是第 2 楼冷树真值')
  } finally { db.close(); closeAll() }
})

test.after(() => closeAll())
