// 采集身份（只读纯函数）：只接受**精确**的 loopback 预加载前缀（旧 perf-probe.cjs 与新 module-probe.cjs），
// 其它 --require 路径不得被剥掉（否则会被误判成已核准 188 酒馆启动）。不启动采集器、不连接任何服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeProfileArgv, PROFILE_PREFIXES} from '../../../tools/collectors/tavern-collector.mjs'

test('采集身份：只接精确模块插针启动且拒绝其他路径', () => {
  // 1) 默认白名单形状：恰好两条 loopback 预加载路径，且分别以 perf-probe.cjs / module-probe.cjs 结尾（不硬编绝对根）
  assert.equal(PROFILE_PREFIXES.length, 2, '默认只允许两条精确预加载路径')
  const tails = PROFILE_PREFIXES.map(entry => entry[2]).sort()
  assert.match(tails[0], /\/module-probe\.cjs$/, '新 adapter 前缀必须精确到 module-probe.cjs')
  assert.match(tails[1], /\/perf-probe\.cjs$/, '旧代 perf-probe.cjs 前缀必须保留兼容')
  for (const entry of PROFILE_PREFIXES) assert.equal(entry[0], '--inspect=127.0.0.1:9229', '只允许 loopback inspect')
  // 2) 纯函数口径：精确前缀被正常化、非精确路径原样保留（后续 readIdentity 会拒）
  const root = '/root/tavern-clean/home/apps/dsh-tavern/tools/collectors'
  const home = '/root/tavern-clean/home'
  const expected = ['/usr/bin/node', home + '/runtime/bin/dsh', '--profile', 'tavern', '--host', '127.0.0.1', '--port', '3081', '--no-open']
  const prefixes = [['--inspect=127.0.0.1:9229', '--require', root + '/perf-probe.cjs'], ['--inspect=127.0.0.1:9229', '--require', root + '/module-probe.cjs']]
  for (const probe of ['perf-probe.cjs', 'module-probe.cjs']) {
    const argv = [expected[0], '--inspect=127.0.0.1:9229', '--require', root + '/' + probe, ...expected.slice(1)]
    assert.deepEqual(normalizeProfileArgv(argv, prefixes), expected, probe + ' 精确前缀必须被正常化（兼容旧代与新 adapter）')
    const withVm = [expected[0], '--experimental-vm-modules', '--inspect=127.0.0.1:9229', '--require', root + '/' + probe, ...expected.slice(1)]
    assert.deepEqual(normalizeProfileArgv(withVm, prefixes), [expected[0], ...expected.slice(1)], probe + ' 带 --experimental-vm-modules 时同样正常化')
  }
  assert.deepEqual(normalizeProfileArgv([expected[0], '--inspect=127.0.0.1:9229', ...expected.slice(1)], prefixes), expected, '只有 inspect（无预加载）仍按原口径接受')
  for (const bad of [root + '/evil-probe.cjs', home + '/tools/collectors/module-probe.cjs', '/tmp/module-probe.cjs']) {
    const argv = [expected[0], '--inspect=127.0.0.1:9229', '--require', bad, ...expected.slice(1)]
    assert.notDeepEqual(normalizeProfileArgv(argv, prefixes), expected, '非精确路径必须保留原样（readIdentity 会拒）：' + bad)
  }
})
