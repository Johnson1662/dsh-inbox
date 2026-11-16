import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { legacySpec, loadSourceManifests, spawnSpec } from '../../src/core/sources.js'

function pkg(dir, name, source, extra = {}) {
  const pkgDir = join(dir, name)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { source }, ...extra }))
  return pkgDir
}

test('扫描 node_modules 里的来源声明', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-src-'))
  const telegramDir = pkg(dir, 'dsh-inbox-source-telegram', {
    name: 'telegram', label: 'Telegram', runtime: 'python', entry: 'worker.py',
    fields: [{ key: 'intervalMs', type: 'number', default: 8000 }],
  })
  writeFileSync(join(telegramDir, 'worker.py'), 'print()')
  pkg(dir, 'dsh-inbox-source-imap', { name: 'imap', runtime: 'node', entry: 'worker.js' })
  pkg(dir, 'some-other-plugin', {})                    // 没有 dsh.source
  mkdirSync(join(dir, '.bin'))

  const list = loadSourceManifests({ dirs: [dir] })
  assert.deepEqual(list.map(m => m.name).sort(), ['imap', 'telegram'])

  const telegram = list.find(m => m.name === 'telegram')
  assert.equal(telegram.runtime, 'python')
  assert.equal(telegram.fields.length, 1)
  assert.equal(telegram.present, true, 'entry 存在')
  assert.equal(list.find(m => m.name === 'imap').present, false, 'entry 不存在要标出来')
  rmSync(dir, { recursive: true, force: true })
})

test('runtime 决定怎么起进程，未知 runtime 直接报错', () => {
  assert.equal(spawnSpec({ present: true, runtime: 'python', entry: '/x/w.py' }).command, 'python3')
  assert.equal(spawnSpec({ present: true, runtime: 'node', entry: '/x/w.js' }).command, process.execPath)
  assert.equal(spawnSpec({ present: false, runtime: 'node' }), null)
  assert.throws(() => spawnSpec({ present: true, runtime: 'ruby', name: 'x' }), /只支持 node \/ python/)
})

test('没有声明时退回仓库里的旧路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-legacy-'))
  writeFileSync(join(dir, 'telegram.py'), '')
  assert.equal(legacySpec('telegram', dir).command, 'python3')
  assert.equal(legacySpec('nope', dir), null)
  rmSync(dir, { recursive: true, force: true })
})
