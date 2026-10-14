// D07 真菜单委托叶（修正版）：真 TavernRollbackAction.rollback() clear 分支必须委托共享 tavernStorageUi.cleanFailure。
// 观察口径：菜单真实副作用读 harness.events（含真 catch 的 error/rebase/rolling/panel）；serviceCalls 只记"委托边界被调用"。
// 本叶只证**委托边界**（谁被调、传什么、菜单自己做什么/不做什么），不证共享服务内部的等待/刷新语义（由 error-purge 6/12 与 client-rollback-* 覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyErrorPurgePlayControlsTransform} from '../deploy/error-purge-transform.mjs'
import {applyRollbackSyncActionGuardTransform} from '../deploy/rollback-sync-install-transform.mjs'
import {applyAuthorRollbackActionTransform} from '../deploy/rollback-sync-author-transform.mjs'

const AUTHOR_ROOT = '../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/'
const TARGET = {kind:'body', turn:53, branchId:'branch-53', revision:7, operationId:'op53', chatId:'chat-f', sessionId:'s1'}

function wiredMenuSource() {
  const raw = readFileSync(new URL(AUTHOR_ROOT + 'src/client/features/play-controls.js', import.meta.url), 'utf8')
  return applyErrorPurgePlayControlsTransform(applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(raw)))
}
function menuCallbackBody(source) {
  const comp = source.lastIndexOf('function TavernRollbackAction(props) {')
  assert.ok(comp >= 0, '真源必须存在 TavernRollbackAction')
  const start = source.indexOf('async function rollback()', comp)
  const end = source.indexOf('if (!canRollback) {', start)
  assert.ok(start > comp && end > start, '菜单 callback 边界必须可定位')
  return source.slice(start, end)
}
/** deps 与 test/client-rollback-retry-target.test.mjs:43-54 同套（含 R2 重试闭包）；菜单副作用进 events。 */
function runMenuCallback(body, { view, storageUi, onRpc }) {
  const events = []
  const serviceCalls = []
  let retryTarget = null
  const rpc = async (name, args, sessionId) => { events.push(['rpc', name, args, sessionId]); return await onRpc(name, args, sessionId) }
  const sessions = { waitForTavernRollbackSync: async receipt => { events.push(['sync:wait', receipt]) } }
  const props = { sessionId: 's1', chatId: 'chat-f', sessions, storageUi: () => (storageUi === undefined ? undefined : {
    async cleanFailure(sessionId, turn, failureTarget) {
      serviceCalls.push([sessionId, turn, failureTarget])
      return await storageUi(sessionId, turn, failureTarget)
    },
  }) }
  const setRollbackRetryTarget = value => { const next = typeof value === 'function' ? value(retryTarget) : value; retryTarget = next; events.push(['retryTarget', next]) }
  const rollback = new Function(
    'rpc', 'historyProjection', 'props', 'rolling', 'setRolling', 'setCandidatePanel', 'setRegenPanel', 'setCandidateGuidePanel',
    'tavernErrorHub', 'liveTavernView', 'tavernCoordination', 'clearIncomplete', 'blocked', 'targetTurn', 'view',
    'rollbackViewState', 'rollbackRetryTarget', 'setRollbackRetryTarget', 'canRollback', 'rollbackRetryOwner',
    body + '\nreturn rollback;')(
    rpc,
    { rolledBack: () => events.push(['projection']) },
    props,
    false,
    value => events.push(['rolling', value]),
    () => events.push(['panel']), () => events.push(['panel']), () => events.push(['panel']),
    { report: (label, error) => events.push(['error', String(error && error.message || error)]) },
    { rebase: () => events.push(['view:rebase']) },
    { invalidate: () => events.push(['coord:invalidate']) },
    true, false, 53, view, { view },
    retryTarget, setRollbackRetryTarget, true, { current: props.sessionId })
  return { rollback, events, serviceCalls }
}
const viewWithTarget = () => ({ canRollback: true, rollbackTargetTurn: 53, rollbackTarget: { ...TARGET }, failureTarget: { ...TARGET }, failureCleanupReason: '', canClearIncompleteReply: true, rollbackUnavailableReason: '' })
const count = (events, kind) => events.filter(event => event[0] === kind).length

test('D07 真菜单clear委托边界：normal与alreadyClean各恰一次委托且菜单不重复刷新，缺服务与service抛错各报一次error零rpc', async () => {
  const source = wiredMenuSource()
  assert.equal(source.split('// [dsh-tavern-error-purge-menu-delegated:v1]').length - 1, 1, '菜单必须已施共享委托标记')
  const body = menuCallbackBody(source)
  assert.ok(body.includes('menuStorageUi.cleanFailure(props.sessionId, Number(menuFailureTarget.turn), menuFailureTarget)'), 'clear 分支必须委托共享服务')
  assert.equal(body.includes('targetCompare('), false, '菜单不得再内联身份算法')

  // ① normal
  {
    const harness = runMenuCallback(body, {
      view: viewWithTarget(),
      storageUi: async () => ({ view: { rolledBack: { alreadyClean: false, sync: { id: 'r1' }, cleanedFailureTarget: { ...TARGET } } } }),
      onRpc: async () => { throw new Error('clear 分支不得走 rpc') },
    })
    await harness.rollback()
    assert.equal(harness.serviceCalls.length, 1, 'normal：共享服务恰一次')
    assert.equal(harness.serviceCalls[0][1], 53, 'normal：必须传真实目标轮号')
    assert.equal(count(harness.events, 'rpc'), 0, 'normal：不得直接 rpc')
    assert.equal(count(harness.events, 'error'), 0, 'normal：不得报错')
    assert.equal(count(harness.events, 'panel'), 3, 'normal：菜单只做关闭动作（候选/重生成/引导面板）')
    assert.equal(count(harness.events, 'view:rebase'), 0, 'normal：菜单不自造 rebase')
    assert.equal(count(harness.events, 'coord:invalidate'), 0, 'normal：菜单不自造 invalidate')
    assert.deepEqual(harness.events.filter(event => event[0] === 'rolling').map(event => event[1]), [true, false], 'normal：busy 必须闭合')
  }
  // ② alreadyClean
  {
    const harness = runMenuCallback(body, {
      view: viewWithTarget(),
      storageUi: async () => ({ view: { rolledBack: { alreadyClean: true, sync: { id: 'r1' }, cleanedFailureTarget: { ...TARGET } } } }),
      onRpc: async () => { throw new Error('clear 分支不得走 rpc') },
    })
    await harness.rollback()
    assert.equal(harness.serviceCalls.length, 1, 'alreadyClean：仍恰一次委托')
    assert.equal(count(harness.events, 'error'), 0, 'alreadyClean：不得报错')
    assert.equal(count(harness.events, 'panel'), 3, 'alreadyClean：菜单仍只做关闭动作')
    assert.equal(count(harness.events, 'view:rebase'), 0, 'alreadyClean：菜单不自造 rebase')
  }
  // ③ 缺共享服务
  {
    const harness = runMenuCallback(body, {
      view: viewWithTarget(),
      storageUi: undefined,
      onRpc: async () => { throw new Error('缺服务不得走 rpc') },
    })
    await harness.rollback()
    assert.equal(count(harness.events, 'rpc'), 0, '缺服务：零 rpc')
    assert.equal(count(harness.events, 'error'), 1, '缺服务：必须 report 一次；实得=' + JSON.stringify(harness.events))
    assert.match(String(harness.events.find(event => event[0] === 'error')[1]), /精简清理未接线|找不到共享|storageUi/, '缺服务错误须指向共享服务未接线')
    assert.equal(count(harness.events, 'panel'), 0, '缺服务：不得关闭面板')
    assert.equal(count(harness.events, 'view:rebase') <= 1, true, '缺服务：catch 恢复至多一次 rebase')
    assert.deepEqual(harness.events.filter(event => event[0] === 'rolling').map(event => event[1]), [true, false], '缺服务：busy 仍须闭合')
  }
  // ④ 共享服务抛错
  {
    const harness = runMenuCallback(body, {
      view: viewWithTarget(),
      storageUi: async () => { throw new Error('清理回执目标与请求不一致，拒绝更新：turn 不一致') },
      onRpc: async () => { throw new Error('clear 分支不得走 rpc') },
    })
    await harness.rollback()
    assert.equal(harness.serviceCalls.length, 1, 'service 抛错：委托仍发生一次')
    assert.equal(count(harness.events, 'rpc'), 0, 'service 抛错：零 rpc')
    assert.equal(count(harness.events, 'error'), 1, 'service 抛错：必须 report 一次；实得=' + JSON.stringify(harness.events))
    assert.match(String(harness.events.find(event => event[0] === 'error')[1]), /回执目标与请求不一致/, '错误必须原样透出共享服务的拒绝原因')
    assert.equal(count(harness.events, 'panel'), 0, 'service 抛错：不得关闭面板')
  }
})

test('D07 已委托菜单缺服务读取或能力守卫一律拒绝', () => {
  const source = wiredMenuSource()
  for (const needle of ['var menuStorageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;',
    'if (!menuStorageUi || typeof menuStorageUi.cleanFailure !== "function") throw new Error("精简清理未接线：找不到共享 tavernStorageUi.cleanFailure，拒绝清理");']) {
    assert.ok(source.includes(needle))
    assert.throws(()=>applyErrorPurgePlayControlsTransform(source.replace(needle,'')),/不完整/)
  }
})
// 旧 marked 真升级：固定真旧产物由当前变换原位升级，不复制算法作为期望。
test('D07 旧marked菜单原位升级：current变换把面板形状菜单升为共享委托且幂等，半截块拒', async () => {
  // 真旧writer从固定作者树生成的已marked源码，纳入本地提交，不依赖会话临时bak。
  const legacy = readFileSync(new URL('./fixtures/old-marked-menu.js.txt', import.meta.url), 'utf8')
  assert.equal(legacy.includes('// [dsh-tavern-error-purge-menu-delegated:v1]'), false, '旧代产物不得带新委托标记')
  assert.ok(legacy.includes('failureTarget: menuFailureTarget'), '旧代产物应是面板形状（自造清理请求体）')
  // ② 当前变换必须把旧 marked 原位升级为共享委托
  const upgraded = applyErrorPurgePlayControlsTransform(legacy)
  assert.equal(upgraded.split('// [dsh-tavern-error-purge-menu-delegated:v1]').length - 1, 1, '升级后委托标记恰一处')
  assert.ok(upgraded.includes('menuStorageUi.cleanFailure(props.sessionId, Number(menuFailureTarget.turn), menuFailureTarget)'), '升级后必须委托共享服务')
  assert.equal(upgraded.includes('failureTarget: menuFailureTarget'), false, '升级后不得再自造清理请求体')
  // ③ 幂等：再施一次必须逐字节不变
  assert.equal(applyErrorPurgePlayControlsTransform(upgraded), upgraded, 'current 变换必须幂等')
  // ④ 已标记产物的完整性门：删掉委托调用后必须响亮失败（marked 分支显式 enforced 的那条）
  const broken = upgraded.replace('menuStorageUi.cleanFailure(props.sessionId, Number(menuFailureTarget.turn), menuFailureTarget)', 'undefined')
  assert.notEqual(broken, upgraded, '半截构造必须生效')
  assert.throws(() => applyErrorPurgePlayControlsTransform(broken), /./, '缺委托调用的已标记产物必须被拒（不得静默通过）')
})

// 接线幂等负例（无测试替身、不复制清理算法）：dock 取用函数已在，但菜单侧 props 透传丢失/重复时必须拒绝，
// 否则"getter 在、菜单丢传"会被当幂等放过（真实后果＝菜单取不到共享服务）。
test('D07 接线负例：dock 取用函数已在而菜单 props 透传丢失或重复时变换必须拒绝', () => {
  const source = wiredMenuSource()
  assert.equal(source.split('React.createElement(TavernRollbackAction, props)').length - 1, 1, '前置：菜单必须以 props 透传调用 RollbackAction')
  assert.equal(source.split('CandidateDockActions, Object.assign({}, props, { storageUi: function () { return ctx.get("tavernStorageUi") },').length - 1, 1, '前置：注册处已挂合法取用函数')
  const lost = source.replace('React.createElement(TavernRollbackAction, props)', 'React.createElement(TavernRollbackAction, Object.assign({}, props, {}))')
  assert.notEqual(lost, source, '构造必须生效（丢失透传）')
  assert.throws(() => applyErrorPurgePlayControlsTransform(lost), /props 透传|拒绝/, '菜单 props 透传丢失必须被拒')
  const twice = source.replace('React.createElement(TavernRollbackAction, props)', 'React.createElement(TavernRollbackAction, props), React.createElement(TavernRollbackAction, props)')
  assert.notEqual(twice, source, '构造必须生效（重复透传）')
  assert.throws(() => applyErrorPurgePlayControlsTransform(twice), /props 透传|拒绝/, '菜单 props 透传重复必须被拒')
})



