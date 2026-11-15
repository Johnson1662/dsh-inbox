import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { normalize } from '../../src/core/envelope.js'
import {
  backoffMs,
  createPoller,
  extractText,
  isRateLimited,
  main,
  parseChatList,
  parseMessageList,
  preflight,
  retryAfterMs,
  toEnvelope,
  toZonedIso,
  writeJsonAtomic,
} from '../../src/sources/feishu.js'

// 测试全程用假 exec，不碰网络、不看真实登录状态。
// 时间也钉死：时区固定 +08:00，不依赖跑测试那台机器的 TZ。
const OFFSET = 480
const NOW = new Date('2026-11-15T09:00:00+08:00')
const INTERVAL = 5000

// ---------------------------------------------------------------------------
// 假 lark-cli
// ---------------------------------------------------------------------------

function flagValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

function pageAt(pages, token) {
  const index = token ? Number(token) : 0
  return pages[index] ?? {}
}

/** 现行成功信封：数据在 data 里，分页状态同时出现在 data 和 meta.pagination。 */
function chatListEnvelope({ chats = [], next = null } = {}) {
  return {
    ok: true,
    identity: 'user',
    data: {
      chats,
      has_more: next !== null,
      ...(next === null ? {} : { page_token: next }),
    },
    meta: { pagination: { complete: next === null, pages: 1, items: chats.length, next_token: next } },
  }
}

function messageListEnvelope({ messages = [], next = null } = {}) {
  return {
    ok: true,
    identity: 'user',
    data: {
      messages,
      ...(next === null ? {} : { page_token: next }),
    },
    meta: { pagination: { complete: next === null, next_token: next } },
  }
}

function chat(id, name) {
  return { chat_id: id, name, chat_mode: 'group' }
}

function message(id, chatId, time, text, sender = { id: 'ou_other', name: '同事', sender_type: 'user' }) {
  return {
    chat_id: chatId,
    content: text,
    create_time: time,
    deleted: false,
    message_id: id,
    msg_type: 'text',
    sender,
  }
}

/** 429：lark-cli 把错误信封写 stderr、退出码非 0。 */
function rateLimitError({ retryAfterSeconds } = {}) {
  const envelope = {
    ok: false,
    identity: 'user',
    error: {
      type: 'rate_limit',
      subtype: 'too_many_requests',
      code: 99991400,
      message: 'OpenAPI gateway rate limit exceeded',
      ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
    },
  }
  return Object.assign(new Error('lark-cli 退出码 1：OpenAPI gateway rate limit exceeded'), {
    exitCode: 1,
    stdout: '',
    stderr: JSON.stringify(envelope),
  })
}

/** 非限流错误：不许被误当成 429。 */
function permissionError() {
  const envelope = {
    ok: false,
    identity: 'user',
    error: { type: 'authorization', subtype: 'missing_scope', code: 99991679, message: 'Permission denied' },
  }
  return Object.assign(new Error('lark-cli 退出码 1：Permission denied'), {
    exitCode: 1,
    stdout: '',
    stderr: JSON.stringify(envelope),
  })
}

function createFakeLark({ chatPages = [], messagePages = {}, override, delayMs = 0 } = {}) {
  const calls = []
  const stats = { inFlight: 0, maxInFlight: 0 }

  const exec = async args => {
    calls.push(args)
    stats.inFlight += 1
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
    try {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      const custom = override ? await override(args, calls.length) : undefined
      if (custom instanceof Error) throw custom
      if (custom !== undefined) return custom

      const token = flagValue(args, '--page-token')
      if (args[1] === '+chat-list') {
        return { stdout: JSON.stringify(chatListEnvelope(pageAt(chatPages, token))) }
      }
      const chatId = flagValue(args, '--chat-id')
      return { stdout: JSON.stringify(messageListEnvelope(pageAt(messagePages[chatId] ?? [], token))) }
    } finally {
      stats.inFlight -= 1
    }
  }

  return { exec, calls, stats }
}

function messageCalls(fake) {
  return fake.calls.filter(args => args[1] === '+chat-messages-list')
}

/**
 * 每个测试一个临时状态目录；poller 只认注入的 exec/now/sleep。
 * prepare(dir) 在建 poller 之前跑，用来伪造「上一个进程留下的水位」。
 */
function createTestPoller(t, { fake, prepare, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-lark-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (prepare) prepare(dir)
  const emitted = []
  const logs = []
  const poller = createPoller({
    exec: fake.exec,
    stateDir: dir,
    now: () => NOW,
    sleep: async () => {},
    offsetMinutes: OFFSET,
    intervalMs: INTERVAL,
    emit: envelope => emitted.push(envelope),
    log: line => logs.push(line),
    ...options,
  })
  return {
    poller,
    dir,
    emitted,
    logs,
    fake,
    statusFile: join(dir, 'sources', 'feishu.status.json'),
    watermarkFile: join(dir, 'watermarks', 'feishu.json'),
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------
// 纯函数：时间
// ---------------------------------------------------------------------------

test('create_time 的三种形态都转成带时区的 ISO', () => {
  // 毫秒时间戳（原始 API 透出来的样子）
  assert.equal(toZonedIso('1753777093016', { offsetMinutes: OFFSET }), '2025-07-29T16:18:13.016+08:00')
  // shortcut 按本机时区格式化、不带时区、只有分钟精度
  assert.equal(toZonedIso('2026-11-14 19:40', { offsetMinutes: OFFSET }), '2026-11-14T19:40:00+08:00')
  assert.equal(toZonedIso('2026-11-14 19:40:33', { offsetMinutes: OFFSET }), '2026-11-14T19:40:33+08:00')
  // 本来就带时区
  assert.equal(toZonedIso('2026-11-14T19:40:00+08:00', { offsetMinutes: OFFSET }), '2026-11-14T19:40:00+08:00')
})

test('不带时区的时间按传入偏移解释，不偷偷当 UTC', () => {
  assert.equal(toZonedIso('2026-11-14 19:40', { offsetMinutes: OFFSET }), '2026-11-14T19:40:00+08:00')
  assert.equal(toZonedIso('2026-11-14 19:40', { offsetMinutes: 0 }), '2026-11-14T19:40:00+00:00')
  assert.equal(toZonedIso('2026-11-14 19:40', { offsetMinutes: -300 }), '2026-11-14T19:40:00-05:00')
})

test('解析不出来的时间返回 null，不猜', () => {
  assert.equal(toZonedIso('', { offsetMinutes: OFFSET }), null)
  assert.equal(toZonedIso('昨天下午', { offsetMinutes: OFFSET }), null)
  assert.equal(toZonedIso(undefined, { offsetMinutes: OFFSET }), null)
  assert.equal(toZonedIso(null, { offsetMinutes: OFFSET }), null)
})

// ---------------------------------------------------------------------------
// 纯函数：退避与限流识别
// ---------------------------------------------------------------------------

test('429 退避是 1s、2s、4s…，封顶 60s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(attempt => backoffMs(attempt)), [1000, 2000, 4000, 8000, 16000, 32000])
  assert.equal(backoffMs(6), 60000)
  assert.equal(backoffMs(99), 60000)
})

test('只有真的 429 才算限流', () => {
  assert.equal(isRateLimited(rateLimitError()), true)
  assert.equal(isRateLimited({ status: 429 }), true)
  assert.equal(isRateLimited(permissionError()), false)
  assert.equal(isRateLimited(new Error('socket hang up')), false)
  assert.equal(isRateLimited(null), false)
})

test('服务端给了 retry_after_seconds 就照办', () => {
  assert.equal(retryAfterMs(rateLimitError({ retryAfterSeconds: 3 })), 3000)
  assert.equal(retryAfterMs(rateLimitError()), 0)
  assert.equal(retryAfterMs(new Error('普通错误')), 0)
})

// ---------------------------------------------------------------------------
// 纯函数：正文与信封
// ---------------------------------------------------------------------------

test('正文只取消息文本，绝不把原始 JSON 塞进 text', () => {
  // shortcut 已经把 content 渲染成可读文本
  assert.equal(extractText({ content: '  作业 DDL 改到 25 号  ' }), '作业 DDL 改到 25 号')
  // raw JSON 形态：拆出正文
  assert.equal(extractText({ content: '{"text":"收到"}' }), '收到')
  assert.equal(
    extractText({
      content: JSON.stringify({
        title: '周报',
        content: [
          [{ tag: 'text', text: '第一行' }],
          [{ tag: 'a', href: 'https://my.feishu.cn/wiki/x' }],
        ],
      }),
    }),
    '周报\n第一行\nhttps://my.feishu.cn/wiki/x',
  )
  // 卡片类 markup 是可读文本，原样保留
  assert.equal(extractText({ content: '<card title="安全登录通知">\n**登录时间**：16:18\n</card>' }).startsWith('<card'), true)
  // 拆不出正文就给空字符串，而不是把 JSON 当正文
  const unknown = extractText({ content: '{"some_key":"x"}' })
  assert.equal(unknown, '')
  assert.equal(unknown.includes('{'), false)
  assert.equal(extractText({}), '')
})

test('信封：id / at / actor / meta 四项按票据给', () => {
  const envelope = toEnvelope({
    message: {
      message_id: 'om_1',
      create_time: '2026-11-14 19:40',
      content: '合同我看过了',
      sender: { id: 'ou_self', name: '陈' },
    },
    chat: { chatId: 'oc_x', name: '项目群' },
    offsetMinutes: OFFSET,
    selfId: 'ou_self',
  })
  assert.deepEqual(envelope, {
    id: 'feishu:oc_x:om_1',
    source: 'feishu',
    at: '2026-11-14T19:40:00+08:00',
    actor: 'self',
    text: '合同我看过了',
    meta: { chat: '项目群', chat_id: 'oc_x', sender: '陈', sender_id: 'ou_self' },
  })

  // 别人发的
  const other = toEnvelope({
    message: { message_id: 'om_2', create_time: '2026-11-14 19:41', content: '收到', sender: { id: 'ou_x', name: '王' } },
    chat: { chatId: 'oc_x', name: '项目群' },
    offsetMinutes: OFFSET,
    selfId: 'ou_self',
  })
  assert.equal(other.actor, 'other')

  // 缺幂等键或时间：返回 null，由调用方记日志（不猜、不编）
  assert.equal(toEnvelope({ message: { content: 'x' }, chat: { chatId: 'oc_x' }, offsetMinutes: OFFSET }), null)
})

test('信封能通过 core 的准入（at 一定带时区）', () => {
  const envelope = toEnvelope({
    message: { message_id: 'om_1', create_time: '2026-11-14 19:40', content: 'hi', sender: { id: 'ou_x', name: '王' } },
    chat: { chatId: 'oc_x', name: '项目群' },
    offsetMinutes: OFFSET,
  })
  const normalized = normalize(envelope)
  assert.equal(normalized.error, undefined)
  assert.equal(normalized.id, envelope.id)
  assert.equal(normalized.source, 'feishu')
})

// ---------------------------------------------------------------------------
// 纯函数：分页信封解析（两种形状都认）
// ---------------------------------------------------------------------------

test('会话列表解析容错：data.chats + page_token，以及顶层 items + pageToken', () => {
  const current = parseChatList(
    JSON.stringify({
      ok: true,
      identity: 'user',
      data: { chats: [{ chat_id: 'oc_a', name: '项目群', chat_mode: 'group' }], has_more: true, page_token: 't2' },
      meta: { pagination: { complete: false, next_token: 't2' } },
    }),
  )
  assert.deepEqual(current, { chats: [{ chatId: 'oc_a', name: '项目群', mode: 'group' }], hasMore: true, nextToken: 't2' })

  // 另一种形状：扁平顶层 + items + pageToken，没有 data
  const flat = parseChatList(
    JSON.stringify({ items: [{ chat_id: 'oc_b', name: '私聊', chat_mode: 'p2p' }], hasMore: true, pageToken: 'p9' }),
  )
  assert.deepEqual(flat, { chats: [{ chatId: 'oc_b', name: '私聊', mode: 'p2p' }], hasMore: true, nextToken: 'p9' })

  // 只有 meta.pagination 描述分页
  const metaOnly = parseChatList(
    JSON.stringify({ ok: true, data: { chats: [] }, meta: { pagination: { complete: false, next_token: 'm1' } } }),
  )
  assert.deepEqual(metaOnly, { chats: [], hasMore: true, nextToken: 'm1' })

  // 说还有下一页却没给游标：当作翻完了，不能原地打转
  assert.deepEqual(parseChatList(JSON.stringify({ ok: true, data: { chats: [], has_more: true } })), {
    chats: [],
    hasMore: false,
    nextToken: null,
  })

  // 失败信封直接抛，且带上足够信息
  assert.throws(() => parseChatList(JSON.stringify({ ok: false, error: { type: 'validation', message: 'bad' } })), /返回失败/)
  assert.throws(() => parseChatList(''), /返回失败/)
})

test('消息列表解析容错：data.messages 与顶层 items', () => {
  const current = parseMessageList(
    JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_1' }], has_more: true, page_token: 'p2' } }),
  )
  assert.deepEqual(current, { messages: [{ message_id: 'om_1' }], hasMore: true, nextToken: 'p2' })

  const flat = parseMessageList(JSON.stringify({ items: [{ message_id: 'om_2' }], hasMore: false }))
  assert.deepEqual(flat, { messages: [{ message_id: 'om_2' }], hasMore: false, nextToken: null })

  assert.deepEqual(parseMessageList(JSON.stringify({ ok: true, data: {} })), { messages: [], hasMore: false, nextToken: null })
})

// ---------------------------------------------------------------------------
// 轮询器：分页、水位、幂等、并发、限流
// ---------------------------------------------------------------------------

test('会话枚举必须翻完所有分页，不把第一页当全部', async t => {
  const chats = [chat('oc_0', '群0'), chat('oc_1', '群1'), chat('oc_2', '群2')]
  const fake = createFakeLark({
    chatPages: [
      { chats: [chats[0]], next: '1' },
      { chats: [chats[1]], next: '2' },
      { chats: [chats[2]] },
    ],
    messagePages: Object.fromEntries(
      chats.map(item => [item.chat_id, [{ messages: [message(`om_${item.chat_id}`, item.chat_id, '2026-11-15 08:59', 'hi')] }]]),
    ),
  })
  const ctx = createTestPoller(t, { fake })

  const result = await ctx.poller.pollOnce()

  assert.equal(result.chats, 3)
  assert.deepEqual(ctx.emitted.map(envelope => envelope.id), ['feishu:oc_0:om_oc_0', 'feishu:oc_1:om_oc_1', 'feishu:oc_2:om_oc_2'])
  const tokens = fake.calls.filter(args => args[1] === '+chat-list').map(args => flagValue(args, '--page-token'))
  assert.deepEqual(tokens, [null, '1', '2'])
  assert.equal(result.requests, 3 + 3)
})

test('单会话的消息也要翻完分页，不能只交第一页', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: {
      oc_a: [
        { messages: [message('om_1', 'oc_a', '2026-11-15 08:58', '第一条')], next: '1' },
        { messages: [message('om_2', 'oc_a', '2026-11-15 08:59', '第二条')] },
      ],
    },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()

  assert.deepEqual(ctx.emitted.map(envelope => envelope.id), ['feishu:oc_a:om_1', 'feishu:oc_a:om_2'])
  assert.deepEqual(messageCalls(fake).map(args => flagValue(args, '--page-token')), [null, '1'])
  assert.deepEqual(messageCalls(fake).map(args => flagValue(args, '--start')), [
    '2026-11-15T09:00:00+08:00',
    '2026-11-15T09:00:00+08:00',
  ])
})

test('水位按会话存到 watermarks/feishu.json，下一轮从水位往后取', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: { oc_a: [{ messages: [message('om_1', 'oc_a', '2026-11-15 08:58', '第一条')] }] },
  })
  const ctx = createTestPoller(t, {
    fake,
    // 模拟上一个进程留下的水位：重启后必须从这里接着取
    prepare: dir =>
      writeJsonAtomic(join(dir, 'watermarks', 'feishu.json'), {
        source: 'feishu',
        version: 1,
        chats: { oc_a: { at: '2026-11-15T08:50:00+08:00', message_id: 'om_0' } },
      }),
  })

  await ctx.poller.pollOnce()

  const saved = readJson(ctx.watermarkFile)
  assert.equal(saved.chats.oc_a.at, '2026-11-15T08:58:00+08:00')
  assert.equal(saved.chats.oc_a.message_id, 'om_1')
  assert.deepEqual(ctx.poller.watermarks(), {
    oc_a: { at: '2026-11-15T08:58:00+08:00', messageId: 'om_1', name: '项目群' },
  })

  await ctx.poller.pollOnce()

  // 第一轮从文件里的水位起步，第二轮从上一轮推进后的水位起步
  assert.deepEqual(messageCalls(fake).map(args => flagValue(args, '--start')), [
    '2026-11-15T08:50:00+08:00',
    '2026-11-15T08:58:00+08:00',
  ])
})

test('第一次见到的会话从当前分钟起步，不回溯历史', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_new', '新群')] }],
    messagePages: { oc_new: [{ messages: [message('om_1', 'oc_new', '2026-11-15 08:58', '历史消息')] }] },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()

  assert.equal(flagValue(messageCalls(fake)[0], '--start'), '2026-11-15T09:00:00+08:00')
  // 水位取「本轮起点」和「最新消息」里更靠后的那个：单调，且不会把起点往后拉回去
  assert.equal(readJson(ctx.watermarkFile).chats.oc_new.at, '2026-11-15T09:00:00+08:00')
  // 消息本身该交还是交了，不因为起点比它新就吞掉
  assert.deepEqual(ctx.emitted.map(envelope => envelope.id), ['feishu:oc_new:om_1'])
})

test('新消息让水位继续前进', async t => {
  let calls = 0
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    override: args => {
      if (args[1] !== '+chat-messages-list') return undefined
      calls += 1
      const messages =
        calls === 1
          ? [message('om_1', 'oc_a', '2026-11-15 08:58', '第一条')]
          : [message('om_1', 'oc_a', '2026-11-15 08:58', '第一条'), message('om_2', 'oc_a', '2026-11-15 09:03', '第二条')]
      return { stdout: JSON.stringify(messageListEnvelope({ messages })) }
    },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()
  await ctx.poller.pollOnce()

  assert.equal(readJson(ctx.watermarkFile).chats.oc_a.at, '2026-11-15T09:03:00+08:00')
  assert.deepEqual(ctx.emitted.map(envelope => envelope.id), ['feishu:oc_a:om_1', 'feishu:oc_a:om_1', 'feishu:oc_a:om_2'])
})

test('同一条消息被两轮取到：id 稳定，下游按 id 幂等', async t => {
  const same = message('om_same', 'oc_a', '2026-11-15 08:59', '只发了一次')
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: { oc_a: [{ messages: [same] }] },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()
  await ctx.poller.pollOnce()

  // 重采会再交一次（水位按分钟精度，同一分钟会重合），但 id 一模一样：库里只有一行
  assert.equal(ctx.emitted.length, 2)
  assert.deepEqual([...new Set(ctx.emitted.map(envelope => envelope.id))], ['feishu:oc_a:om_same'])
  assert.equal(new Set(ctx.emitted.map(envelope => JSON.stringify(envelope))).size, 1)
})

test('同一轮内重复出现的消息只交一次', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: {
      oc_a: [
        { messages: [message('om_1', 'oc_a', '2026-11-15 08:59', 'hi')], next: '1' },
        { messages: [message('om_1', 'oc_a', '2026-11-15 08:59', 'hi')] },
      ],
    },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()

  assert.deepEqual(ctx.emitted.map(envelope => envelope.id), ['feishu:oc_a:om_1'])
})

test('429：指数退避 + degraded 状态文件，恢复后回 normal', async t => {
  let limited = 3
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: { oc_a: [{ messages: [message('om_1', 'oc_a', '2026-11-15 08:59', 'hi')] }] },
    override: args => {
      if (args[1] !== '+chat-messages-list') return undefined
      if (limited <= 0) return undefined
      limited -= 1
      return rateLimitError()
    },
  })
  const ctx = createTestPoller(t, { fake })

  const first = await ctx.poller.pollOnce()
  assert.equal(first.rateLimited, true)
  assert.equal(first.nextDelayMs, 1000)
  assert.equal(first.events, 0)
  assert.equal(ctx.poller.status().state, 'degraded')
  const degraded = readJson(ctx.statusFile)
  assert.equal(degraded.state, 'degraded')
  assert.equal(degraded.consecutive_rate_limits, 1)
  assert.equal(degraded.next_attempt_at, '2026-11-15T09:00:01+08:00')
  assert.ok(degraded.reason.includes('rate limit'))
  // 限流那一轮不许推进水位
  assert.equal(ctx.poller.watermarks().oc_a, undefined)

  assert.equal((await ctx.poller.pollOnce()).nextDelayMs, 2000)
  assert.equal((await ctx.poller.pollOnce()).nextDelayMs, 4000)
  assert.equal(readJson(ctx.statusFile).consecutive_rate_limits, 3)

  const recovered = await ctx.poller.pollOnce()
  assert.equal(recovered.rateLimited, false)
  assert.equal(recovered.state, 'normal')
  assert.equal(recovered.nextDelayMs, INTERVAL)
  assert.equal(ctx.emitted.length, 1)
  assert.equal(readJson(ctx.statusFile).state, 'normal')
  assert.equal(readJson(ctx.statusFile).consecutive_rate_limits, 0)
  assert.equal(readJson(ctx.statusFile).next_attempt_at, null)
})

test('retry_after_seconds 比指数退避长时以它为准，但不超过 60s', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    override: args => (args[1] === '+chat-messages-list' ? rateLimitError({ retryAfterSeconds: 7 }) : undefined),
  })
  const ctx = createTestPoller(t, { fake })
  assert.equal((await ctx.poller.pollOnce()).nextDelayMs, 7000)

  const huge = createFakeLark({
    chatPages: [{ chats: [chat('oc_b', '项目群')] }],
    override: args => (args[1] === '+chat-messages-list' ? rateLimitError({ retryAfterSeconds: 3600 }) : undefined),
  })
  const other = createTestPoller(t, { fake: huge })
  assert.equal((await other.poller.pollOnce()).nextDelayMs, 60000)
})

test('一个会话被 429 后本轮不再继续打接口，失败会话的水位不动', async t => {
  const chats = Array.from({ length: 5 }, (_, index) => chat(`oc_${index}`, `群${index}`))
  const fake = createFakeLark({
    chatPages: [{ chats }],
    messagePages: Object.fromEntries(chats.map(item => [item.chat_id, [{ messages: [] }]])),
    override: args => (flagValue(args, '--chat-id') === 'oc_0' ? rateLimitError() : undefined),
  })
  const ctx = createTestPoller(t, { fake, concurrency: 1 })

  const result = await ctx.poller.pollOnce()

  assert.equal(result.rateLimited, true)
  assert.equal(result.chats, 5)
  // 会话枚举 1 次 + 撞上 429 的那 1 次，之后收手
  assert.equal(result.requests, 2)
  assert.equal(ctx.poller.watermarks().oc_0, undefined)
  assert.deepEqual(ctx.emitted, [])
})

test('非限流错误：本轮记错、水位不动、下一轮照常补上', async t => {
  let failing = true
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: { oc_a: [{ messages: [message('om_1', 'oc_a', '2026-11-15 08:59', 'hi')] }] },
    override: args => {
      if (args[1] !== '+chat-messages-list' || !failing) return undefined
      failing = false
      return permissionError()
    },
  })
  const ctx = createTestPoller(t, { fake })

  const first = await ctx.poller.pollOnce()
  assert.ok(first.error)
  assert.equal(first.state, 'normal') // 不是 429 就不降频
  assert.equal(first.rateLimited, false)
  assert.deepEqual(ctx.emitted, [])
  assert.equal(ctx.poller.watermarks().oc_a, undefined)

  const second = await ctx.poller.pollOnce()
  assert.equal(second.error, null)
  assert.deepEqual(ctx.emitted.map(envelope => envelope.id), ['feishu:oc_a:om_1'])
  // 补齐之后水位落在本轮起点（比消息时间新，取最大值）
  assert.equal(readJson(ctx.watermarkFile).chats.oc_a.at, '2026-11-15T09:00:00+08:00')
})

test('一轮内并发不超过上限，且确实并行', async t => {
  const chats = Array.from({ length: 20 }, (_, index) => chat(`oc_${index}`, `群${index}`))
  const fake = createFakeLark({
    chatPages: [{ chats }],
    messagePages: Object.fromEntries(chats.map(item => [item.chat_id, [{ messages: [] }]])),
    delayMs: 5,
  })
  const ctx = createTestPoller(t, { fake, concurrency: 4 })

  await ctx.poller.pollOnce()

  assert.ok(fake.stats.maxInFlight <= 4, `并发 ${fake.stats.maxInFlight} 超过上限 4`)
  assert.ok(fake.stats.maxInFlight > 1, '没有真的并发')
  assert.equal(messageCalls(fake).length, 20) // 每个会话都要拉一次，一个都不能少
})

test('空会话列表不崩', async t => {
  const fake = createFakeLark({ chatPages: [{ chats: [] }] })
  const ctx = createTestPoller(t, { fake })

  const result = await ctx.poller.pollOnce()

  assert.equal(result.chats, 0)
  assert.equal(result.events, 0)
  assert.equal(result.requests, 1)
  assert.equal(result.state, 'normal')
  assert.deepEqual(ctx.emitted, [])
  assert.equal(readJson(ctx.statusFile).state, 'normal')
})

test('全程 --as user，且只用轮询不用事件订阅', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: { oc_a: [{ messages: [message('om_1', 'oc_a', '2026-11-15 08:59', 'hi')] }] },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()

  assert.equal(fake.calls.length, 2)
  for (const args of fake.calls) {
    assert.equal(flagValue(args, '--as'), 'user')
    assert.equal(args[0], 'im')
    assert.equal(args.includes('event'), false)
    assert.equal(args.includes('consume'), false)
  }
  // 会话枚举的两个类型都要带上
  assert.equal(flagValue(fake.calls[0], '--types'), 'p2p,group')
  // 消息按时间升序取
  assert.equal(flagValue(fake.calls[1], '--order'), 'asc')
})

test('每轮把请求数 / 耗时 / 状态写到日志', async t => {
  const fake = createFakeLark({
    chatPages: [{ chats: [chat('oc_a', '项目群')] }],
    messagePages: { oc_a: [{ messages: [message('om_1', 'oc_a', '2026-11-15 08:59', 'hi')] }] },
  })
  const ctx = createTestPoller(t, { fake })

  await ctx.poller.pollOnce()

  const round = ctx.logs.find(line => line.includes('round'))
  assert.ok(round)
  assert.match(round, /requests=2\b/)
  assert.match(round, /duration=\d+ms\b/)
  assert.match(round, /state=normal\b/)
})

test('run() 按退避节奏睡，stop() 后就退出', async t => {
  let round = 0
  const fake = createFakeLark({
    chatPages: [{ chats: [] }],
    override: args => {
      if (args[1] !== '+chat-list') return undefined
      round += 1
      return round <= 2 ? rateLimitError() : undefined
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'pc-lark-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const slept = []
  const poller = createPoller({
    exec: fake.exec,
    stateDir: dir,
    now: () => NOW,
    offsetMinutes: OFFSET,
    intervalMs: INTERVAL,
    emit: () => {},
    log: () => {},
    sleep: async ms => {
      slept.push(ms)
      if (slept.length >= 3) poller.stop()
    },
  })

  await poller.run()

  assert.deepEqual(slept, [1000, 2000, INTERVAL])
  assert.equal(poller.stopped, true)
})

test('没注入 exec 直接报错，不装作能用', () => {
  assert.throws(() => createPoller({ stateDir: '/tmp/pc-lark-nope' }), /exec/)
})

// ---------------------------------------------------------------------------
// 启动自检：没装 / 没登录就别装作在跑
// ---------------------------------------------------------------------------

/** 假的 lark-cli 进程：version 成功，auth status 按需返回或抛错。 */
function fakeCli({ version = 'lark-cli version 1.0.96\n', auth }) {
  return async args => {
    if (args[0] === '--version') return { stdout: version }
    if (args[0] === 'auth' && args[1] === 'status') return auth()
    throw new Error(`没料到的调用：${args.join(' ')}`)
  }
}

test('未安装：stderr 中文说明并退出 1', async () => {
  const written = []
  const code = await main({
    env: { PERSONAL_CONTEXT_SOURCE_LARK_CLI: '/nonexistent/definitely-no-lark-cli', PERSONAL_CONTEXT_STATE_DIR: '/tmp/pc-lark-not-installed' },
    err: { write: line => written.push(line) },
  })

  assert.equal(code, 1)
  assert.match(written.join(''), /找不到 lark-cli/)
  assert.match(written.join(''), /PERSONAL_CONTEXT_SOURCE_LARK_CLI/)
})

test('未登录：自检拒绝启动，并说清楚怎么登录', async () => {
  const result = await preflight(fakeCli({
    auth: () => ({
      stdout: JSON.stringify({ identities: { user: { status: 'not_logged_in', available: false } } }),
    }),
  }))

  assert.equal(result.ok, false)
  assert.match(result.message, /未就绪/)
  assert.match(result.message, /auth login/)
})

test('auth status 非零退出时，仍从错误信封里的身份信息判断', async () => {
  const result = await preflight(fakeCli({
    auth: () => {
      throw Object.assign(new Error('lark-cli 退出码 1'), {
        stderr: JSON.stringify({ ok: false, identities: { user: { status: 'expired', tokenStatus: 'expired' } } }),
      })
    },
  }))

  assert.equal(result.ok, false)
  assert.match(result.message, /expired/)
})

test('已登录：自检交出本人 open_id，用来区分 actor=self', async () => {
  const result = await preflight(fakeCli({
    auth: () => ({
      stdout: JSON.stringify({
        identities: { user: { status: 'ready', available: true, tokenStatus: 'valid', openId: 'ou_self' } },
      }),
    }),
  }))

  assert.deepEqual(result, { ok: true, selfId: 'ou_self' })
})
