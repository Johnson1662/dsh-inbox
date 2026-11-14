import { createHash } from 'node:crypto'
import { effectiveLimits, pick } from '../core/batcher.js'
import { render } from '../core/render.js'

/** 一批的稳定标识：由事件 id 集合推导，同一批重投时消息 id 不变，去重才有依据。 */
export function batchIdOf(batch) {
  const digest = createHash('sha1').update(batch.map(event => event.id).join('\u0000')).digest('hex')
  return `pc:${digest.slice(0, 16)}`
}

/**
 * 投递循环：取一批 → 渲染 → 投进会话 → 标记。
 *
 * 不变式：
 *  - 投成功才 ack；失败只记一次尝试，事件仍在待投里
 *  - 目标会话不可用时不动事件，等下一轮
 *  - 失败后按指数退避，不空转
 *  - 这一轮装不下的事件原样留在库里（未 ack），下一轮接着投：不丢一条
 */
export function createDeliveryLoop({
  queue,
  sink = 'chief',
  resolveAgent,
  deliver,
  limits = {},
  limit = 200,
  intervalMs = 500,
  log = () => {},
  now = () => Date.now(),
}) {
  let running = false
  let failures = 0
  let retryAt = 0
  const batchLimits = toLimits(limits)

  async function drain() {
    if (running || now() < retryAt) return
    running = true
    try {
      // 先按放大后的条数上限取候选，再由 pick 按条数/字数裁出这一批；裁掉的留在库里等下一批
      const backlog = queue.pending(sink)
      const ceiling = effectiveLimits(batchLimits, backlog)
      const candidates = queue.take(sink, Math.min(limit, ceiling.count))
      const { batch, rest } = pick(candidates, batchLimits, { backlog })
      if (!batch.length) return

      const agent = resolveAgent(sink)
      if (!agent) {
        log(`sink=${sink} 没有可用会话，${batch.length} 条继续等待`)
        return
      }

      const id = batchIdOf(batch)
      try {
        await deliver(agent, { id, text: render(batch) })
        queue.ack(batch.map(event => event.id))
        failures = 0
        retryAt = 0
        log(`delivered ${id} events=${batch.length}${rest.length ? ` 顺延=${rest.length}` : ''}`)
      } catch (error) {
        queue.fail(batch.map(event => event.id), error?.message ?? String(error))
        failures += 1
        retryAt = now() + Math.min(2 ** failures * 1000, 60000)
        log(`投递失败 sink=${sink} events=${batch.length}: ${error?.message ?? error}`)
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { drain().catch(error => log(`drain error: ${error?.stack ?? error}`)) }, intervalMs)
  return { drain, stop: () => clearInterval(timer) }
}

/**
 * config.limits 沿用设置界面的命名（batchCount / batchChars），batcher 用 count / chars。
 * 只在这一处对齐，缺失的键交给 batcher 的默认值。
 */
function toLimits(limits = {}) {
  return {
    count: limits.count ?? limits.batchCount,
    chars: limits.chars ?? limits.batchChars,
    backlogCount: limits.backlogCount,
    backlogChars: limits.backlogChars,
  }
}
