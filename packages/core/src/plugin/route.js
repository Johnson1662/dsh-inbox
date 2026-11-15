/**
 * 设置页与宿主之间的那条 HTTP：GET 读、POST 写。
 *
 * 只有同一个进程里的面板会调它，所以两道门就够：对端必须是回环、Host 必须是回环。
 * 真正的值校验在 settings.js，这里只做请求形状与落盘。
 */
import { existsSync, readFileSync } from 'node:fs'
import { configPath, loadConfig, persistConfig } from '../core/config.js'
import { DEFAULTS as DEFAULT_SETTINGS, FIELDS, toLayered, toSettings, validate } from './settings.js'
import { listBots, routesFromTargets, targetOfSource } from './targets.js'

const MAX_BODY = 64 * 1024

export function createSettingsRoute({ config, apply, applyRoutes, log = () => {}, botStatePath }) {
  const path = configPath(config)

  return async function handle(req, res) {
    const blocked = guard(req)
    if (blocked) return send(res, 403, { ok: false, error: blocked })
    try {
      if (req.method === 'GET') return send(res, 200, { ok: true, data: snapshot() })
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        const file = readFile()
        const current = toSettings(file)
        const { settings, errors } = validate(body?.settings ?? {}, current)
        if (errors.length) return send(res, 400, { ok: false, error: errors.join('；') })

        // 来源 → 目标会话：只收存在的 botId，写进 routes
        const targets = pickTargets(body?.targets, file, botStatePath)
        if (targets.error) return send(res, 400, { ok: false, error: targets.error })

        const patch = toLayered(settings)
        if (targets.routes) patch.routes = targets.routes

        persistConfig(path, patch)
        log(`设置已更新：${JSON.stringify(settings)}`)
        try {
          await apply?.(settings)
          if (targets.routes) await applyRoutes?.(targets.routes)
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
    const file = readFile()
    const bots = listBots(botStatePath)
    const routes = file.routes ?? []
    const current = {}
    for (const source of Object.keys(config.sources ?? {})) current[source] = targetOfSource(routes, source)
    return {
      settings: settings ?? toSettings(loadConfig(file)),
      fields: FIELDS,
      targets: { available: bots.map(bot => ({ id: bot.id, name: bot.name, role: bot.role })), current },
      groups: buildGroups(bots, current, settings ?? toSettings(loadConfig(file))),
      path,
      note: '改完保存即可，守护进程一个轮询周期内生效；来源开关会重启对应来源进程，水位不丢。',
    }
  }
}

/**
 * 面板的结构由这里决定，客户端只负责画。
 *
 * 一个来源一张卡：开关、节奏、投给谁全在同一张卡里——
 * 之前开关在「飞书」、投给谁在底下「收件会话」，读的人得自己拼起来。
 */
export function buildGroups(bots, current, settings) {
  const groups = []
  const items = group => FIELDS.filter(field => field.group === group).map(field => ({
    kind: field.type,
    key: field.key,
    label: field.label,
    hint: field.type === 'number' ? `${field.min} – ${field.max}` : '',
    min: field.min,
    max: field.max,
    step: field.step,
    default: DEFAULT_SETTINGS[field.key],
  }))

  for (const field of FIELDS) {
    if (!field.source) continue
    if (groups.some(group => group.id === `source:${field.source}`)) continue
    const source = field.source
    groups.push({
      id: `source:${source}`,
      title: field.group,
      note: '关掉就停止采集；采到的消息投进下面选的会话。',
      items: [
        ...items(field.group),
        {
          kind: 'target',
          key: `target:${source}`,
          label: '投给哪个会话',
          hint: '需要在 DSH 里打开过该会话',
          value: current[source] ?? '',
          options: bots.map(bot => ({ value: bot.id, label: bot.role ? `${bot.name} · ${bot.role}` : bot.name })),
        },
      ],
    })
  }

  groups.push({
    id: 'delivery',
    title: '投递',
    note: '只影响怎么打包投递，不影响采集。积压多时会自动放大上限，少唤醒几次。',
    items: items('投递'),
  })

  return groups
}

/**
 * 把面板交上来的 target 映射校验成 routes。
 * 只认当前真实存在的 botId；没交这一项就表示"别动路由"。
 */
function pickTargets(input, file, botStatePath) {
  if (!input || typeof input !== 'object') return { routes: null }
  const allowed = new Set(listBots(botStatePath).map(bot => bot.id))
  const targets = {}
  for (const [source, sink] of Object.entries(input)) {
    if (!sink) continue
    if (!allowed.has(String(sink))) return { error: `来源 ${source} 指向了不存在的会话：${sink}` }
    targets[source] = String(sink)
  }
  if (!Object.keys(targets).length) return { error: '至少要有一个来源指向某个会话' }
  const fallback = targetOfSource(file.routes ?? [], '__fallback__')
  return { routes: routesFromTargets(targets, { fallbackSink: Object.values(targets)[0] ?? fallback }) }
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
