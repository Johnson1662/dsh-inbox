/**
 * 设置页与宿主之间的那条 HTTP：GET 读、POST 写。
 *
 * 只有同一个进程里的面板会调它，所以两道门就够：对端必须是回环、Host 必须是回环。
 * 真正的值校验在 settings.js，这里只做请求形状与落盘。
 */
import { existsSync, readFileSync } from 'node:fs'
import { configPath, loadConfig, persistConfig } from '../core/config.js'
import { FIELDS, toLayered, toSettings, validate } from './settings.js'

const MAX_BODY = 64 * 1024

export function createSettingsRoute({ config, apply, log = () => {} }) {
  const path = configPath(config)

  return async function handle(req, res) {
    const blocked = guard(req)
    if (blocked) return send(res, 403, { ok: false, error: blocked })
    try {
      if (req.method === 'GET') return send(res, 200, { ok: true, data: snapshot() })
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const current = toSettings(readFile())
        const { settings, errors } = validate(body?.settings ?? {}, current)
        if (errors.length) return send(res, 400, { ok: false, error: errors.join('；') })

        persistConfig(path, toLayered(settings))
        log(`设置已更新：${JSON.stringify(settings)}`)
        try {
          await apply?.(settings)
        } catch (error) {
          // 落盘成功了但热应用失败：如实告诉面板，别假装成功
          return send(res, 500, { ok: false, error: `已保存但热应用失败：${error?.message ?? error}` })
        }
        return send(res, 200, { ok: true, data: snapshot(settings) })
      }
      return send(res, 405, { ok: false, error: '只支持 GET / POST' })
    } catch (error) {
      log(`设置接口出错：${error?.stack ?? error}`)
      return send(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  function readFile() {
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      log(`配置文件读不出来（${error?.message ?? error}），按默认值处理`)
      return {}
    }
  }

  function snapshot(settings) {
    return {
      settings: settings ?? toSettings(loadConfig(readFile())),
      fields: FIELDS,
      path,
      note: '改完保存即可，守护进程一个轮询周期内生效；来源开关会重启对应来源进程，水位不丢。',
    }
  }
}

/** 只接受本机、且 Host 也是回环的请求：这是浏览器面板回写设置的最低门槛。 */
function guard(req) {
  const peer = String(req.socket?.remoteAddress ?? '')
  if (peer && !/^(::1|::ffff:127\.|127\.)/.test(peer)) return `拒绝非本机请求（${peer}）`
  const host = String(req.headers?.host ?? '').replace(/:\d+$/, '')
  if (host && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return `拒绝非回环 Host（${host}）`
  return ''
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('请求体过大'))
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
