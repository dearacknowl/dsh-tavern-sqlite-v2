// 新 bootstrap 就绪依赖（本轮新路径）：只验"共享宿主句柄 ready 才 provide 放行、失败不放行"，不跑安装/网络/业务方法。
// 真身：bootstrap/host-patch.js 的 apply 与 lib/host-session-install.js 的 installSharedHostSessionPatch（均为真实现，未改）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
const runtimeRequire=createRequire(path.join(process.env.DSH_TAVERN_TEST_DESKTOP_RUNTIME || 'D:/Program Files (x86)/DSH-Tavern/runtime-9be856025c1522cb-setup7-5ae29095747f4f4a9fc3f12a68611fd7/resources/app','package.json'))
const sessionModuleUrl=pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-session')).href
registerHooks({resolve(spec,context,next){return spec==='@deepseek-ai/dsh-session'?next(sessionModuleUrl,context):next(spec,context)}})

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const HOST_SESSION_PATCH = Symbol.for('dsh-tavern.host-session-patch.v1')
const { apply: applyBootstrap } = await import(pathToFileURL(path.join(pluginRoot, 'bootstrap', 'host-patch.js')).href)
const { installSharedHostSessionPatch } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'host-session-install.js')).href)

/** 真 host-patch.js 需要的 controller 契约形状（只提供方法/映射，不执行业务）。 */
function controllerFixture() {
  const calls = []
  return {
    calls,
    history: {
      promote: async (...args) => { calls.push(['promote', args.length]); return { promoted: true } },
      assistantStreams: new Map(),
    },
    agents: {
      resolve: (...args) => { calls.push(['resolve', args.length]); return { sessionId: 'x' } },
      ensure: async (...args) => { calls.push(['ensure', args.length]); return {} },
      // 真 host-patch.js 的 directResumes 必需名（不是 ensure）：ensureSession
      ensureSession: async (...args) => { calls.push(['ensureSession', args.length]); return {} },
      resume: async (...args) => { calls.push(['resume', args.length]); return {} },
      resumeObserved: async (...args) => { calls.push(['resumeObserved', args.length]); return {} },
      createOrAdopt: async (...args) => { calls.push(['createOrAdopt', args.length]); return {} },
    },
    controlState: {
      ctx: { sessionProjections: { snapshot: () => null } },
      broadcast() {},                       // 同连接 control 广播（真 host-patch 断言为函数）
      jobsFor: () => [],                    // 同连接作业视图（同上）
    },
  }
}

function ctxFixture({ persistence, query, controller = controllerFixture() } = {}) {
  const provided = new Map()
  const disposers = []
  const services = { sessionController: controller, sessionPersistence: persistence, sessionQuery: query }
  const ctx = {
    get: name => services[name],
    provide(name, value) {
      provided.set(name, value)
      const dispose = () => provided.delete(name)
      disposers.push(dispose)
      return dispose
    },
    effect(effect) {
      const dispose = effect()
      assert.equal(typeof dispose, 'function', 'ctx.effect 必须拿到 disposer')
      disposers.push(dispose)
      return dispose
    },
    logger: { warn() {}, info() {}, error() {} },
  }
  return { ctx, provided, disposers }
}

test('标准启动依赖：共享宿主句柄ready才放行且失败不提供ready', async () => {
  const ran = []
  // ① 已由别处安装且 ready：真 apply 必须放行并提供 tavernStorageBootstrapReady
  const readyHandle = { serverReady: true, status: 'ready', reason: '', dispose() { ran.push('ready-dispose') } }
  const readyPersistence = { [HOST_SESSION_PATCH]: readyHandle, kind: 'sessionPersistence' }
  const a = ctxFixture({ persistence: readyPersistence, query: {} })
  try {
    await applyBootstrap(a.ctx, {})
    assert.equal(a.provided.get('tavernStorageBootstrapReady'), true, 'ready 才允许 provide 启动依赖')
  } finally { for (const dispose of a.disposers.reverse()) dispose() }
  assert.deepEqual(ran, ['ready-dispose'], 'host-patch 的 ctx.effect 释放必须真调用已装句柄 dispose（既有合同，成功路径 1 次）')

  // ② 共享入口幂等：同一 persistence 再调 installShared 必须拿到**同一个** handle 对象（不重复安装、不谎报）
  const shared1 = await installSharedHostSessionPatch({ ctx: a.ctx })
  const shared2 = await installSharedHostSessionPatch({ ctx: a.ctx })
  assert.equal(shared1, readyHandle, '必须如实返回已装句柄本身')
  assert.equal(shared2, shared1, '重复调用必须是同一实例（===）')

  // ③ 失败：serverReady=false ⇒ 真 apply 抛错且**不提供** ready（不能"false 就放行"作者）
  const failedPersistence = { [HOST_SESSION_PATCH]: { serverReady: false, status: 'failed', reason: '测试未就绪' } }
  const b = ctxFixture({ persistence: failedPersistence, query: {} })
  try {
    await assert.rejects(() => applyBootstrap(b.ctx, {}), error => /宿主补丁未就绪/.test(String(error?.message)) && /测试未就绪/.test(String(error?.message)))
    assert.equal(b.provided.has('tavernStorageBootstrapReady'), false, '未就绪时不得提供启动依赖')
  } finally { for (const dispose of b.disposers.reverse()) dispose() }

  // ④ 缺服务（无 persistence/query）：真共享入口必须抛错（覆盖 no-query），更不得 provide
  const c = ctxFixture({})
  try {
    await assert.rejects(() => installSharedHostSessionPatch({ ctx: c.ctx }), error => /缺少 sessionPersistence \/ sessionQuery/.test(String(error?.message)))
    assert.equal(c.provided.has('tavernStorageBootstrapReady'), false, '缺服务不得提供启动依赖')
  } finally { for (const dispose of c.disposers.reverse()) dispose() }
})
