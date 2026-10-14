// D01 活动判定：真作者 coordinator（原源 vs 施缝源）与新的唯一 pure 模块对照。
// 真源：夹具树 background-task-coordinator.js；真 timeline：作者 story-timeline.js 的 inspect。
// 活动回执真契约（作者源 :369 Object.freeze({activity,…}) 暴露的 activity(chat)）：
//   { phase, busy, role, operationId, basedOn, updatedAt }
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs'
import {pathToFileURL, fileURLToPath} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {applyActivityStateTransform} from '../deploy/activity-state-transform.mjs'
import {activityFromSmallRows} from '../lib/activity-state.js'

const AUTHOR_ROOT = new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/', import.meta.url)
const AUTHOR_DOMAIN_DIR = path.join(fileURLToPath(AUTHOR_ROOT), 'lib', 'domain')
const authorFile = name => pathToFileURL(path.join(AUTHOR_DOMAIN_DIR, name)).href
const PURE_URL = new URL('../lib/activity-state.js', import.meta.url).href
const MARKER = '// [dsh-tavern-activity-state:v1]'

const authorSource = () => readFileSync(path.join(AUTHOR_DOMAIN_DIR, 'background-task-coordinator.js'), 'utf8')
const rewire = source => source
  .replace("from './storage-native-data.js'", "from '" + PURE_URL + "'")
  .replace(/from '\.\/([^']+)'/g, (all, rel) => "from '" + new URL(rel, pathToFileURL(AUTHOR_DOMAIN_DIR + path.sep).href).href + "'")
async function load(root, name, source) {
  const file = path.join(root, name + '.mjs')
  writeFileSync(file, source, 'utf8')
  return await import(pathToFileURL(file).href + '?v=' + Math.random())
}
// store 三个必需方法：被调用即抛（活动判定不得触碰存储）
const storeStub = () => ({
  readChat: () => { throw new Error('活动判定不得调用 store.readChat') },
  writeChat: () => { throw new Error('活动判定不得调用 store.writeChat') },
  updateChat: () => { throw new Error('活动判定不得调用 store.updateChat') }
})

test('D01 活动判定：真作者 coordinator 委托 pure 模块，多状态矩阵与原契约逐字一致', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'd01-activity-'))
  try {
    const createStoryTimeline = (await load(root, 'story-timeline', rewire(
      readFileSync(path.join(AUTHOR_DOMAIN_DIR, 'story-timeline.js'), 'utf8')))).createStoryTimeline
    const original = await load(root, 'coordinator-original', rewire(authorSource()))
    const wired = await load(root, 'coordinator-wired', rewire(applyActivityStateTransform(authorSource())))
    const coordinatorOf = mod => mod.createBackgroundTaskCoordinator({store: storeStub(), timeline: createStoryTimeline({})})
    assert.equal(typeof coordinatorOf(wired).activity, 'function', 'coordinator 必须暴露 activity(chat)')

    const cases = [
      ['running', {a1: {kind: 'agent', status: 'running', createdAt: 30, committedBranchId: 'b1'}}, 'b1'],
      ['failed', {a1: {kind: 'agent', status: 'failed', createdAt: 30, committedBranchId: 'b1'}}, 'b1'],
      ['settlementInterrupted', {a1: {kind: 'agent', status: 'interrupted', role:'settlement', createdAt: 30, committedBranchId: 'b1'}}, 'b1'],
      ...['pending','running','failed'].map(phase=>['background-'+phase,{body:{id:'body',kind:'body',status:'completed',completedAt:20,committedBranchId:'b1',background:{phase,role:'settlement',updatedAt:25,reason:phase==='failed'?'失败原因':''}}},'b1']),
      ['bodyForegroundCompleted', {b1: {kind: 'body', status: 'foreground-completed', createdAt: 20, committedBranchId: 'b1'}}, 'b1'],
      ['bodyFailed', {b1: {kind: 'body', status: 'failed', createdAt: 20, committedBranchId: 'b1'}}, 'b1'],
      ['otherBranch', {b1: {kind: 'body', status: 'foreground-completed', createdAt: 20, committedBranchId: 'other'}}, 'b1'],
      ['idle', {}, 'b1']
    ]
    for (const [label, ops, branch] of cases) {
      const chat = {id: 'chat-d01', timeline: {schemaVersion: 1, branchId: branch, revision: 7, checkpoints: [], operations: ops, participants: {}}}
      const expected = coordinatorOf(original).activity(chat)
      const actual = coordinatorOf(wired).activity(chat)
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), label + '：字段包括作者按状态添加的reason')
      assert.deepEqual(actual, expected, label + '：施缝后活动判定必须与原作者逐字一致')
      const pure = activityFromSmallRows({operations: ops, branchId: branch, revision: 7})
      assert.equal(actual.phase, pure.phase, label + '：phase 必须与 pure 模块同源')
      assert.equal(actual.busy, pure.busy, label + '：busy 必须与 pure 模块同源')
    }
    // 冻结时间语义：SQL 侧不传 updatedAt ⇒ 0；显式传入时原/缝一致
    assert.equal(activityFromSmallRows({operations: {}, branchId: 'b1', revision: 1}).updatedAt, 0)
    const chatUpdated = {id: 'c', timeline: {schemaVersion: 1, branchId: 'b1', revision: 7, checkpoints: [], operations: {}, participants: {}, updatedAt: 99}}
    assert.equal(coordinatorOf(wired).activity(chatUpdated).updatedAt, coordinatorOf(original).activity(chatUpdated).updatedAt,
      '显式 timeline.updatedAt 时 原/缝 必须一致')
  } finally { rmSync(root, {recursive: true, force: true}) }
})

test('D01 活动判定：幂等、半标记/未知工厂形态拒绝', async () => {
  const once = applyActivityStateTransform(authorSource())
  assert.equal(applyActivityStateTransform(once), once, '重复施缝必须字节幂等')
  assert.throws(() => applyActivityStateTransform(authorSource() + '\n' + MARKER + '\n'), /锚点|标记|activity/i,
    '半标记产物必须拒绝')
  assert.throws(() => applyActivityStateTransform('export function other() { return 1 }\n'), /锚点|工厂|activity/i,
    '未知工厂形态必须拒绝')
})
