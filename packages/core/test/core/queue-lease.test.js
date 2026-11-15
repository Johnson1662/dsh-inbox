import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync as dbModule } from 'node:sqlite'
import { openQueue } from '../../src/core/queue.js'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'pc-lease-'))
  const q = openQueue(join(dir, 'q.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }] })
  return { q, done: () => { q.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const ev = (n, text = `第${n}条`) => ({
  id: `e${n}`, source: 'manual', at: `2026-11-14T19:${String(n).padStart(2, '0')}:00+08:00`, actor: 'other', text, meta: {},
})

test('取货给小票，被划走的事件别人拿不到', () => {
  const { q, done } = fresh()
  for (let i = 0; i < 3; i += 1) q.ingest(ev(i))
  const first = q.takeBatch('chief', 2)
  assert.equal(first.events.length, 2)
  assert.match(first.ticket, /^t:/)
  assert.equal(first.backlog, 3)

  const second = q.takeBatch('chief', 5)
  assert.equal(second.events.length, 1, '只剩没被划走的那条')
  assert.equal(q.leased('chief'), 3)
  done()
})

test('投完了：点名的入库已投，没点名的放回队列', () => {
  const { q, done } = fresh()
  for (let i = 0; i < 3; i += 1) q.ingest(ev(i))
  const { ticket, events } = q.takeBatch('chief', 3)
  const result = q.done(ticket, [events[0].id, events[1].id])
  assert.deepEqual(result, { delivered: 2, released: 1 })
  assert.deepEqual(q.stats(), { pending: 1, delivered: 2, perSource: { manual: { pending: 1, delivered: 2 } } })
  assert.equal(q.takeBatch('chief', 5).events.length, 1, '放回的那条能被重新取到')
  done()
})

test('投失败：整张小票退回，attempts 加一', () => {
  const { q, done } = fresh()
  for (let i = 0; i < 2; i += 1) q.ingest(ev(i))
  const { ticket } = q.takeBatch('chief', 2)
  const result = q.retry(ticket, '会话没响应')
  assert.equal(result.released, 2)
  const again = q.takeBatch('chief', 2)
  assert.equal(again.events.length, 2)
  assert.ok(again.events.every(e => e.attempts >= 1))
  done()
})

test('租约过期自动收回：消费者崩了也不会把消息锁死', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-lease-ttl-'))
  let t = Date.parse('2026-11-14T20:00:00Z')
  const q = openQueue(join(dir, 'q.sqlite'), { routes: [{ sources: ['*'], sink: 'chief' }], now: () => new Date(t) })
  q.ingest(ev(0))

  const first = q.takeBatch('chief', 1, { leaseMs: 1000 })
  assert.equal(first.events.length, 1)
  assert.equal(q.takeBatch('chief', 1).events.length, 0, '租约内拿不到')

  t += 1001                                    // 时间往前走，租约到期
  const after = q.takeBatch('chief', 1)
  assert.equal(after.events.length, 1, '过期后能再取到')
  q.done(after.ticket, [after.events[0].id])
  assert.deepEqual(q.stats(), { pending: 0, delivered: 1, perSource: { manual: { pending: 0, delivered: 1 } } })
  q.close()
  rmSync(dir, { recursive: true, force: true })
})

test('老库能补列：只有旧 schema 的库打开后照样能用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-lease-old-'))
  const path = join(dir, 'old.sqlite')
  const old = new dbModule(path)
  old.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, sink TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, ingested_at TEXT NOT NULL, delivered_at TEXT)`)
  old.close()
  const q = openQueue(path, { routes: [{ sources: ['*'], sink: 'chief' }] })
  q.ingest(ev(0))
  assert.equal(q.takeBatch('chief', 1).events.length, 1)
  q.close()
  rmSync(dir, { recursive: true, force: true })
})
