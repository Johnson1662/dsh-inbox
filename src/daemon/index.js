import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { configPath, expandHome, loadConfig } from '../core/config.js'
import { createCredentialRules, normalize, stripCredentials } from '../core/envelope.js'
import { openQueue } from '../core/queue.js'
import { createSupervisor } from './supervisor.js'

const MAX_BODY = 1024 * 1024

/** 组合根：只接线，不放业务逻辑。队列、信封、凭据规则都在 core 里。 */
export function createDaemon(config, { log = () => {} } = {}) {
  const stateDir = expandHome(config.stateDir)
  mkdirSync(stateDir, { recursive: true })
  const token = config.http.token ?? readOrCreateToken(stateDir, log)
  const queue = openQueue(join(stateDir, 'context.sqlite'), { routes: config.routes ?? [] })
  const credentials = createCredentialRules(config.credentials)
  // 来源进程和 HTTP 入口走同一条管道：normalize 过、凭据规则过，才进队列
  const sources = createSupervisor({
    stateDir,
    credentials,
    log,
    ingest(envelope) {
      const result = queue.ingest(envelope)
      log(`ingest ${result.id} sink=${result.sink} duplicate=${result.duplicate}`)
      return result
    },
  })

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      log(`request failed: ${error?.stack ?? error}`)
      send(res, 500, { error: 'internal' })
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return send(res, 200, { ok: true, queue: queue.path })
    }
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/v1/stats') {
      return send(res, 200, queue.stats())
    }
    if (req.method === 'POST' && url.pathname === '/v1/event') {
      const raw = await readBody(req)
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return send(res, 400, { error: 'invalid_json' })
      }
      const envelope = normalize(parsed)
      if (envelope.error) return send(res, 400, { error: envelope.error })
      const result = queue.ingest(stripCredentials(envelope, credentials))
      log(`ingest ${result.id} sink=${result.sink} duplicate=${result.duplicate}`)
      return send(res, 200, result)
    }
    return send(res, 404, { error: 'not_found' })
  }

  function authorized(req) {
    const header = req.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    const a = Buffer.from(presented)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  return {
    queue,
    token,
    stateDir,
    sources,
    listen(port) {
      const wanted = port ?? Number(config.http.listen.split(':').pop())
      return new Promise(resolve => {
        server.listen(wanted, '127.0.0.1', () => {
          log(`listening on 127.0.0.1:${server.address().port}`)
          // 起监听之后再拉来源：收事件的通道先就位，来源写出来的东西才有人接
          sources.startEnabled(config)
          resolve(server.address().port)
        })
      })
    },
    async close() {
      // 先收来源子进程（SIGTERM → 5s → SIGKILL），再关队列：反过来的话它们还在写库
      await sources.stopAll()
      return new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          try { queue.close() } catch {}
          resolve()
        }
        server.close(finish)
        // 不等长连接自己超时：立刻断开，并给一个兜底上限
        server.closeAllConnections?.()
        setTimeout(finish, 1000).unref?.()
      })
    },
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('body_too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  })
  res.end(body)
}

function readOrCreateToken(stateDir, log) {
  const path = join(stateDir, 'token')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const token = randomBytes(24).toString('hex')
  writeFileSync(path, token, { mode: 0o600 })
  chmodSync(path, 0o600)
  log(`generated token at ${path}`)
  return token
}

if (process.argv[1]?.endsWith(join('daemon', 'index.js'))) {
  const file = process.argv[2] ?? process.env.PC_CONFIG
  // 配置文件缺失不是错误：插件还没跑过时用默认值 + 环境变量顶上
  const overrides = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  if (file && !existsSync(file)) console.log(`config: ${file} 不存在，用默认值 + 环境变量`)
  const config = loadConfig(overrides)
  const daemon = createDaemon(config, { log: message => console.log(`${new Date().toISOString()} ${message}`) })
  const port = await daemon.listen()
  console.log(`config: ${configPath(config)}`)
  process.on('SIGTERM', () => daemon.close().then(() => process.exit(0)))
  process.on('SIGINT', () => daemon.close().then(() => process.exit(0)))
  console.log(`token: ${daemon.token}`)
  console.log(`POST http://127.0.0.1:${port}/v1/event`)
}
