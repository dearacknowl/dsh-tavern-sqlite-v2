// 只验数字改动仍可接入与真实声明唯一性，不启动作者或读取存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBudgetTransform } from '../deploy/core-host-transform.mjs'
import { describeSeamChanges } from '../deploy/comment-seam-descriptors.mjs'
import { planSeamInstall, planSeamUninstall } from '../deploy/comment-seam-plan.mjs'

test('预算接缝：现场数字修改允许且伪文本/重复/非数值拒绝，卸载保原值', () => {
  const targets = [
    ['dispatch', 'export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000'],
    ['dispatch', '// 用户预算\nexport const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 180000;\n'],
    ['template', 'export function runtime({timeoutMs = 120000, idleMs = 600000}) {}'],
    ['template', 'export function runtime({timeoutMs = 900000, idleMs = 700000}) {}'],
  ]
  for (const [target, source] of targets) {
    const next = applyBudgetTransform(source, target)
    assert.equal(applyBudgetTransform(next, target), next)
    assert.ok(next.includes(target === 'dispatch' ? 'BUDGETS.scriptClaimMs' : 'BUDGETS.serverTemplateMs'))
    if (target === 'template') assert.ok(next.includes(source.includes('700000') ? 'idleMs = 700000' : 'idleMs = 600000'))
    const rel = 'tavern-plugin/lib/domain/' + target + '.js', owner = 'dsh-tavern-sqlite-v2'
    const descriptors = describeSeamChanges(source, next, {rel, owner})
    const installed = planSeamInstall(source, {rel, owner, descriptors}).source
    assert.equal(planSeamUninstall(installed, {rel, owner}).source, source, '卸载必须保留本次现场数值和注释')
  }
  assert.throws(() => applyBudgetTransform('// export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000\nconst text = "export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000"', 'dispatch'), /锚点不唯一/)
  assert.throws(() => applyBudgetTransform('export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = readBudget()', 'dispatch'), /锚点不唯一/)
  assert.throws(() => applyBudgetTransform('function a({timeoutMs=1,idleMs=2}) {}\nfunction b({timeoutMs=3,idleMs=4}) {}', 'template'), /锚点不唯一/)
  assert.throws(() => applyBudgetTransform('const text = "timeoutMs = 120000, idleMs = 600000"', 'template'), /锚点不唯一/)
})
