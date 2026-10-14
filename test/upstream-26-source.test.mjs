// 上游 2.6（038cc63f）真实作者源码 + buildCore 真产物：slot DI 注入、旧标记升级、旧代兼容。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {maintenanceTargets, maintenanceReadSources, prepareStandardSeams} from '../deploy/standard-seams.mjs'
import {applyDbSaveHostTransform} from '../deploy/db-save-transform.mjs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
const ROOT = new URL('../../../tmp/upstream-038c-review-20261012/fixture-tree/', import.meta.url)
const text = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8')
test('上游2.6源接缝：真实作者slot DI与旧标记升级、旧代兼容', () => {
  const present = maintenanceTargets.filter(rel => fs.existsSync(new URL(rel, ROOT)))
  assert.ok(present.length > 0, '夹具必须含装配目标源码')
  // scene-slots.js 是作者只读依赖：不在 maintenanceTargets（不可卸资产），另经 maintenanceReadSources 供 buildCore 判能力。
  const readSources = maintenanceReadSources.filter(rel => fs.existsSync(new URL(rel, ROOT)))
  assert.deepEqual(readSources, ['tavern-plugin/lib/domain/scene-slots.js'], '只读依赖清单必须只含 scene-slots.js')
  assert.equal(maintenanceTargets.includes('tavern-plugin/lib/domain/scene-slots.js'), false, '只读依赖不得进装配目标')
  const sources = new Map([...present, ...readSources].map(rel => [rel, text(rel)]))
  assert.ok(sources.has('tavern-plugin/lib/domain/scene-slots.js'), '夹具必须含作者新增 scene-slots.js')
  const writes = buildCore(fileURLToPath(ROOT), sources)
  const index = writes.get('tavern-plugin/lib/index.js')
  assert.equal(typeof index, 'string', 'index 必须有真产物')
  // 有 scene-slots.js 时：注入真实 slot DI（模块 import + deps 键）
  assert.match(index, /import \{ sceneSlotKeys as dbSaveSceneSlotKeys \} from '\.\/domain\/scene-slots\.js'/)
  assert.match(index, /sceneSlotKeys: dbSaveSceneSlotKeys/)
  for (const [rel, value] of writes) parse(value, {ecmaVersion: 'latest', sourceType: 'module'})
  // 只读性：真 fixture 的安装计划不得把 scene-slots.js 当作可写变更。
  const plan = prepareStandardSeams({appDir: fileURLToPath(ROOT), operation: 'install'})
  assert.equal(plan.changes.some(change => change.rel === 'tavern-plugin/lib/domain/scene-slots.js'), false, 'scene-slots.js 不得出现在可写变更计划')
  assert.equal(writes.has('tavern-plugin/lib/domain/scene-slots.js'), false, '只读依赖不得有自己的写产物')
  // 旧标记无 DI：同一 API 必须升级到同一 source，且复跑幂等
  const legacy = index.split('\n').filter(line => !line.includes('dbSaveSceneSlotKeys')).join('\n')
  assert.notEqual(legacy, index, '缺 DI 的输入必须真的不同')
  const upgraded = applyDbSaveHostTransform(legacy, {sceneSlots: true})
  assert.equal(upgraded, index, '旧无 DI 的标记输入必须升级到同一 source')
  assert.equal(applyDbSaveHostTransform(upgraded, {sceneSlots: true}), upgraded, '已施新版复跑必须幂等')
  // 旧代：无 scene-slots.js 模块（options false）不得注入 slot DI，保持插件主 key 兼容
  const noSlots = applyDbSaveHostTransform(legacy, {sceneSlots: false})
  assert.equal(typeof noSlots, 'string')
  assert.equal(noSlots.includes('dbSaveSceneSlotKeys'), false, '旧代不得注入 slot DI')
})
