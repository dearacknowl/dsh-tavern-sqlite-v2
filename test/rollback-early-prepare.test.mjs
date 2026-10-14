// 正文准备早期读卡失败：只验新增的「首个 commit 边界」（真实完整模块消费者，不抽取函数；不改产品）。
// 真实消费者＝实际 a2008bf 离线作者树 tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf…/tavern-plugin/lib/domain/：
//   · 完整施缝 turn 模块：applyRollbackBusinessTurnTransform → applyRollbackSharedBranchTurnTransform → applyRollbackBodySignalTurnTransform；
//   · 完整 timeline 模块：applyRowTimelineTransform → applyRollbackBusinessTimelineTransform（顺序依 standard-seam-transforms，不是产品缺接口）；
//   · 真 chat-persistence 建 store；archive＝本包真 SQL chat store（真事务）。
// 契约：prepare 在 body.begin 之后、任何可能抛错的读取（readCard/扩展/preset 正则/模板）之前，先 await 首个 commit
//   （savePreparation → archive 落 running body + 完整 businessBefore），提交成功后才 publish owner；提交失败 ⇒ prepare 拒、
//   owner 不发布、卡读取不触发、archive 原样。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {registerHooks} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {applyRowTimelineTransform} from '../deploy/row-rollback-transform.mjs'
import {applyRollbackBusinessTurnTransform,applyRollbackBusinessTimelineTransform} from '../deploy/rollback-business-transform.mjs'
import {applyRollbackSharedBranchTurnTransform} from '../deploy/rollback-shared-branch-transform.mjs'
import {applyRollbackBodySignalTurnTransform} from '../deploy/rollback-body-signal-transform.mjs'

/** 当前离线作者树（真源码，不复制；本树无显示 DOM 打包依赖）。 */
const AUTHOR=new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/domain/',import.meta.url)
const PRODUCT_STORAGE_BUSINESS=new URL('../lib/rollback-business-state.js',import.meta.url).href
// 仅未调用的显示 DOM／卡工具装 fail-closed 占位，不冒充显示或模板渲染验证，也不 stub 核心。
registerHooks({resolve(spec,context,next){
 if(spec==='./tavern-macro-engine.js')return {url:'fixture-macros:unused',shortCircuit:true}
 if(['jsdom','marked'].includes(spec))return {url:'fixture-display:'+spec,shortCircuit:true}
 if(['dsh-mnemon-source-runtime','dsh-mnemon-source-documents'].includes(spec))return {url:'fixture-cardmemory:'+spec,shortCircuit:true}
 return next(spec,context)
},load(url,context,next){
 if(url==='fixture-macros:unused')return {format:'module',source:"export const renderTavernMacros=()=>{throw Error('本断言禁止调用未打包宏引擎')}",shortCircuit:true}
 if(url.startsWith('fixture-display:'))return {format:'module',source:"const unavailable=()=>{throw Error('本断言禁止调用显示DOM依赖')};export const JSDOM=unavailable;export const marked=unavailable;export const VirtualConsole=unavailable",shortCircuit:true}
 if(url.startsWith('fixture-cardmemory:'))return {format:'module',source:"const unavailable=()=>{throw Error('本断言禁止调用卡记忆依赖')};export const createRuntimeMemorySource=unavailable;export const createDocumentsMemorySource=unavailable",shortCircuit:true}
 return next(url,context)
}})
/** 真模块装载：只重写 import 指向（作者目录相对 → 绝对 file URL；storage-rollback-business → 本包产品实现；卡记忆包 → 空工具表）。 */
async function loadRealModules(root){
 const module=(name,source)=>{const file=path.join(root,name+'.mjs');writeFileSync(file,source,'utf8');return pathToFileURL(file).href}
 const rewrite=source=>source.replace(/from '(.+?)'/g,(all,spec)=>spec.startsWith('./')?'from '+JSON.stringify(new URL(spec,AUTHOR).href):all)
 const persistence=await import(module('persistence',rewrite(readFileSync(new URL('chat-persistence.js',AUTHOR),'utf8'))))
 let timelineSource=applyRollbackBusinessTimelineTransform(applyRowTimelineTransform(readFileSync(new URL('story-timeline.js',AUTHOR),'utf8')))
 assert.equal(applyRollbackBusinessTimelineTransform(timelineSource),timelineSource,'业务时间线 transform 必须幂等（row 前置施缝在位）')
 timelineSource=rewrite(timelineSource).replace(new URL('storage-rollback-business.js',AUTHOR).href,PRODUCT_STORAGE_BUSINESS)
 const timeline=await import(module('timeline',timelineSource))
 let turnSource=applyRollbackBodySignalTurnTransform(applyRollbackSharedBranchTurnTransform(applyRollbackBusinessTurnTransform(readFileSync(new URL('turn-orchestration.js',AUTHOR),'utf8'))))
 assert.equal(applyRollbackBodySignalTurnTransform(turnSource),turnSource,'正文信号 transform 必须幂等（接线在位）')
 assert.ok(turnSource.includes("await savePreparation({source:'foreground.body-before-prepare'})"),'首个 commit 必须先于 publish（正文准备前基准提交接线）')
 turnSource=turnSource.replace("import { CARD_MEMORY_TOOLS } from '../../packages/dsh-tavern-card-memory/index.js'",'const CARD_MEMORY_TOOLS=[] // 本断言仅 story，不访问卡工具')
 turnSource=rewrite(turnSource).replace(new URL('chat-persistence.js',AUTHOR).href,pathToFileURL(path.join(root,'persistence.mjs')).href).replace(new URL('storage-rollback-business.js',AUTHOR).href,PRODUCT_STORAGE_BUSINESS).replace(new URL('storage-failure-state.js',AUTHOR).href,new URL('../lib/failure-state.js',import.meta.url).href)
 const turn=await import(module('turn',turnSource))
 return {persistence,timeline,turn}
}
const CHAT_ID='chat-early-prepare-fixture',SESSION_ID='session-early-prepare-fixture',TURN=53,CARD_ERROR='卡片读取故障（夹具）'
/** 真 SQL archive + 真 chatPersistence；两个 fixture 只差注入的 readCard / 首个写是否失败。 */
async function fixture(modules,{readCard,readScript=async()=>{throw Error('readScript 不应被调用')},firstWriteFails=false,writeCalls,scriptState,mode='story',header=false,compat=false}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-early-prepare-'))
 const helpers={}
 // 真协议 helpers（作者树原实现，绝不 stub SQL 核心）：copyJsonTree/diffJson/applyJsonChangesShared + 五个 project* + isScopedMessages/lastTavernHelperVariables。
 const AUTHOR_HELPERS=[['copyJsonTree','copy-json-tree.js'],['diffJson','json-mutation.js'],['applyJsonChangesShared','json-mutation.js'],['projectSceneImageState','chat-session-state.js'],['projectChatSessionState','chat-session-state.js'],['projectDisplayRuntimeState','chat-session-state.js'],['projectChatBackgroundConfig','chat-session-state.js'],['projectSettlementCheckpoint','chat-session-state.js'],['isScopedMessages','scoped-messages.js'],['lastTavernHelperVariables','tavern-helper-context.js']]
 for(const [key,file] of AUTHOR_HELPERS){const module=await import(new URL(file,AUTHOR));if(typeof module[key]!=='function')throw Error('作者协议 helper 缺导出（不许 stub 核心）：'+key+' @ '+file);helpers[key]=module[key]}
 const archive=createChatSqliteStore({dataRoot:root,helpers})
 const chatPersistence=modules.persistence.createChatPersistence({store:archive})
 const base={id:CHAT_ID,sessionId:SESSION_ID,_storageRevision:1,mode,cardPath:'cards/fixture.json',cardName:'原创卡',
  messages:[{role:'user',turn:52,text:'输入52'},{role:'assistant',turn:52,text:'正文52',swipeId:0,swipes:['正文52']}],variables:{hp:52},
  timeline:{schemaVersion:1,branchId:'branch-early-prepare',revision:52,checkpoints:[],operations:{},participants:{}}}
 if(scriptState!==undefined)base.scriptState=scriptState
 await archive.update(CHAT_ID,()=>base)
 const before=await archive.read(CHAT_ID)
 const owners=[],headerCalls=[]
 const store={chatForSession:async()=>chatPersistence.read(CHAT_ID),readCard,readScript,
  writeChat:async(chat,meta)=>{if(writeCalls)writeCalls.push(meta&&meta.source);if(firstWriteFails)throw Error('archive 首次提交失败（夹具）');return chatPersistence.write(chat,meta)},
  ...(header?{writeChatHeader:async(chat,baseline,meta)=>{headerCalls.push(meta&&meta.source);return chatPersistence.writeHeader(chat,baseline,meta)}}:{}),
  updateChat:async(...args)=>chatPersistence.update(...args)}
 const orchestrator=modules.turn.createTurnOrchestrator({store,recordRollbackBodySignal:owner=>owners.push(owner),
  ...(compat?{captureSceneWorldbook:async(_chat,card)=>({fixture:true,card:card&&card.name})}:{}),
  timeline:modules.timeline.createStoryTimeline({readRollbackWorldbook:archive.readRollbackWorldbook,readRollbackWorldbookRef:archive.readCurrentRollbackWorldbookRef}),
  planner:{plan:async()=>{throw Error('card 分支不应发生')}},
  frameBuilder:{build:()=>{throw Error('模板/帧构建不应发生')}},
  projectUserTemplate:async()=>{throw Error('模板不应被调用')},
  resolvePresetRegexScripts:async()=>[]})
 return {root,archive,store,orchestrator,owners,headerCalls,before,read:()=>archive.read(CHAT_ID),writeCalls,
  cleanup:()=>{archive.dispose();assert.ok(path.basename(root).startsWith('rollback-early-prepare-'));rmSync(root,{recursive:true,force:true})}}
}
const input={sessionId:SESSION_ID,turn:TURN,userText:'输入53',requestId:'req-53'}

// 脚本失败收尾不重读损坏脚本：product 已从 retainFailedScriptForPhysicalRollback 移除 readScript+scripts.transition 软恢复块，
// 只登记 failed，脚本运行状态交给统一物理回退基准恢复；本叶只测这条新增 discard 路径（不重复前一叶的全套断言）。
test('脚本失败收尾不重读损坏脚本：仅登记failed并保留待物理回退状态',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-early-modules-'))
 try{
  const modules=await loadRealModules(root)
  const readScriptCalls=[]
  const f=await fixture(modules,{mode:'script',readCard:async()=>{throw Error(CARD_ERROR)},readScript:async()=>{readScriptCalls.push('read');throw Error('损坏脚本读取必须不被调用')}})
  try{
   // mode='script' 下 prepare 才会走到脚本相关路径；readCard 在后段先抛 ⇒ 本叶覆盖的 discard 分支是真被触发的分支。
   await assert.rejects(f.orchestrator.prepare(input),/卡片读取故障/,'前置：prepare 必须因读卡失败而拒')
   const prepared=await f.read(),body=Object.values(prepared.timeline.operations||{}).filter(op=>op.kind==='body')
   assert.equal(prepared.mode,'script','前置：fixture 必须真的是 script 档')
   assert.equal(body.length,1,'前置：首个 commit 必须已落一条 body')
   const op=body[0]
   assert.equal(op.status,'running','前置：body 必须 running')
   assert.ok(op.businessBefore&&typeof op.businessBefore==='object','前置：必须已保存完整 businessBefore')
   assert.equal(f.owners.length,1,'前置：提交成功后 owner 必须已发布')
   // 基准必须是**失败前**原 52：此时还没有 prepared53
   const baselineBefore=JSON.stringify(op.businessBefore)
   assert.equal(baselineBefore.includes('"prepared"'),false,'基准不得含 prepared（失败状态不能进基准）')
   // 模拟"已准备"：只在 prepare 失败之后写 scriptState.prepared53（仅经真 chatPersistence，不绕 SQL revision 链）
   const scriptState={prepared:{nativeTurn:TURN,reference:{chunk:1},state:{step:'prepared'}},history:['52']}
   await f.store.updateChat(CHAT_ID,current=>{current.scriptState=scriptState;return current},{source:'fixture.script-prepared'})
   const before=await f.read()
   assert.equal(before.scriptState.prepared.nativeTurn,TURN,'前置：scriptState.prepared 必须已持久为 53')
   const baselineAfter=JSON.stringify(before.timeline.operations[op.id].businessBefore)
   assert.equal(baselineAfter,baselineBefore,'后写 scriptState 不得改写已落库的 businessBefore')
   // ① 同 owner 收尾必须成功，且绝不重读损坏脚本
   const ok=await f.orchestrator.discard({sessionId:SESSION_ID,turn:TURN,rollbackBodyOwner:f.owners[0]})
   assert.equal(ok,true,'同 owner 收尾必须返回 true')
   assert.equal(readScriptCalls.length,0,'收尾不得调用 store.readScript')
   const after=await f.read()
   assert.equal(after.timeline.operations[op.id].status,'failed','收尾必须只把该 body 置 failed')
   assert.deepEqual(after.scriptState,scriptState,'收尾不得改脚本运行状态（待物理回退恢复）')
   assert.equal(JSON.stringify(after.timeline.operations[op.id].businessBefore),baselineBefore,'收尾不得改 businessBefore')
   assert.deepEqual(after.messages,before.messages,'收尾不得改正文')
   assert.deepEqual(after.variables,before.variables,'收尾不得改变量')
   // ② stale owner（operationId 不属于本档运行中 body）必须拒，零 SQL 改
   const staleOwner=Object.freeze({...f.owners[0],operationId:'op-stale-fixture'})
   const revisionBefore=(await f.read())._storageRevision
   const stale=await f.orchestrator.discard({sessionId:SESSION_ID,turn:TURN,rollbackBodyOwner:staleOwner})
   assert.equal(stale,false,'无身份/异 operationId 的收尾必须返回 false')
   const final=await f.read()
   assert.equal(final._storageRevision,revisionBefore,'stale 收尾不得推进存储版本')
   assert.deepEqual(final.scriptState,scriptState,'stale 收尾不得改脚本状态')
   assert.equal(final.timeline.operations[op.id].status,'failed','stale 收尾不得改动已 failed 的 body')
   assert.equal(readScriptCalls.length,0,'stale 收尾同样不得读脚本')
  }finally{f.cleanup()}
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('正文准备早期首个commit：读卡失败前已落完整基准且提交失败不发布身份',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-early-modules-'))
 try{
  const modules=await loadRealModules(root)
  // ① 读卡失败：首个 commit 已先发生（archive 有 running body + 完整 businessBefore），owner 按提交后顺序发布且可同 owner 收尾
  const f=await fixture(modules,{readCard:async()=>{throw Error(CARD_ERROR)}})
  try{
   await assert.rejects(f.orchestrator.prepare(input),/卡片读取故障/,'prepare 必须按真实错因 reject')
   const chat=await f.read(),body=Object.values(chat.timeline.operations||{}).filter(op=>op.kind==='body')
   assert.equal(body.length,1,'archive 必须恰有一条 body 操作：'+JSON.stringify(body.map(op=>[op.turn,op.status])))
   const op=body[0]
   assert.equal(op.status,'running','读卡失败后 body 必须已是 running（首个 commit 先于卡读取）')
   assert.equal(Number(op.turn),TURN);assert.equal(op.basedOn.branchId,chat.timeline.branchId,'basedOn 必须落在本分支')
   const baseline=op.businessBefore
   assert.ok(baseline&&typeof baseline==='object','archive 必须带完整 businessBefore')
   assert.equal(baseline.version,1);assert.equal(baseline.messageCount,f.before.messages.length,'基准正文行数必须等于 prepare 前')
   assert.deepEqual(baseline.fields.variables,f.before.variables,'基准变量必须等于 prepare 前变量')
   assert.equal(Object.hasOwn(baseline,'operationStates'),true,'基准必须带 operation 状态（完整形状）')
   assert.deepEqual(chat.messages,f.before.messages,'archive 正文必须逐字保留原文')
   assert.equal(chat.messages.length,2)
   assert.equal(f.owners.length,1,'提交成功后必须发布恰好一个 owner')
   assert.equal(f.owners[0].operationId,op.id,'owner.operationId 必须等于 archive 里的 body 操作 id')
   assert.equal(f.owners[0].turn,TURN);assert.equal(f.owners[0].branchId,chat.timeline.branchId)
   const failure=await f.orchestrator.discard({sessionId:SESSION_ID,turn:TURN,rollbackBodyOwner:f.owners[0]}).then(()=>null,error=>error)
   assert.equal(failure,null,'同 owner 收尾必须成功：'+String(failure&&failure.message))
   const after=await f.read(),bodyAfter=Object.values(after.timeline.operations).filter(candidate=>candidate.kind==='body')
   assert.equal(bodyAfter.length,1);assert.equal(bodyAfter[0].status,'failed','收尾必须把该 body 置 failed');assert.equal(bodyAfter[0].id,op.id)
   assert.deepEqual(after.messages,f.before.messages,'收尾不得改正文');assert.deepEqual(after.variables,f.before.variables,'收尾不得改变量')
  }finally{f.cleanup()}
  // ② 首个 commit 失败：owner 必须 0、卡读取不触发（计数为 0）、archive 原样
  const writeCalls=[],cardCalls=[]
  const g=await fixture(modules,{readCard:async()=>{cardCalls.push('read');throw Error(CARD_ERROR)},firstWriteFails:true,writeCalls})
  try{
   await assert.rejects(g.orchestrator.prepare(input),/首次提交失败/,'首个 commit 失败必须响亮上抛')
   assert.equal(writeCalls.length,1,'首个 commit 必须已尝试且只一次：'+JSON.stringify(writeCalls))
   assert.equal(writeCalls[0],'foreground.body-before-prepare','首写 source 必须是正文准备前基准提交')
   assert.equal(cardCalls.length,0,'提交失败时卡读取计数必须为 0')
   assert.equal(g.owners.length,0,'提交失败时 owner 不得发布')
   const after=await g.read()
   assert.deepEqual(after.messages,g.before.messages,'提交失败不得改 archive 正文')
   assert.deepEqual(after.variables,g.before.variables,'提交失败不得改 archive 变量')
   assert.deepEqual(Object.keys(after.timeline.operations||{}),[],'提交失败不得在 archive 留下 body 操作')
   assert.equal(after.timeline.branchId,g.before.timeline.branchId,'提交失败不得换分支')
  }finally{g.cleanup()}
 }finally{rmSync(root,{recursive:true,force:true})}
})

// 早期基准覆盖产品另两条受影响分支（同一新接线，不是扩大测试范围）：
// ① store 提供 writeChatHeader 时，prepare 的 savePreparation 走 header 分支（真 chatPersistence.writeHeader），基准仍须落库；
// ② beginCompatibility 的兼容入口——captureSceneWorldbook 提供时，40行后必真读卡，首 commit 必须先于读卡落库。
test('早期基准覆盖header与兼容入口：读卡失败仍保原基准',async()=>{
 const cases=[{label:'header prepare',options:{header:true},call:f=>f.orchestrator.prepare(input)},{label:'compat beginCompatibility',options:{compat:true},call:f=>f.orchestrator.beginCompatibility(input)}]
 for(const entry of cases){
  const root=mkdtempSync(path.join(os.tmpdir(),'rollback-early-modules-'))
  try{
   const modules=await loadRealModules(root),writeCalls=[],cardCalls=[]
   const f=await fixture(modules,{...entry.options,readCard:async()=>{cardCalls.push('read');throw Error(CARD_ERROR)},writeCalls})
   try{
    await assert.rejects(entry.call(f),/卡片读取故障/,entry.label+'：必须按真实读卡错因拒绝')
    // ① 首个 commit 必须先发生（含 header 分支），且 source 正确
    const commits=writeCalls.length+f.headerCalls.length
    assert.ok(commits>=1,entry.label+'：prepare/兼容入口的首个 commit 必须已发生')
    const firstSource=writeCalls.length>0?writeCalls[0]:f.headerCalls[0]
    assert.equal(firstSource,'foreground.body-before-prepare',entry.label+'：首写 metadata source 必须是正文准备前基准提交')
    if(entry.options.header)assert.equal(writeCalls.length,0,entry.label+'：有 writeChatHeader 时不得退化成全文写')
    assert.equal(cardCalls.length,1,entry.label+'：读卡必须已被触发（且只一次）')
    // ② archive 必须有 running body 53 + 完整基准，owner 身份同 op
    const chat=await f.read(),body=Object.values(chat.timeline.operations||{}).filter(op=>op.kind==='body')
    assert.equal(body.length,1,entry.label+'：archive 必须恰有一条 body 操作：'+JSON.stringify(body.map(op=>[op.turn,op.status])))
    const op=body[0]
    assert.equal(op.status,'running',entry.label+'：读卡失败后 body 必须已是 running')
    assert.equal(Number(op.turn),TURN)
    assert.equal(op.basedOn.branchId,chat.timeline.branchId,entry.label+'：basedOn 必须落在本分支')
    const baseline=op.businessBefore
    assert.ok(baseline&&typeof baseline==='object',entry.label+'：archive 必须带完整 businessBefore')
    assert.equal(baseline.version,1);assert.equal(baseline.messageCount,f.before.messages.length,entry.label+'：基准正文行数必须等于提交前')
    assert.deepEqual(baseline.fields.variables,f.before.variables,entry.label+'：基准变量必须等于提交前')
    assert.equal(Object.hasOwn(baseline,'operationStates'),true,entry.label+'：基准必须带 operation 状态')
    assert.equal(f.owners.length,1,entry.label+'：提交成功后必须发布恰好一个 owner')
    assert.equal(f.owners[0].operationId,op.id,entry.label+'：owner.operationId 必须等于 archive 里的 body 操作 id')
    assert.equal(f.owners[0].turn,TURN)
    // ③ 原正文/变量原样
    assert.equal(chat.messages.length,f.before.messages.length)
    assert.deepEqual(chat.messages,f.before.messages,entry.label+'：读卡失败不得改正文')
    assert.deepEqual(chat.variables,f.before.variables,entry.label+'：读卡失败不得改变量')
   }finally{f.cleanup()}
  }finally{rmSync(root,{recursive:true,force:true})}
 }
})
