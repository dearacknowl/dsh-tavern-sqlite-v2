// 公开 API 兼容闸（定向）：只核"兼容文档 ↔ package.json exports ↔ 替代符号在仓内存在"三者一致，
// **不测任何未改行为**（不改运行时、不跑产品路径、不碰真实档/网络/服务）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const doc = fs.readFileSync(new URL('../PUBLIC-API-COMPATIBILITY.md', import.meta.url), 'utf8')
const read = rel => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
const keys = Object.keys(manifest.exports)

test('兼容文档与 package.json exports 一一对应：56 键分类、替代符号在仓内可证', () => {
  assert.equal(keys.length, 56, '公开合同面必须仍是 56 个子路径；增删应同步更新兼容文档与策略')
  for (const key of keys) {
    assert.ok(doc.includes(key === '.' ? '`.`' : key), '兼容文档缺少导出条目：' + key)
  }
  // 分类与计数（文档是退役决定的依据，必须与核查结论一致）
  assert.match(doc, /prod（仓内生产消费者\/根入口\/宿主装配） \| 44/, 'prod 计数必须为 44')
  assert.match(doc, /deploy-only（仅 deploy 动态装配） \| 7/, 'deploy-only 计数必须为 7')
  assert.match(doc, /test-only \| 1 \| `\.\/variable-store`/, './variable-store 必须登记为 test-only')
  assert.match(doc, /zero（仓内零消费者） \| 2 \| `\.\/mvu-script-sandbox`、`\.\/card-script-dispatch-store`/, 'zero 分类必须列出两个子路径')
  assert.match(doc, /infra（解析器基础设施） \| 2 \| `\.\/package\.json`、`\.\/locale\/\*\.json`/, 'infra 必须登记为永久保留')
  for (const key of ['./regeneration-adoption', './legacy-view-seams', './legacy-fork-records', './legacy-source-workspace', './budgets', './conversation-fork-point', './chat-history-rescue']) {
    assert.match(doc, new RegExp('deploy-only[^\\n]*' + key.replace(/[./*]/g, '\\$&')), 'deploy-only 行必须含 ' + key)
  }
  // 替代 API 必须是仓内真实符号（文档不得指向不存在的入口）
  assert.match(read('lib/server-dependencies.js'), /export function createServerDispatchStore/, 'createServerDispatchStore 必须存在于 lib/server-dependencies.js')
  assert.match(read('lib/variable-archive.js'), /export function createVariableArchive/, 'createVariableArchive 必须存在于 lib/variable-archive.js')
  assert.match(read('chat-sqlite-store.js'), /from '\.\/lib\/variable-archive\.js'/, '现役变量链必须仍由 chat-sqlite-store.js 构造')
  assert.match(read('lib/rollback-head-prune.js'), /export (?:async )?function cleanupRollbackHeadIndex/, 'cleanupRollbackHeadIndex 必须存在（该导出仍保留）')
  assert.match(read('deploy/core-host-transform.mjs'), /createServerDispatchStore/, '注入点必须仍是 deploy/core-host-transform.mjs')
  assert.ok(manifest.exports['./mvu-card-runtime'], '现役卡脚本运行时必须仍在 exports 中')
})

test('兼容政策不变量在文档中就位：保留exports、大版本移除、不直接写库、deprecated仅注记', () => {
  assert.ok(doc.includes('本仓零引用 ≠ 无外部消费者'), '必须写明"零引用≠无外部消费者"')
  assert.ok(doc.includes('大版本'), '移除必须绑定大版本流程')
  assert.ok(doc.includes('不直接写库'), '必须明确外部集成不直接写库')
  assert.ok(doc.includes('只做注记'), 'deprecated 必须限定为注记、不改运行时行为')
  assert.ok(/未核[\s\S]*不得删除导出/.test(doc), '未核外部消费者前必须禁止删除导出')
  assert.ok(!/直接使用 variable-archive 写库|用 variable-archive 直接写/.test(doc), '不得推荐外部用 variable-archive 直接写库')
})

console.log('public-api-compatibility: 文档↔exports一致/分类计数/替代符号可证/政策不变量 定向通过')
