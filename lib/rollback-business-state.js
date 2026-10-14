import { isDeepStrictEqual } from 'node:util'
// 本档已知剧情根捕获整根；未知运行根由实际归属写口累计前像，独立配置/资源编辑不撤销。
// 实际写口：story-timeline、turn-orchestration、MVU effect、script adapter、history-recall。
const STORY_FIELDS = new Set([
 'variables','tavernPluginMetadata','tavernHelperScriptVariables','tavernScriptPrompts','mvu',
 'presentation','presentationWarnings','posture','ledger','scriptState',
 'candidates','candidateAgent','settleStatus','settleError','lastSettle','foregroundError',
 'preparedWorldBookContext','preparedWorldBook','lastWorldBookRecall','worldBookReads','worldBookRandomState','worldBookError',
 'openingWorldbookSnapshot','promptTemplateInput','promptTemplateInitialVariables',
 'runtimeInputs','foregroundFrames','nativeCommits','pendingCardChanges','compatibilityTraces',
 'contextCompaction','historyRecallCooldowns','taskMailbox','rollbackSessionCuts',
 'ledgerInjection',
 'regenInProgress','regenRecovery','regenerationCompletion','hiddenDshErrorTurns','suppressedDshTurns','regeneratedDshTurns'
])
// 宏局部/全局是本档运行快照；userName由setPlayerName手工控制，不能随宏状态回退。
const MACRO_FIELDS = ['local','global']
// 已发布row-v1的snapshot精确覆盖面；其余根不能当作当时不存在而删除。
const ROW_FIELDS = ['presentation','presentationWarnings','variables','tavernPluginMetadata','tavernHelperScriptVariables','tavernScriptPrompts','runtimeInputs','posture','ledger','scriptState','candidates','settleStatus','settleError','lastSettle','preparedWorldBookContext','preparedWorldBook','worldBookReads']
export function resolveRollbackBusinessState(chat,turn,source) {
 const operations=chat.timeline?.operations || {},body=Object.values(operations).find(op=>op.kind==='body' && Number(op.turn)===turn)
 const checkpoint=chat.timeline?.checkpoints?.findLast(cp=>Number(cp.turn)===turn)
 // 来源是实际前像节点，不以状态或operationId存在推导失败/成功算法；旧boolean调用也同样取真实前像。
 const baselineSource=source && typeof source==='object' ? source
   : [body,checkpoint].find(value=>value?.businessBefore!==undefined)
     || [body,checkpoint].find(value=>value?.rowBefore && (value.beforeParticipants || value.participants))
 const complete=baselineSource?.businessBefore
 if(complete!==undefined)return complete // 未知新格式不能静默降级。
 const row=baselineSource?.rowBefore,participants=baselineSource?.beforeParticipants || baselineSource?.participants
 if(!row || !participants || ['presentation','presentationWarnings','macroState','tavernScriptPrompts','runtimeInputs','posture','ledger','scriptState','candidates','settleStatus','settleError','lastSettle','preparedWorldBookContext','preparedWorldBook','worldBookReads'].some(key=>!Object.hasOwn(row,key)))throw new Error('本轮缺少可识别的业务回退基准（businessBefore或旧rowBefore）；未删数据库，不以当前值猜历史')
 const messages=chat.messages || []
 let messageCount=messages.findIndex(message=>Number(message.turn)>=turn)
 // 旧行快照未存行数：带轮号的目标输入优先；旧无轮号user紧邻目标assistant时也属于同一次发送。
 if(messageCount>0 && messages[messageCount]?.role==='assistant' && messages[messageCount-1]?.role==='user'
   && (messages[messageCount-1].turn===undefined || Number(messages[messageCount-1].turn)===turn))messageCount--
 if(messageCount<0)throw new Error('旧rowBefore缺少确切输入/正文前缀，未删数据库')
 if(messages.slice(messageCount).some(message=>Number.isSafeInteger(message.turn) && message.turn<turn))throw new Error('旧快照行前缀不是纯尾，未删数据库')
 const kept=Object.fromEntries(Object.entries(operations).filter(([,op])=>Number(op.turn)<turn))
 const operationIds=Object.keys(kept),fields=Object.fromEntries(ROW_FIELDS.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))
 fields.macroState=Object.fromEntries(MACRO_FIELDS.filter(key=>Object.hasOwn(row.macroState || {},key)).map(key=>[key,row.macroState[key]]))
 return structuredClone({version:1,legacyFormat:'row-v1',turn,fields,messageCount,participants,operationIds,operationStates:{}})
}
export function captureRollbackBusinessState(chat, copy = structuredClone, worldbookRef) {
 const fields = {}
 for (const key of STORY_FIELDS) if (Object.hasOwn(chat,key)) fields[key] = chat[key]
 if(chat.macroState && typeof chat.macroState==='object')fields.macroState=Object.fromEntries(MACRO_FIELDS.filter(key=>Object.hasOwn(chat.macroState,key)).map(key=>[key,chat.macroState[key]]))
 const operationStates = {}, operationPreimages = {}
 for (const [id,operation] of Object.entries(chat.timeline?.operations || {})) {
  // 只有带前像（businessBefore/rowBefore/beforeParticipants）的操作才需要恢复状态；
  // 纯状态操作（kind: agent 的 settlement/ledger 等）节点可被正常回收，记进来只会让基准永久失效。
  const {businessBefore,rowBefore,beforeParticipants,...state} = operation
  if (businessBefore === undefined && rowBefore === undefined && beforeParticipants === undefined) continue
  operationStates[id] = state
  operationPreimages[id] = {...(businessBefore === undefined ? {} : {businessBefore}),...(rowBefore === undefined ? {} : {rowBefore}),...(beforeParticipants === undefined ? {} : {beforeParticipants})}
 }
 if (worldbookRef !== undefined) {
  if (!Object.hasOwn(fields, 'openingWorldbookSnapshot')) throw new Error('世界书引用不能代替本来缺失的字段')
  delete fields.openingWorldbookSnapshot
 }
 return copy({version:1,fields,...(worldbookRef === undefined ? {} : {worldbookRef}),messageCount:Array.isArray(chat.messages)?chat.messages.length:0,participants:chat.timeline?.participants || {},operationIds:Object.keys(chat.timeline?.operations || {}),operationStates,operationPreimages})
}
// 未知运行根沿实际写入归属捕获，不用字段/输出类型名单；独立配置写入不归最近正文。
// 新生产者可显式携带rollbackOwner；兼容实际前台/结算/模板运行写口，不认body-edit独立编辑。
export function recordRollbackBusinessWrites(before,next,metadata={},copy=structuredClone) {
 const operations=before?.timeline?.operations || {}
 const entry=Object.entries(operations).filter(([,op])=>op.kind==='body' && Number.isSafeInteger(Number(op.turn)))
   .sort(([,a],[,b])=>Number(b.turn)-Number(a.turn))[0]
 if(!entry)return
 const [id,body]=entry,owner=metadata.rollbackOwner
 const explicit=owner && owner.chatId===before.id && owner.sessionId===before.sessionId
   && owner.branchId===before.timeline.branchId && owner.operationId===id && Number(owner.turn)===Number(body.turn)
 const runtime=/^(foreground\.(?!body-edit|regen)|settlement\.|prompt-template\.|tavern-helper\.)/.test(metadata.source || '')
 if(owner && !explicit)throw new Error('本档运行写入撤销归属已变化，拒绝旧任务写入')
 if(!explicit && !runtime)return
 const current=next.timeline?.operations?.[id]
 if(!current?.businessBefore || current.businessBefore.version!==1)return
 // 首次写入时记录旧值/不存在；自有前像嵌在同一body，沿现有SQL节点事务，不另建状态库。
 const baseline=copy(current.businessBefore)
 const roots=baseline.runtimeFields || {}
 for(const key of new Set([...Object.keys(before),...Object.keys(next)])) {
   if(STORY_FIELDS.has(key) || key==='macroState' || key==='messages' || key==='timeline' || key.startsWith('_')
     || key==='id' || key==='sessionId' || key==='updatedAt' || key.startsWith('rollback'))continue
   if(isDeepStrictEqual(before[key],next[key]) || Object.hasOwn(roots,key))continue
   roots[key]=Object.hasOwn(before,key)?{present:true,value:copy(before[key])}:{present:false}
 }
 // 正文/工具/变量写口可能修改保留历史的行，不只新增尾部；按行前像恢复，不按role/content分类。
 const rows=baseline.messagePreimages || {}
 const beforeRows=before.messages || [],nextRows=next.messages || []
 for(let index=0;index<baseline.messageCount && index<beforeRows.length;index++) {
   if(!isDeepStrictEqual(beforeRows[index],nextRows[index]) && !Object.hasOwn(rows,index))rows[index]=copy(beforeRows[index])
 }
 if(Object.keys(roots).length)baseline.runtimeFields=roots
 if(Object.keys(rows).length)baseline.messagePreimages=rows
 if(isDeepStrictEqual(current.businessBefore,baseline))return
 const updatedBody={...current,businessBefore:baseline}
 next.timeline={...next.timeline,operations:{...next.timeline.operations,[id]:updatedBody}}
 // 完成checkpoint与body必须携同一累计前像，不能留在首次capture版本。
 if(Array.isArray(next.timeline.checkpoints))next.timeline.checkpoints=next.timeline.checkpoints.map(cp=>Number(cp.turn)===Number(body.turn)?{...cp,businessBefore:copy(baseline)}:cp)
 return id
}
export function restoreRollbackBusinessState(chat, baseline, copy = structuredClone, readWorldbook, readOperation) {
 if (baseline?.version !== 1 || !baseline.fields || !baseline.participants || !Array.isArray(baseline.operationIds)) throw new Error('缺少完整上轮业务基准，拒绝用当前状态或空值冒充历史')
 const hasBookRef = Object.hasOwn(baseline, 'worldbookRef')
 let historicalBook
 // 先解析并验证，失败不得留下半恢复状态，不从当前书猜历史。
 if (hasBookRef) {
  if (Object.hasOwn(baseline.fields, 'openingWorldbookSnapshot')) throw new Error('世界书基准同时有全文与引用，拒绝不明确恢复')
  if (typeof readWorldbook !== 'function') throw new Error('世界书历史引用缺少数据库解析接线')
  historicalBook = readWorldbook(chat, baseline.worldbookRef)
  if (historicalBook === undefined || historicalBook?.then) throw new Error('世界书历史引用未返回完整同步状态')
 }
 // 所需历史先解析完再改头；当前节点消失不再构成拒绝条件。
 const restoredOperations = {}
 for (const [id,state] of Object.entries(baseline.operationStates || {})) {
  let preimage = baseline.operationPreimages?.[id]
  if (preimage?.operationSnapshotId !== undefined) {
   if (typeof readOperation !== 'function') throw new Error('操作历史前像缺少数据库解析接线')
   preimage = readOperation(chat,preimage)
   if (!preimage || preimage.then) throw new Error('操作历史前像未返回同步状态')
  }
  if (preimage === undefined && !Object.hasOwn(baseline,'operationPreimages')) {
   const current = chat.timeline?.operations?.[id]
   const checkpoint = state.kind==='body' ? chat.timeline?.checkpoints?.findLast(cp=>Number(cp.turn)===Number(state.turn)) : null
   const source = current || checkpoint
   if (source) preimage = Object.fromEntries(['businessBefore','rowBefore','beforeParticipants'].filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]))
   if (checkpoint && !current && !Object.hasOwn(preimage,'beforeParticipants') && checkpoint.participants!==undefined) preimage.beforeParticipants=checkpoint.participants
  }
  if (state.kind==='body' && !preimage?.businessBefore && !(preimage?.rowBefore && preimage?.beforeParticipants)) throw new Error('缺少正文操作的真实历史前像：'+id)
  restoredOperations[id] = {...copy(state),...copy(preimage || {})}
 }
 for (const key of baseline.legacyFormat==='row-v1'?ROW_FIELDS:STORY_FIELDS) {
  if (key === 'openingWorldbookSnapshot' && hasBookRef) chat[key] = copy(historicalBook)
  else if(Object.hasOwn(baseline.fields,key))chat[key]=copy(baseline.fields[key]);else delete chat[key]
 }
 // runtimeFields只来自已核归属写口的实际变更；未知运行根也恢复，配置从未被归属写口触碰则不受影响。
 for(const [key,entry] of Object.entries(baseline.runtimeFields || {})) {
   if(entry.present)chat[key]=copy(entry.value);else delete chat[key]
 }
 if(Array.isArray(chat.messages))for(const [index,row] of Object.entries(baseline.messagePreimages || {})) {
   if(Number(index)<baseline.messageCount)chat.messages[Number(index)]=copy(row)
 }
 const currentMacro=chat.macroState && typeof chat.macroState==='object'?{...chat.macroState}:{}
 for(const key of MACRO_FIELDS){if(Object.hasOwn(baseline.fields.macroState || {},key))currentMacro[key]=copy(baseline.fields.macroState[key]);else delete currentMacro[key]}
 if(Object.keys(currentMacro).length)chat.macroState=currentMacro;else delete chat.macroState
 if (chat.timeline) {
  const kept = new Set(baseline.operationIds)
  for (const key of Object.keys(chat.timeline.operations || {})) if (!kept.has(key)) delete chat.timeline.operations[key]
  chat.timeline.operations ||= {}
  Object.assign(chat.timeline.operations,restoredOperations)
 }
 if(baseline.legacyFormat==='row-v1'){
  // 旧快照未记录的独立初始化/控制根不复写；有确切轮归属的运行缓存只删目标尾。
  const turn=baseline.turn
  for(const key of ['foregroundFrames','nativeCommits','rollbackSessionCuts','regeneratedDshTurns','historyRecallCooldowns']){
   const value=chat[key]
   if(Array.isArray(value))chat[key]=value.filter(item=>Number(item?.turn)<turn)
   else if(value && typeof value==='object')for(const [id,item] of Object.entries(value))if(Number(item?.turn ?? id)>=turn)delete value[id]
  }
  for(const key of ['lastWorldBookRecall','worldBookRandomState'])if(Number(chat[key]?.turn)>=turn)delete chat[key]
  // 压缩调度缓存随新分支重建，不用旧分支收据/警告充当上轮状态；策略配置在外层保留。
  delete chat.contextCompaction;delete chat.foregroundError;delete chat.regenInProgress
 }
 delete chat.rollbackUndo
 return chat
}
