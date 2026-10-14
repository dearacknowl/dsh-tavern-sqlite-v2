// 输入-only 锚点（合同 2026-10-13 第二批）：最新一次发送在**尚无正文**时也能定位。
//   ① round-anchor.js：validAnchor 允许 reply===null（input-only），resolve 天然返回 { input, reply:null }；
//   ② story-timeline.js：beginBody 把 intent.nativeAnchor 存进 body operation；
//   ③ turn-orchestration.js：在前台 prepare 的既有捕获点（业务变换注入处）算出 nativeAnchor 并随 body.begin 传入。
// 不改 lib/clean-rollback.js 与 index.js；session 由 orchestrator 选项 sessions.get(id)（agent 或 session 两形态）或宿主 DI resolveSendInputAnchor 提供。
function once(source,old,next,label){
  if(source.split(old).length!==2)throw Error((label||'输入-only锚点接缝未命中/不唯一')+'：'+old.slice(0,110))
  return source.replace(old,next)
}
// ── ① 解析器：允许 { turn, input, reply:null } ──────────────────────────────
const RESOLVER_MARKER='// [dsh-tavern-input-only-anchor:v1]'
const VALID_OLD=`export function validAnchor(anchor) {
  return Boolean(anchor && ['turn', 'input', 'reply'].every(key => Number.isSafeInteger(anchor[key])))
}`
const VALID_NEW=`export function validAnchor(anchor) {
  ${RESOLVER_MARKER}
  // input-only：最新一次发送可能还没有正文（停止/失败/未知终态）——reply 允许 null，turn/input 仍必须为整数。
  return Boolean(anchor && Number.isSafeInteger(anchor.turn) && Number.isSafeInteger(anchor.input)
    && (anchor.reply === null || Number.isSafeInteger(anchor.reply)))
}`
export function applyInputOnlyAnchorResolverTransform(source){
  if(source.includes(RESOLVER_MARKER))return source
  return once(source,VALID_OLD,VALID_NEW,'input-only 锚点解析器锚点缺失/不唯一')
}
// ── ② body operation 存锚点 ────────────────────────────────────────────────
const OP_MARKER='// [dsh-tavern-body-operation-anchor:v1]'
const OP_OLD=`, beforeParticipants: clone(chat.timeline.participants), createdAt: now()
    }
    chat.timeline.operations[operation.id] = operation`
const OP_NEW=`, beforeParticipants: clone(chat.timeline.participants), createdAt: now(),
      ${OP_MARKER}
      ...(intent.nativeAnchor && typeof intent.nativeAnchor === 'object'
        ? { nativeAnchor: { turn: Number(intent.nativeAnchor.turn), input: intent.nativeAnchor.input, reply: intent.nativeAnchor.reply === undefined ? null : intent.nativeAnchor.reply } }
        : {})
    }
    chat.timeline.operations[operation.id] = operation`
export function applySendAnchorTimelineTransform(source){
  let next=source
  if(!next.includes(OP_MARKER))next=once(next,OP_OLD,OP_NEW,'body operation 锚点字段锚点缺失/不唯一')
  if(!next.includes(PENDING_MARKER))next=once(next,PENDING_OLD,PENDING_NEW,'body 占位复用锚点缺失/不唯一')
  return next
}
// ── ②b beginBody 复用早期 capture 占位（真实复用，不手写近似）────────────────
// 只当 existing.inputPending === true（早期 capture 在 turn/start 前落的占位、原生 player 输入尚未到达）：
//   补 existing.userText=userText、delete inputPending；intent.nativeAnchor 有才填（无则保持已写锚点）；
//   existing.businessBefore 永不改。原生 capture 已补 text（inputPending 已删）时走原有 normal same 文本复用；
//   同轮不同输入的 IDEMPOTENCY_CONFLICT 原样保留。
const PENDING_MARKER='// [dsh-tavern-body-input-pending-reuse:v1]'
const PENDING_OLD=`    if (existing !== undefined) {
      if (str(existing.userText) !== userText) {`
const PENDING_NEW=`    if (existing !== undefined) {
      ${PENDING_MARKER}
      // 早期 capture 占位：原生 player 输入还没到就先开了轮。此处补真实输入与锚点，businessBefore 一律不动。
      if (existing.inputPending === true && userText !== '') {
        existing.userText = userText
        delete existing.inputPending
        if (intent.nativeAnchor && typeof intent.nativeAnchor === 'object') {
          existing.nativeAnchor = { turn: Number(intent.nativeAnchor.turn), input: intent.nativeAnchor.input, reply: intent.nativeAnchor.reply === undefined ? null : intent.nativeAnchor.reply }
        }
        return operationValue(existing)
      }
      if (str(existing.userText) !== userText) {`
// ── ③ 前台 prepare：算锚点并随 body.begin 传入 ─────────────────────────────
const TURN_MARKER='// [dsh-tavern-send-anchor-prepare:v1]'
const IMPORT_LINE="import { inputEventForTurn } from './session-turn-input.js'\n"
const CAPTURE_OLD='    const rollbackBusinessBefore = captureRollbackBusinessState(chat)\n'
// 旧作者树没有 session-turn-input.js：那种树只走宿主 DI，不注入该 import（否则旧代安装即坏）。
function captureNew(hasInputModule){
  const resolve=hasInputModule
    ?`        const handle = options.sessions && typeof options.sessions.get === 'function' ? options.sessions.get(chat.sessionId) : undefined
        const inputSession = handle && handle.session ? handle.session : handle
        const event = inputEventForTurn(inputSession, turn)
        return event && Number.isSafeInteger(event.seq) ? { turn: Number(turn), input: Number(event.seq), reply: null } : null`
    :`        return null`
  return CAPTURE_OLD+`    ${TURN_MARKER}
    // 发轮前锚点：优先宿主 DI，其次 orchestrator 选项里的 sessions.get(id)（可能是 agent，也可能是 session）。
    // 异步拿不到或没有原生输入事件时留 null——绝不猜 seq，也不阻塞 prepare。
    const rollbackSendAnchor = (function () {
      try {
        if (typeof options.resolveSendInputAnchor === 'function') {
          const provided = options.resolveSendInputAnchor(chat.sessionId, turn)
          return provided && Number.isSafeInteger(Number(provided.input)) ? { turn: Number(turn), input: Number(provided.input), reply: null } : null
        }
${resolve}
      } catch (error) { return null }
    })()
`
}
const INTENT_WITH_BB="const begun = timeline.apply({ chat: { ...chat, messages: [] }, intent: { kind: 'body.begin', turn, userText, businessBefore: rollbackBusinessBefore } })"
const INTENT_PLAIN="const begun = timeline.apply({ chat: { ...chat, messages: [] }, intent: { kind: 'body.begin', turn, userText } })"
export function applySendAnchorTurnTransform(source, options = {}){
  const hasInputModule = options.hasInputModule !== false
  if(source.includes(TURN_MARKER))return source
  let next = hasInputModule && !source.includes(IMPORT_LINE) ? IMPORT_LINE + source : source
  // 业务变换之后捕获行有两种真实形态：世界书捕获会把它改写成
  // `timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)`。
  const PLAIN='    const rollbackBusinessBefore = captureRollbackBusinessState(chat)\n'
  const WORLDBOOK='    const rollbackBusinessBefore = timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)\n'
  const plain=next.split(PLAIN).length-1, worldbook=next.split(WORLDBOOK).length-1
  const capture=worldbook===1?WORLDBOOK:(plain===1?PLAIN:null)
  if(capture===null)throw Error('发轮前锚点捕获锚点缺失/不唯一：plain='+plain+' worldbook='+worldbook)
  const tail=captureNew(hasInputModule).slice(CAPTURE_OLD.length)
  next=once(next,capture,capture+tail,'发轮前锚点捕获锚点缺失/不唯一')
  // body.begin intent 同样两种形态：带 businessBefore 的那一种优先（537e878 实测就是这一种）。
  const withBb=next.split(INTENT_WITH_BB).length-1, bare=next.split(INTENT_PLAIN).length-1
  const intent=withBb===1?INTENT_WITH_BB:(bare===1?INTENT_PLAIN:null)
  if(intent===null)throw Error('发轮前锚点 body.begin 锚点缺失/不唯一：withBB='+withBb+' plain='+bare)
  next=once(next,intent,intent.replace(' } })',', nativeAnchor: rollbackSendAnchor } })'),'发轮前锚点 body.begin 锚点缺失/不唯一')
  return next
}
