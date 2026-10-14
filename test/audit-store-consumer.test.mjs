// 定向闸：store API 真实消费者（2026-10-13）
//
// 目标：`index.js` 的 dbSaveDeleteFootprint 三个 caller（peek / closeCached）用**真实 SqliteSessionStore**
// 跑通，而不是手搓 `dbs` Map 的 fake —— 接口改名（dbs.get/delete → peek/closeCached）的真实消费者验证。
// 覆盖：
//   ① peek：未知档不创建文件、不建连接条目（"窥探不产生副作用"）
//   ② closeCached：真实打开 → 关闭（连接真的 NotOpen）→ 可重开；未知档返回 false
//   ③ 生产 caller（真实方法体 + 真实 store + 真实 .db + 真实 meta.rollback_archive 绑定）：归属通过后关缓存并产出三项足迹
//   ④ 生产 caller fail-closed：archive 绑定不符时必须拒绝，且**不得**顺手关掉已缓存连接
//
// 说明：`dbSaveDeleteFootprint` 的方法体沿用既有夹具的"源码截取"手法（index.js 直接 import 会拉起 SDK 依赖），
// 但注入的是**真实** SqliteSessionStore 实例（不是 Map fake）。不扫真档、不动权限、不执行真实删除。
// 夹具落仓库内 tmp/（不用 os.tmpdir()：本机 TEMP 在工作区外，受限写入下 EPERM）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteSessionStore } from '../store.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE_BASE = path.join(REPO_ROOT, 'tmp', 'gate-fixtures-store-consumer')
const roots = []
function freshRoot() {
  mkdirSync(FIXTURE_BASE, { recursive: true })
  const root = mkdtempSync(path.join(FIXTURE_BASE, 'case-'))
  roots.push(root)
  return { root, sessionsRoot: path.join(root, 'sessions'), dataRoot: path.join(root, 'tavern') }
}
test.after(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// 真实方法体（与生产同一份源码）：只注入 DatabaseSync/path，其余走真实 store/host
const HEAD = '\tdbSaveDeleteFootprint(chatId, ids, archive) {'
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf(HEAD)
assert.ok(start > 0, '未找到 dbSaveDeleteFootprint 源码（协议变更需人工复核）')
const end = source.indexOf('\n\t}', start)
assert.ok(end > start, '未找到方法结束边界')
const body = source.slice(start + HEAD.length, end)
assert.ok(body.includes('this.store.peek(') && body.includes('this.store.closeCached('), '提取体必须已用 peek/closeCached（本次接口改名的消费者）')
const makeDelete = new Function('DatabaseSync', 'path', 'return function dbSaveDeleteFootprint(chatId, ids, archive) {' + body + '}')

/** 真实会话库 + 真实 meta 绑定（与生产同表同语句）。 */
function makeSession(store, id, binding) {
  store.materializeSession({ id, version: 1, createdAt: 1 }, 0, [])
  const db = new DatabaseSync(store.pathOf(id))
  try { if (binding) db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('rollback_archive',?)").run(binding) } finally { db.close() }
}
function realHost(store, handles) {
  return { store, tracker: { openHandles: handles }, assertWritable(id) { if (!store.exists(id)) throw Error('原件只读') } }
}

test('STORE-API-peek 未知档不创建库也不建连接条目（窥探零副作用）', () => {
  const { root, sessionsRoot } = freshRoot()
  const store = new SqliteSessionStore(sessionsRoot)
  const missing = path.join(sessionsRoot, 'session-ghost.db')
  try {
    assert.equal(store.peek('session-ghost'), undefined, '未知档 peek 必须 undefined')
    assert.equal(existsSync(missing), false, 'peek 不得创建库文件')
    assert.equal(existsSync(sessionsRoot), false, 'peek 不得创建 root 目录')
    // 已打开档才有条目；closeCached 未知档返回 false（幂等、不抛）
    assert.equal(store.closeCached('session-ghost'), false, '未知档 closeCached 必须 false')
    assert.equal(existsSync(missing), false, 'closeCached 不得创建库文件')
  } finally { store.closeAll() }
})

test('STORE-API-closeCached 真实连接被关闭且所有权仍在 store（可重开）', () => {
  const { sessionsRoot } = freshRoot()
  const store = new SqliteSessionStore(sessionsRoot)
  try {
    const opened = store.open('session-own-1')
    assert.equal(store.peek('session-own-1'), opened, 'peek 必须返回同一缓存实例')
    assert.equal(opened.db.isOpen, true, '前置：连接是打开的')
    assert.equal(store.closeCached('session-own-1'), true, 'closeCached 必须返回 true')
    assert.equal(opened.db.isOpen, false, 'closeCached 必须真的关闭底层连接')
    assert.equal(store.peek('session-own-1'), undefined, '关闭后缓存条目必须已摘除')
    const reopened = store.open('session-own-1')
    assert.notEqual(reopened, opened, '重开必须得到新连接（所有权留在 store）')
    assert.equal(reopened.db.isOpen, true, '重开的连接可用')
    assert.equal(store.closeCached('session-own-1'), true, '新连接同样可回收')
  } finally { store.closeAll() }
})

test('STORE-API-生产caller 归属通过后关真实缓存并产出三件足迹（deferred/冷两条路径）', () => {
  const { sessionsRoot, dataRoot } = freshRoot()
  const store = new SqliteSessionStore(sessionsRoot)
  const FG = 'session-consume-fg', BG = 'session-consume-bg'
  const chatId = 'chat-consume'
  const archive = path.join(dataRoot, 'chats', chatId, 'archive.db')
  mkdirSync(path.dirname(archive), { recursive: true })
  const handles = []
  const host = realHost(store, handles)
  try {
    makeSession(store, FG, archive)
    makeSession(store, BG, archive)
    assert.equal(existsSync(store.pathOf(FG)), true, '前置：真实 .db 已在盘上')

    // ① 冷路径：未缓存 ⇒ peek undefined ⇒ 只读打开核对 ⇒ closeCached 无条目返回 false 但不报错
    const cold = makeDelete(DatabaseSync, path).call(host, chatId, [FG], archive)
    assert.deepEqual(cold.map(item => item.path), [store.pathOf(FG), store.pathOf(FG) + '-wal', store.pathOf(FG) + '-shm'], '足迹三件路径必须来自真实 pathOf')
    assert.deepEqual(cold.map(item => item.deferred ?? false), [false, false, false], '无活动句柄不得标 deferred')
    assert.equal(store.peek(FG), undefined, '冷路径结束后不得留下缓存条目')
    assert.equal(existsSync(store.pathOf(FG)), true, '预检不得执行真实删除')

    // ② 活动句柄：真实缓存连接 + tracker 登记 ⇒ deferred，且**不关**缓存
    const cached = store.open(BG)
    handles.push({ id: BG })
    const active = makeDelete(DatabaseSync, path).call(host, chatId, [BG], archive)
    assert.deepEqual(active.map(item => item.deferred), [true, true, true], '活动句柄必须标 deferred')
    assert.equal(store.peek(BG), cached, 'deferred 路径不得关缓存')
    assert.equal(cached.db.isOpen, true, 'deferred 路径连接必须仍打开')

    // ③ 释放句柄后再跑：cold 路径真的关掉那条真实连接
    handles.length = 0
    const afterRelease = makeDelete(DatabaseSync, path).call(host, chatId, [BG], archive)
    assert.deepEqual(afterRelease.map(item => item.deferred ?? false), [false, false, false], '释放后不得再标 deferred')
    assert.equal(cached.db.isOpen, false, '生产 caller 必须真的关掉该档缓存连接')
    assert.equal(store.peek(BG), undefined, '关闭后条目必须摘除')
  } finally { store.closeAll() }
})

test('STORE-API-生产caller 绑定不符时 fail-closed 且不动既有缓存', () => {
  const { sessionsRoot, dataRoot } = freshRoot()
  const store = new SqliteSessionStore(sessionsRoot)
  const FG = 'session-consume-bad'
  const chatId = 'chat-consume-bad'
  const archive = path.join(dataRoot, 'chats', chatId, 'archive.db')
  mkdirSync(path.dirname(archive), { recursive: true })
  const handles = []
  const host = realHost(store, handles)
  try {
    makeSession(store, FG, path.join(dataRoot, 'chats', 'chat-other', 'archive.db'))
    const cached = store.open(FG)
    assert.throws(() => makeDelete(DatabaseSync, path).call(host, chatId, [FG], archive), /DB删局目标归属不符/, '绑定指向别的档必须拒绝')
    assert.equal(store.peek(FG), cached, '拒绝路径不得摘除缓存条目')
    assert.equal(cached.db.isOpen, true, '拒绝路径不得关闭真实连接')
  } finally { store.closeAll() }
})
