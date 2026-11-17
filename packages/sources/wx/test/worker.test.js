import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createNameSource, createPoller, isNewer, parseChats, toEnvelope, toZonedIso } from '../worker.js'

// 全程用假 exec，不碰真实微信库；时区钉死 +08:00，不依赖跑测试那台机器的 TZ。
const OFFSET = 480
const SELF = 'wxid_self'

function message(localId, timestamp, { sender = '张三', content = '正文', type = '文本', typeId = 'text' } = {}) {
  return {
    local_id: localId,
    timestamp,
    sender,
    sender_username: `wxid_${sender}`,
    content,
    type,
    type_id: typeId,
  }
}

/** 假 wx：按 username 返回预先排好的消息（故意倒序，考验排序）。 */
function fakeWx(byChat, { fail = [], names = {} } = {}) {
  const calls = []
  return {
    calls,
    async exec(file, args) {
      calls.push(args)
      const username = args[1]
      if (fail.includes(username)) throw new Error(`读 ${username} 炸了`)
      const messages = byChat[username] ?? []
      return { stdout: JSON.stringify({ chat: names[username] ?? username, messages: [...messages].reverse() }) }
    },
  }
}

function createTestPoller(t, { fake, chats, prepare, backfill, lookupName } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-wx-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (prepare) prepare(dir)
  const emitted = []
  const logs = []
  const poller = createPoller({
    exec: fake.exec,
    stateDir: dir,
    chats,
    selfId: SELF,
    backfill,
    intervalMs: 30_000,
    offsetMinutes: OFFSET,
    emit: envelope => emitted.push(envelope),
    log: line => logs.push(line),
    ...(lookupName ? { lookupName } : {}),
  })
  return { poller, dir, emitted, logs, watermarkFile: join(dir, 'watermarks', 'wx.json') }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('时间戳转带时区的 ISO', () => {
  assert.equal(toZonedIso(1794748178, OFFSET), '2026-11-15T21:09:38+08:00')
  assert.equal(toZonedIso(1794748178, 0), '2026-11-15T13:09:38+00:00')
  assert.equal(toZonedIso(1794748178, -300), '2026-11-15T08:09:38-05:00')
  assert.equal(toZonedIso('abc', OFFSET), null)
})

test('白名单解析：逗号分隔、去空格、空就是空', () => {
  assert.deepEqual(parseChats('a@chatroom, wxid_b ,,c'), ['a@chatroom', 'wxid_b', 'c'])
  assert.deepEqual(parseChats(''), [])
  assert.deepEqual(parseChats(undefined), [])
})

test('一条消息 → 信封：id 稳定、字段齐全', () => {
  const envelope = toEnvelope(message(957, 1794748178), { username: '463@chatroom', name: '🀄' }, { offsetMinutes: OFFSET })
  assert.equal(envelope.id, 'wx:463@chatroom:957')
  assert.equal(envelope.source, 'wx')
  assert.equal(envelope.at, '2026-11-15T21:09:38+08:00')
  assert.equal(envelope.actor, 'other')
  assert.equal(envelope.text, '正文')
  assert.deepEqual(envelope.meta, { chat: '🀄', chat_username: '463@chatroom', sender: '张三', type: 'text' })
  assert.equal(envelope.timestamp, 1794748178)
  assert.equal(envelope.localId, 957)
})

test('自己的消息判成 self；缺时间或缺 id 直接丢弃', () => {
  const mine = toEnvelope(message(1, 1794748178, { sender: 'self' }), { username: 'u' }, { offsetMinutes: OFFSET, selfId: SELF })
  assert.equal(mine.actor, 'self')

  assert.equal(toEnvelope(message(1, 0), { username: 'u' }, { offsetMinutes: OFFSET }), null)
  assert.equal(toEnvelope({ timestamp: 1794748178 }, { username: 'u' }, { offsetMinutes: OFFSET }), null)
})

test('非文本消息不丢：正文放类型标签', () => {
  const envelope = toEnvelope(
    message(2, 1794748178, { content: '', type: '图片', typeId: 'image' }),
    { username: 'u' },
    { offsetMinutes: OFFSET },
  )
  assert.equal(envelope.text, '[图片]')
  assert.equal(envelope.meta.type, 'image')
})

test('水位比较：同一条不算新，更新时间或更大 local_id 才算', () => {
  assert.equal(isNewer(message(5, 100), null), true)
  assert.equal(isNewer(message(5, 100), { ts: 100, localId: 5 }), false)
  assert.equal(isNewer(message(6, 100), { ts: 100, localId: 5 }), true)
  assert.equal(isNewer(message(1, 101), { ts: 100, localId: 5 }), true)
  assert.equal(isNewer(message(9, 99), { ts: 100, localId: 5 }), false)
})

test('投递用群名：history 解出来的优先，其次是联系人缓存，都没有才退回 username', async t => {
  const fake = fakeWx(
    { '1@chatroom': [message(1, 100)], '2@chatroom': [message(2, 100)], '3@chatroom': [message(3, 100)] },
    { names: { '2@chatroom': 'history 里的群名' } },
  )
  const ctx = createTestPoller(t, {
    fake,
    chats: ['1@chatroom', '2@chatroom', '3@chatroom'],
    backfill: 1,
    lookupName: username => (username === '1@chatroom' ? '缓存里的群名' : ''),
  })

  await ctx.poller.pollOnce()

  const names = Object.fromEntries(ctx.emitted.map(e => [e.meta.chat_username, e.meta.chat]))
  assert.deepEqual(names, {
    '1@chatroom': '缓存里的群名',
    '2@chatroom': 'history 里的群名',
    '3@chatroom': '3@chatroom',
  })
})

test('名字来源按 TTL 刷新，读失败当没有', () => {
  let reads = 0
  let clock = 0
  const lookup = createNameSource({
    ttlMs: 1000,
    now: () => clock,
    load: () => {
      reads += 1
      return new Map([['a@chatroom', '群 A']])
    },
  })

  assert.equal(lookup('a@chatroom'), '群 A')
  assert.equal(lookup('a@chatroom'), '群 A')
  assert.equal(reads, 1, 'TTL 内只读一次缓存')

  clock = 1500
  lookup('a@chatroom')
  assert.equal(reads, 2)

  const broken = createNameSource({
    load: () => {
      throw new Error('database disk image is malformed')
    },
  })
  assert.equal(broken('a@chatroom'), '', '读不出来就退回空，不抛错')
})

// ---------------------------------------------------------------------------
// 轮询
// ---------------------------------------------------------------------------

test('第一次见到的会话默认不回溯：水位设到最新，一条都不发', async t => {
  const fake = fakeWx({ 'a@chatroom': [message(1, 100), message(2, 101), message(3, 102)] })
  const ctx = createTestPoller(t, { fake, chats: ['a@chatroom'] })

  await ctx.poller.pollOnce()

  assert.deepEqual(ctx.emitted, [])
  assert.deepEqual(ctx.poller.watermarks(), { 'a@chatroom': { ts: 102, localId: 3 } })
  assert.match(ctx.logs.join('\n'), /首轮不回溯/)

  // 水位已经落盘，下个进程从这里接着取
  assert.deepEqual(JSON.parse(readFileSync(ctx.watermarkFile, 'utf8')).chats['a@chatroom'], { ts: 102, localId: 3 })
})

test('只采白名单里的会话，按时间顺序交', async t => {
  const fake = fakeWx({
    'a@chatroom': [message(1, 100), message(2, 101)],
    'b@chatroom': [message(3, 102)],
  })
  const ctx = createTestPoller(t, { fake, chats: ['a@chatroom'], backfill: 10 })

  await ctx.poller.pollOnce()

  assert.deepEqual(fake.calls.map(args => args[1]), ['a@chatroom'])
  assert.deepEqual(ctx.emitted.map(item => item.id), ['wx:a@chatroom:1', 'wx:a@chatroom:2'])
})

test('连续多轮取到同一条：只交一次（水位是严格大于）', async t => {
  const fake = fakeWx({ 'a@chatroom': [message(9, 100)] })
  const ctx = createTestPoller(t, { fake, chats: ['a@chatroom'], backfill: 10 })

  for (let round = 0; round < 5; round++) await ctx.poller.pollOnce()

  assert.equal(ctx.emitted.length, 1)
  assert.deepEqual(ctx.poller.watermarks(), { 'a@chatroom': { ts: 100, localId: 9 } })
})

test('水位落盘，新进程从这里接着取', async t => {
  const fake = fakeWx({ 'a@chatroom': [message(1, 100), message(2, 101)] })
  const ctx = createTestPoller(t, {
    fake,
    chats: ['a@chatroom'],
    prepare: dir => {
      mkdirSync(join(dir, 'watermarks'), { recursive: true })
      writeFileSync(
        join(dir, 'watermarks', 'wx.json'),
        JSON.stringify({ source: 'wx', version: 1, chats: { 'a@chatroom': { ts: 100, localId: 1 } } }),
      )
    },
  })

  await ctx.poller.pollOnce()

  assert.deepEqual(ctx.emitted.map(item => item.id), ['wx:a@chatroom:2'])
  const saved = JSON.parse(readFileSync(ctx.watermarkFile, 'utf8'))
  assert.deepEqual(saved.chats['a@chatroom'], { ts: 101, localId: 2 })
})

test('某个会话读失败：不影响别的会话，水位不动', async t => {
  const fake = fakeWx({ 'a@chatroom': [message(1, 100)], 'b@chatroom': [message(2, 101)] }, { fail: ['a@chatroom'] })
  const ctx = createTestPoller(t, { fake, chats: ['a@chatroom', 'b@chatroom'], backfill: 10 })

  await ctx.poller.pollOnce()

  assert.deepEqual(ctx.emitted.map(item => item.id), ['wx:b@chatroom:2'])
  assert.equal(ctx.poller.watermarks()['a@chatroom'], undefined)
  assert.match(ctx.logs.join('\n'), /a@chatroom 读取失败/)
})
