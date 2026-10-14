// 上游 1d45 冻结源码 + 全部装配目标：真 buildCore 产物必须可解析（不手造 source）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {applyDbSaveHostTransform} from '../deploy/db-save-transform.mjs'
import {maintenanceTargets} from '../deploy/standard-seams.mjs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = new URL('../../../tmp/upstream-1d45-review-20261012/author-tree/', import.meta.url)
const text = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8')
test('上游1d45接缝：真实Host及全部受影响桥接源码可生成解析', () => {
  const present = maintenanceTargets.filter(rel => fs.existsSync(new URL(rel, ROOT)))
  assert.ok(present.length > 0, '冻结树必须存在装配目标源码')
  const sources = new Map(present.map(rel => [rel, text(rel)]))
  const writes = buildCore(fileURLToPath(ROOT), sources)
  for (const [rel, value] of writes) {
    assert.equal(typeof value, 'string', rel + ' 产物必须是源码文本')
    parse(value, {ecmaVersion: 'latest', sourceType: 'module'})
  }
  assert.ok(writes.size >= present.length, '每个受影响目标都必须有产物')
  const host=writes.get('tavern-plugin/lib/index.js')
  assert.ok(host.includes('pluginData: { snapshot:'))
  assert.equal(applyDbSaveHostTransform(host),host,'新DI幂等')
  const legacy=host.replace(/^    plugin(?:Data|Media): \{ snapshot:.*\n/gm,'')
  const upgraded=applyDbSaveHostTransform(legacy)
  assert.ok(upgraded.includes('pluginData: { snapshot:') && upgraded.includes('pluginMedia: { snapshot:'))
  assert.equal(applyDbSaveHostTransform(upgraded),upgraded,'旧标记升级后幂等')
  parse(upgraded,{ecmaVersion:'latest',sourceType:'module'})
})
