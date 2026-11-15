/**
 * 配置的单一入口。
 *
 * 优先级：环境变量 > 插件/文件配置 > 这里的默认值。
 * 任何一处都不许在代码里写死值——要改行为，改这三层中的一层。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = Object.freeze({
  stateDir: '~/.dsh/state/personal-context',
  http: { listen: '127.0.0.1:7788' },
  delivery: { intervalMs: 500, limit: 200, sink: 'chief' },
  limits: { batchCount: 50, batchChars: 4000, backlogCount: 200, backlogChars: 20000 },
  routes: [{ sources: ['*'], sink: 'chief' }],
  credentials: {
    chats: ['777000'],
    patterns: ['验证码|校验码|动态码|密码|口令|passcode|verification code|\\botp\\b'],
  },
  sources: {
    telegram: { enabled: false, intervalMs: 8000 },
    feishu: { enabled: false, intervalMs: 5000 },
  },
})

/** 每路来源各自要求的凭据；缺了就在启动时明确报错，不静默关掉。 */
const REQUIRED = {
  telegram: ['apiId', 'apiHash', 'session'],
  feishu: [],
}

const BOOL = { '1': true, 'true': true, yes: true, on: true, '0': false, 'false': false, no: false, off: false }

function bool(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'boolean' ? value : BOOL[String(value).toLowerCase()]
  if (parsed === undefined) throw new Error(`${name} 不是布尔值: ${value}`)
  return parsed
}

function int(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 必须是正数: ${value}`)
  return Math.floor(parsed)
}

/** 允许 0 的计数（backfill=0 表示不回填，是合法值，不能用 int 卡掉）。 */
function count(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数: ${value}`)
  return Math.floor(parsed)
}

function list(value) {
  if (value === undefined || value === null || value === '') return undefined
  return Array.isArray(value) ? value.map(String) : String(value).split(',').map(v => v.trim()).filter(Boolean)
}

function pick(...values) {
  for (const value of values) if (value !== undefined) return value
  return undefined
}

/** 从环境变量读到的覆盖项。命名一律 PC_ 前缀，按 A_B_C 对应层级。 */
export function readEnv(env = process.env) {
  const out = { http: {}, delivery: {}, limits: {}, sources: { telegram: {}, feishu: {} }, credentials: {} }

  out.stateDir = pick(env.PC_STATE_DIR)
  out.http.listen = pick(env.PC_HTTP_LISTEN)
  out.http.token = pick(env.PC_HTTP_TOKEN)

  out.delivery.sink = pick(env.PC_SINK)
  out.delivery.intervalMs = int(env.PC_DELIVERY_INTERVAL_MS, 'PC_DELIVERY_INTERVAL_MS')
  out.delivery.limit = int(env.PC_DELIVERY_LIMIT, 'PC_DELIVERY_LIMIT')

  out.limits.batchCount = int(env.PC_BATCH_COUNT, 'PC_BATCH_COUNT')
  out.limits.batchChars = int(env.PC_BATCH_CHARS, 'PC_BATCH_CHARS')
  out.limits.backlogCount = int(env.PC_BACKLOG_COUNT, 'PC_BACKLOG_COUNT')
  out.limits.backlogChars = int(env.PC_BACKLOG_CHARS, 'PC_BACKLOG_CHARS')

  out.sources.telegram.enabled = bool(env.PC_TELEGRAM_ENABLED, 'PC_TELEGRAM_ENABLED')
  out.sources.telegram.intervalMs = int(env.PC_TELEGRAM_INTERVAL_MS, 'PC_TELEGRAM_INTERVAL_MS')
  out.sources.telegram.apiId = pick(env.PC_TELEGRAM_API_ID)
  out.sources.telegram.apiHash = pick(env.PC_TELEGRAM_API_HASH)
  out.sources.telegram.session = pick(env.PC_TELEGRAM_SESSION)
  // 下面三项由 supervisor 变成 PC_SOURCE_PROXY / CHATS / BACKFILL 交给来源进程
  out.sources.telegram.proxy = pick(env.PC_TELEGRAM_PROXY)
  out.sources.telegram.chats = list(env.PC_TELEGRAM_CHATS)
  out.sources.telegram.backfill = count(env.PC_TELEGRAM_BACKFILL, 'PC_TELEGRAM_BACKFILL')

  out.sources.feishu.enabled = bool(env.PC_FEISHU_ENABLED, 'PC_FEISHU_ENABLED')
  out.sources.feishu.intervalMs = int(env.PC_FEISHU_INTERVAL_MS, 'PC_FEISHU_INTERVAL_MS')
  out.sources.feishu.larkCli = pick(env.PC_FEISHU_LARK_CLI)
  out.sources.feishu.concurrency = int(env.PC_FEISHU_CONCURRENCY, 'PC_FEISHU_CONCURRENCY')

  out.credentials.chats = list(env.PC_CREDENTIAL_CHATS)
  out.credentials.patterns = list(env.PC_CREDENTIAL_PATTERNS)

  return out
}

/** 深合并，undefined 不覆盖；数组整体替换。 */
export function merge(base, ...layers) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = merge(out[key] ?? {}, value)
      else out[key] = value
    }
  }
  return out
}

/**
 * 组装最终配置并校验。
 * @param overrides 插件配置或配置文件内容
 * @param options.env 环境变量来源（测试可注入）
 */
export function loadConfig(overrides = {}, { env = process.env, requireCredentials = false } = {}) {
  // 插件配置可能拿到的是响应式字段（带 .get()）
  const plain = unwrap(overrides)
  const config = merge(DEFAULTS, plain, readEnv(env))
  config.routes = plain.routes ?? DEFAULTS.routes

  // 凭据校验只属于真正去连来源的那一侧（守护进程）。插件只负责投递，
  // 它看不到 sources.env，没理由因为“TG 缺 apiHash”就整行启动失败。
  for (const [name, source] of Object.entries(config.sources)) {
    if (!requireCredentials || !source.enabled) continue
    const missing = (REQUIRED[name] ?? []).filter(field => !source[field])
    if (missing.length) {
      throw new Error(`来源 ${name} 已启用但缺少配置：${missing.join(', ')}（用环境变量或配置文件提供）`)
    }
  }
  return config
}

/** schemastery 的响应式配置对象带 .get()，统一摊平成普通对象。 */
function unwrap(value) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value
  if (typeof value.get === 'function' && !Array.isArray(value)) return unwrap(value.get())
  if (Array.isArray(value)) return value.map(unwrap)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = unwrap(item)
  return out
}

/** 唯一的配置文件位置：设置界面和守护进程读写的是同一个文件。 */
export function configPath(config) {
  return join(expandHome(config.stateDir), 'config.json')
}

/** 原子写入：先写临时文件再 rename，避免守护进程读到半个文件。 */
export function persistConfig(path, patch, { env } = {}) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const next = merge(current, patch)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  return next
}

export function expandHome(path) {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

/** 给守护进程用：只列出启用且配置齐全的来源。 */
export function enabledSources(config) {
  return Object.entries(config.sources)
    .filter(([, source]) => source.enabled)
    .map(([name, source]) => ({ name, ...source }))
}
