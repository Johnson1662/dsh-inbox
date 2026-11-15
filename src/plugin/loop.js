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
  consumer,
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
  let batchLimits = toLimits(limits)
  let period = intervalMs
  let backlogSeen = 0
  // 有 HTTP 客户端就用它；直接给 queue 时包一层（单进程测试、脚本用）
  const api = consumer ?? queueConsumer(queue, sink)

  async function drain() {
    if (running || now() < retryAt) return
    running = true
    try {
      // 先按（可能放大过的）条数上限取候选，再由 pick 按条数/字数裁出这一批。
      // 裁掉的不用管：done 时只点名投出去的那些，剩下的由守护进程放回队列。
      // 第一轮不知道积压多深：问一次（之后全靠 take 的返回值，不再多打请求）
      if (!backlogSeen && typeof api.backlog === 'function') {
        backlogSeen = await api.backlog(sink).catch(() => 0) || 0
      }
      const ceiling = effectiveLimits(batchLimits, backlogSeen)
      const taken = await api.take(Math.min(limit, ceiling.count), { sink })
      const candidates = taken.events ?? []
      if (!candidates.length) return
      backlogSeen = taken.backlog ?? candidates.length

      const { batch } = pick(candidates, batchLimits, { backlog: backlogSeen })
      if (!batch.length) {
        await api.retry(taken.ticket, '一条都装不下')
        return
      }

      const agent = resolveAgent(sink)
      if (!agent) {
        // 目标会话不在：整批退回去，等下一轮
        await api.retry(taken.ticket, '目标会话不可用')
        log(`sink=${sink} 没有可用会话，${candidates.length} 条继续等待`)
        return
      }

      const id = batchIdOf(batch)
      try {
        await deliver(agent, { id, text: render(batch) })
        const result = await api.done(taken.ticket, batch.map(event => event.id))
        failures = 0
        retryAt = 0
        log(`delivered ${id} events=${batch.length}${result?.released ? ` 顺延=${result.released}` : ''}`)
      } catch (error) {
        await api.retry(taken.ticket, error?.message ?? String(error))
        failures += 1
        retryAt = now() + Math.min(2 ** failures * 1000, 60000)
        log(`投递失败 sink=${sink} events=${batch.length}: ${error?.message ?? error}`)
      }
    } finally {
      running = false
    }
  }

  let timer = setInterval(() => { drain().catch(error => log(`drain error: ${error?.stack ?? error}`)) }, period)

  /** 设置页改完就地生效：上限立刻换，间隔变了重挂定时器。 */
  function update(next = {}) {
    if (next.limits !== undefined) batchLimits = toLimits(next.limits)
    if (next.intervalMs !== undefined && next.intervalMs !== period) {
      period = next.intervalMs
      clearInterval(timer)
      timer = setInterval(() => { drain().catch(error => log(`drain error: ${error?.stack ?? error}`)) }, period)
    }
  }

  return { drain, update, stop: () => clearInterval(timer) }
}

/** 把队列对象包成 API 客户端的样子：测试和单进程脚本直接用，不必起 HTTP。 */
export function queueConsumer(queue, sink = 'chief') {
  return {
    async take(limit) {
      return queue.takeBatch(sink, limit)
    },
    async backlog() {
      return queue.pending(sink)
    },
    async done(ticket, ids) {
      return queue.done(ticket, ids)
    },
    async retry(ticket, reason) {
      return queue.retry(ticket, reason)
    },
  }
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
