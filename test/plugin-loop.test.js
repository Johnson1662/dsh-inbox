import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalize } from '../src/core/envelope.js'
import { openQueue } from '../src/core/queue.js'
import { batchIdOf, createDeliveryLoop } from '../src/plugin/loop.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pc-loop-'))
  const queue = openQueue(join(dir, 'c.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }] })
  return { dir, queue, done: () => { queue.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const envelope = text => normalize({ source: 'telegram', at: '2026-11-14T19:40:00+08:00', text, meta: { chat: 'A', sender: '甲' } })

test('取一批、投一次、标记已投', async () => {
  const { queue, done } = setup()
  queue.ingest(envelope('一'))
  queue.ingest(envelope('二'))
  const sent = []
  const loop = createDeliveryLoop({ queue, resolveAgent: () => ({ id: 'agent' }), deliver: async (agent, batch) => sent.push(batch) })
  await loop.drain()
  loop.stop()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /\[telegram\] 2 条新消息/)
  assert.equal(queue.stats().delivered, 2)
  assert.equal(queue.stats().pending, 0)
  done()
})

test('会话不可用时不动事件', async () => {
  const { queue, done } = setup()
  queue.ingest(envelope('等会话'))
  const loop = createDeliveryLoop({ queue, resolveAgent: () => undefined, deliver: async () => assert.fail('不该投') })
  await loop.drain()
  loop.stop()
  assert.equal(queue.stats().pending, 1)
  done()
})

test('投递失败只记一次尝试，事件留着；退避期内不再重试', async () => {
  const { queue, done } = setup()
  queue.ingest(envelope('会失败'))
  let attempts = 0
  let clock = 1_000_000
  const loop = createDeliveryLoop({
    queue,
    resolveAgent: () => ({ id: 'agent' }),
    deliver: async () => { attempts += 1; throw new Error('agent offline') },
    now: () => clock,
  })
  await loop.drain()
  assert.equal(attempts, 1)
  assert.equal(queue.stats().pending, 1)
  assert.equal(queue.take('chief', 10)[0].attempts, 1)

  await loop.drain() // 还在退避窗口内
  assert.equal(attempts, 1)

  clock += 60_000
  await loop.drain()
  assert.equal(attempts, 2)
  loop.stop()
  done()
})

test('同一批事件推导出同一个消息 id', () => {
  const batch = [envelope('a'), envelope('b')]
  assert.equal(batchIdOf(batch), batchIdOf([...batch]))
  assert.notEqual(batchIdOf(batch), batchIdOf([batch[0]]))
})
