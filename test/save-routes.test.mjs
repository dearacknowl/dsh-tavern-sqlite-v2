// 退役重写（标准 RPC 通道取代旧 HTTP 路由）：本文件不再 import 已退役的 save-routes.js。
// 旧的 4 条 HTTP 路由用例由 save-handlers.test.mjs 的 10+1 条通道用例覆盖；这里只保留
// "作者侧只保保存服务、普通入口不装 HTTP、装配模板为 bootstrap 三件套" 的轻护栏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const readText = rel => readFileSync(path.join(pluginRoot, rel), 'utf8')
const readJson = rel => JSON.parse(readText(rel))

test('标准RPC：作者只保保存服务且普通入口无HTTP装配', async () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.exports['.'], './plugin.js', 'root exports 必须指向普通 plugin.js')
  assert.equal(pkg.exports['./save-handlers'], './save-handlers.js', '必须导出 save-handlers（7 条 RPC 真实现）')
  assert.equal(pkg.exports['./client'], './client.js', '浏览器半边仍单独导出（callHost 走 tavernUi）')
  assert.equal(Object.keys(pkg.exports).some(key => /save-routes/.test(key)), false, '不得再导出 HTTP 路由模块')
  // 退役后的稳态（主侧删除 save-routes.js 之后成立）：旧 HTTP 入口文件必须不存在
  assert.equal(existsSync(path.join(pluginRoot, 'save-routes.js')), false, '旧 HTTP 路由文件必须已退役')
  // 单源装载：不再声明 profile bundle；浏览器半边由 dsh.client 声明并注入作者 UI 服务
  assert.equal(pkg.dsh?.profile?.bundles, undefined, '不得声明 profile bundle（普通入口 + data/plugins 单源）')
  assert.equal(pkg.dsh?.client?.platform, 'web', '浏览器半边平台声明')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('dsh-tavern-plugin'), '浏览器半边必须注入作者 UI 服务（tavernUi 提供者所在包）')

  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'plugin.js')).href)
  assert.deepEqual([...plugin.inject].sort(), ['commands', 'tavern', 'tavernSaveActions'], '普通入口 inject＝tavern/tavernSaveActions/commands')
  assert.equal(typeof plugin.apply, 'function', '普通入口必须是 apply 形状')

  const handlers = await import(pathToFileURL(path.join(pluginRoot, 'save-handlers.js')).href)
  assert.equal(typeof handlers.registerSaveHandlers, 'function')
  assert.equal(typeof handlers.handlerName, 'function', 'kebab 命名映射必须仍在（与客户端逐字一致）')
  assert.deepEqual(Object.keys(handlers.SAVE_HANDLERS).sort(), [
    'sqliteSaveClaim', 'sqliteSaveComplete', 'sqliteSavePrepare', 'sqliteSaveRecover',
    'sqliteSaveRelease', 'sqliteSaveStatus', 'sqliteVariablesQuery',
  ], '7 条动作白名单固定')

  // 装配模板＝bootstrap 三件套；作者旧条目 disabled；不得再挂 HTTP 路由入口
  const patch = readText('cordis.patch.yml')
  for (const entry of ['./bootstrap/session-persistence.js', './bootstrap/host-patch.js', './bootstrap/standard-host.js']) {
    assert.ok(patch.includes(entry), '装配模板缺 ' + entry)
  }
  assert.ok(/-\s*id:\s*dsh-tavern\b/.test(patch) && patch.includes('disabled: true'), '作者旧条目必须 disabled')
  assert.equal(/name:\s*\.\/save-routes\.js/.test(patch), false, '装配模板不得再挂 HTTP 路由入口')
  assert.ok(/persistedSeams:\s*true/.test(patch), 'legacy 传输形状的 readiness 判据仍真（bootstrap/standard-host 的 persistedSeams）')
})
