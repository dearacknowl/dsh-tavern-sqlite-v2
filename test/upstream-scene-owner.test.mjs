// 最新上游（f3/2.5.0）：导入图库的 scene 记录必须带**目标双身份**，且不得携带源档审计/上下文。
// 走真实链路 capture → validate → install；profileData 为自有 temp 真实文件，读回一律 readFileSync（不用内存 Map 冒充）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDbSaveResourceTransfer } from '../lib/db-save-resource-transfer.js'

const sha256 = value => createHash('sha256').update(String(value)).digest('hex')
const keyFor = (chatId, turn, text) => sha256(chatId + ':' + turn + ':' + text)
const ref = id => ({ attachmentId: id, mediaType: 'image/png', width: 8, height: 8, bytes: 3, name: 'a.png' })

test('最新上游：导入图库采用目标双身份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-scene-owner-'))
  const abs = path => join(dir, path.replaceAll('/', '__'))
  const sourceText = '第一段正文'
  const sourceKey = keyFor('chat-a', 1, sourceText)
  // 源记录：带审计/已删字段与**源档**上下文 ⇒ 必须被 capture 归一化剔除，不得进 bundle/目标记录
  const sourceRecord = {
    key: sourceKey, turn: 1, status: 'succeeded',
    diagnosticContext: { chatId: 'chat-a', sessionId: 'session-a' },
    diagnostics: { refs: [ref('att-audit')] },
    deletedVersions: [{ attachment: ref('att-gone') }],
    versions: [{ id: 'v1', attachment: ref('att-1'), prompt: '海边' }],
  }
  const sourceBytes = Buffer.from(JSON.stringify(sourceRecord))
  const sourceFilePath = join(dir, 'source-record.json')      // 源原件落在本测试自有 temp，用于事后核字节不变
  writeFileSync(sourceFilePath, sourceBytes)
  const sourceChat = {
    id: 'chat-a', sessionId: 'session-a', mode: 'story', cardPath: 'cards/卡.json', cardName: '卡',
    cardDefinitionSnapshot: { raw: { name: '卡' }, name: '卡' },
    workspace: { mountedResources: [{ kind: 'card', path: 'cards/卡.json' }, { kind: 'source', path: 'materials/剧本.txt' }] },
    messages: [{ role: 'assistant', turn: 1, text: sourceText }],
  }
  const savedImages = []
  const profileData = {
    writeBytes: async (path, data) => { writeFileSync(abs(path), Buffer.from(data)) },
    version: async path => (existsSync(abs(path)) ? '1' : ''),
    remove: async path => { if (existsSync(abs(path))) unlinkSync(abs(path)) },
  }
  const deps = {
    fileResources: {
      scriptForCard: async () => 'materials/剧本.txt',
      importText: async (kind, payload) => 'materials/' + payload.name,
      bindMaterial: async (cardPath, materialPath) => materialPath,
      remove: async () => {},
      unbindMaterial: async () => {},
    },
    profileData,
    gameFootprint: {
      readSceneFiles: async () => [{ path: sourceKey + '.json', content: sourceBytes }],
      readSceneWorldbook: async () => Buffer.from('{"entries":[]}'),
    },
    attachments: {
      saveImage: async input => { savedImages.push(input); return { attachmentId: 'sha256:' + sha256(Buffer.from(input.data).toString('base64')), mediaType: input.mediaType, width: 8, height: 8, bytes: input.data.length } },
      readImage: async () => ({ ref: ref('att-1'), data: new Uint8Array([1, 2, 3]) }),
    },
    readChatCard: async () => ({ name: '卡', pic: { attachment: ref('att-1') } }),
    importCard: async payload => ({ path: 'cards/' + payload.name }),
    computeSceneTarget: (target, turn) => ({ key: keyFor(target.id, turn, String((target.messages || []).find(message => message.turn === turn)?.text || '')) }),
    validateCard: async payload => ({ raw: JSON.parse(payload.text), definition: { name: '卡' } }),
  }
  const transfer = createDbSaveResourceTransfer(deps)
  try {
    // 真实链路：capture → validate（安装只接受校验过的 bundle）
    const window = await transfer.capture({ chat: sourceChat, tables: {}, nativeEvents: [] })
    const bundle = await transfer.validate({ files: window.files, chat: sourceChat, tables: {}, nativeEvents: [] })
    // ① 归一化后的 bundle 不含源审计/上下文，且附件闭包只有 att-1
    assert.deepEqual(bundle.attachments.map(item => item.attachmentId), ['att-1'], '附件闭包只应含 att-1')
    const bundleSceneText = JSON.stringify(bundle.sceneFiles)
    assert.equal(bundleSceneText.includes('att-audit'), false, 'bundle.sceneFiles 不得含源 diagnostics 审计')
    assert.equal(bundleSceneText.includes('att-gone'), false, 'bundle.sceneFiles 不得含源 deletedVersions')
    assert.equal(bundleSceneText.includes('diagnosticContext'), false, 'bundle.sceneFiles 不得携带源 diagnosticContext')
    const before = readFileSync(sourceFilePath)
    const result = await transfer.install(bundle, sourceChat, { chatId: 'target-chat', sessionId: 'target-session' })
    assert.ok(result.cardPath, '安装必须返回新卡路径')
    // ② 真写盘：按目录实际筛出 scene 文件，逐个 readFileSync 回读（不用内存 Map）
    const sceneNames = readdirSync(dir).filter(name => name.startsWith('scene-images__') && !name.includes('worldbooks'))
    assert.equal(sceneNames.length, 1, '必须且只写 1 个目标 scene 文件')
    assert.ok(existsSync(join(dir, sceneNames[0])), '目标 scene 文件必须真实存在')
    const targetText = readFileSync(join(dir, sceneNames[0]), 'utf8')
    const targetRecord = JSON.parse(targetText)
    // ③ 目标双身份（本次改动）
    assert.deepEqual(targetRecord.diagnosticContext, { chatId: 'target-chat', sessionId: 'target-session' }, '诊断上下文必须是目标双身份')
    // ④ 不携带源审计/源身份
    assert.equal(targetText.includes('att-audit'), false, '目标记录不得含源 diagnostics 审计')
    assert.equal(targetText.includes('att-gone'), false, '目标记录不得含源 deletedVersions')
    assert.equal(targetText.includes('session-a'), false, '目标记录不得残留源会话身份')
    // ⑤ 版本保留且引用已重绑为新附件
    assert.equal(targetRecord.versions.length, 1, '图片版本必须保留')
    assert.ok(targetRecord.versions[0].attachment?.attachmentId, '版本必须仍带 attachment 引用')
    assert.equal(savedImages.length, 1, '本局图片必须经 saveImage 重新登记')
    // ⑥ 源原件字节不变
    assert.equal(readFileSync(sourceFilePath).equals(before), true, '源记录字节不得被改写')
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }) } catch { /* Windows EPERM */ }
  }
})
