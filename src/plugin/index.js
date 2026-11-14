import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { openQueue } from '../core/queue.js'
import { createDeliveryLoop } from './loop.js'

export const name = 'dsh-personal-context'
export const inject = ['agents']

/** 组合根：把队列、会话解析、投递方式接起来。业务判断都不在这里。 */
export function apply(ctx, initialConfig = {}) {
  if (initialConfig.enabled === false) return
  const stateDir = expand(initialConfig.stateDir ?? '~/.dsh/state/personal-context')
  mkdirSync(stateDir, { recursive: true })
  const log = message => {
    try { appendFileSync(join(stateDir, 'bridge.log'), `${new Date().toISOString()} ${message}\n`) } catch {}
  }

  const queue = openQueue(join(stateDir, 'context.sqlite'), {
    routes: initialConfig.routes ?? [{ sources: ['*'], sink: 'chief' }],
  })
  const sinks = initialConfig.sinks ?? {}

  const resolveAgent = sink => {
    const config = sinks[sink]
    if (!config) return undefined
    let id = config.sessionId
    if (config.botId) {
      try {
        const state = JSON.parse(readFileSync(expand(config.botStatePath ?? '~/.dsh/bot/state.json'), 'utf8'))
        id = state.bots?.[config.botId]?.sessionId ?? id
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
    sink: initialConfig.sink ?? 'chief',
    resolveAgent,
    deliver,
    limit: initialConfig.limits?.batchCount ?? 200,
    intervalMs: initialConfig.intervalMs ?? 500,
    log,
  })

  log(`started sink=${initialConfig.sink ?? 'chief'} queue=${queue.path}`)
  ctx.effect(() => () => {
    loop.stop()
    queue.close()
  })
}

function expand(path) {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}
