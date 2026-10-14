// R2 客户端重试闭环（真作者按钮 + 真施缝链）：
//   · 普通回退首次 RPC 失败后必须把**本次普通目标**留在 state，用户才能对同一目标重试；
//   · 视图已被主 catch 刷新成更早轮（甚至 canRollback=false）时，重试仍以同一对象发同一请求；
//   · 成功后先等同连接 push 再清空凭据；全程只发一次 RPC（不自动二次）。
// 身份门：夹具 = 本轮审查用真实 a2008bf 树；施缝顺序与 deploy/client-seams.mjs:36 的 split 通道逐字一致。
// 闭包按**真 body 实际消费**注入（canRollback / rollbackViewState / liveTavernView.rebase / setRolling / 两个 sessions 守卫）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {applyAuthorRollbackActionTransform} from '../deploy/rollback-sync-author-transform.mjs'
import {applyRollbackSyncActionGuardTransform} from '../deploy/rollback-sync-install-transform.mjs'
import {applyErrorPurgePlayControlsTransform} from '../deploy/error-purge-transform.mjs'

const top=spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'})
assert.equal(top.status,0,'必须能定位仓库顶层')
const REPO_ROOT=new URL('file:///'+top.stdout.trim().replace(/\\/g,'/')+'/')
const AUTHOR_ROOT=new URL('tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/',REPO_ROOT)
const RETRY_MARK='// [dsh-tavern-rollback-retry-target:v1]'
const TARGET53={kind:'rollback',turn:53,branchId:'branch-53',revision:7,chatId:'chat-fixture',sessionId:'sync-fixture'}

function wiredSource(){
 const raw=readFileSync(new URL('src/client/features/play-controls.js',AUTHOR_ROOT),'utf8')
 return applyErrorPurgePlayControlsTransform(applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(raw)))
}
// 真 callback 切片：TavernRollbackAction 内 async function rollback() 到 `if (!canRollback) {` 之前。
function callbackBody(source){
 const comp=source.lastIndexOf('function TavernRollbackAction(props) {')
 assert.ok(comp>=0,'真源里必须存在 TavernRollbackAction')
 const start=source.indexOf('async function rollback()',comp)
 const end=source.indexOf('if (!canRollback) {',start)
 assert.ok(start>comp && end>start,'callback 边界必须可定位')
 return source.slice(start,end)
}
function runCallback(body,{view,retryTarget=null,clearIncomplete=false,onRpc}){
 const events=[],writes=[]
 const rpc=async(name,args,sessionId)=>{events.push(['rpc',name,args,sessionId]);return await onRpc(name,args)}
 const sessions={waitForTavernRollbackSync:async receipt=>{events.push(['sync:wait',receipt]);assert.ok(receipt&&typeof receipt==='object','等待必须带同连接回执')}}
 const props={sessionId:'sync-fixture',chatId:'chat-fixture',sessions}
 const rollbackViewState={view}
 const canRollback=!!retryTarget || view.canRollback===true
 const setRollbackRetryTarget=value=>{const next=typeof value==='function'?value(retryTarget):value;retryTarget=next;writes.push(next);events.push(['retryTarget',next])}
 const rollback=new Function('rpc','historyProjection','props','rolling','setRolling','setCandidatePanel','setRegenPanel','setCandidateGuidePanel','tavernErrorHub','liveTavernView','tavernCoordination','clearIncomplete','blocked','targetTurn','view','rollbackViewState','rollbackRetryTarget','setRollbackRetryTarget','canRollback','rollbackRetryOwner',
  body+'\nreturn rollback;')(
  rpc,
  {rolledBack:()=>events.push(['projection'])},
  props,
  false,
  value=>events.push(['rolling',value]),
  ()=>events.push(['panel']),()=>events.push(['panel']),()=>events.push(['panel']),
  {report:(label,error)=>events.push(['error',error&&error.message||String(error)])},
  {rebase:()=>events.push(['view:rebase'])},
  {invalidate:()=>events.push(['coord:invalidate'])},
  clearIncomplete,false,53,view,rollbackViewState,retryTarget,setRollbackRetryTarget,canRollback,{current:props.sessionId})
 return {rollback,events,writes,retryTarget:()=>retryTarget}
}

test('R2客户端：普通回退首次RPC抛错后保留同目标凭据，视图回退到更早轮仍以同一对象重试，成功后先push再清空',async()=>{
 const source=wiredSource()
 assert.equal(source.split(RETRY_MARK).length-1,1,'重试闭环标记必须唯一')
 assert.equal(callbackBody(source).split('setRollbackRetryTarget(').length-1,2,'callback只允许catch记录与成功清空两处state写入')
 assert.equal(source.includes('React.useEffect(function () { setRollbackRetryTarget(function (current) { return current && current.sessionId !== props.sessionId ? null : current; }); }, [props.sessionId]);'),true,'切换session须定向回收原凭据')
 assert.ok(source.includes('const canRollback = !!rollbackRetryTarget ||'),'canRollback 必须含重试目标兜底')
 assert.ok(source.indexOf('const [rollbackRetryState, setRollbackRetryTarget]')<source.indexOf('const canRollback = !!rollbackRetryTarget'),'state 必须声明在 canRollback 读取之前（避 TDZ）')
 assert.equal(source.includes('tavernCoordination.refresh('),false,'不得新增 global refresh')
 const body=callbackBody(source)
 // ① 首轮：视图带普通目标；新协议首请求也带对象（不是旧数字语义）。
 const view={canRollback:true,rollbackTargetTurn:53,rollbackTarget:{...TARGET53},rollbackUnavailableReason:''}
 const first=runCallback(body,{view,onRpc:async()=>{throw Error('RPC失败')}})
 assert.equal(typeof first.rollback,'function','callback 必须返回可调用的 rollback')
 await first.rollback()
 const firstRpc=first.events.filter(event=>event[0]==='rpc')
 assert.equal(firstRpc.length,1,'失败路径只发一次 RPC；实得事件='+JSON.stringify(first.events))
 assert.deepEqual(firstRpc[0][2].expectedTurn,TARGET53,'首请求必须带普通目标对象')
 assert.equal(first.events.filter(event=>event[0]==='error').length,1,'失败必须上报，不得吞')
 assert.equal(first.events.some(event=>event[0]==='sync:wait'),false,'失败不得等同连接 push')
 assert.equal(first.events.some(event=>event[0]==='panel'),false,'失败不得关面板')
 assert.deepEqual(first.writes,[TARGET53],'catch 必须把本次普通目标留在 state（供同目标重试）')
 // ② 重试：视图已被刷新成更早轮且 canRollback=false；凭据仍在 ⇒ 仍发同一对象、同一请求。
 const retry=runCallback(body,{view:{canRollback:false,rollbackTargetTurn:0},retryTarget:first.retryTarget(),
  onRpc:async()=>({view:{rolledBack:{sync:{protocol:1,id:'rollback-53',chatId:'chat-fixture',revision:8},cleanedFailureTarget:null}}})})
 await retry.rollback()
 const retryRpc=retry.events.filter(event=>event[0]==='rpc')
 assert.equal(retryRpc.length,1,'重试只由用户触发，不得自动二次 RPC')
 assert.deepEqual(retryRpc[0][2].expectedTurn,TARGET53,'重试必须发同一普通目标对象（原凭据，不是刷新后的更早轮）')
 assert.equal(retry.events.filter(event=>event[0]==='sync:wait').length,1,'成功路径先等同连接 push')
 assert.deepEqual(retry.events.filter(event=>['sync:wait','retryTarget'].includes(event[0])).map(event=>event[0]),['sync:wait','retryTarget'],'必须先 push 再清空凭据')
 assert.deepEqual(retry.writes,[null],'成功后清空重试凭据')
 assert.equal(retry.events.some(event=>event[0]==='error'),false,'重试成功不得再报错')
})
