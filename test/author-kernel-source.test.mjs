// D02/D04/D05/D06：本次真实作者源码→标准writer→执行生成桥，不写作者树。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {maintenanceTargets,applyStandardSeams,uninstallStandardSeams,checkStandardSeams} from '../deploy/standard-seams.mjs'
import os from 'node:os'
import {helperReadonlySource} from '../deploy/helper-readonly-source.mjs'
import {createHelperReadonlyApi} from '../lib/helper-readonly-api.js'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
const ROOT = new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/',import.meta.url)
const text = rel => fs.readFileSync(new URL(rel,ROOT),'utf8')
const moduleOf = source => import('data:text/javascript;base64,'+Buffer.from(source,'utf8').toString('base64'))

test('作者纯内核：标准writer生成桥真实导出并把投影/宏/slash注入唯一执行器，全部维护目标内可解析',async()=>{
 const sources=new Map(maintenanceTargets.filter(rel=>fs.existsSync(new URL(rel,ROOT))).map(rel=>[rel,text(rel)]))
 const writes=buildCore(fileURLToPath(ROOT),sources)
 assert.equal(maintenanceTargets.length,63)
 for(const rel of ['tavern-plugin/lib/index.js','tavern-plugin/lib/domain/story-timeline.js','tavern-plugin/lib/domain/background-task-coordinator.js','tavern-plugin/lib/domain/storage-native-data.js','tavern-plugin/lib/domain/storage-helper-readonly.js','tavern-plugin/lib/domain/storage-server-execution.js']) {
   assert.ok(maintenanceTargets.includes(rel));parse(writes.get(rel),{ecmaVersion:'latest',sourceType:'module'})
 }
 const nativeSource=writes.get('tavern-plugin/lib/domain/storage-native-data.js')
 const assembler=await moduleOf(nativeSource.slice(nativeSource.indexOf('export async function assembleTavernView')))
 assert.equal(typeof assembler.assembleTavernView,'function')
 const kernel=await moduleOf(writes.get('tavern-plugin/lib/domain/storage-helper-readonly.js'))
 assert.equal(typeof kernel.installTavernHelperMacroApi,'function');assert.equal(typeof kernel.createSlashReader,'function')
 // 执行真实桥的函数，替身只观察impl入口DI；生成任务函数不调用。
 const shim=writes.get('tavern-plugin/lib/domain/storage-server-execution.js')
 const AST=parse(shim,{ecmaVersion:'latest',sourceType:'module'})
 const fn=AST.body.find(n=>n.type==='ExportNamedDeclaration'&&n.declaration?.id?.name==='createServerExecution').declaration
 const projection=()=>{}, generation=()=>{}
 const dependencies={impl:{createServerExecution:options=>options},projectTavernHelperMessage:projection,
   installTavernHelperMacroApi:kernel.installTavernHelperMacroApi,createSlashReader:kernel.createSlashReader,createHelperGenerationTasks:generation,
   installTavernHelperRegexApi:()=>{},createTavernRegexEngine:()=>{},path,os:{homedir:()=>'/fixture'},
   deps:{serverLodash:()=>({}),serverYaml:()=>({})},zod:undefined,zodLoadError:undefined,
   authorScripts:{projectTavernHelperScripts:()=>{},isHostOwnedMvu:()=>false},options:{probe:1}}
 const actual=new Function(...Object.keys(dependencies),shim.slice(fn.body.start,fn.body.end))(...Object.values(dependencies))
 assert.equal(actual.projectHelperMessage,projection);assert.equal(actual.installMacroApi,kernel.installTavernHelperMacroApi);assert.equal(actual.createSlashReader,kernel.createSlashReader);assert.equal(actual.probe,1)
 assert.ok(writes.get('tavern-plugin/lib/index.js').includes('get assembleTavernView() { return assembleTavernView }'))
})

test('作者组装桥：真实有限源码安装/ready/现场代码保留卸载，新增桥回收无残留',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tavern-author-kernel-install-'))
 const relatives=[...maintenanceTargets,'tavern-plugin/package.json']
 const originals=new Map(relatives.filter(rel=>fs.existsSync(new URL(rel,ROOT))).map(rel=>[rel,text(rel)]))
 try {
   for(const [rel,source]of originals){const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source,'utf8')}
   // 明确用户现场注释；装卸不能拿官方原文覆盖现场。
   const rel='tavern-plugin/lib/index.js'
   const custom=originals.get(rel)+'\n// 用户现场自有注释\n'
   originals.set(rel,custom);fs.writeFileSync(path.join(root,rel),custom,'utf8')
   const install=applyStandardSeams({appDir:root,authorUnloaded:true})
   assert.equal(install.ready,true);assert.equal(checkStandardSeams({appDir:root}).ready,true)
   assert.equal(fs.existsSync(path.join(root,'tavern-plugin/lib/domain/storage-helper-readonly.js')),true)
   for(const rel of maintenanceTargets){const file=path.join(root,rel);if(fs.existsSync(file))parse(fs.readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'module'})}
   uninstallStandardSeams({appDir:root,authorUnloaded:true})
   for(const [rel,original]of originals)assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),original,rel)
   for(const rel of maintenanceTargets.filter(rel=>!originals.has(rel)))assert.equal(fs.existsSync(path.join(root,rel)),false,rel)
 }finally{assert.ok(path.basename(root).startsWith('tavern-author-kernel-install-'));fs.rmSync(root,{recursive:true,force:true})}
})

test('作者纯内核：macro毒key和私有键过滤、活窗口与整管道先校验零写零IO',async()=>{
 const kernel=await moduleOf(helperReadonlySource(text('tavern-plugin/src/client/runtime/helper-macro-api.js'),text('tavern-plugin/src/client/features/assistant-renderer.js')))
 const built=await moduleOf(helperReadonlySource(text('tavern-plugin/lib/client.js'),text('tavern-plugin/lib/client.js')))
 let opened=true,worldbookReads=0,windowReads=0
 const variables={obj:{$secret:1,visible:2},constructor:{x:'poison'},value:'a|b'}
 const input={playerName:'当前玩家',characterName:'当前卡'}
 const getVariables=()=>variables
 const api=createHelperReadonlyApi({readOpen:()=>{windowReads++;if(!opened)throw Error('已关窗');return input},getVariables,getCurrentMessageId:()=>4,getLastMessageId:()=>8,
   host:{getWorldbook:async()=>{worldbookReads++;return {worldbook:{entries:[{uid:9,name:'命中',strategy:{keys:['目标']}}]}}}},options:{installMacroApi:kernel.installTavernHelperMacroApi,createSlashReader:kernel.createSlashReader,state:open=>open}})
 const browser={getVariables,getCurrentMessageId:()=>4,getLastMessageId:()=>8}
 built.installTavernHelperMacroApi({window:browser,context:()=>input})
 const macro='{{user}}|{{char}}|{{messageId}}|{{lastMessageId}}|{{get_chat_variable::obj}}|{{getvar::constructor.x}}|{{setvar::x}}'
 assert.equal(api.substitudeMacros(macro),browser.substitudeMacros(macro));assert.equal(windowReads,1,'一次宏调用使用一次同窗回执')
 assert.equal(api.substitudeMacros('{{get_chat_variable::obj}}'),'\u007b"visible":2\u007d')
 assert.equal(api.substitudeMacros('{{getvar::constructor.x}}'),'')
 assert.equal(api.substitudeMacros('{{getvar::value}}'),'a|b')
 input.playerName='后来玩家';assert.equal(api.substitudeMacros('{{user}}'),'后来玩家')
 await assert.rejects(()=>api.triggerSlash('/findentry file=current 目标 | /send 非只读'),/只读|不支持/);assert.equal(worldbookReads,0)
 assert.equal(await api.triggerSlash('/pass "目|标" | /return "{{pipe}}"'),'目|标')
 assert.equal(await api.triggerSlash('/findentry file=current 目标'),'9');assert.equal(worldbookReads,1)
 opened=false;assert.throws(()=>api.substitudeMacros('无宏普通文本'),/关窗/)
 await assert.rejects(()=>api.triggerSlash('/pass literal'),/关窗/);assert.equal(worldbookReads,1)
})

test('状态组装警告：真实标准writer生成模块执行无需Host闭包',async()=>{
 const sources=new Map(maintenanceTargets.filter(rel=>fs.existsSync(new URL(rel,ROOT))).map(rel=>[rel,text(rel)]))
 const writes=buildCore(fileURLToPath(ROOT),sources)
 const entry=[...writes].find(([,value])=>typeof value==='string' && value.includes('export async function assembleTavernView'))
 assert.ok(entry,'标准 writer 必须产出装配器模块')
 const source=entry[1].slice(entry[1].indexOf('export async function assembleTavernView'))
 // 独立组装模块不得携带 Host 闭包符号（游离引用才是现场 ReferenceError 的来源）
 assert.equal(/\bprojectCompactionWarning\b/.test(source),false,'生成模块不得引用 projectCompactionWarning')
 assert.equal(/\bctx\.llm\b/.test(source),false,'生成模块不得引用 ctx.llm 表达式')
 assert.match(source,/contextCompaction/,'生成模块必须以注入值承载 contextCompaction')
 const assembler=await moduleOf(source)
 const handler={get:(_,key)=>key==='then'?undefined:(key===Symbol.toPrimitive?()=>''
   :(key==='toString'||key==='valueOf'?()=>''
   :stub)),apply:()=>stub,has:()=>true}
 const stub=new Proxy(function(){},handler)
 const compaction={warning:{turn:52,message:'压缩提醒'}}
 const values=new Proxy({contextCompaction:compaction,debugTurns:['最新','次新'],chat:stub,card:stub,str:value=>String(value),deferResources:stub,resourceRevision:0,activePresetSnapshot:null,cardUpdate:null,late:stub},{get:(target,key)=>key in target?target[key]:stub,has:()=>true})
 const view=await assembler.assembleTavernView(values)
 assert.equal(view.contextCompaction,compaction,'contextCompaction 必须直接来自 values 注入（同一对象）')
 assert.deepEqual(view.debugTurns,['最新','次新'],'debugTurns 必须保持最新优先且不额外 reverse')
})
