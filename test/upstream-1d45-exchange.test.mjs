// 完整DB引擎/容器/SQL目标 + 真作者插件数据模块，不只验证资源层。
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {fixture} from './db-save-exchange.test.mjs'
import {decodeDbSave,inspectDatabase} from '../lib/db-save-codec.js'
const CHAT='chat-dummy-source',SESSION='session-dummy-source'
test('上游1d45DB交换：完整包携带插件数据与前像历史，新双ID恢复且发布失败补偿',async t=>{
 const f=fixture(t,{pluginScenario:true}),source=inspectDatabase(f.archivePath(CHAT),'archive').head,key=f.computeSceneTarget(source,1).key
 await f.pluginData.saveTurn({chatId:CHAT,owner:'game',turn:1,key,data:{score:3}})
 await f.pluginData.saveGame({chatId:CHAT,owner:'game',data:{level:4}})
 const db=new DatabaseSync(f.archivePath(CHAT))
 db.prepare('INSERT INTO archive_operation_history(operation_snapshot_id,snapshot_json) VALUES(?,?)').run(1,JSON.stringify({businessBefore:{version:1,operationPreimages:{older:{version:1,chatId:CHAT,operationSnapshotId:1}}}}))
 db.close()
 const exported=await f.engine.exportGameSave(SESSION),packed=decodeDbSave(Buffer.from(exported.base64,'base64'))
 assert.equal(packed.manifest.portable.pluginData,true);assert.ok(packed.resources.some(file=>file.path==='plugins.json'))
 const result=await f.engine.importGameSave({fileB64:exported.base64}),after=inspectDatabase(f.archivePath(result.chatId),'archive')
 assert.notEqual(result.chatId,CHAT);assert.notEqual(result.sessionId,SESSION)
 const data=await f.pluginData.snapshot(result.chatId)
 assert.deepEqual(data.owners.game.game,{level:4});assert.equal(data.owners.game.turns[0].key,f.computeSceneTarget(after.head,1).key)
 assert.equal(JSON.parse(after.tables.archive_operation_history[0].snapshot_json).businessBefore.operationPreimages.older.chatId,result.chatId)
 assert.equal((await f.pluginData.snapshot(CHAT)).owners.game.turns[0].key,key)
 const failed=fixture(t,{pluginScenario:true,failPublish:true}),other=inspectDatabase(failed.archivePath(CHAT),'archive').head
 await failed.pluginData.saveGame({chatId:CHAT,owner:'game',data:{level:2}})
 const bad=await failed.engine.exportGameSave(SESSION)
 await assert.rejects(()=>failed.engine.importGameSave({fileB64:bad.base64}),/合成发布失败/)
 assert.equal(await failed.pluginData.snapshot(failed.attempted[0].chatId),null)
 assert.deepEqual((await failed.pluginData.snapshot(CHAT)).owners.game.game,{level:2})
})
