// 原生重生成纯尾替换：真实 SqliteSessionDb（合成库，不读真实档）；单叶证明前缀保留、旧尾 SQL 真删、连续写回、幂等零写、漂移与插入失败回滚。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SqliteSessionDb } from '../store.js'

const ev = (seq, type, data, time = 1) => ({ seq, type, time, data })
const start = ev(0, 'turn/start', { turn: 6 })
const user = ev(1, 'user/message', { id: 'u6', role: 'user', content: [{ type: 'text', text: '原输入' }], source: { kind: 'user' } })
const oldAssistant = ev(2, 'assistant/message', { turn: 6, step: 1, message: { id: 'a6', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, stream: [] })
const newAssistant = ev(2, 'assistant/message', { turn: 6, step: 1, message: { id: 'a6b', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, stream: [] })
const turnEnd = ev(3, 'turn/end', { turn: 6, reason: { kind: 'completed' } })

test('原生重生成采用：单事务旧尾删除与连续输出写回，重试零写及漂移拒', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'regen-native-tail-'))
  const db = new SqliteSessionDb(path.join(root, 'session.db'))
  try {
    db.materialize({ id: 'fixture', version: 3, createdAt: 1 }, 0, [start, user, oldAssistant])
    assert.equal(db.cursor(), 3)
    const changes = () => Number(db.db.prepare('SELECT total_changes() AS n').get().n)
    // ① 替换：keep=2 保原 user 前缀，删旧 assistant 尾，连续写回同 turn 的新正文 + turn/end
    const meta = db.replaceRegeneratedTail(2, [oldAssistant], [newAssistant, turnEnd])
    assert.equal(meta.eventCount, 4, 'event_count 必须更新为 keep + output 长度')
    assert.equal(db.cursor(), 4)
    const rows = db.stmts.selectEvents.all().map(row => ({ seq: Number(row.seq), type: row.type, json: row.data_json }))
    assert.deepEqual(rows.slice(0, 2).map(row => [row.seq, row.type]), [[0, 'turn/start'], [1, 'user/message']], '前缀固定不变')
    assert.ok(rows[1].json.includes('原输入'), '原 user 内容必须原样保留')
    assert.equal(rows.some(row => row.json.includes('旧正文')), false, '旧 assistant 必须在 SQL 中真的不存在')
    assert.ok(rows.some(row => row.seq === 2 && row.json.includes('新正文')), '新正文必须落在 seq=2（同 turn）')
    assert.deepEqual(rows.map(row => row.seq), [0, 1, 2, 3], '输出 seq 必须连续')
    // ② 幂等：同 output 复调 ⇒ 零写（total_changes 不增）且返回 meta
    const before = changes()
    const again = db.replaceRegeneratedTail(2, [newAssistant, turnEnd], [newAssistant, turnEnd])
    assert.equal(again.eventCount, 4)
    assert.equal(changes(), before, '复调必须零修改')
    // ③ 漂移：库内旧尾与 expectedTail 不同 ⇒ 拒绝且不删
    const tail = db.stmts.selectEventsFrom.all(2).map(row => ({ seq: Number(row.seq), type: row.type, time: Number(row.time), data: JSON.parse(row.data_json) }))
    assert.throws(() => db.replaceRegeneratedTail(2, [oldAssistant], [{ ...newAssistant, data: { ...newAssistant.data, step: 2 } }, turnEnd]), /漂移/, '旧尾漂移必须拒')
    assert.deepEqual(db.stmts.selectEventsFrom.all(2).map(row => Number(row.seq)), [2, 3], '漂移拒绝后不得删除')
    // ④ 插入失败 ⇒ 事务回滚（触发器中止 seq=3 写入）
    db.db.exec("CREATE TRIGGER regen_abort BEFORE INSERT ON events WHEN NEW.seq = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const fresh = [{ ...newAssistant, data: { ...newAssistant.data, message: { ...newAssistant.data.message, id: 'a6c' } } }, turnEnd]
    assert.throws(() => db.replaceRegeneratedTail(2, tail, fresh), /boom/, '插入失败必须把错误抛给调用方')
    assert.deepEqual(db.stmts.selectEventsFrom.all(2).map(row => Number(row.seq)), [2, 3], '回滚后旧尾必须原样存在')
    assert.equal(db.cursor(), 4, '回滚后游标必须不变')
  } finally {
    db.db.close()
    assert.ok(path.basename(root).startsWith('regen-native-tail-'))
    rmSync(root, { recursive: true, force: true })
  }
})
