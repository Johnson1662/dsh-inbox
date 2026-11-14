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

const linesOf = text => text.split('\n').filter(line => line.startsWith('· '))

test('没有待投就直接返回，不投空消息', async () => {
  const { queue, done } = setup()
  const loop = createDeliveryLoop({ queue, resolveAgent: () => ({ id: 'agent' }), deliver: async () => assert.fail('不该投') })
  await loop.drain()
  loop.stop()
  assert.deepEqual(queue.stats(), { pending: 0, delivered: 0, perSource: {} })
  done()
})

test('60 条 → 50 条一批、10 条下一批；两批合计 60 行，库里条数守恒', async () => {
  const { queue, done } = setup()
  for (let i = 0; i < 60; i += 1) queue.ingest(envelope(`第${i}条`))
  const sent = []
  const loop = createDeliveryLoop({ queue, resolveAgent: () => ({ id: 'agent' }), deliver: async (agent, batch) => sent.push(batch) })

  await loop.drain()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^\[telegram\] 50 条新消息/)
  assert.equal(queue.pending('chief'), 10)

  await loop.drain()
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /^\[telegram\] 10 条新消息/)
  assert.equal(queue.pending('chief'), 0)

  const lines = sent.flatMap(batch => linesOf(batch.text))
  assert.equal(lines.length, 60)
  assert.equal(new Set(lines).size, 60)
  assert.equal(queue.stats().delivered, 60)
  assert.equal(queue.stats().pending, 0)
  loop.stop()
  done()
})

test('5000 字的一条独占一批，正文完整不截断，后面的顺延', async () => {
  const { queue, done } = setup()
  const long = 'x'.repeat(5000)
  queue.ingest(envelope(long))
  queue.ingest(envelope('紧随其后的一条'))
  const sent = []
  const loop = createDeliveryLoop({ queue, resolveAgent: () => ({ id: 'agent' }), deliver: async (agent, batch) => sent.push(batch) })

  await loop.drain()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^\[telegram\] 1 条新消息/)
  assert.ok(sent[0].text.includes(long), '超长正文被截断了')
  assert.equal(queue.pending('chief'), 1)

  await loop.drain()
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /紧随其后的一条/)
  assert.equal(queue.pending('chief'), 0)
  loop.stop()
  done()
})

test('字数装满就停下，剩下的仍是待投', async () => {
  const { queue, done } = setup()
  for (let i = 0; i < 3; i += 1) queue.ingest(envelope(`${i}`.padEnd(1500, 'x'))) // 每条约 1520 字
  const sent = []
  const loop = createDeliveryLoop({ queue, resolveAgent: () => ({ id: 'agent' }), deliver: async (agent, batch) => sent.push(batch) })

  await loop.drain()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^\[telegram\] 2 条新消息/)
  assert.equal(queue.pending('chief'), 1)
  assert.equal(queue.stats().delivered, 2)
  loop.stop()
  done()
})

test('300 条积压：上限放大，唤醒次数少于按 50 条一批', async () => {
  const { queue, done } = setup()
  for (let i = 0; i < 300; i += 1) queue.ingest(envelope(`积压${i}`))
  const sizes = []
  const loop = createDeliveryLoop({
    queue,
    resolveAgent: () => ({ id: 'agent' }),
    deliver: async (agent, batch) => sizes.push(linesOf(batch.text).length),
  })

  await loop.drain()
  assert.deepEqual(sizes, [200])
  assert.equal(queue.pending('chief'), 100)

  while (queue.pending('chief')) await loop.drain()
  assert.deepEqual(sizes, [200, 50, 50])
  assert.equal(queue.stats().delivered, 300)
  assert.ok(sizes.length < 300 / 50, `唤醒 ${sizes.length} 次，没有比按 50 条一批更少`)
  loop.stop()
  done()
})

test('批次上限取自 config.limits 的命名（batchCount / batchChars）', async () => {
  const { queue, done } = setup()
  for (let i = 0; i < 7; i += 1) queue.ingest(envelope(`第${i}条`))
  const sent = []
  const loop = createDeliveryLoop({
    queue,
    limits: { batchCount: 3, batchChars: 4000, backlogCount: 200, backlogChars: 20000 },
    resolveAgent: () => ({ id: 'agent' }),
    deliver: async (agent, batch) => sent.push(batch),
  })

  await loop.drain()
  assert.match(sent[0].text, /^\[telegram\] 3 条新消息/)
  assert.equal(queue.pending('chief'), 4)
  loop.stop()
  done()
})
