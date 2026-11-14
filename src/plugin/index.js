import { appendFileSync, mkdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath, expandHome, loadConfig, persistConfig } from '../core/config.js'
import { openQueue } from '../core/queue.js'
import { createDeliveryLoop } from './loop.js'

export { Config } from './config-schema.js'
export const name = 'dsh-personal-context'
export const inject = ['agents']

/**
 * 组合根。设置界面里的字段（见 config-schema.js）在这里摊成配置层，
 * 并回写到与守护进程共用的那一份文件——界面改一次，两边都跟着变。
 */
export function apply(ctx, pluginConfig = {}) {
  if (pluginConfig.enabled === false) return

  const config = loadConfig(fromSettings(pluginConfig))
  const stateDir = expandHome(config.stateDir)
  mkdirSync(stateDir, { recursive: true })

  const log = message => {
    try { appendFileSync(join(stateDir, 'bridge.log'), `${new Date().toISOString()} ${message}\n`) } catch {}
  }

  try {
    persistConfig(configPath(config), toPatch(config))
  } catch (error) {
    log(`回写配置文件失败: ${error.message}`)
  }

  const queue = openQueue(join(stateDir, 'context.sqlite'), { routes: config.routes })
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
  }

  const loop = createDeliveryLoop({
    queue,
    sink: config.delivery.sink,
    resolveAgent,
    deliver,
    limit: config.delivery.limit,
    intervalMs: config.delivery.intervalMs,
    log,
  })

  log(`started sink=${config.delivery.sink} interval=${config.delivery.intervalMs}ms queue=${queue.path}`)
  ctx.effect(() => () => {
    loop.stop()
    queue.close()
  })
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

/** 回写到共用配置文件的部分：只有守护进程关心的那些。 */
function toPatch(config) {
  return {
    stateDir: config.stateDir,
    delivery: config.delivery,
    limits: config.limits,
    routes: config.routes,
    sources: {
      telegram: { enabled: config.sources.telegram.enabled, intervalMs: config.sources.telegram.intervalMs },
      feishu: { enabled: config.sources.feishu.enabled, intervalMs: config.sources.feishu.intervalMs },
    },
  }
}
