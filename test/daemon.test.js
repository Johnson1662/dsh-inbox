import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDaemon } from '../src/daemon/index.js'

// 清理注册到测试上下文：断言失败也要收掉监听，否则进程退不出去
async function start(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-daemon-'))
  const daemon = createDaemon(
    {
      stateDir: dir,
      http: { token: 'test-token' },
      routes: [{ sources: ['*'], sink: 'chief' }],
      credentials: { chats: ['777000'], patterns: ['验证码'] },
    },
    { log: () => {} },
  )
  const port = await daemon.listen(0)
  t.after(async () => {
    await daemon.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    daemon,
    base: `http://127.0.0.1:${port}`,
    post: (path, body, token = 'test-token') =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    get: (path, token = 'test-token') =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
  }
}

const event = {
  source: 'manual',
  at: '2026-11-14T19:40:00+08:00',
  actor: 'self',
  text: '明天上午取体检报告',
  meta: { from: '手机快捷指令' },
}

test('health 不需要 token', async t => {
  const s = await start(t)
  const response = await s.get('/v1/health', null)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
})

test('没有 token 一律 401', async t => {
  const s = await start(t)
  assert.equal((await s.post('/v1/event', event, '')).status, 401)
  assert.equal((await s.get('/v1/stats', 'wrong')).status, 401)
})

test('curl 一条落库，重复提交只标记 duplicate', async t => {
  const s = await start(t)
  const first = await (await s.post('/v1/event', event)).json()
  assert.equal(first.duplicate, false)
  const second = await (await s.post('/v1/event', event)).json()
  assert.equal(second.duplicate, true)
  assert.equal((await (await s.get('/v1/stats')).json()).pending, 1)
})

test('非法信封被拒且不落库', async t => {
  const s = await start(t)
  const response = await s.post('/v1/event', { at: '2026-11-14T19:40:00+08:00' })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'missing_source')
  assert.equal((await (await s.get('/v1/stats')).json()).pending, 0)
})

test('凭据命中：正文不入库，只留定位', async t => {
  const s = await start(t)
  await s.post('/v1/event', { source: 'telegram', at: '2026-11-14T19:40:00+08:00', text: '你的验证码是 839201' })
  const [row] = s.daemon.queue.take('chief', 10)
  assert.equal(row.text, '')
  assert.equal(row.meta.redacted, true)
})
