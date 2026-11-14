import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalize } from '../../src/core/envelope.js'
import { openQueue } from '../../src/core/queue.js'

const routes = [{ sources: ['*'], sink: 'chief' }]

function makeQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'pc-queue-'))
  const queue = openQueue(join(dir, 'context.sqlite'), { routes })
  return { queue, dir, done: () => { queue.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function envelope(overrides = {}) {
  return normalize({ source: 'telegram', at: '2026-11-14T19:40:00+08:00', actor: 'other', text: '一条消息', ...overrides })
}

test('ingest 之后是待投，重复 ingest 只多一个 duplicate 标记', () => {
  const { queue, done } = makeQueue()
  assert.equal(queue.ingest(envelope()).duplicate, false)
  assert.equal(queue.ingest(envelope()).duplicate, true)
  assert.equal(queue.stats().pending, 1)
  done()
})

test('take 是只读的', () => {
  const { queue, done } = makeQueue()
  queue.ingest(envelope())
  assert.equal(queue.take('chief', 10).length, 1)
  assert.equal(queue.take('chief', 10).length, 1)
  assert.equal(queue.stats().pending, 1)
  done()
})

test('ack 之后不再被 take 到，且重复 ack 无副作用', () => {
  const { queue, done } = makeQueue()
  const { id } = queue.ingest(envelope())
  queue.ack([id])
  assert.equal(queue.take('chief', 10).length, 0)
  assert.deepEqual(queue.stats(), { pending: 0, delivered: 1, perSource: { telegram: { pending: 0, delivered: 1 } } })
  queue.ack([id])
  assert.equal(queue.stats().delivered, 1)
  done()
})

test('fail 保留事件并计次，正文不丢', () => {
  const { queue, done } = makeQueue()
  const { id } = queue.ingest(envelope({ text: '要重投的一条' }))
  queue.fail([id], 'agent offline')
  const [row] = queue.take('chief', 10)
  assert.equal(row.id, id)
  assert.equal(row.text, '要重投的一条')
  assert.equal(row.attempts, 1)
  assert.equal(queue.stats().pending, 1)
  done()
})

test('按 at 升序取出，与时序无关', () => {
  const { queue, done } = makeQueue()
  queue.ingest(envelope({ at: '2026-11-14T19:42:00+08:00', text: '晚' }))
  queue.ingest(envelope({ at: '2026-11-14T19:40:00+08:00', text: '早' }))
  assert.deepEqual(queue.take('chief', 10).map(row => row.text), ['早', '晚'])
  done()
})

test('路由在 ingest 时定下；没有兜底规则就启动失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-route-'))
  const queue = openQueue(join(dir, 'a.sqlite'), {
    routes: [{ sources: ['telegram'], sink: 'work' }, { sources: ['*'], sink: 'chief' }],
  })
  assert.equal(queue.ingest(envelope({ source: 'telegram' })).sink, 'work')
  assert.equal(queue.ingest(envelope({ source: 'feishu', text: '另一个来源' })).sink, 'chief')
  queue.close()
  assert.throws(() => openQueue(join(dir, 'b.sqlite'), { routes: [{ sources: ['telegram'], sink: 'x' }] }), /兜底/)
  rmSync(dir, { recursive: true, force: true })
})
