import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDaemon } from '../src/daemon/index.js'
import { normalize } from '../src/core/envelope.js'

/**
 * 对外契约的护栏。
 *
 * README 上有两处承诺：信封的字段，和 `take / done / retry` 三个动作的返回形状。
 * 有人改了其中任何一处，这份用例必须红，并且逼他去写 ADR——而不是让第三方
 * 适配器在下一个版本里静默坏掉。
 */

async function withDaemon(run) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-contract-'))
  const daemon = createDaemon({
    stateDir: dir,
    http: { listen: '127.0.0.1:0' },
    delivery: { intervalMs: 20 },
    routes: [{ sources: ['*'], sink: 'chief' }],
    credentials: { chats: [], patterns: [] },
    sources: {},
  })
  const port = await daemon.listen()
  try {
    await run({ port, daemon })
  } finally {
    await daemon.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const call = (port, token, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const envelope = {
  id: 'manual:1',
  source: 'manual',
  at: '2026-11-15T09:00:00+08:00',
  actor: 'other',
  text: '正文',
  ref: 'blobs/2026/11/15/0900.json',
  meta: { chat: '产品群', sender: '张三' },
}

test('信封：字段表与 README 一致，多一个少一个都算破坏契约', () => {
  const normalized = normalize(envelope)
  assert.deepEqual(Object.keys(normalized).sort(), ['actor', 'at', 'id', 'meta', 'source', 'text'])

  // 必填三个：source / at / actor（缺省 other）；id 可推导
  assert.equal(normalize({ ...envelope, source: '' }).error, 'missing_source')
  assert.equal(normalize({ ...envelope, at: '2026-11-15 09:00' }).error, 'invalid_at')
  assert.equal(normalize({ ...envelope, actor: 'robot' }).error, 'invalid_actor')
  assert.equal(normalize({ ...envelope, id: undefined }).id, normalize({ ...envelope, id: undefined }).id)
  assert.match(normalize({ ...envelope, id: undefined }).id, /^manual:[0-9a-f]{16}$/)
})

test('take：返回 ticket / events / backlog，事件字段固定', async () => {
  await withDaemon(async ({ port, daemon }) => {
    await call(port, daemon.token, '/v1/event', envelope)

    const taken = await (await call(port, daemon.token, '/v1/take', { sink: 'chief', limit: 50 })).json()
    assert.deepEqual(Object.keys(taken).sort(), ['backlog', 'events', 'expiresAt', 'ticket'])
    assert.equal(taken.events.length, 1)
    assert.deepEqual(
      Object.keys(taken.events[0]).sort(),
      ['actor', 'at', 'attempts', 'id', 'meta', 'source', 'text'],
    )
    assert.equal(taken.events[0].text, envelope.text)
  })
})

test('done / retry：只回计数，不多不少', async () => {
  await withDaemon(async ({ port, daemon }) => {
    await call(port, daemon.token, '/v1/event', envelope)
    const taken = await (await call(port, daemon.token, '/v1/take', { sink: 'chief' })).json()

    const done = await (await call(port, daemon.token, '/v1/done', { ticket: taken.ticket, ids: [envelope.id] })).json()
    assert.deepEqual(Object.keys(done).sort(), ['delivered', 'released'])
    assert.equal(done.delivered, 1)

    await call(port, daemon.token, '/v1/event', { ...envelope, id: 'manual:2' })
    const second = await (await call(port, daemon.token, '/v1/take', { sink: 'chief' })).json()
    const retried = await (await call(port, daemon.token, '/v1/retry', { ticket: second.ticket, reason: 'boom' })).json()
    assert.deepEqual(Object.keys(retried).sort(), ['ids', 'released'])
  })
})

test('错误码：401 / 400 / 404 的语义不许漂移', async () => {
  await withDaemon(async ({ port, daemon }) => {
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/sinks`)
    assert.equal(noAuth.status, 401)

    const badJson = await fetch(`http://127.0.0.1:${port}/v1/event`, {
      method: 'POST',
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(badJson.status, 400)
    assert.equal((await badJson.json()).error, 'invalid_json')

    const noTicket = await call(port, daemon.token, '/v1/done', {})
    assert.equal(noTicket.status, 400)
    assert.equal((await noTicket.json()).error, 'missing_ticket')

    const wrongPath = await call(port, daemon.token, '/v1/nope', {})
    assert.equal(wrongPath.status, 404)
  })
})

test('健康检查不需要鉴权，且只回两个字段', async () => {
  await withDaemon(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(await response.json()).sort(), ['ok', 'queue'])
  })
})
