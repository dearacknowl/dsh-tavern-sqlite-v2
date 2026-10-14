// 当前作者源（跨机器显式根）：env DSH_TAVERN_TEST_APP 优先（必须是含 tavern-plugin/ 的 app root），
// 否则回落到本地冻结的 **428** 源；**不**回落到 682 等其它代（不同 generation 不得冒充当前源）。
// 只读文本：不复制有限树、不施缝、不写盘、不造哈希/身份层；失败按 rel 缓存同一 error。
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const LOCAL_CURRENT_AUTHOR_ROOT = path.resolve(HERE, '../../../../tmp/upstream-construction-20261010-42852b0/dsh-tavern-42852b0d160fc8d165faf291ddc779b71fc429ef')

/** 当前源需要的三个文件（rel 带 tavern-plugin/ 前缀，与接缝键一致）。 */
export const CURRENT_AUTHOR_FILES = Object.freeze({
  index: 'tavern-plugin/lib/index.js',
  playControls: 'tavern-plugin/src/client/features/play-controls.js',
  turnErrorControls: 'tavern-plugin/src/client/turn-error-controls.js',
})
const ALLOWED = Object.freeze(Object.values(CURRENT_AUTHOR_FILES))

let rootCache = null
let rootError = null
const textCache = new Map()
const errorCache = new Map()

/** 显式来源：env（合法 app root）优先，其次本地 428 源；两者都不可用即响亮失败（不 skip、不假 pass）。 */
export function getCurrentAuthorSourceRoot() {
  if (rootError !== null) throw rootError
  if (rootCache !== null) return rootCache
  const raw = typeof process.env.DSH_TAVERN_TEST_APP === 'string' ? process.env.DSH_TAVERN_TEST_APP.trim() : ''
  // env 显式指定就按 env 判：不合法即响亮抛错，**不静默回落到本地 428 源**（避免把别的代当当前源）。
  if (raw) {
    const candidate = path.resolve(raw)
    if (!existsSync(path.join(candidate, 'tavern-plugin', 'lib', 'index.js'))) {
      rootError = new Error('DSH_TAVERN_TEST_APP 指向的作者根不含 tavern-plugin/lib/index.js（不静默回落）：' + candidate)
      throw rootError
    }
    rootCache = candidate
    return rootCache
  }
  // 未设 env：本地冻结 428 源即默认（仍不做任何复制/施缝）。
  if (existsSync(path.join(LOCAL_CURRENT_AUTHOR_ROOT, 'tavern-plugin', 'lib', 'index.js'))) {
    rootCache = LOCAL_CURRENT_AUTHOR_ROOT
    return rootCache
  }
  rootError = new Error('缺少当前作者源：设 DSH_TAVERN_TEST_APP（含 tavern-plugin/ 的 app root）或准备本地 428 源：' + LOCAL_CURRENT_AUTHOR_ROOT)
  throw rootError
}

/** 读当前作者源文本（只允许受管三文件；同 rel 只读盘一次，失败也缓存同一 error）。 */
export function readCurrentAuthorSource(rel) {
  if (!ALLOWED.includes(rel)) throw new Error('当前作者源只允许读取受管文件：' + rel)
  if (errorCache.has(rel)) throw errorCache.get(rel)
  if (textCache.has(rel)) return textCache.get(rel)
  try {
    const file = path.join(getCurrentAuthorSourceRoot(), ...rel.split('/'))
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error('当前作者源缺文件：' + rel + '（根：' + getCurrentAuthorSourceRoot() + '）')
    const text = readFileSync(file, 'utf8')
    textCache.set(rel, text)
    return text
  } catch (error) {
    errorCache.set(rel, error)
    throw error
  }
}
