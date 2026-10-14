// 执行真作者完整按钮组件与现行施缝链；hook仅提供React状态/引用/effect时序，业务选择器不仿写。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyAuthorRollbackActionTransform} from '../deploy/rollback-sync-author-transform.mjs'
import {applyRollbackSyncActionGuardTransform} from '../deploy/rollback-sync-install-transform.mjs'
import {applyErrorPurgePlayControlsTransform} from '../deploy/error-purge-transform.mjs'
const AUTHOR=new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/',import.meta.url)
const target=sessionId=>({kind:'rollback',turn:53,revision:7,branchId:'branch-fixture',chatId:'chat-'+sessionId,sessionId})
const receipt=()=>({view:{rolledBack:{sync:{protocol:1,id:'rollback-fixture',chatId:'chat-A',revision:8}}}})
function fixture(){
 const raw=readFileSync(new URL('src/client/features/play-controls.js',AUTHOR),'utf8')
 const source=applyErrorPurgePlayControlsTransform(applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(raw)))
 const start=source.indexOf('function TavernRollbackAction(props) {'),end=source.indexOf('function TavernUndoRollbackAction(props) {',start)
 assert.ok(start>=0&&end>start)
 const hooks=[],events=[];let index=0,effects=[],view,onRpc=async()=>{throw Error('测试RPC失败')}
 const React={
  useState(initial){const i=index++;if(!hooks[i])hooks[i]={value:initial};return [hooks[i].value,next=>{hooks[i].value=typeof next==='function'?next(hooks[i].value):next;events.push(['state',i,hooks[i].value])}]},
  useRef(initial){const i=index++;if(!hooks[i])hooks[i]={current:initial};return hooks[i]},
  useEffect(fn,deps){const i=index++,old=hooks[i];if(!old||deps.some((value,n)=>value!==old.deps[n])){hooks[i]={deps};effects.push(fn)}},
  createElement(type,props,...children){return {type,props,children}},
 }
 const Component=new Function('React','useRegenPanel','latestTavernAssistantMessageId','useLiveTavernView','useTavernCoordination','describeTavernActivity','rpc','historyProjection','setCandidatePanel','setRegenPanel','setCandidateGuidePanel','tavernErrorHub','liveTavernView','tavernCoordination',source.slice(start,end)+'\nreturn TavernRollbackAction;')(
  React,()=>null,()=>'',()=>({view}),()=>({view:{activity:{}}}),()=>({busy:false}),
  async(method,args,sid)=>{events.push(['rpc',args,sid]);return await onRpc(method,args,sid)},
  {rolledBack:()=>{throw Error('不允许RPC旧view覆盖push')}},()=>{},()=>{},()=>{},
  {report:(_label,error)=>events.push(['error',error.message])},
  {rebase:sid=>events.push(['rebase',sid])},{invalidate:sid=>events.push(['coord',sid])})
 return {events,hooks,rpc:fn=>{onRpc=fn},render(sid,nextView,{flush=true}={}){
  index=0;view=nextView;const result=Component({sessionId:sid,chatId:'chat-'+sid,useSession:()=>false,useChat:()=>'',sessions:{waitForTavernRollbackSync:async sync=>{assert.ok(sync);events.push(['sync'])}}})
  if(flush){const queued=effects;effects=[];for(const fn of queued)fn()}
  return result
 },retry:()=>hooks[1].value}
}

test('R2客户端会话隔离：切换聊天和迟到回调不串凭据，重试优先普通模式且坏目标零RPC',async()=>{
 const f=fixture(),A=target('A'),B=target('B'),live=value=>({canRollback:true,rollbackTargetTurn:53,rollbackTarget:value})
 await f.render('A',live(A)).props.onClick()
 assert.deepEqual(f.retry(),A)
 const retry=f.render('A',{canRollback:false,canClearIncompleteReply:true,rollbackTargetTurn:54,failureTarget:{turn:54}})
 assert.equal(retry.children[0],'重试完成回退','普通同目标重试必须优先于新失败清理模式')
 f.rpc(async()=>receipt());await retry.props.onClick()
 assert.deepEqual(f.events.filter(event=>event[0]==='rpc').at(-1)[1],{expectedTurn:A})
 assert.equal(f.retry(),null)
 assert.equal(f.events.findLastIndex(event=>event[0]==='sync')<f.events.findLastIndex(event=>event[0]==='state'),true)
 // 切换后的首render即禁止旧目标；effect只是回收旧state，不是身份保护的前置。
 f.rpc(async()=>{throw Error('保留A')});await f.render('A',live(A)).props.onClick()
 const switched=f.render('B',{canRollback:false,rollbackTargetTurn:0},{flush:false})
 assert.notEqual(switched?.children?.[0],'重试完成回退')
 const count=f.events.filter(event=>event[0]==='rpc').length
 assert.equal(switched?.props?.onClick,undefined);assert.equal(f.events.filter(event=>event[0]==='rpc').length,count)
 f.render('B',{canRollback:false,rollbackTargetTurn:0});assert.equal(f.retry(),null)
 // A旧catch与旧success迟到后，都不得覆盖/清空B的新凭据。
 let rejectOld;f.rpc(()=>new Promise((_resolve,reject)=>{rejectOld=reject}))
 const oldFailure=f.render('A',live(A)).props.onClick()
 f.render('B',live(B));f.rpc(async()=>{throw Error('保留B')});await f.render('B',live(B)).props.onClick()
 rejectOld(Error('A迟到失败'));await oldFailure;assert.deepEqual(f.retry(),B)
 let resolveOld;f.rpc(()=>new Promise(resolve=>{resolveOld=resolve}))
 const oldSuccess=f.render('A',live(A)).props.onClick()
 f.render('B',live(B));f.rpc(async()=>{throw Error('再次保留B')});await f.render('B',live(B)).props.onClick()
 resolveOld(receipt());await oldSuccess;assert.deepEqual(f.retry(),B)
 // 坏对象不得降级到视图里的数字旧目标（也不得发异session请求）。
 for(const bad of [{...A,sessionId:'foreign'},{...A,revision:'7'},{...A,kind:'unknown'}]){
  const clean=fixture();clean.rpc(async()=>{throw Error('不应RPC')})
  await clean.render('A',live(bad)).props.onClick()
  assert.equal(clean.events.some(event=>event[0]==='rpc'),false,'非法凭据必须零RPC')
  assert.equal(clean.events.some(event=>event[0]==='error'),true)
 }
})
