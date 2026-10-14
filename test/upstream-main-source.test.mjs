// 上游 main 91963734（相对0.4.8基线4145093）：输入判定/漏写回合/重新生成修复与既有回退接缝组合。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCore } from '../deploy/standard-seam-transforms.mjs'
import { maintenanceTargets, maintenanceReadSources, prepareStandardSeams } from '../deploy/standard-seams.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'

const ROOT = fileURLToPath(new URL('../../../tmp/upstream-main-adapt-20261013/', import.meta.url))
const exists = rel => fs.existsSync(`${ROOT}/${rel}`)
const text = rel => fs.readFileSync(`${ROOT}/${rel}`, 'utf8')

test('上游main：输入判定/漏写回合/重新生成变更与现有回退接缝组合', { skip: !exists('tavern-plugin/lib/index.js') && '需要本地上游main评审fixture' }, () => {
  const present = maintenanceTargets.filter(exists)
  const readOnly = maintenanceReadSources.filter(exists)
  const sources = new Map([...present, ...readOnly].map(rel => [rel, text(rel)]))
  const writes = buildCore(ROOT, sources)
  for (const [rel, value] of writes) parse(value, { ecmaVersion: 'latest', sourceType: 'module' })

  const index = writes.get('tavern-plugin/lib/index.js')
  const lifecycle = writes.get('tavern-plugin/lib/hooks/turn-lifecycle.js')
  const roundHistory = writes.get('tavern-plugin/lib/domain/round-history.js')
  assert.match(index, /adoptUncommittedRounds/)
  assert.match(index, /session-turn-input\.js/)
  assert.match(lifecycle, /adoptUncommittedRounds/)
  assert.match(roundHistory, /createRegenerationAdoption/)
  assert.match(roundHistory, /dsh-tavern-clean-rollback:v1/)
  assert.ok(writes.has('tavern-plugin/lib/domain/storage-rollback.js'), '回退存储垫片必须继续生成')

  const plan = prepareStandardSeams({ appDir: ROOT, operation: 'install' })
  assert.ok(plan.changes.length > 0, '最新main干净树必须有待施缝变更')
  assert.equal(plan.changes.some(change => change.rel === 'tavern-plugin/lib/domain/scene-slots.js'), false, 'scene-slots仍是只读依赖')
})
