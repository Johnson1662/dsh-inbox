import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { listBots, routesFromTargets, targetOfSource } from '../src/plugin/targets.js'

test('列出有 sessionId 的 bot，按名字排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bots-'))
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify({
    bots: {
      'session-a': { name: 'Chief', role: '总管', sessionId: 'session-a' },
      'session-b': { name: 'QA', sessionId: 'session-b' },
      'session-c': { name: '空壳', sessionId: null },
    },
  }))
  const bots = listBots(path)
  assert.deepEqual(bots.map(b => b.name), ['Chief', 'QA'])
  assert.equal(bots[0].id, 'session-a')
  rmSync(dir, { recursive: true, force: true })
})

test('文件不存在或坏掉时返回空数组，不抛', () => {
  assert.deepEqual(listBots('/nope/state.json'), [])
  const dir = mkdtempSync(join(tmpdir(), 'pc-bots-bad-'))
  const path = join(dir, 'state.json')
  writeFileSync(path, '{不是 json')
  assert.deepEqual(listBots(path), [])
  rmSync(dir, { recursive: true, force: true })
})

test('每个来源指向哪个会话：取第一条匹配规则', () => {
  const routes = [
    { sources: ['telegram'], sink: 'session-a' },
    { sources: ['feishu'], sink: 'session-b' },
    { sources: ['*'], sink: 'session-a' },
  ]
  assert.equal(targetOfSource(routes, 'telegram'), 'session-a')
  assert.equal(targetOfSource(routes, 'feishu'), 'session-b')
  assert.equal(targetOfSource(routes, 'manual'), 'session-a', '没人认领就走兜底')
  assert.equal(targetOfSource([], 'telegram'), '', '没有规则就是空')
})

test('由映射生成 routes，末尾一定有兜底', () => {
  const routes = routesFromTargets({ telegram: 'session-a', feishu: '', manual: 'session-b' })
  assert.deepEqual(routes, [
    { sources: ['telegram'], sink: 'session-a' },
    { sources: ['manual'], sink: 'session-b' },
    { sources: ['*'], sink: 'session-a' },
  ])
})

test('一个都没选时不给兜底，让调用方自己报错', () => {
  assert.deepEqual(routesFromTargets({ telegram: '' }), [])
})
