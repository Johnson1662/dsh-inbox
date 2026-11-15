import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDaemon } from '../src/daemon/index.js'
import { openQueue } from '../src/core/queue.js'
import { createDeliveryLoop } from '../src/plugin/loop.js'

/**
 * 竖切的一段真链路：HTTP 收事件 → 入库 → 投递循环取批 → 渲染成消息。
 * 没有 DSH，用一个假的 agent 顶替会话；验的是契约，不是 UI。
 */
async function withDaemon(run) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-e2e-'))
  const daemon = createDaemon({
    stateDir: dir,
    http: { listen: '127.0.0.1:0' },
    delivery: { intervalMs: 20 },
    routes: [{ sources: ['*'], sink: 'chief' }],
    credentials: { chats: ['777000'], patterns: ['验证码|passcode'] },
    sources: {},
  })
  const port = await daemon.listen()
  try {
    await run({ port, dir, daemon })
  } finally {
    await daemon.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function post(port, token, body) {
  return fetch(`http://127.0.0.1:${port}/v1/event`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('一条事件走完 HTTP → 库 → 投递循环，正文一字不差', async () => {
  await withDaemon(async ({ port, dir, daemon }) => {
    const text = '作业 DDL 改到 25 号'
    const response = await post(port, daemon.token, {
      source: 'manual', at: '2026-11-14T19:40:00+08:00', actor: 'other', text, meta: { chat: '自然语言处理', sender: '王老师' },
    })
    assert.equal(response.status, 200)

    const queue = openQueue(join(dir, 'context.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }] })
    const delivered = []
    const loop = createDeliveryLoop({
      queue, sink: 'chief',
      resolveAgent: () => ({ id: 'fake-agent' }),
      deliver: async (agent, message) => { delivered.push(message) },
      intervalMs: 10,
    })
    for (let i = 0; i < 50 && !delivered.length; i += 1) await new Promise(r => setTimeout(r, 10))
    loop.stop()

    assert.equal(delivered.length, 1, '应当只投一次')
    assert.match(delivered[0].text, /\[manual\] 1 条新消息/)
    assert.match(delivered[0].text, new RegExp(text))
    assert.deepEqual(queue.stats(), { pending: 0, delivered: 1, perSource: { manual: { pending: 0, delivered: 1 } } })
    queue.close()
  })
})

test('同一事件提交两次只入一行，且只投一次', async () => {
  await withDaemon(async ({ port, dir, daemon }) => {
    const event = { source: 'manual', at: '2026-11-14T19:41:00+08:00', actor: 'other', text: '收到' }
    await post(port, daemon.token, event)
    const again = await (await post(port, daemon.token, event)).json()
    assert.equal(again.duplicate, true)

    const queue = openQueue(join(dir, 'context.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }] })
    assert.deepEqual(queue.stats(), { pending: 1, delivered: 0, perSource: { manual: { pending: 1, delivered: 0 } } })
    queue.close()
  })
})

test('没有 token 一律拒绝，队列一条不写', async () => {
  await withDaemon(async ({ port, dir }) => {
    const response = await post(port, 'wrong-token', { source: 'manual', at: '2026-11-14T19:42:00+08:00', actor: 'other', text: 'x' })
    assert.equal(response.status, 401)
    const queue = openQueue(join(dir, 'context.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }] })
    assert.equal(queue.stats().pending, 0)
    queue.close()
  })
})

test('凭据类消息只留元数据，正文不入库', async () => {
  await withDaemon(async ({ port, dir, daemon }) => {
    await post(port, daemon.token, {
      source: 'telegram', at: '2026-11-14T19:43:00+08:00', actor: 'other',
      text: '你的验证码是 123456', meta: { chat: 'Telegram', chat_id: '777000', sender: 'Telegram' },
    })
    const queue = openQueue(join(dir, 'context.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }] })
    const [event] = queue.take('chief', 10)
    assert.equal(event.text, '')
    assert.equal(event.meta.redacted, true)
    queue.close()
  })
})
