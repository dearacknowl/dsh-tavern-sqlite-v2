// 安装入口单源闸（定向）：包内二入口/外部发行件同源渲染 + 版本/URL/SHA 语义 + 源码树 wrapper 只读当前 manifest/bootstrap。
// 全部在本次自建临时目录或只读真实产品文件上做；不联网、不构建、不装包、不碰酒馆与服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  installShInputs, renderInstallSh, assertInstallShSemantics, installShBody, localInstallEntrySh,
  PACK_INSTALL_ENTRIES, PLACEHOLDER_URL, PLACEHOLDER_SHA256, PLACEHOLDER_VERSION, HEREDOC_OPEN,
} from '../scripts/render-install-sh.mjs'

const product = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const readEntry = rel => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
const normalizePath = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '')
const samePath = (left, right) => process.platform === 'win32'
  ? normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase()
  : normalizePath(left) === normalizePath(right)

test('安装入口单源：包内二入口与外部install.sh同源渲染，版本/URL/SHA语义受闸', () => {
  const inputs = installShInputs(product)
  assert.equal(inputs.version, manifest.version, '渲染输入必须取当前 manifest 版本')
  const pack = renderInstallSh({ ...inputs })
  // 包内形态：版本具体、地址/摘要占位（内嵌本次 tgz 摘要会自引用）。
  assert.equal(pack.includes("VERSION='" + manifest.version + "'\n"), true)
  assert.equal(pack.includes(PLACEHOLDER_URL), true)
  assert.equal(pack.includes(PLACEHOLDER_SHA256), true)
  assert.equal(installShBody(pack), inputs.bootstrap, '渲染件内嵌体必须与获取器源逐字节一致')
  assert.equal(pack.includes(PLACEHOLDER_VERSION), false)
  // 外部形态：同一渲染器只多地址与摘要一次；合成摘要只测语义，不哈希任何构件。
  const url = 'https://github.com/example/fixture/releases/download/v' + manifest.version + '/dsh-tavern-sqlite-v2-' + manifest.version + '.tgz'
  const digest = 'a'.repeat(64)
  const release = renderInstallSh({ ...inputs, url, sha256: digest })
  assert.equal(release.includes(PLACEHOLDER_URL), false)
  assert.equal(release.includes(PLACEHOLDER_SHA256), false)
  assert.equal(release.includes("RELEASE_URL='" + url + "'\n"), true)
  assert.equal(release.includes("RELEASE_SHA256='" + digest + "'\n"), true)
  const packLines = pack.split('\n'), releaseLines = release.split('\n')
  assert.equal(packLines.length, releaseLines.length, '两形态行数必须一致（只换两个字段值）')
  assert.equal(packLines.filter((line, i) => line !== releaseLines[i]).length, 2, '包内与发行件只允许 URL、SHA 两行不同')
  // 语义闸必须能拒：占位版本、半填地址/摘要、拿包内形态冒充发行形态、内嵌体漂移。
  assert.throws(() => renderInstallSh({ ...inputs, version: PLACEHOLDER_VERSION }), /版本/)
  assert.throws(() => renderInstallSh({ ...inputs, url }), /同为占位或同为发行值/)
  assert.throws(() => renderInstallSh({ ...inputs, url, sha256: 'A'.repeat(64) }), /同为占位或同为发行值/)
  assert.throws(() => assertInstallShSemantics(pack, { version: manifest.version, url, sha256: digest }), /不一致/)
  assert.throws(() => assertInstallShSemantics(pack, { version: manifest.version, bootstrap: inputs.bootstrap + '// drift\n' }), /不同文本/)
})

test('源码树两入口为本地wrapper：无内嵌获取器/无固定版本与URL，只读当前manifest与bootstrap', () => {
  const wrapper = localInstallEntrySh()
  for (const rel of PACK_INSTALL_ENTRIES) {
    const text = readEntry(rel)
    assert.equal(text, wrapper, rel + ' 必须与本模块给出的唯一文本逐字一致（单源）')
    assert.equal(text.includes(HEREDOC_OPEN), false, rel + ' 不得内嵌获取器副本')
    assert.equal(/VERSION='/.test(text), false, rel + ' 不得写死版本号')
    assert.equal(/__DSH_RELEASE_(URL|SHA256|VERSION)__/.test(text), false, rel + ' 不得留发布占位符')
    assert.equal(/dsh-tavern-sqlite-v2-[0-9]/.test(text), false, rel + ' 不得写死某代 tgz/URL')
    assert.equal(text.includes('deploy/bootstrap.mjs'), true, rel + ' 必须指向当前获取器源')
    assert.equal(text.includes('--package'), true, rel + ' 未显式 --package 时须补当前包目录')
    // 旧"只换版本"的内嵌件不得再冒充单源入口。
    assert.throws(() => assertInstallShSemantics(text, { version: manifest.version }), /VERSION|heredoc/, rel + ' 旧内嵌形态必须被语义闸拒绝')
  }
  assert.equal(readEntry('install.sh'), readEntry('deploy/install.sh'), '源码树两入口必须同文本')
})

test('构建器同源写包内二入口与外部件，且拒绝包内自嵌tgz摘要（静态合同）', () => {
  const text = fs.readFileSync(new URL('../scripts/build-release.mjs', import.meta.url), 'utf8')
  assert.match(text, /import\('\.\/render-install-sh\.mjs'\)/, '构建器必须从同一渲染器导入')
  assert.match(text, /renderInstallSh\(\{ \.\.\.installInputs \}\)/, '包内形态必须由渲染器产出')
  assert.match(text, /renderInstallSh\(\{ \.\.\.installInputs, url, sha256: digest \}\)/, '发行件必须用同一渲染器只多地址与摘要')
  assert.match(text, /assertInstallShSemantics\(releaseShell/, '发行件必须过版本/URL/SHA 语义闸')
  assert.match(text, /PACK_INSTALL_ENTRIES/, '包内二入口必须共用同一清单')
  assert.match(text, /embedded\.includes\(digest\)/, '必须拒绝包内自嵌本次 tgz 摘要')
  assert.equal((text.match(/digest = createHash/g) || []).length, 1, '本次 tgz 摘要只算一次')
  assert.equal((text.match(/const releaseShell = renderInstallSh/g) || []).length, 1, '发行件只用同一次摘要渲染一次')
  assert.equal(/template\.replace\('__DSH_RELEASE_URL__'/.test(text), false, '不得再手工拼装发行 SH')
  assert.equal(text.includes("template.replace('__DSH_RELEASE_VERSION__'"), false, '不得再手工替换版本占位')
})

test('源码入口wrapper按包身份定位并透传参数（假获取器，无网络/服务）', () => {
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' })
  assert.equal(bash.status, 0, 'Git Bash 不可用，不能冒称 wrapper 已验证')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-install-entry-'))
  try {
    const fixture = path.join(root, 'pkg'), deploy = path.join(fixture, 'deploy')
    fs.mkdirSync(deploy, { recursive: true })
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'dsh-tavern-sqlite-v2', version: '0.0.0-fixture' }) + '\n', 'utf8')
    // 假获取器：只打印收到的 argv，绝不联网、不装包、不碰酒馆。
    fs.writeFileSync(path.join(deploy, 'bootstrap.mjs'), "console.log('FIXTURE_BOOTSTRAP ' + JSON.stringify(process.argv.slice(2)))\n", 'utf8')
    for (const rel of PACK_INSTALL_ENTRIES) fs.writeFileSync(path.join(fixture, rel), localInstallEntrySh(), 'utf8')
    const run = (args, input) => spawnSync('bash', ['-c', 'exec sh "$@"', 'v2-entry', ...args],
      { input, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8', timeout: 15000 })
    const argvOf = stdout => JSON.parse(stdout.slice(stdout.indexOf('[')))
    // ① 包内 deploy 入口：按自身位置定位本包并补 --package，不改用户参数
    const direct = run([normalizePath(path.join(deploy, 'install.sh')), 'install', '--home', '/fixture/home'])
    assert.equal(direct.status, 0, direct.stderr)
    assert.match(direct.stdout, /FIXTURE_BOOTSTRAP/)
    const directArgv = argvOf(direct.stdout)
    assert.deepEqual(directArgv.slice(0, -2), ['install', '--home', '/fixture/home'])
    assert.equal(directArgv.at(-2), '--package')
    assert.ok(samePath(directArgv.at(-1), fixture), '补的必须是本次定位到的包目录：' + directArgv.at(-1))
    // ② 根入口（同文本）：同样定位，动作原样
    const fromRoot = run([normalizePath(path.join(fixture, 'install.sh')), 'uninstall'])
    assert.equal(fromRoot.status, 0, fromRoot.stderr)
    const rootArgv = argvOf(fromRoot.stdout)
    assert.deepEqual(rootArgv.slice(0, -2), ['uninstall'])
    assert.ok(samePath(rootArgv.at(-1), fixture), '根入口同样按自身位置定位：' + rootArgv.at(-1))
    // ③ 管道模式（$0 无路径）+ 显式 --package：不得覆盖或重复补
    const piped = run(['-s', '--', 'install', '--package', fixture], localInstallEntrySh())
    assert.equal(piped.status, 0, piped.stderr)
    assert.deepEqual(argvOf(piped.stdout), ['install', '--package', fixture], '用户显式 --package 不得被覆盖或重复')
    // ④ 非本包目录：拒绝并给可操作提示，绝不执行外来获取器
    const foreign = path.join(root, 'foreign'), foreignDeploy = path.join(foreign, 'deploy')
    fs.mkdirSync(foreignDeploy, { recursive: true })
    fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ name: 'dsh-tavern-sqlite-v1', version: '1.0.0' }) + '\n', 'utf8')
    fs.writeFileSync(path.join(foreignDeploy, 'bootstrap.mjs'), 'console.log("SHOULD_NOT_RUN")\n', 'utf8')
    fs.writeFileSync(path.join(foreign, 'install.sh'), localInstallEntrySh(), 'utf8')
    const bad = run([normalizePath(path.join(foreign, 'install.sh')), 'install'])
    assert.notEqual(bad.status, 0, '外来同名目录不得被认领')
    assert.equal(bad.stdout.includes('SHOULD_NOT_RUN'), false, '不得执行外来获取器')
    assert.match(bad.stderr, /未定位本插件包/)
  } finally {
    assert.ok(path.basename(root).startsWith('v2-install-entry-'), '只清理本次自建临时目录')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

console.log('install-entry-single-source: 渲染语义/源码wrapper单源/构建器合同/wrapper定位透传 定向通过')
