import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath, expandHome, loadConfig, persistConfig } from '../core/config.js'
import { createApiClient } from './api-client.js'
import { createDeliveryLoop } from './loop.js'
import { createSettingsRoute } from './route.js'
import { toLayered, toSettings } from './settings.js'

export { Config } from './config-schema.js'
export const name = 'dsh-personal-context'
export const inject = ['agents', 'sessionPersistence', 'webServer']

/**
 * 组合根。设置界面里的字段（见 config-schema.js）在这里摊成配置层，
 * 并回写到与守护进程共用的那一份文件——界面改一次，两边都跟着变。
 */
export function apply(ctx, pluginConfig = {}) {
  if (pluginConfig.enabled === false) return

  // 插件不碰来源凭据：配置有问题也只影响展示，不该让整行插件起不来
  let config
  try {
    config = loadConfig(fromSettings(pluginConfig))
  } catch (error) {
    config = loadConfig({})
    pluginConfig = { ...pluginConfig }
    queueMicrotask(() => log(`插件配置有误，按默认值跑：${error?.message ?? error}`))
  }
  const stateDir = expandHome(config.stateDir)
  mkdirSync(stateDir, { recursive: true })

  const log = message => {
    try { appendFileSync(join(stateDir, 'bridge.log'), `${new Date().toISOString()} ${message}\n`) } catch {}
  }

  // 配置文件是设置页和守护进程共用的事实来源：
  //  - 已有文件 → 投递参数以文件为准（面板改过就是改在这里）
  //  - 没有文件 → 用插件配置播一次种，之后不再覆盖
  const settingsPath = configPath(config)
  let settings = toSettings(config)
  if (existsSync(settingsPath)) {
    try {
      settings = toSettings(loadConfig(JSON.parse(readFileSync(settingsPath, 'utf8'))))
    } catch (error) {
      log(`配置文件读不出来，退回插件配置: ${error.message}`)
    }
  } else {
    try {
      persistConfig(settingsPath, toLayered(settings))
    } catch (error) {
      log(`回写配置文件失败: ${error.message}`)
    }
  }

  // 插件不是数据库的写者：它只是"第一个第三方适配器"，只认 take / done / retry
  const daemonUrl = `http://${config.http.listen}`
  const api = createApiClient({ baseUrl: daemonUrl, token: readToken(stateDir, log) })
  const sinks = pluginConfig.sinks ?? {}

  const resolveAgent = sinkName => {
    const sink = sinks[sinkName]
    if (!sink) return undefined
    let id = sink.sessionId
    if (sink.botId) {
      try {
        const state = JSON.parse(readFileSync(expandHome(sink.botStatePath ?? '~/.dsh/bot/state.json'), 'utf8'))
        id = state.bots?.[sink.botId]?.sessionId ?? id
      } catch (error) {
        log(`读取 bot state 失败: ${error.message}`)
      }
    }
    if (!id) return undefined
    id = String(id)
    return ctx.agents.get(id) ?? ctx.agents.get(`session-${id.replace(/^session-/, '')}`) ?? ctx.agents.get(id.replace(/^session-/, ''))
  }

  const deliver = async (agent, batch) => {
    const llm = await import('@deepseek-ai/dsh-llm')
    const source = {
      kind: 'webhook', provider: 'personal-context', source: name,
      deliveryId: batch.id, ruleId: 'context-inbox', form: 'notice', summary: '个人上下文',
    }
    const message = llm.freezeMessage({
      id: llm.MessageId(batch.id),
      role: 'user',
      content: [{ type: 'text', text: batch.text }],
      source,
    })
    agent.followup(message)
    // 投完立刻落盘：崩溃或不正常退出时，这条消息不该只活在内存里
    try { ctx.sessionPersistence?.flush?.() } catch (error) { log(`flush 失败: ${error?.message ?? error}`) }
    log(`accepted batch=${batch.id} session=${agent.session?.id ?? '?'}`)
  }

  const loop = createDeliveryLoop({
    consumer: api,
    sink: config.delivery.sink,
    resolveAgent,
    deliver,
    limits: {
      count: settings.batchCount,
      chars: settings.batchChars,
      backlogCount: settings.backlogCount,
      backlogChars: settings.backlogChars,
    },
    limit: config.delivery.limit,
    intervalMs: settings.intervalMs,
    log,
  })

  // 设置面板的宿主半边：读写 config.json，写完立刻热应用
  if (ctx.webServer?.register) {
    try {
      const route = createSettingsRoute({
        config,
        log,
        apply(next) {
          loop.update({
            intervalMs: next.intervalMs,
            limits: {
              count: next.batchCount,
              chars: next.batchChars,
              backlogCount: next.backlogCount,
              backlogChars: next.backlogChars,
            },
          })
        },
      })
      const dispose = ctx.webServer.register({ kind: 'prefix', path: '/personal-context', handler: route })
      ctx.effect(() => dispose)
      log('设置接口已挂载：/personal-context/config')
    } catch (error) {
      log(`设置接口挂载失败：${error?.stack ?? error}`)
    }
  } else {
    log('宿主没有 webServer，设置面板的接口没挂上（投递照常）')
  }

  log(`started sink=${config.delivery.sink} interval=${settings.intervalMs}ms daemon=${daemonUrl}`)
  ctx.effect(() => () => loop.stop())
}

/** 读守护进程的 token：它写在 state 目录里（0600），插件和适配器都从这里拿。 */
function readToken(stateDir, log) {
  const path = join(stateDir, 'token')
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (error) {
    log(`读不到 token（${path}）：${error?.message ?? error}；守护进程起来后会自动重试`)
    return ''
  }
}

/** 设置界面的扁平字段 → 分层配置。没填的字段不覆盖，交给默认值。 */
function fromSettings(settings = {}) {
  const sink = settings.sink ?? undefined
  return {
    stateDir: settings.stateDir ?? undefined,
    routes: sink ? [{ sources: ['*'], sink }] : undefined,
    delivery: { intervalMs: settings.intervalMs, limit: settings.batchCount, sink },
    limits: {
      batchCount: settings.batchCount,
      batchChars: settings.batchChars,
      backlogCount: settings.backlogCount,
      backlogChars: settings.backlogChars,
    },
    sources: {
      telegram: { enabled: settings.telegramEnabled, intervalMs: settings.telegramIntervalMs },
      feishu: { enabled: settings.feishuEnabled, intervalMs: settings.feishuIntervalMs },
    },
  }
}

