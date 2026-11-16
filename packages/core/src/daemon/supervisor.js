/**
 * 来源子进程的看护者。
 *
 * 一层薄壳，只做四件事：发现实现、算环境、读 stdout 逐行交给管道、崩了按退避重启。
 * 来源自己不认识队列，也不认识 agent——它只管往 stdout 写一行一个信封。
 *
 * 不变式：
 *  - 一行 stdout = 一个信封；坏行记日志丢掉，绝不中断后续行
 *  - 除显式 stop 外，任何退出（含退出码 0）→ 退避重启；SIGTERM 之后不再重启
 *  - 父进程已有的 PERSONAL_CONTEXT_TELEGRAM_* 之类环境变量原样透传，只往上加 PERSONAL_CONTEXT_SOURCE_*
 */

import { spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize, stripCredentials } from '../core/envelope.js'
import { legacySpec, spawnSpec } from '../core/sources.js'

/** 来源实现的默认目录：src/sources/<name>.{js,py} */
export const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'sources')

/** 后缀 → 解释器。顺序即优先级：同一个来源两种实现都在时用 .js。 */
const RUNTIMES = [
  ['.js', 'node'],
  ['.py', 'python3'],
]

const ENV_PREFIX = 'PERSONAL_CONTEXT_SOURCE_'

/** 坏行日志里最多留多少字符：够定位问题，又不至于把一整条消息灌进日志。 */
const LINE_IN_LOG = 200

/**
 * 找来源实现。没有实现返回 null——「配置里有但没写」是正常状态，不是错误。
 * @returns {{name: string, path: string, command: string, args: string[]} | null}
 */
export function discover(name, { root = SOURCE_ROOT, manifest } = {}) {
  const plain = typeof name === 'string' ? name.trim() : ''
  // 名字就是文件名，不许带路径：来源名来自配置，不能变成任意文件执行
  if (!plain || /[\\/]/.test(plain) || plain === '.' || plain === '..') return null

  // ① 装了来源包：按它的声明起（runtime + entry）
  if (manifest) {
    const spec = spawnSpec(manifest)
    if (spec) return { name: plain, path: manifest.entry, command: spec.command, args: spec.args, manifest }
  }

  // ② 仓库内的老路径兜底
  const legacy = legacySpec(plain, root)
  if (legacy) return { name: plain, path: legacy.path, command: legacy.command, args: legacy.args }
  return null
}

/** intervalMs → INTERVAL_MS，apiId → API_ID，backfill → BACKFILL */
export function toEnvName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

/** 数组按逗号拼（chats 这类列表），布尔按 1/0，对象原样 JSON。 */
function envValue(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null).map(String).join(',')
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value)
  return text === '' ? undefined : text
}

/**
 * 子进程的环境：父进程的全套继承下来（PERSONAL_CONTEXT_TELEGRAM_* 之类要原样透传），
 * 再加上 PERSONAL_CONTEXT_STATE_DIR / PERSONAL_CONTEXT_SOURCE_NAME / 每个配置键对应的 PERSONAL_CONTEXT_SOURCE_<UPPER_SNAKE>。
 * 后加的优先——配置是这一层的事实来源，父进程的 PERSONAL_CONTEXT_SOURCE_* 不会盖掉它。
 */
export function sourceEnv(name, sourceConfig = {}, { stateDir, env = process.env } = {}) {
  const out = { ...env }
  if (stateDir !== undefined && stateDir !== null && stateDir !== '') out.PERSONAL_CONTEXT_STATE_DIR = String(stateDir)
  out.PERSONAL_CONTEXT_SOURCE_NAME = String(name)
  for (const [key, value] of Object.entries(sourceConfig ?? {})) {
    const envName = `${ENV_PREFIX}${toEnvName(key)}`
    // 名字这一格归 supervisor：配置里写 name 不能把来源名改掉
    if (envName === `${ENV_PREFIX}NAME`) continue
    const text = envValue(value)
    if (text === undefined) continue
    out[envName] = text
  }
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined || value === null) delete out[key]
    else if (typeof value !== 'string') out[key] = String(value)
  }
  return out
}

/**
 * 造一个看护者。
 *
 * @param options.root            来源目录（默认 src/sources）
 * @param options.stateDir        传给子进程的 PERSONAL_CONTEXT_STATE_DIR
 * @param options.ingest          收信封的回调（已经 normalize + stripCredentials 过）
 * @param options.credentials     凭据规则，createCredentialRules() 的产物
 * @param options.env             父进程环境（默认 process.env，测试可注入）
 * @param options.spawn           注入用，默认 node:child_process.spawn
 * @param options.restartDelayMs  首次重启等待，默认 10 秒
 * @param options.maxRestartDelayMs 退避上限，默认 60 秒
 * @param options.stopTimeoutMs   停的时候 SIGTERM 到 SIGKILL 的宽限，默认 5 秒
 */
export function createSupervisor({
  root = SOURCE_ROOT,
  manifests = [],
  stateDir,
  ingest = () => {},
  credentials,
  log = () => {},
  env = process.env,
  spawn = spawnChild,
  restartDelayMs = 10_000,
  maxRestartDelayMs = 60_000,
  stopTimeoutMs = 5_000,
} = {}) {
  const records = new Map()
  const manifestOf = new Map(manifests.map(manifest => [manifest.name, manifest]))

  function record(name) {
    let rec = records.get(name)
    if (!rec) {
      rec = {
        name,
        implementation: null,
        config: {},
        child: null,
        restarts: 0,
        timer: null,
        stopping: false,
        lines: 0,
        ingested: 0,
        dropped: 0,
        lastError: null,
      }
      records.set(name, rec)
    }
    return rec
  }

  /**
   * 配置变了：该开的开、该关的关、间隔变了的重启。
   * 水位在文件里，重启子进程不会重投。
   */
  function reconcile(config = {}) {
    const wanted = config?.sources ?? {}
    const changes = []

    for (const name of [...records.keys()]) {
      const want = wanted[name]
      if (!want?.enabled) {
        if (records.get(name)?.child || records.get(name)?.timer) {
          stop(name)
          changes.push(`${name}: 关`)
        } else {
          records.delete(name)
        }
      }
    }

    for (const [name, sourceConfig] of Object.entries(wanted)) {
      if (!sourceConfig?.enabled) continue
      const rec = records.get(name)
      if (!rec?.child) {
        if (start(name, sourceConfig)) changes.push(`${name}: 开`)
        continue
      }
      // 间隔/凭据变了才重启，避免无谓抖动
      const changed = JSON.stringify(rec.config ?? {}) !== JSON.stringify(sourceConfig ?? {})
      if (!changed) continue
      stop(name)
      records.delete(name)
      if (start(name, sourceConfig)) changes.push(`${name}: 重启`)
    }

    if (changes.length) log(`来源变更：${changes.join('、')}`)
    return changes
  }

  /** 只拉 enabled 的来源；配置里有但没实现的，WARN 一行，不崩。 */
  function startEnabled(config = {}) {
    const started = []
    for (const [name, sourceConfig] of Object.entries(config?.sources ?? {})) {
      if (!sourceConfig?.enabled) continue
      const rec = start(name, sourceConfig)
      if (rec) started.push(name)
    }
    return started
  }

  function start(name, sourceConfig = {}) {
    const existing = records.get(name)
    if (existing?.child || existing?.timer) {
      log(`WARN 来源 ${name} 已经在跑，不重复拉`)
      return null
    }
    const implementation = discover(name, { root, manifest: manifestOf.get(name) })
    if (!implementation) {
      log(`WARN 来源 ${name} 已启用，但既没有 dsh.source 声明的包，${root} 下也没有 ${name}.js / ${name}.py——跳过`)
      return null
    }
    const rec = record(name)
    rec.implementation = implementation
    rec.config = sourceConfig ?? {}
    rec.stopping = false
    launch(rec)
    return rec
  }

  function launch(rec) {
    if (rec.stopping) return
    const childEnv = sourceEnv(rec.name, rec.config, { stateDir, env })
    log(`${rec.name}: 启动 ${rec.implementation.command} ${rec.implementation.path}`)
    let child
    try {
      child = spawn(rec.implementation.command, rec.implementation.args, {
        cwd: root,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      rec.lastError = error?.message ?? String(error)
      scheduleRestart(rec, `拉不起来：${rec.lastError}`)
      return
    }

    rec.child = child
    readLines(child.stdout, line => handleLine(rec, line))
    readLines(child.stderr, line => {
      if (line.trim()) log(`${rec.name}: ${line}`)
    })
    child.on('error', error => {
      rec.lastError = error?.message ?? String(error)
      log(`${rec.name}: 子进程错误：${rec.lastError}`)
      // 起不来的（解释器不在、权限不对）不会触发 exit，不在这里兜住就永远不重启了
      if (!child.pid && rec.child === child) {
        rec.child = null
        scheduleRestart(rec, `起不来：${rec.lastError}`)
      }
    })
    child.on('exit', (code, signal) => {
      rec.child = null
      if (rec.stopping) {
        log(`${rec.name}: 已退出（${signal ?? code}）`)
        return
      }
      // [2026-11-16]-[退出码 0 不等于「干完了」：来源 worker 都是常驻轮询器，自己退出
      // （读不到配置、上游把连接关了、被 kill 前先优雅收尾）都算掉线。早先这里把 0 当
      // 正常结束不重启，采集会静默中断，只能靠改配置触发 reconcile 才拉起来。
      // 除显式 stop 外，任何退出都按退避重启。]
      scheduleRestart(rec, signal ? `被 ${signal} 终止` : `退出码 ${code}`)
    })
  }

  /** 一行 stdout：JSON.parse → normalize → stripCredentials → ingest。任何一步失败都只是丢这一行。 */
  function handleLine(rec, line) {
    const text = line.trim()
    if (!text) return
    rec.lines += 1

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      rec.dropped += 1
      log(`WARN ${rec.name}: 丢弃非 JSON 行：${clip(text)}`)
      return
    }

    const envelope = normalize(raw)
    if (envelope.error) {
      rec.dropped += 1
      log(`WARN ${rec.name}: 丢弃 ${envelope.error} 行：${clip(text)}`)
      return
    }

    let clean
    try {
      clean = stripCredentials(envelope, credentials)
    } catch (error) {
      rec.dropped += 1
      log(`WARN ${rec.name}: 凭据规则失败，丢弃 ${envelope.id}：${error?.message ?? error}`)
      return
    }

    try {
      const result = ingest(clean)
      rec.ingested += 1
      if (result && typeof result.then === 'function') {
        result.catch(error => log(`WARN ${rec.name}: ingest 失败（${clean.id}）：${error?.message ?? error}`))
      }
    } catch (error) {
      rec.dropped += 1
      log(`WARN ${rec.name}: ingest 失败（${clean.id}）：${error?.message ?? error}`)
    }
  }

  /** 退避重启：10s → 20s → 40s → 60s 封顶；同时只挂一个定时器。 */
  function scheduleRestart(rec, reason) {
    if (rec.stopping || rec.timer) return
    rec.restarts += 1
    const delay = Math.min(restartDelayMs * 2 ** (rec.restarts - 1), maxRestartDelayMs)
    log(`${rec.name}: ${reason}，${delay}ms 后重启（第 ${rec.restarts} 次）`)
    rec.timer = setTimeout(() => {
      rec.timer = null
      launch(rec)
    }, delay)
  }

  /** 先 SIGTERM；宽限期到了还在就 SIGKILL。收到信号之后一律不再重启。 */
  function stop(name) {
    const rec = records.get(name)
    if (!rec) return Promise.resolve()
    rec.stopping = true
    if (rec.timer) {
      clearTimeout(rec.timer)
      rec.timer = null
    }
    const child = rec.child
    if (!child) return Promise.resolve()
    return new Promise(resolve => {
      let done = false
      let killer = null
      let giveUp = null
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(killer)
        clearTimeout(giveUp)
        resolve()
      }
      child.once('exit', finish)
      killer = setTimeout(() => {
        log(`${rec.name}: ${stopTimeoutMs}ms 内没退出，发 SIGKILL`)
        try { child.kill('SIGKILL') } catch {}
        // 连 SIGKILL 都不认的，给 1 秒兜底就走，别把整个进程收尾卡住
        giveUp = setTimeout(finish, 1000)
        giveUp.unref?.()
      }, stopTimeoutMs)
      log(`${rec.name}: 发 SIGTERM`)
      try {
        child.kill('SIGTERM')
      } catch (error) {
        log(`${rec.name}: SIGTERM 发不出去：${error?.message ?? error}`)
        finish()
      }
    })
  }

  function stopAll() {
    return Promise.all([...records.keys()].map(name => stop(name)))
  }

  function status() {
    return [...records.values()].map(rec => ({
      name: rec.name,
      pid: rec.child?.pid ?? null,
      restarts: rec.restarts,
      stopping: rec.stopping,
      running: Boolean(rec.child),
      lines: rec.lines,
      ingested: rec.ingested,
      dropped: rec.dropped,
      lastError: rec.lastError,
    }))
  }

  return { start, startEnabled, stop, stopAll, status, reconcile }
}

/** 逐行切 stdout：自己攒缓冲，不依赖 readline（来源可能一次吐出巨大的正文）。 */
function readLines(stream, onLine) {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf8')
  // 管道断了（子进程死了）不该把整个守护进程拖下去
  stream.on('error', () => {})
  stream.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
    }
  })
  stream.on('end', () => {
    if (buffer) onLine(buffer.replace(/\r$/, ''))
    buffer = ''
  })
}

function clip(text) {
  return text.length > LINE_IN_LOG ? `${text.slice(0, LINE_IN_LOG)}…` : text
}
