import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {linkHostPeersIntoPackage} from '../deploy/maintenance/driver.mjs'

test('宿主tools peer：标准目录声明并链接到现有同物理模块，缺失拒绝', () => {
 const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'))
 assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'],'>=0.1.5-rc.2 <0.2.0')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-tools-peer-'))
 try {
  const host=path.join(root,'runtime'),installed=path.join(root,'plugins','v2')
  for(const name of Object.keys(pkg.peerDependencies)) {
   const dir=path.join(host,'node_modules',...name.split('/'));fs.mkdirSync(dir,{recursive:true})
   fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:'0.1.5-rc.2',main:'index.js'}),'utf8')
   fs.writeFileSync(path.join(dir,'index.js'),'module.exports = {}\n','utf8')
  }
  const linked=linkHostPeersIntoPackage(pkg,{appDir:host},installed,'夹具宿主')
  assert.ok(linked.includes('@deepseek-ai/dsh-tools'))
  const require=createRequire(path.join(installed,'package.json'))
  assert.equal(fs.realpathSync(require.resolve('@deepseek-ai/dsh-tools')),path.join(host,'node_modules','@deepseek-ai','dsh-tools','index.js'))
  assert.throws(()=>linkHostPeersIntoPackage(pkg,{appDir:path.join(root,'missing')},path.join(root,'missing-install')),/缺少宿主 peer/)
 }finally{assert.ok(path.basename(root).startsWith('host-tools-peer-'));fs.rmSync(root,{recursive:true,force:true})}
})
