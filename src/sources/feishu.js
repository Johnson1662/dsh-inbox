/**
 * 飞书来源：轮询 lark-cli（本人身份）→ 信封 NDJSON 到 stdout，日志走 stderr。
 *
 * 为什么是轮询而不是事件订阅：`event consume` 只支持 bot 身份，见
 * docs/adr/0003-飞书只能轮询.md。`im +chat-list` 又不返回最后消息时间，
 * 所以成本必然是「会话数 × 轮询频率」，只能靠并发拉 + 遇 429 自动降频。
 *
 * 三层分界（为了可测，也为了这文件能单独看懂）：
 *   1. 纯函数：时间换算、分页信封解析、正文抽取、退避计算、429 识别 —— 零 IO
 *   2. createPoller：只依赖注入的 exec(args) → { stdout }、now()、sleep()、stateDir
 *   3. createCliExec / main：真正的子进程与进程生命周期，只在被直接执行时启动
 *
 * 不变式：
 *   - 全程 `--as user`；不碰 `event consume`（user 身份不支持）
 *   - 先交出消息，再推进水位：进度丢了最多重采（id 幂等兜底），消息丢了没法补
 *   - 分页必须翻完：会话枚举和每个会话的消息都翻到 has_more=false 才算这一轮完
 *   - 429 只降频不退场：写 degraded，指数退避，恢复后回 normal
 *   - lark-cli 的输出按信封字段拆开；原始 JSON 绝不进 text
 *
 * 字段形状：按 `lark-cli im +chat-list --help` / `+chat-messages-list --help`
 * 与本地实跑输出核对过（2026-11-15，lark-cli 1.0.96），成功信封是
 * { ok, identity, data:{ chats | messages, has_more, page_token }, meta:{ pagination:{ complete, next_token } } }。
 * 但解析写成容错的：chats/messages 之外也认 items，page_token 之外也认 pageToken，
 * 顶层扁平形状也认 —— 换版本、换实现不至于整路瞎掉。真机首跑仍需核对一遍。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const SOURCE = 'feishu'

export const DEFAULTS = Object.freeze({
  cli: 'lark-cli',
  stateDir: '~/.dsh/state/personal-context',
  intervalMs: 5000,
  concurrency: 8,
  chatPageSize: 100,
  messagePageSize: 50,
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
  // 分页硬上限：触顶要喊出来，不能把「翻到上限」当「翻完了」
  maxPages: 1000,
  timeoutMs: 60000,
})

// ---------------------------------------------------------------------------
// 纯函数：时间
// ---------------------------------------------------------------------------

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?$/

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** 本机时区相对 UTC 的偏移（分钟，东八区是 480）。 */
export function localOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset()
}

export function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(Math.round(offsetMinutes))
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 时间戳 → 带时区 ISO。时区是「表示成哪个偏移」，不做隐式换算。 */
export function isoFromEpoch(epochMs, offsetMinutes = 0) {
  const shifted = new Date(epochMs + offsetMinutes * 60000)
  const millis = shifted.getUTCMilliseconds()
  const fraction = millis ? `.${pad(millis, 3)}` : ''
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${fraction}${offsetLabel(offsetMinutes)}`
  )
}

/** 向下取整到分钟：新会话的起点用这个，保证「这一分钟」里已有的消息也算进来。 */
export function isoMinute(date, offsetMinutes = 0) {
  return isoFromEpoch(Math.floor(date.getTime() / 60000) * 60000, offsetMinutes)
}

/**
 * 消息自带的时间 → 带时区 ISO。
 *
 * lark-cli 的 create_time 有三种形态：
 *   - 毫秒时间戳 "1753777093016"（原始 API 透出来时的样子）
 *   - "2026-11-14 19:40"（shortcut 按**本机时区**格式化过，且只有分钟精度，不带时区）
 *   - 本来就带时区的 ISO
 * 不带时区的那种按传入的 offsetMinutes 解释并原样输出，不做二次换算。
 * 解析不出来返回 null —— 宁可让调用方跳过并记一条日志，也不猜。
 */
export function toZonedIso(value, { offsetMinutes = 0 } = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return isoFromEpoch(value < 1e11 ? value * 1000 : value, offsetMinutes)
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^\d{9,11}$/.test(text)) return isoFromEpoch(Number(text) * 1000, offsetMinutes)
  if (/^\d{12,}$/.test(text)) return isoFromEpoch(Number(text), offsetMinutes)

  const naive = NAIVE.exec(text)
  if (naive) {
    const [, y, mo, d, h, mi, s = '0', fraction = ''] = naive
    const millis = Number(fraction.slice(0, 3).padEnd(3, '0') || 0)
    const epoch =
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis) -
      offsetMinutes * 60000
    return isoFromEpoch(epoch, offsetMinutes)
  }

  if (ZONED.test(text)) {
    const epoch = Date.parse(text)
    return Number.isNaN(epoch) ? null : isoFromEpoch(epoch, offsetMinutes)
  }
  return null
}

// ---------------------------------------------------------------------------
// 纯函数：退避与限流识别
// ---------------------------------------------------------------------------

/** 429 的指数退避：1s、2s、4s… 封顶 60s。attempt 从 0 开始。 */
export function backoffMs(attempt, { base = DEFAULTS.backoffBaseMs, max = DEFAULTS.backoffMaxMs } = {}) {
  const step = Math.max(0, Math.floor(Number(attempt) || 0))
  return Math.min(base * 2 ** Math.min(step, 30), max)
}

const RATE_LIMIT_CODES = new Set([429, 99991400])
const RATE_LIMIT_TEXT = /\b429\b|rate[\s_-]?limit|too\s*many\s*requests?|99991400|限流|频率限制|请求过于频繁/i

export function parseJson(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {}
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

/** lark-cli 的失败信封：{ ok:false, error:{ type, subtype, code, message, retry_after_seconds } }。 */
export function cliErrorEnvelope(error) {
  for (const candidate of [error?.stderr, error?.stdout, error?.message]) {
    const parsed = parseJson(candidate)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  }
  return null
}

/** 真 429 才算 429：别的错误不算，免得把「没权限」当成「太快了」一直等。 */
export function isRateLimited(error) {
  if (!error) return false
  for (const key of ['status', 'statusCode', 'httpStatus', 'http_status']) {
    if (Number(error[key]) === 429) return true
  }
  const envelope = cliErrorEnvelope(error)
  const failure = envelope?.error ?? error?.larkError ?? null
  if (failure && RATE_LIMIT_CODES.has(Number(failure.code))) return true
  if (failure && /rate[\s_-]?limit|too[\s_-]?many/i.test(`${failure.type ?? ''} ${failure.subtype ?? ''}`)) {
    return true
  }
  const text = [error.message, error.stderr, error.stdout]
    .filter(value => typeof value === 'string')
    .join('\n')
  return RATE_LIMIT_TEXT.test(text)
}

/** 服务端明说了 retry_after_seconds 就照办（仍受 60s 上限约束）。 */
export function retryAfterMs(error) {
  const envelope = cliErrorEnvelope(error)
  const failure = envelope?.error ?? error?.larkError ?? {}
  const seconds = Number(failure?.retry_after_seconds ?? envelope?.retry_after_seconds)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
}

/** 一条人话的错误摘要，进日志和状态文件。 */
export function shortReason(error) {
  const failure = cliErrorEnvelope(error)?.error
  const text = failure?.message ?? error?.message ?? String(error ?? '')
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200)
}

// ---------------------------------------------------------------------------
// 纯函数：lark-cli 输出 → 会话 / 消息 / 正文
// ---------------------------------------------------------------------------

/**
 * 分页信封：以 data.has_more / data.page_token 为准，兼容 meta.pagination。
 * 「说还有下一页却没给游标」当作翻完了，否则会原地打转。
 */
function paginationOf(payload) {
  const data = pickField(payload, ['data']) ?? payload ?? {}
  const meta = pickField(payload, ['meta', 'metadata']) ?? {}
  const cursor = pickField(meta, ['pagination', 'page']) ?? {}
  const declared = pickField(data, ['has_more', 'hasMore'])
  const complete = pickField(cursor, ['complete', 'is_complete', 'isComplete'])
  const hasMore = declared !== undefined ? Boolean(declared) : complete === false
  const token =
    pickField(data, ['page_token', 'pageToken']) ??
    pickField(cursor, ['next_token', 'nextToken', 'page_token', 'pageToken']) ??
    null
  const nextToken = token ? String(token) : null
  return { hasMore: hasMore && Boolean(nextToken), nextToken }
}

/** 同一件事在不同版本里可能叫两个名字，取第一个有值的。 */
function pickField(object, names) {
  if (!object || typeof object !== 'object') return undefined
  for (const name of names) {
    const value = object[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 列表既可能在 data 里，也可能直接摊在顶层。 */
function listOf(payload, names) {
  const data = pickField(payload, ['data']) ?? payload ?? {}
  const list = pickField(data, names)
  return Array.isArray(list) ? list : []
}

function failureOf(payload) {
  if (!payload) return '输出不是 JSON'
  const failure = payload.error ?? {}
  const head = `${failure.type ?? 'unknown'}/${failure.subtype ?? '-'}`
  return [head, failure.code, failure.message].filter(value => value !== undefined && value !== '').join(' ')
}

/** ok:false 也要带够信息，这样 isRateLimited 仍能认出它是 429。 */
function envelopeError(kind, payload) {
  const error = new Error(`${kind} 返回失败：${failureOf(payload)}`)
  error.larkError = payload?.error ?? null
  error.stdout = JSON.stringify(payload ?? {})
  return error
}

export function parseChatList(stdout) {
  const payload = parseJson(stdout)
  if (!payload || payload.ok === false) throw envelopeError('chat-list', payload)
  const chats = listOf(payload, ['chats', 'items'])
    .map(chat => ({
      chatId: String(chat?.chat_id ?? ''),
      name: String(chat?.name ?? ''),
      mode: String(chat?.chat_mode ?? chat?.chat_type ?? ''),
    }))
    .filter(chat => chat.chatId)
  return { chats, ...paginationOf(payload) }
}

export function parseMessageList(stdout) {
  const payload = parseJson(stdout)
  if (!payload || payload.ok === false) throw envelopeError('chat-messages-list', payload)
  const messages = listOf(payload, ['messages', 'items'])
  return { messages, ...paginationOf(payload) }
}

/**
 * 正文：shortcut 已经把 content 渲染成可读文本，直接用。
 * 万一拿到的是 raw JSON（原始 API 形态），只拆出正文；拆不出来就给空字符串——
 * 绝不把整块 JSON 塞进 text。
 */
export function extractText(message) {
  const raw = typeof message?.content === 'string' ? message.content : ''
  const text = raw.trim()
  if (!text) return ''
  if (!/^[[{]/.test(text)) return text
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  return textFromJson(parsed)
}

function textFromJson(parsed) {
  if (Array.isArray(parsed)) return parsed.map(textFromJson).filter(Boolean).join('\n').trim()
  if (!parsed || typeof parsed !== 'object') return ''
  if (typeof parsed.text === 'string') return parsed.text.trim()
  if (Array.isArray(parsed.content)) {
    // 原生 post：{ title, content: [[{ tag, text | href }]] }
    const lines = []
    if (typeof parsed.title === 'string' && parsed.title.trim()) lines.push(parsed.title.trim())
    for (const row of parsed.content) {
      const line = (Array.isArray(row) ? row : [row])
        .map(cell => {
          if (typeof cell === 'string') return cell
          if (typeof cell?.text === 'string') return cell.text
          if (typeof cell?.href === 'string') return cell.href
          return ''
        })
        .join('')
        .trim()
      if (line) lines.push(line)
    }
    return lines.join('\n').trim()
  }
  if (typeof parsed.image_key === 'string') return '[图片]'
  if (typeof parsed.file_key === 'string') {
    return typeof parsed.file_name === 'string' && parsed.file_name ? `[文件] ${parsed.file_name}` : '[文件]'
  }
  return ''
}

/**
 * 一条飞书消息 → 一个信封。
 * 幂等键 `feishu:<chat_id>:<message_id>`：重采、重投都不会产生第二行。
 * meta 只放这四项（依 03 票据）；没有 message_id 或时间的返回 null，由调用方记日志。
 */
export function toEnvelope({ message, chat, offsetMinutes = 0, selfId = null } = {}) {
  const messageId = String(message?.message_id ?? '')
  const chatId = String(chat?.chatId ?? message?.chat_id ?? '')
  const at = toZonedIso(message?.create_time, { offsetMinutes })
  if (!messageId || !chatId || !at) return null

  const sender = message?.sender ?? {}
  const senderId = String(sender.id ?? '')
  return {
    id: `${SOURCE}:${chatId}:${messageId}`,
    source: SOURCE,
    at,
    actor: selfId && senderId === selfId ? 'self' : 'other',
    text: extractText(message),
    meta: {
      chat: chat?.name || chatId,
      chat_id: chatId,
      sender: String(sender.name ?? ''),
      sender_id: senderId,
    },
  }
}

// ---------------------------------------------------------------------------
// 文件：原子写
// ---------------------------------------------------------------------------

export function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/** 先写临时文件再 rename：守护进程/重启永远不会读到半个 JSON。 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readJsonFile(path) {
  try {
    return parseJson(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readWatermarks(path) {
  const parsed = readJsonFile(path)
  const chats = parsed?.chats && typeof parsed.chats === 'object' ? parsed.chats : {}
  const out = {}
  for (const [chatId, entry] of Object.entries(chats)) {
    const at = typeof entry === 'string' ? entry : entry?.at
    if (typeof at !== 'string' || !at) continue
    out[chatId] = {
      at,
      messageId: typeof entry?.message_id === 'string' ? entry.message_id : null,
      name: typeof entry?.chat === 'string' ? entry.chat : '',
    }
  }
  return out
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 轮询器：只认识注入的 exec / now / sleep
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {(args: string[]) => Promise<{stdout: string}>} options.exec 跑一次 lark-cli；失败必须抛错
 * @param {string} options.stateDir 状态目录（水印与状态文件都在它下面）
 * @param {() => Date} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(envelope: object) => void} [options.emit] 交出一个信封（生产里写 stdout NDJSON）
 * @param {(line: string) => void} [options.log] 日志（生产里写 stderr）
 * @param {number} [options.offsetMinutes] 解释不带时区的 create_time 用的偏移；默认取本机
 * @param {string|null} [options.selfId] 本人的 open_id，用来区分 actor=self
 */
export function createPoller({
  exec,
  stateDir = DEFAULTS.stateDir,
  now = () => new Date(),
  sleep = defaultSleep,
  emit = () => {},
  log = line => process.stderr.write(`${line}\n`),
  intervalMs = DEFAULTS.intervalMs,
  concurrency = DEFAULTS.concurrency,
  chatPageSize = DEFAULTS.chatPageSize,
  messagePageSize = DEFAULTS.messagePageSize,
  backoffBase = DEFAULTS.backoffBaseMs,
  backoffMax = DEFAULTS.backoffMaxMs,
  maxPages = DEFAULTS.maxPages,
  offsetMinutes,
  selfId = null,
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('createPoller 需要注入 exec(args) -> { stdout }')

  const home = expandHome(stateDir)
  const watermarkPath = join(home, 'watermarks', 'feishu.json')
  const statusPath = join(home, 'sources', 'feishu.status.json')
  const offset = offsetMinutes ?? localOffsetMinutes(now())
  const stamps = () => isoFromEpoch(now().getTime(), offset)

  const watermarks = readWatermarks(watermarkPath)
  let dirty = false
  let stopped = false
  let state = 'normal'
  let since = stamps()
  let reason = null
  let streak = 0
  let nextAttemptAt = null
  let lastBackoffMs = 0
  let persisted = null

  function statusSnapshot() {
    return { state, since, reason, streak, nextAttemptAt }
  }

  /** 状态只在真的变了才落盘。 */
  function persistStatus() {
    const snapshot = statusSnapshot()
    if (persisted && JSON.stringify(persisted) === JSON.stringify(snapshot)) return
    persisted = snapshot
    writeJsonAtomic(statusPath, {
      source: SOURCE,
      state,
      since,
      updated_at: stamps(),
      consecutive_rate_limits: streak,
      next_attempt_at: nextAttemptAt,
      reason,
    })
  }

  function persistWatermarks() {
    const chats = {}
    for (const [chatId, entry] of Object.entries(watermarks)) {
      chats[chatId] = { chat: entry.name ?? '', at: entry.at, message_id: entry.messageId ?? null }
    }
    writeJsonAtomic(watermarkPath, { source: SOURCE, version: 1, updated_at: stamps(), chats })
  }

  /** 429：写 degraded、算退避。返回这一轮之后该睡多久。 */
  function degrade(error) {
    streak += 1
    const delay = Math.min(
      Math.max(backoffMs(streak - 1, { base: backoffBase, max: backoffMax }), retryAfterMs(error)),
      backoffMax,
    )
    if (state !== 'degraded') {
      state = 'degraded'
      since = stamps()
    }
    reason = shortReason(error)
    nextAttemptAt = isoFromEpoch(now().getTime() + delay, offset)
    lastBackoffMs = delay
    persistStatus()
    log(`[feishu] 429 限流第 ${streak} 次：退避 ${delay}ms，状态 degraded`)
    return delay
  }

  /** 一整轮没有限流就回 normal，退避清零。 */
  function recover() {
    streak = 0
    nextAttemptAt = null
    reason = null
    lastBackoffMs = 0
    if (state !== 'normal') {
      state = 'normal'
      since = stamps()
      log('[feishu] 限流解除：状态 normal')
    }
  }

  function chatListArgs(token) {
    const args = [
      'im', '+chat-list',
      '--as', 'user',
      '--types', 'p2p,group',
      '--format', 'json',
      '--page-size', String(chatPageSize),
    ]
    if (token) args.push('--page-token', token)
    return args
  }

  function messageListArgs(chatId, startAt, token) {
    const args = [
      'im', '+chat-messages-list',
      '--as', 'user',
      '--chat-id', chatId,
      '--order', 'asc',
      '--format', 'json',
      '--page-size', String(messagePageSize),
      '--start', startAt,
    ]
    if (token) args.push('--page-token', token)
    return args
  }

  /** 会话枚举：翻完所有页，不把这 10 页当全部。 */
  async function listChats(call) {
    const chats = new Map()
    let token = null
    for (let page = 1; page <= maxPages; page += 1) {
      const result = parseChatList((await call(chatListArgs(token))).stdout)
      for (const chat of result.chats) if (!chats.has(chat.chatId)) chats.set(chat.chatId, chat)
      if (!result.hasMore) return [...chats.values()]
      if (result.nextToken === token) {
        log('[feishu] 会话枚举的游标没有前进，停止翻页')
        return [...chats.values()]
      }
      token = result.nextToken
    }
    log(`[feishu] 会话枚举翻到 ${maxPages} 页仍未结束：本轮只处理已拿到的 ${chats.size} 个会话`)
    return [...chats.values()]
  }

  /** 单会话增量：同样翻完所有页，否则这一轮的增量是残缺的。 */
  async function fetchMessages(chat, startAt, call) {
    const messages = []
    let token = null
    for (let page = 1; page <= maxPages; page += 1) {
      const result = parseMessageList((await call(messageListArgs(chat.chatId, startAt, token))).stdout)
      messages.push(...result.messages)
      if (!result.hasMore) return messages
      if (result.nextToken === token) {
        log(`[feishu] 会话 ${chat.chatId} 的消息游标没有前进，停止翻页`)
        return messages
      }
      token = result.nextToken
    }
    log(`[feishu] 会话 ${chat.chatId} 的消息翻到 ${maxPages} 页仍未结束，本轮取到 ${messages.length} 条`)
    return messages
  }

  async function pollChat(chat, call, stats, seen) {
    if (stats.rateLimited) return
    const known = watermarks[chat.chatId]
    // 第一次见到的会话从「当前分钟」开始：不回溯历史（回溯不在本期范围），
    // 但同一分钟里已有的消息仍然会拿到，不会漏。
    const startAt = known?.at ?? isoMinute(now(), offset)

    let messages
    try {
      messages = await fetchMessages(chat, startAt, call)
    } catch (error) {
      if (isRateLimited(error)) {
        stats.rateLimited = true
        degrade(error)
        return
      }
      stats.error = stats.error ?? error
      log(`[feishu] 会话 ${chat.chatId} 拉取失败，水位不动，下一轮重试：${shortReason(error)}`)
      return
    }

    let newest = startAt
    let newestId = known?.messageId ?? null
    let newestEpoch = Date.parse(startAt)

    for (const message of messages) {
      const envelope = toEnvelope({ message, chat, offsetMinutes: offset, selfId })
      if (!envelope) {
        stats.skipped += 1
        log(`[feishu] 跳过会话 ${chat.chatId} 的一条消息：缺 message_id 或时间`)
        continue
      }
      // 同一轮内的重复（分页重叠、水位重合）只交一次；跨轮的重复靠 id 幂等
      if (seen.has(envelope.id)) continue
      seen.add(envelope.id)
      emit(envelope)
      stats.events += 1

      const epoch = Date.parse(envelope.at)
      if (Number.isFinite(epoch) && epoch >= newestEpoch) {
        newestEpoch = epoch
        newest = envelope.at
        newestId = String(message?.message_id ?? '') || newestId
      }
    }

    if (!known || newest !== known.at || newestId !== (known.messageId ?? null)) {
      watermarks[chat.chatId] = { at: newest, messageId: newestId, name: chat.name }
      dirty = true
    }
  }

  /**
   * 一轮：枚举会话 → 并发拉增量 → 交信封 → 推水位。
   * 返回 { requests, durationMs, state, events, rateLimited, nextDelayMs }，
   * 同时把「请求数 / 耗时 / 状态」写一行到 stderr。
   */
  async function pollOnce() {
    const startedAt = now().getTime()
    const stats = {
      requests: 0,
      events: 0,
      skipped: 0,
      chats: 0,
      rateLimited: false,
      error: null,
    }
    const seen = new Set()
    const startedState = state

    const call = args => {
      stats.requests += 1
      return exec(args)
    }

    try {
      const chats = await listChats(call)
      stats.chats = chats.length
      if (chats.length) {
        await mapWithLimit(
          chats,
          concurrency,
          chat => pollChat(chat, call, stats, seen),
          // 限流或收到退出信号都不再发起新请求：已拿到的不丢，没拿到的保持原水位
          () => stats.rateLimited || stopped,
        )
      }
    } catch (error) {
      if (isRateLimited(error)) {
        stats.rateLimited = true
        degrade(error)
      } else {
        stats.error = error
        log(`[feishu] 本轮失败（不是限流）：${shortReason(error)}`)
      }
    } finally {
      if (dirty) {
        persistWatermarks()
        dirty = false
      }
    }

    if (!stats.rateLimited && !stats.error) recover()
    persistStatus()

    const durationMs = now().getTime() - startedAt
    const nextDelayMs = stats.rateLimited ? lastBackoffMs : intervalMs
    log(
      `[feishu] round requests=${stats.requests} duration=${durationMs}ms state=${state} ` +
        `events=${stats.events} chats=${stats.chats}` +
        (stats.skipped ? ` skipped=${stats.skipped}` : '') +
        (stats.error ? ` error=${shortReason(stats.error)}` : '') +
        (stats.rateLimited ? ` backoff=${nextDelayMs}ms` : '') +
        (startedState !== state ? ` ${startedState}->${state}` : ''),
    )

    return { ...stats, durationMs, state, nextDelayMs }
  }

  async function run({ rounds = Infinity } = {}) {
    let done = 0
    while (!stopped && done < rounds) {
      const result = await pollOnce()
      done += 1
      if (stopped) break
      await sleep(result.nextDelayMs)
    }
    return done
  }

  return {
    pollOnce,
    run,
    stop() {
      stopped = true
    },
    get stopped() {
      return stopped
    },
    status() {
      return { ...statusSnapshot(), nextAttemptAt }
    },
    watermarks() {
      return JSON.parse(JSON.stringify(watermarks))
    },
    paths: { status: statusPath, watermarks: watermarkPath },
  }
}

/** 并发上限是硬约束：同时在飞的请求不超过 width 个。 */
async function mapWithLimit(items, limit, worker, aborted = () => false) {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1))
  let index = 0
  const runners = Array.from({ length: width }, async () => {
    while (index < items.length && !aborted()) {
      const item = items[index]
      index += 1
      await worker(item)
    }
  })
  await Promise.all(runners)
}

// ---------------------------------------------------------------------------
// 子进程：真的 lark-cli
// ---------------------------------------------------------------------------

/**
 * 可执行文件由 PERSONAL_CONTEXT_SOURCE_LARK_CLI 指定（默认 lark-cli）。
 * 成功 resolve({ stdout })；失败 reject，错误对象带 exitCode / stdout / stderr。
 */
export function createCliExec({ bin = DEFAULTS.cli, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  return function exec(args) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(error)
        return
      }
      const out = []
      const err = []
      let settled = false
      const timer = timeoutMs
        ? setTimeout(() => {
            if (settled) return
            child.kill('SIGTERM')
            const error = Object.assign(new Error(`lark-cli 超时（${timeoutMs}ms）：${args.join(' ')}`), {
              exitCode: null,
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(err).toString('utf8'),
              timeout: true,
            })
            settle(() => reject(error))
          }, timeoutMs)
        : null
      timer?.unref?.()

      function settle(fn) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
      child.on('error', error => settle(() => reject(error)))
      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        settle(() => {
          if (code === 0) {
            resolve({ stdout, stderr, exitCode: 0 })
            return
          }
          // 被信号打断（关机、超时清理）和被服务端拒绝是两码事，日志里要能分辨
          const head = signal
            ? `lark-cli 被 ${signal} 终止`
            : stderr.trim().split('\n')[0] || `lark-cli 退出码 ${code}`
          reject(Object.assign(new Error(head), { exitCode: code, signal, stdout, stderr, args }))
        })
      })
    })
  }
}

/**
 * 启动自检：没装 / 没登录就别装作在跑。
 * 返回 { ok:true, selfId } 或 { ok:false, message }（message 直接给用户看）。
 */
export async function preflight(exec) {
  try {
    await exec(['--version'])
  } catch (error) {
    const missing = error?.code === 'ENOENT' || /ENOENT|not found/i.test(String(error?.message ?? ''))
    if (missing) {
      return {
        ok: false,
        message:
          '找不到 lark-cli 可执行文件。请先安装 lark-cli 并完成 lark-cli config init，' +
          '或用环境变量 PERSONAL_CONTEXT_SOURCE_LARK_CLI 指定可执行文件路径。',
      }
    }
    return { ok: false, message: `调用 lark-cli 失败：${shortReason(error)}` }
  }

  let status = null
  try {
    status = parseJson((await exec(['auth', 'status', '--json'])).stdout)
  } catch (error) {
    status = parseJson(error?.stdout) ?? parseJson(error?.stderr)
    if (!status) {
      return {
        ok: false,
        message: '读不到 lark-cli 的登录状态。请先执行 lark-cli auth login 完成飞书授权（本来源全程使用 --as user）。',
      }
    }
  }

  const user = status?.identities?.user
  const ready = user && user.status === 'ready' && user.available !== false && (!user.tokenStatus || user.tokenStatus === 'valid')
  if (!ready) {
    return {
      ok: false,
      message:
        `飞书 user 身份未就绪（当前状态：${user?.status ?? '未知'}` +
        `${user?.tokenStatus ? `，token：${user.tokenStatus}` : ''}）。` +
        '请执行 lark-cli auth login 完成本人身份授权后重试；user 身份不能用 bot 令牌代替。',
    }
  }
  return { ok: true, selfId: user.openId ?? null }
}

// ---------------------------------------------------------------------------
// 进程入口
// ---------------------------------------------------------------------------

function readInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * 真正的进程：环境变量取配置 → 自检 → 轮询，信封写 stdout，日志写 stderr。
 * 系统提示：不写库、不知道 sink、不认识 agent。
 */
export async function main({ env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const stateDir = expandHome(env.PERSONAL_CONTEXT_STATE_DIR || DEFAULTS.stateDir)
  // PERSONAL_CONTEXT_SOURCE_* 是本来源自己的开关；PERSONAL_CONTEXT_FEISHU_* 是 config.js 给守护进程用的同名项，认它做兜底。
  const intervalMs = readInt(env.PERSONAL_CONTEXT_SOURCE_INTERVAL_MS ?? env.PERSONAL_CONTEXT_FEISHU_INTERVAL_MS, DEFAULTS.intervalMs)
  const concurrency = readInt(env.PERSONAL_CONTEXT_SOURCE_CONCURRENCY ?? env.PERSONAL_CONTEXT_FEISHU_CONCURRENCY, DEFAULTS.concurrency)
  const bin = env.PERSONAL_CONTEXT_SOURCE_LARK_CLI || env.PERSONAL_CONTEXT_FEISHU_LARK_CLI || DEFAULTS.cli

  const exec = createCliExec({ bin })
  const ready = await preflight(exec)
  if (!ready.ok) {
    err.write(`[feishu] ${ready.message}\n`)
    return 1
  }

  const poller = createPoller({
    exec,
    stateDir,
    intervalMs,
    concurrency,
    selfId: ready.selfId,
    emit: envelope => out.write(`${JSON.stringify(envelope)}\n`),
    log: line => err.write(`${line}\n`),
  })

  err.write(
    `[feishu] 开始轮询：bin=${bin} interval=${intervalMs}ms concurrency=${concurrency} ` +
      `state=${stateDir} self=${ready.selfId ?? '-'}\n`,
  )

  const stop = () => poller.stop()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await poller.run()
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
  err.write('[feishu] 已停止\n')
  return 0
}

const invokedDirectly = typeof process.argv[1] === 'string' && basename(process.argv[1]) === 'feishu.js'
if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code
    })
    .catch(error => {
      process.stderr.write(`[feishu] 采集进程异常退出：${error?.stack ?? error}\n`)
      process.exitCode = 1
    })
}
