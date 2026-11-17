#!/usr/bin/env node
/**
 * GitHub 来源：轮询 /notifications，把未读通知写成信封交给守护进程。
 *
 * 这一路只负责"把看见的东西交上来"：不判断、不摘要、不改通知状态。
 * 不调 PATCH /notifications —— GitHub 上的未读红点该留着还留着，清不清由人决定。
 *
 * stdout 只放信封，一个字节的日志都不许混进去；日志一律走 stderr。
 *
 * 环境变量（supervisor 注入的 PERSONAL_CONTEXT_SOURCE_*）：
 *   PERSONAL_CONTEXT_SOURCE_TOKEN       GitHub token；空则退回 `gh auth token`
 *   PERSONAL_CONTEXT_SOURCE_REPOS       只采这些仓库，逗号分隔的 owner/repo；空 = 全部
 *   PERSONAL_CONTEXT_SOURCE_INTERVAL_MS 轮询间隔，默认 60000
 *   PERSONAL_CONTEXT_SOURCE_BACKFILL    第一次只记基线；设成 N 就补最近 N 条（默认 0）
 *   PERSONAL_CONTEXT_SOURCE_GH_BIN      gh 可执行文件，默认走 PATH
 *   PERSONAL_CONTEXT_SOURCE_API         API 根地址，默认 https://api.github.com（测试用）
 *   PERSONAL_CONTEXT_STATE_DIR          状态目录；水位与 ETag 存 <state>/watermarks/github.json
 *
 * 退出码：SIGTERM / SIGINT 干净退出 0；配置或环境问题打印中文错误并退出 1。
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SOURCE = 'github'
const DEFAULT_API = 'https://api.github.com'
const ACCEPT = 'application/vnd.github+json'
/** 一页 50 条：够一轮交完，又不至于一次拿太多。 */
const PAGE = 50
/** 一轮最多翻几页：通知中心正常不会超过一页，翻太多只会白耗配额。 */
const MAX_PAGES = 4
const EXEC_TIMEOUT_MS = 10_000

function log(message) {
  process.stderr.write(`github: ${message}\n`)
}

function die(message) {
  process.stderr.write(`github: ${message}\n`)
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

/** 'a/b, c/d' → ['a/b','c/d']；空就是空列表（不按仓库过滤）。 */
export function parseRepos(raw) {
  return String(raw ?? '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
}

/** subject.type → 中文类型名。不认识的原样留着，不丢。 */
const TYPES = {
  Issue: 'Issue',
  PullRequest: 'PR',
  Discussion: 'Discussion',
  Commit: 'Commit',
  Release: 'Release',
  CheckSuite: 'CI',
  RepositoryVulnerabilityAlert: '安全告警',
  RepositoryInvitation: '邀请',
}

/** subject.url 末尾那串数字就是 issue/PR 序号；别的类型（CheckSuite 等）没有。 */
export function subjectNumber(thread) {
  const url = String(thread?.subject?.url ?? '')
  const match = url.match(/\/(\d+)$/)
  return match ? Number(match[1]) : null
}

/**
 * 一条通知 → 统一信封。缺 id 或 updated_at 就是 null，交给调用方计数跳过。
 * 正文两行以内：第一行人读的摘要，第二行原文链接（有才写）。
 */
export function toEnvelope(thread) {
  const id = thread?.id === undefined || thread?.id === null ? '' : String(thread.id)
  const updatedAt = String(thread?.updated_at ?? '')
  if (!id || !updatedAt || Number.isNaN(Date.parse(updatedAt))) return null

  const subject = thread?.subject ?? {}
  const repo = String(thread?.repository?.full_name ?? '')
  const reason = String(thread?.reason ?? '')
  const type = TYPES[subject.type] ?? String(subject.type ?? '通知')
  const number = subjectNumber(thread)
  const title = String(subject.title ?? '').trim() || '(无标题)'
  const url = subject.latest_comment_url || subject.url || ''

  const head = `${type} ${repo}${number ? ` #${number}` : ''}：${title}${reason ? `（${reason}）` : ''}`
  const text = url ? `${head}\n${url}` : head

  return {
    id: `${SOURCE}:${id}:${updatedAt}`,
    source: SOURCE,
    at: updatedAt,
    actor: 'other',
    text,
    meta: {
      chat: repo || 'GitHub',
      chat_username: repo,
      sender: reason || type,
      type: String(subject.type ?? ''),
      reason,
      thread_id: id,
      ...(number ? { number } : {}),
      ...(url ? { url } : {}),
    },
  }
}

/** 水位比较：同一线程的 updated_at 严格更新才算新，边界那条不会每轮重交。 */
export function isNewer(thread, watermark) {
  if (!watermark) return true
  const updatedAt = String(thread?.updated_at ?? '')
  if (!updatedAt) return false
  return updatedAt > String(watermark)
}

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const threads = parsed?.threads && typeof parsed.threads === 'object' ? parsed.threads : {}
    const out = {}
    for (const [id, updatedAt] of Object.entries(threads)) {
      if (typeof updatedAt === 'string' && updatedAt) out[id] = updatedAt
    }
    return {
      threads: out,
      etag: typeof parsed?.etag === 'string' ? parsed.etag : '',
      lastModified: typeof parsed?.last_modified === 'string' ? parsed.last_modified : '',
      initialized: parsed?.initialized === true,
    }
  } catch {
    return { threads: {}, etag: '', lastModified: '', initialized: false }
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/** 响应头里的 Link: <...&page=2>; rel="next", <...>; rel="last" → 下一页 URL。 */
export function nextPage(link) {
  if (!link) return null
  for (const part of String(link).split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1]
  }
  return null
}

/**
 * 轮询器：只认识注入的 request / now / emit / log，跑起来才碰网络。
 * request(url, headers) → { status, headers: Headers, body } —— 由 main 用 fetch 实现。
 */
export function createPoller({
  request,
  stateDir,
  repos = [],
  api = DEFAULT_API,
  intervalMs = 60_000,
  backfill = 0,
  page = PAGE,
  maxPages = MAX_PAGES,
  now = () => new Date(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  emit = envelope => process.stdout.write(`${JSON.stringify(envelope)}\n`),
  log: logLine = log,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('createPoller 需要注入 request(url, headers) -> Promise<{status, headers, body}>')

  const statePath = join(stateDir, 'watermarks', 'github.json')
  const state = readState(statePath)
  // 第一次见到这份状态：和 Telegram / 微信那两路一致，只记基线不回溯——
  // 否则一装好就把通知中心里攒了几周的未读全灌进会话。
  // initialized 落盘之后就不再算第一次：哪怕当时一条未读都没有
  let baseline = !state.initialized
  let stopped = false
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

  function wanted(thread) {
    if (repos.length === 0) return true
    const full = String(thread?.repository?.full_name ?? '').toLowerCase()
    return repos.includes(full)
  }

  /** 一轮：翻页取未读通知，交信封，推进水位。返回这一轮发出去的条数。 */
  async function pollOnce() {
    const headers = { Accept: ACCEPT, 'X-GitHub-Api-Version': '2022-11-28' }
    // 条件请求：没变化时 GitHub 回 304，不耗配额
    if (state.etag) headers['If-None-Match'] = state.etag
    if (state.lastModified) headers['If-Modified-Since'] = state.lastModified

    const fresh = []
    let url = `${api}/notifications?all=false&per_page=${page}`
    let first = true
    let sent = 0
    for (let pages = 0; pages < maxPages && url && !stopped; pages += 1) {
      const response = await request(url, first ? headers : { Accept: ACCEPT, 'X-GitHub-Api-Version': '2022-11-28' })
      first = false

      if (response.status === 304) {
        logLine('没有变化（304）')
        return 0
      }
      if (response.status === 401) throw new Error('token 无效或已过期（401），检查 gh 登录或 PERSONAL_CONTEXT_SOURCE_TOKEN')
      if (response.status === 403) throw new Error('被限流或没有权限（403），检查 X-RateLimit-Remaining')
      if (response.status !== 200) throw new Error(`GitHub 返回 ${response.status}`)

      const etag = response.headers?.get?.('etag') ?? ''
      const lastModified = response.headers?.get?.('last-modified') ?? ''
      if (etag && etag !== state.etag) {
        state.etag = etag
        dirty = true
      }
      if (lastModified && lastModified !== state.lastModified) {
        state.lastModified = lastModified
        dirty = true
      }

      const rows = Array.isArray(response.body) ? response.body : []
      fresh.push(...rows)
      url = nextPage(response.headers?.get?.('link'))
    }

    // 第一次运行：默认只记基线不回溯（和 Telegram / 微信两路一致），
    // 否则一装好就把通知中心里攒了几周的未读全灌进会话。
    const known = fresh.filter(thread => thread?.id && wanted(thread))

    if (baseline) {
      baseline = false
      const ordered = [...known].sort((left, right) => String(left.updated_at).localeCompare(String(right.updated_at)))
      const picked = backfill > 0 ? ordered.slice(-backfill) : []
      for (const thread of picked) {
        if (stopped) break
        const envelope = toEnvelope(thread)
        if (!envelope) continue
        emit(envelope)
        sent += 1
      }
      for (const thread of known) state.threads[String(thread.id)] = String(thread.updated_at)
      dirty = true
      logLine(
        picked.length
          ? `第一次运行：补最近 ${picked.length} 条，其余 ${known.length - picked.length} 条只记基线`
          : `第一次运行：记下 ${known.length} 条未读当基线，不回溯（要补历史就设 PERSONAL_CONTEXT_SOURCE_BACKFILL）`,
      )
    } else {
      for (const thread of known) {
        if (stopped) break
        const id = String(thread.id)
        if (!isNewer(thread, state.threads[id])) continue
        const envelope = toEnvelope(thread)
        if (!envelope) continue
        emit(envelope)
        state.threads[id] = String(thread.updated_at)
        dirty = true
        sent += 1
      }
    }

    if (dirty) {
      writeJsonAtomic(statePath, {
        source: SOURCE,
        version: 1,
        initialized: true,
        updated_at: now().toISOString(),
        etag: state.etag,
        last_modified: state.lastModified,
        threads: state.threads,
      })
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
        logLine(`这一轮失败：${shortReason(error)}`)
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
    threads: () => ({ ...state.threads }),
    paths: { state: statePath },
  }
}

/** fetch → request：只留 status / headers / body，测试也照这个形状造。 */
export function createRequest(fetchImpl = globalThis.fetch) {
  return async function request(url, headers) {
    const response = await fetchImpl(url, { headers })
    const body = response.status === 304 ? [] : await response.json()
    return { status: response.status, headers: response.headers, body }
  }
}

/** token 从环境变量拿；没有就问 gh 要（本机已登录就直接可用，不必再存一份）。 */
export async function resolveToken({ env: envValue = process.env, exec = run, bin = 'gh' } = {}) {
  const direct = envValue.PERSONAL_CONTEXT_SOURCE_TOKEN || envValue.PERSONAL_CONTEXT_GITHUB_TOKEN
  if (direct) return String(direct).trim()
  try {
    const { stdout } = await exec(bin, ['auth', 'token'], { timeout: EXEC_TIMEOUT_MS })
    const token = String(stdout ?? '').trim()
    if (!token) throw new Error('gh auth token 输出为空')
    return token
  } catch (error) {
    throw new Error(`拿不到 GitHub token：${shortReason(error)}（先 gh auth login，或设 PERSONAL_CONTEXT_SOURCE_TOKEN）`)
  }
}

function shortReason(error) {
  const message = error?.stderr?.toString?.() || error?.message || String(error)
  return message.split('\n')[0].slice(0, 200)
}

async function main() {
  const repos = parseRepos(env('REPOS'))
  const stateDirRaw = env('STATE_DIR') || process.env.PERSONAL_CONTEXT_STATE_DIR || '~/.dsh/state/personal-context'
  const stateDir = stateDirRaw.replace(/^~/, process.env.HOME ?? '')
  const api = env('API', DEFAULT_API).replace(/\/+$/, '')
  const intervalMs = envInt('INTERVAL_MS', 60_000, { minimum: 1000 })
  const backfill = envInt('BACKFILL', 0)

  const token = await resolveToken({ exec: run, bin: env('GH_BIN', 'gh') })
  const withAuth = createRequest(globalThis.fetch)
  const request = (url, headers) => withAuth(url, { ...headers, Authorization: `Bearer ${token}` })

  const poller = createPoller({ request, stateDir, repos, api, intervalMs, backfill })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log('收到退出信号，停止轮询')
      poller.stop()
    })
  }

  log(`未读通知${repos.length ? `，只看 ${repos.join(', ')}` : '，全部仓库'}，间隔 ${intervalMs}ms`)
  await poller.run()
  log('已退出')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => die(shortReason(error)))
}
