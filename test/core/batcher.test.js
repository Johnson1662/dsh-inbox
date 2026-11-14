import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LIMITS, costOf, effectiveLimits, pick } from '../../src/core/batcher.js'
import { normalize } from '../../src/core/envelope.js'
import { LINE_OVERHEAD, bodyOf, render } from '../../src/core/render.js'

const AT = '2026-11-14T19:40:00+08:00'
let seq = 0

function ev(text, meta = { chat: 'A', sender: '甲' }) {
  seq += 1
  return normalize({ id: `case:${seq}`, source: 'telegram', at: AT, text, meta })
}

const filler = n => 'x'.repeat(n)
const linesOf = text => text.split('\n').filter(line => line.startsWith('· '))

/** 固定种子的伪随机：属性测试要可复现，不能用 Math.random。 */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

test('0 条：空进空出，积压与否都一样', () => {
  assert.deepEqual(pick([]), { batch: [], rest: [] })
  assert.deepEqual(pick([], DEFAULT_LIMITS, { backlog: 500 }), { batch: [], rest: [] })
})

test('1 条：原样收下，rest 为空', () => {
  const one = ev('只有一条')
  const { batch, rest } = pick([one])
  assert.deepEqual(batch, [one])
  assert.deepEqual(rest, [])
})

test('恰好等于条数上限：整批收下；多一条就留到下一批', () => {
  const events = Array.from({ length: 6 }, () => ev('一条'))
  assert.deepEqual(pick(events.slice(0, 5), { count: 5 }).batch, events.slice(0, 5))
  assert.deepEqual(pick(events.slice(0, 5), { count: 5 }).rest, [])
  const exactly = pick(events, { count: 5 })
  assert.deepEqual(exactly.batch, events.slice(0, 5))
  assert.deepEqual(exactly.rest, events.slice(5))
})

test('恰好等于字数上限：进得来；多一个字就留到下一批', () => {
  const a = ev(filler(10)) // 20 + 10 = 30 字
  const b = ev(filler(10))
  assert.equal(costOf(a), 30)
  assert.deepEqual(pick([a, b], { chars: 60 }), { batch: [a, b], rest: [] })
  assert.deepEqual(pick([a, b], { chars: 59 }), { batch: [a], rest: [b] })
})

test('6 条超过条数上限：5+1 两批，合计 6 行一条不少', () => {
  const events = Array.from({ length: 6 }, (_, i) => ev(`第${i}条`))
  const first = pick(events, { count: 5 })
  assert.equal(first.batch.length, 5)
  assert.equal(first.rest.length, 1)

  const second = pick(first.rest, { count: 5 })
  assert.deepEqual(second.batch, [events[5]])
  assert.deepEqual(second.rest, [])

  const rendered = [...linesOf(render(first.batch)), ...linesOf(render(second.batch))]
  assert.equal(rendered.length, 6)
  assert.match(render(first.batch), /^\[telegram\] 5 条新消息/)
  assert.match(render(second.batch), /^\[telegram\] 1 条新消息/)
  for (let i = 0; i < 6; i += 1) assert.ok(rendered.some(line => line.endsWith(`| 第${i}条`)), `第${i}条丢了`)
})

test('5000 字单条超上限：独占一批，正文不截断', () => {
  const long = filler(5000)
  const big = ev(long)
  const small = ev('小的一条')

  const first = pick([big, small])
  assert.deepEqual(first.batch, [big])
  assert.deepEqual(first.rest, [small])
  assert.equal(first.batch[0].text, long)
  assert.equal(first.batch[0].text.length, 5000)
})

test('超长条排在后面：轮到它时独占一批，仍然不截断', () => {
  const small = ev('小的一条')
  const long = filler(5000)
  const big = ev(long)

  const first = pick([small, big])
  assert.deepEqual(first.batch, [small])
  assert.deepEqual(first.rest, [big])

  const second = pick(first.rest)
  assert.deepEqual(second.batch, [big])
  assert.deepEqual(second.rest, [])
  assert.equal(second.batch[0].text, long)
})

test('恰好等于 backlogCount 不放大；超过才放大到 200 条 / 20000 字', () => {
  assert.deepEqual(effectiveLimits(DEFAULT_LIMITS, 0), { count: 50, chars: 4000, enlarged: false })
  assert.deepEqual(effectiveLimits(DEFAULT_LIMITS, 200), { count: 50, chars: 4000, enlarged: false })
  assert.deepEqual(effectiveLimits(DEFAULT_LIMITS, 201), { count: 200, chars: 20000, enlarged: true })
})

test('300 条积压：上限放大，一批 200 条，剩下 100 条原序顺延', () => {
  const events = Array.from({ length: 300 }, (_, i) => ev(`积压${i}`))
  const { batch, rest } = pick(events, DEFAULT_LIMITS, { backlog: 300 })
  assert.equal(batch.length, 200)
  assert.equal(rest.length, 100)
  assert.deepEqual(rest[0], events[200])
  assert.deepEqual([...batch, ...rest], events)
})

test('放大后字数仍是硬限制：只放宽唤醒次数，不放宽字数', () => {
  const events = Array.from({ length: 300 }, () => ev(filler(300))) // 每条 320 字
  const { batch, rest } = pick(events, DEFAULT_LIMITS, { backlog: 300 })
  assert.equal(batch.length, 62) // floor(20000 / 320)
  assert.equal(rest.length, 238)
  assert.ok(batch.reduce((sum, event) => sum + costOf(event), 0) <= 20000)
})

test('上限缺失或非法时退回默认值，不静默清零', () => {
  assert.deepEqual(effectiveLimits({}, 0), { count: 50, chars: 4000, enlarged: false })
  assert.deepEqual(effectiveLimits({ count: 0, chars: Number.NaN }, 0), { count: 50, chars: 4000, enlarged: false })
  assert.equal(DEFAULT_LIMITS.count, 50)
  assert.equal(DEFAULT_LIMITS.chars, 4000)
  assert.equal(DEFAULT_LIMITS.backlogCount, 200)
  assert.equal(DEFAULT_LIMITS.backlogChars, 20000)
})

test('字数估算与 render 的行模板一致：折行、占位都算同一份正文', () => {
  const folded = ev('第一行\n第二行')
  assert.equal(costOf(folded), LINE_OVERHEAD + '第一行 第二行'.length)
  assert.ok(render([folded]).endsWith(bodyOf(folded)))

  const media = ev('', { chat: 'A', sender: '甲', media: 'photo' })
  assert.equal(costOf(media), LINE_OVERHEAD + '（附件：photo）'.length)

  const redacted = ev('', { chat: 'A', sender: '甲', redacted: true })
  assert.equal(costOf(redacted), LINE_OVERHEAD + '（正文已隐去：凭据类）'.length)
})

test('属性：batch ∪ rest 恒等于输入，顺序不变，装得下的都装进来', () => {
  const rand = lcg(20261115)
  for (let round = 0; round < 300; round += 1) {
    const count = Math.floor(rand() * 60)
    const events = Array.from({ length: count }, () => ev(filler(Math.floor(rand() * 400))))
    const limits = { count: 1 + Math.floor(rand() * 60), chars: 100 + Math.floor(rand() * 5000) }
    const backlog = Math.floor(rand() * 400)
    const { batch, rest } = pick(events, limits, { backlog })
    const ceiling = effectiveLimits(limits, backlog)

    // 守恒：一条不多、一条不少、顺序不变
    assert.equal(batch.length + rest.length, events.length)
    assert.deepEqual([...batch, ...rest], events)
    batch.forEach((event, i) => assert.equal(event, events[i]))
    rest.forEach((event, i) => assert.equal(event, events[batch.length + i]))

    // 非空输入必有非空批次，且不超过条数上限
    if (count > 0) assert.ok(batch.length > 0)
    assert.ok(batch.length <= ceiling.count)

    // 字数：只有单条独占时才允许超，超长条不截断
    const chars = batch.reduce((sum, event) => sum + costOf(event), 0)
    if (batch.length > 1) assert.ok(chars <= ceiling.chars)

    // 贪心到底：rest 的第一条再也塞不进去
    if (rest.length) {
      const overCount = batch.length + 1 > ceiling.count
      const overChars = chars + costOf(rest[0]) > ceiling.chars
      assert.ok(overCount || overChars, `第 ${round} 轮过早停下`)
    }
  }
})
