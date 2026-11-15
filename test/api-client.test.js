import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDaemon } from '../src/daemon/index.js'
import { createApiClient } from '../src/plugin/api-client.js'

/**
 * 契约测试：一个外部适配器只用三个 HTTP 动作，就能把队列投空。
 * 这个文件就是"别人接自己 agent"的最小样张——不 import 任何队列代码。
 */
async function withStack(run) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-api-'))
  const daemon = createDaemon({
    stateDir: dir,
    http: { listen: '127.0.0.1:0' },
    delivery: { intervalMs: 20, sink: 'chief' },
    routes: [{ sources: ['*'], sink: 'chief' }],
    credentials: { chats: [], patterns: [] },
    sources: {},
  })
  const port = await daemon.listen()
  const client = createApiClient({ baseUrl: `http://127.0.0.1:${port}`, token: daemon.token })

  const post = body => fetch(`http://127.0.0.1:${port}/v1/event`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  try {
    await run({ client, post, port, dir })
  } finally {
    await daemon.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const event = n => ({ source: 'manual', at: `2026-11-15T0${n}:00:00+08:00`, actor: 'other', text: `第 ${n} 条`, meta: {} })

test('外部适配器只用 take/done 就能把队列投空', async () => {
  await withStack(async ({ client, post }) => {
    for (const n of [1, 2, 3]) await post(event(n))

    const taken = await client.take(2)
    assert.equal(taken.events.length, 2)
    assert.ok(taken.ticket)
    assert.equal(taken.backlog, 3)

    const result = await client.done(taken.ticket, taken.events.map(e => e.id))
    assert.deepEqual(result, { delivered: 2, released: 0 })

    const rest = await client.take(10)
    assert.equal(rest.events.length, 1)
    await client.done(rest.ticket, rest.events.map(e => e.id))

    const empty = await client.take(10)
    assert.equal(empty.events.length, 0, '投空了就是投空了')
    assert.equal(empty.backlog, 0)
  })
})

test('取走的没回话，别人拿不到（小票互斥）', async () => {
  await withStack(async ({ client, post }) => {
    await post(event(1))
    const first = await client.take(1)
    assert.equal(first.events.length, 1)
    const second = await client.take(1)
    assert.equal(second.events.length, 0, '同一批不该被两个人取走')
  })
})

test('投失败退回去，下一轮还能取到，attempts 加一', async () => {
  await withStack(async ({ client, post }) => {
    await post(event(1))
    const taken = await client.take(1)
    await client.retry(taken.ticket, '会话挂了')
    const again = await client.take(1)
    assert.equal(again.events.length, 1)
    assert.ok(again.events[0].attempts >= 1)
  })
})

test('只投了一部分：点名的那几条入库已投，其余放回', async () => {
  await withStack(async ({ client, post }) => {
    for (const n of [1, 2, 3]) await post(event(n))
    const taken = await client.take(3)
    assert.equal(taken.events.length, 3)
    const result = await client.done(taken.ticket, [taken.events[0].id])
    assert.deepEqual(result, { delivered: 1, released: 2 })
    const rest = await client.take(10)
    assert.equal(rest.events.length, 2)
  })
})

test('没带 token 一律 401', async () => {
  await withStack(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/take`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 401)
  })
})
