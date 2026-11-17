#!/usr/bin/env node
/**
 * 微信来源：调 wx-cli 读本地聊天库，把新消息写成信封交给守护进程。
 *
 * 这一路只负责"把看见的东西交上来"：不判断、不摘要、不截断正文。
 * stdout 只放信封，一个字节的日志都不许混进去；日志一律走 stderr。
 *
 * 环境变量（supervisor 注入的 PERSONAL_CONTEXT_SOURCE_*）：
 *   PERSONAL_CONTEXT_SOURCE_CHATS        白名单，逗号分隔的 username（xxx@chatroom / wxid_xxx）；空 = 一个都不采
 *   PERSONAL_CONTEXT_SOURCE_INTERVAL_MS  轮询间隔，默认 30000
 *   PERSONAL_CONTEXT_SOURCE_WX_BIN       wx 可执行文件，默认走 PATH
 *   PERSONAL_CONTEXT_SOURCE_SELF         自己的 wxid，用来把 actor 判成 self（可选）
 *   PERSONAL_CONTEXT_STATE_DIR           状态目录；水位存 <state>/watermarks/wx.json
 *
 * 退出码：SIGTERM / SIGINT 干净退出 0；配置或环境问题打印中文错误并退出 1。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { contactNames } from './choices.js'

const run = promisify(execFile)

const SOURCE = 'wx'
/** 每个会话每轮最多拉多少条：装不下就下一轮接着取，水位只推进到已发出的最后一条。 */
const PAGE = 60
/** wx history 每轮可能慢（要解密），给足时间。 */
const EXEC_TIMEOUT_MS = 60_000

function log(message) {
  process.stderr.write(`wx: ${message}\n`)
}

function die(message) {
  process.stderr.write(`wx: ${message}\n`)
  process.exit(1)
}

function env(name, fallback = '') {
  const raw = process.env[`PERSONAL_CONTEXT_SOURCE_${name}`]
  return raw === undefined || raw === '' ? fallback : String(raw)
}

function envInt(name, fallback, { minimum = 0 } = {}) {
  const raw = env(name, '')
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < minimum) {
    die(`PERSONAL_CONTEXT_SOURCE_${name} 必须是 ≥${minimum} 的数字，现在是 ${JSON.stringify(raw)}`)
  }
  return Math.trunc(value)
}

/** 'a, b ,c' → ['a','b','c']；空就是空列表（一个都不采）。 */
export function parseChats(raw) {
  return String(raw ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

/** 本地时区偏移，写成 +08:00 这种。 */
function localOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset()
}

export function toZonedIso(epochSeconds, offsetMinutes) {
  const date = new Date(Number(epochSeconds) * 1000)
  if (Number.isNaN(date.getTime())) return null
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const pad = (value, width = 2) => String(Math.trunc(value)).padStart(width, '0')
  const local = new Date(date.getTime() + offsetMinutes * 60_000)
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(abs / 60)}:${pad(abs % 60)}`
  )
}

/**
 * 一条 wx 消息 → 统一信封。缺时间或 id 就是 null，交给调用方计数跳过。
 * 非文本消息（图片/语音/引用/系统提示）照样交，正文放类型标签——不丢，也不假装有内容。
 */
export function toEnvelope(message, chat, { offsetMinutes, selfId = '' } = {}) {
  const localId = message?.local_id
  const timestamp = Number(message?.timestamp)
  if (localId === undefined || localId === null || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null
  }
  const at = toZonedIso(timestamp, offsetMinutes)
  if (!at) return null

  const type = message?.type_id ?? 'text'
  const body = typeof message?.content === 'string' ? message.content : ''
  const text = body || `[${message?.type ?? type}]`
  const sender = message?.sender ?? message?.sender_username ?? ''
  const actor = selfId && message?.sender_username === selfId ? 'self' : 'other'

  return {
    id: `${SOURCE}:${chat.username}:${localId}`,
    source: SOURCE,
    at,
    actor,
    text,
    meta: {
      chat: chat.name ?? '',
      chat_username: chat.username,
      sender,
      type,
    },
    timestamp,
    localId,
  }
}

/** 水位比较：只有严格更新的消息才算新，避免边界那条每轮重交。 */
export function isNewer(message, watermark) {
  if (!watermark) return true
  const timestamp = Number(message?.timestamp)
  if (!Number.isFinite(timestamp)) return false
  if (timestamp > watermark.ts) return true
  if (timestamp < watermark.ts) return false
  return Number(message?.local_id ?? 0) > Number(watermark.localId ?? 0)
}

function readWatermarks(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const chats = parsed?.chats && typeof parsed.chats === 'object' ? parsed.chats : {}
    const out = {}
    for (const [username, entry] of Object.entries(chats)) {
      const ts = Number(entry?.ts)
      if (!Number.isFinite(ts) || ts <= 0) continue
      out[username] = { ts, localId: Number(entry?.localId ?? 0) }
    }
    return out
  } catch {
    return {}
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * 轮询器：只认识注入的 exec / now / emit / log，跑起来才碰真实进程。
 */
export function createPoller({
  exec,
  stateDir,
  chats = [],
  selfId = '',
  backfill = 0,
  intervalMs = 30_000,
  page = PAGE,
  offsetMinutes = localOffsetMinutes(),
  now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  emit = envelope => process.stdout.write(`${JSON.stringify(envelope)}\n`),
  log: logLine = log,
  lookupName = () => '',
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('createPoller 需要注入 exec(file, args) -> Promise<{stdout}>')

  const watermarkPath = join(stateDir, 'watermarks', 'wx.json')
  let watermarks = readWatermarks(watermarkPath)
  let stopped = false
  const chatNames = new Map()
  let dirty = false
  let wake = null

  /** 可被打断的等待：收到 SIGTERM 立刻返回，别让 supervisor 等 5 秒再补一刀。 */
  function pause(ms) {
    if (stopped) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })
  }

  async function history(username) {
    const { stdout } = await exec('wx', ['history', username, '-n', String(page), '--json'])
    const parsed = JSON.parse(stdout)
    chatNames.set(username, parsed?.chat ?? '')
    return Array.isArray(parsed?.messages) ? parsed.messages : []
  }

  /** username → 群名：history 解出来的优先，其次是联系人缓存，都没有才退回 username。 */
  function chatName(username) {
    const fromHistory = chatNames.get(username) ?? ''
    if (fromHistory && fromHistory !== username) return fromHistory
    return lookupName(username) || username
  }

  /** 一轮：逐个白名单会话取增量，交信封，推水位。返回这一轮发出去的条数。 */
  async function pollOnce() {
    let sent = 0
    for (const username of chats) {
      if (stopped) break
      let messages
      try {
        messages = await history(username)
      } catch (error) {
        // 一个会话读失败不影响别的：水位不动，下一轮重试
        logLine(`会话 ${username} 读取失败：${shortReason(error)}`)
        continue
      }
      // 第一次见到的会话：默认不回溯历史（和 Telegram 那路一致），水位直接设到最新。
      // 想补历史就配 backfill=N，只补最近 N 条。
      if (watermarks[username] === undefined) {
        const newest = [...messages].sort(
          (a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.local_id) - Number(b.local_id),
        )
        if (backfill <= 0) {
          const last = newest[newest.length - 1]
          if (last) {
            watermarks[username] = { ts: Number(last.timestamp), localId: Number(last.local_id) }
            dirty = true
            logLine(`会话 ${username} 首轮不回溯，水位设到 ${last.local_id}`)
          }
          continue
        }
        messages = newest.slice(-backfill)
      }

      const ordered = [...messages].sort(
        (a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.local_id) - Number(b.local_id),
      )
      for (const message of ordered) {
        if (!isNewer(message, watermarks[username])) continue
        const envelope = toEnvelope(message, { username, name: chatName(username) }, { offsetMinutes, selfId })
        if (!envelope) continue
        const { timestamp, localId, ...rest } = envelope
        emit(rest)
        watermarks[username] = { ts: timestamp, localId }
        dirty = true
        sent += 1
      }
    }
    if (dirty) {
      const chatsOut = {}
      for (const [username, entry] of Object.entries(watermarks)) {
        chatsOut[username] = { ts: entry.ts, localId: entry.localId }
      }
      writeJsonAtomic(watermarkPath, { source: SOURCE, version: 1, updated_at: now().toISOString(), chats: chatsOut })
      dirty = false
    }
    return sent
  }

  async function run({ rounds = Infinity } = {}) {
    let done = 0
    while (!stopped && done < rounds) {
      try {
        const sent = await pollOnce()
        if (sent) logLine(`一轮：发出 ${sent} 条`)
      } catch (error) {
        logLine(`这一轮失败：${typeOf(error)}: ${shortReason(error)}`)
      }
      done += 1
      if (stopped) break
      await pause(intervalMs)
    }
    return done
  }

  return {
    pollOnce,
    run,
    stop() {
      stopped = true
      wake?.()
    },
    get stopped() {
      return stopped
    },
    watermarks: () => JSON.parse(JSON.stringify(watermarks)),
    paths: { watermarks: watermarkPath },
  }
}

/** 联系人缓存 → 名字查询，按 TTL 刷新；缓存坏页或正在重写时当没有，不影响投递。 */
export function createNameSource({ ttlMs = 5 * 60_000, now = Date.now, load = () => contactNames() } = {}) {
  let names = new Map()
  // -Infinity 保证第一次查询就加载，不吃 now() 的起点
  let loadedAt = Number.NEGATIVE_INFINITY
  return function lookupName(username) {
    if (now() - loadedAt >= ttlMs) {
      loadedAt = now()
      try {
        names = load()
      } catch (error) {
        log(`联系人缓存读不出来：${shortReason(error)}`)
        names = new Map()
      }
    }
    return names.get(username) ?? ''
  }
}

function typeOf(error) {
  return error?.name ?? 'Error'
}

function shortReason(error) {
  const message = error?.stderr?.toString?.() || error?.message || String(error)
  return message.split('\n')[0].slice(0, 200)
}

async function main() {
  const chats = parseChats(env('CHATS'))
  if (chats.length === 0) {
    die('没有配置会话白名单：用 PERSONAL_CONTEXT_SOURCE_CHATS 指定 username（逗号分隔）。空着不采任何会话。')
  }
  const stateDirRaw = env('STATE_DIR') || process.env.PERSONAL_CONTEXT_STATE_DIR || '~/.dsh/state/personal-context'
  const stateDir = stateDirRaw.replace(/^~/, process.env.HOME ?? '')
  const bin = env('WX_BIN', 'wx')
  const selfId = env('SELF', '')
  const intervalMs = envInt('INTERVAL_MS', 30_000, { minimum: 1000 })
  const backfill = envInt('BACKFILL', 0)

  const poller = createPoller({
    exec: (file, args) => run(file === 'wx' ? bin : file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }),
    stateDir,
    chats,
    selfId,
    backfill,
    intervalMs,
    lookupName: createNameSource(),
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log('收到退出信号，停止轮询')
      poller.stop()
    })
  }

  log(`白名单 ${chats.length} 个会话，间隔 ${intervalMs}ms，wx=${bin}`)
  await poller.run()
  log('已退出')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => die(`${typeOf(error)}: ${shortReason(error)}`))
}
