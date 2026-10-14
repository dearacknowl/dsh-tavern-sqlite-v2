// R2 客户端接缝：真 AUTHOR split/built 组合产物 —— 普通目标行的**升级/幂等/语法**核验。
// 旧代升级语义：升级助手必须在「已渲染成品」（模板占位 /*DSH_PURGE_*&#47; 已被替换）上定位，
// 首叶核当前产物二次幂等；第二叶用真实Git旧代变换生成旧marked，再验证原位升级。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import vm from 'node:vm'
import {applyAuthorRollbackActionTransform} from '../deploy/rollback-sync-author-transform.mjs'
import {applyRollbackSyncActionGuardTransform} from '../deploy/rollback-sync-install-transform.mjs'
import {applyErrorPurgePlayControlsTransform} from '../deploy/error-purge-transform.mjs'

const top=spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'})
assert.equal(top.status,0,'必须能定位仓库顶层')
const REPO_ROOT=new URL('file:///'+top.stdout.trim().replace(/\\/g,'/')+'/')
const AUTHOR_ROOT=new URL('tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/',REPO_ROOT)
const MARKER='// [dsh-tavern-error-purge-play:v1]'
const ORDINARY_DECL='var ordinaryTarget ='
const ORDINARY_OBJECT_DECL='var ordinaryObject ='
const OLD_NUMERIC=': await rpc("rollbackTurn", { expectedTurn: targetTurn }, props.sessionId);'
const NEW_ORDINARY_RPC='{ expectedTurn: rollbackRetryTarget || ordinaryTurn }'
const RENDERED_CLEAR='const result = clearIncomplete'

function wired(rel){
 const raw=readFileSync(new URL(rel,AUTHOR_ROOT),'utf8')
 return applyErrorPurgePlayControlsTransform(applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(raw)))
}
// 语法核验：取整文件包成模块函数体（真产物是 bundle 片段，用 vm.Script 只判语法）。
function assertParses(source,label){
 try{ new vm.Script('(function(){'+source+'\n})') }
 catch(error){ assert.fail(label+' 施缝产物语法不可解析：'+error.message) }
}
function rollbackCallback(source){
 const comp=source.lastIndexOf('function TavernRollbackAction(props) {')
 assert.ok(comp>=0,'真产物里必须存在 TavernRollbackAction')
 const start=source.indexOf('async function rollback()',comp)
 const end=source.indexOf('if (!canRollback) {',start)
 assert.ok(start>comp&&end>start,'rollback callback 边界必须可定位')
 return {text:source.slice(start,end),start}
}

test('R2客户端接缝：完整产物语法及二次幂等，standalone无重试state仍安全',()=>{
 for(const rel of ['src/client/features/play-controls.js','lib/client.js']){
  const raw=readFileSync(new URL(rel,AUTHOR_ROOT),'utf8')
  const standalone=applyErrorPurgePlayControlsTransform(raw)
  assertParses(standalone,rel+' standalone')
  assert.equal(standalone.includes('var ordinaryRetry = typeof rollbackRetryTarget === "undefined" ? null : rollbackRetryTarget;'),true)
  assert.equal(standalone.includes(NEW_ORDINARY_RPC),false,'无state的standalone不得引用未声明retry')
  assert.equal(applyErrorPurgePlayControlsTransform(standalone),standalone)
  const first=wired(rel)
  // 前置：真成品必须已渲染（占位已消失）且普通行走对象凭据
  assert.equal(first.includes('/*DSH_PURGE_'),false,rel+'：成品不得残留模板占位')
  assert.equal(first.split(OLD_NUMERIC).length-1,0,rel+'：旧数字普通行必须已被替换')
  assert.equal(first.split(NEW_ORDINARY_RPC).length-1,1,rel+'：普通 RPC 必须恰 1 处走重试/普通目标')
  // ① 普通行必须落在真 rollback callback 内、且声明在 clear 行之前（有目标才发请求）
  const cb=rollbackCallback(first)
  assert.ok(cb.text.includes(ORDINARY_DECL),rel+'：普通目标声明必须在 rollback callback 内')
  assert.ok(cb.text.includes(ORDINARY_OBJECT_DECL),rel+'：对象身份判据必须在 callback 内')
  assert.ok(cb.text.includes('ordinaryTarget.kind === "rollback"'),rel+'：必须校验 kind')
  assert.ok(cb.text.includes('ordinaryTarget.revision'),rel+'：必须校验 revision')
  assert.ok(cb.text.includes('ordinaryTarget.chatId')&&cb.text.includes('ordinaryTarget.sessionId'),rel+'：必须校验身份')
  assert.ok(cb.text.indexOf(ORDINARY_DECL)<cb.text.indexOf(RENDERED_CLEAR),rel+'：普通目标声明必须早于 clear 行')
  assert.equal(cb.text.split(ORDINARY_DECL).length-1,1,rel+'：callback 内普通目标声明必须唯一')
  // ② 完整产物语法可解析
  assertParses(first,rel)
  // ③ 真升级：对已渲染成品再施缝（第 2 次即 marked 分支＝旧 marked 升级路径）⇒ 字节不变
  const second=applyErrorPurgePlayControlsTransform(first)
  assert.equal(second,first,rel+'：旧 marked 升级必须字节幂等（占位已去仍能定位）')
 }
})

// 真实旧代 marked：用 git 历史里 a7a614c 的**旧 transform 源**（不是对当前 source 再施一次）生成旧产物，
// 再交当前两缝升级；同时验 strict syntax / 幂等 / 缺 RPC 时 fail-closed。
test('R2客户端接缝：真实旧代生成升级及新两schema语法幂等与缺RPC拒绝',async()=>{
 const {mkdtempSync,rmSync} = await import('node:fs')
 const os = await import('node:os')
 const pathMod = await import('node:path')
 const {pathToFileURL,fileURLToPath} = await import('node:url')
 const repoRoot = fileURLToPath(REPO_ROOT)
 const gitShow = rel => {
  const r = spawnSync('git',['show','a7a614c:'+rel],{cwd:repoRoot,encoding:'utf8'})
  assert.equal(r.status,0,'git show 旧代源必须成功：'+rel+' :: '+String(r.stderr).slice(0,120))
  return r.stdout
 }
 const oldDir = mkdtempSync(pathMod.join(os.tmpdir(),'r2-oldtransforms-'))
 try{
  const relBase='plugins/dsh-tavern-sqlite-v2/deploy/'
  for(const name of ['rollback-sync-state-transform.mjs','rollback-sync-author-transform.mjs','rollback-sync-install-transform.mjs','error-purge-transform.mjs']){
   const src = gitShow(relBase+name).replace(/from '\.\/([a-z-]+)\.mjs'/g,(all,dep)=>"from '"+pathToFileURL(pathMod.join(oldDir,dep+'.mjs')).href+"'")
   writeFileSync(pathMod.join(oldDir,name),src,'utf8')
  }
  const oldAuthor = await import(pathToFileURL(pathMod.join(oldDir,'rollback-sync-author-transform.mjs')).href)
  const oldGuard = await import(pathToFileURL(pathMod.join(oldDir,'rollback-sync-install-transform.mjs')).href)
  const oldPurge = await import(pathToFileURL(pathMod.join(oldDir,'error-purge-transform.mjs')).href)
  for(const rel of ['src/client/features/play-controls.js','lib/client.js']){
   const raw=readFileSync(new URL(rel,AUTHOR_ROOT),'utf8')
   // 旧代链：旧作者动作 → 旧 sync guard → 旧 purge ⇒ 真旧 marked（普通行=数字、无 retry state）
   const oldMarked = oldPurge.applyErrorPurgePlayControlsTransform(oldGuard.applyRollbackSyncActionGuardTransform(oldAuthor.applyAuthorRollbackActionTransform(raw)))
   assert.ok(oldMarked.includes(MARKER),rel+'：旧代产物必须带 PLAY marker')
   assert.ok(oldMarked.includes(OLD_NUMERIC),rel+'：旧代产物必须是数字普通行')
   assert.equal(oldMarked.includes('rollbackRetryTarget'),false,rel+'：旧代产物不得含重试 state')
   // 当前两缝升级（作者缝 → purge）⇒ 必须成功且只升一次
   const upgraded = applyErrorPurgePlayControlsTransform(applyAuthorRollbackActionTransform(oldMarked))
   assert.equal(upgraded.includes(OLD_NUMERIC),false,rel+'：升级后旧数字普通行必须消失')
   assert.equal(upgraded.split(NEW_ORDINARY_RPC).length-1,1,rel+'：升级后普通 RPC 必须恰 1 处走目标')
   const cb=rollbackCallback(upgraded)
   assert.equal((cb.text.match(/liveTavernView\.rebase\(props\.sessionId\);\s*tavernCoordination\.invalidate\(props\.sessionId\);/g)||[]).length,1,rel+'：旧catch刷新不得叠加，菜单清理已移交共享服务')
   assert.ok(cb.text.includes(ORDINARY_DECL),rel+'：升级后普通声明必须在 callback 内')
   assert.ok(cb.text.includes(ORDINARY_OBJECT_DECL),rel+'：升级后对象判据必须在位')
   assertParses(upgraded,rel+'（升级产物）')
   // 新两 schema 幂等：再施当前两缝字节不变
   assert.equal(applyErrorPurgePlayControlsTransform(applyAuthorRollbackActionTransform(upgraded)),upgraded,rel+'：升级必须字节幂等')
   // 缺 RPC 的畸形旧产物：必须 fail-closed，不得静默产出
   const broken = oldMarked.replace(OLD_NUMERIC,';')
   assert.throws(()=>applyErrorPurgePlayControlsTransform(applyAuthorRollbackActionTransform(broken)),/锚点缺失|不唯一|清除|回退/,'缺普通 RPC 的旧产物必须拒绝')
  }
 }finally{ rmSync(oldDir,{recursive:true,force:true}) }
})
