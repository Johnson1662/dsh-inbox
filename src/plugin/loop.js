import { createHash } from 'node:crypto'
import { effectiveLimits, pick } from '../core/batcher.js'
import { render } from '../core/render.js'

/** 一批的稳定标识：由事件 id 集合推导，同一批重投时消息 id 不变，去重才有依据。 */
export function batchIdOf(batch, sink = '') {
  const digest = createHash('sha1').update(`${sink}\u0000${batch.map(event => event.id).join('\u0000')}`).digest('hex')
  return `pc:${digest.slice(0, 16)}`
}

/**
 * 投递循环：取一批 → 渲染 → 投进会话 → 回话。
 *
 * 不变式：
 *  - 投成功才 done；失败一律 retry（整张退回），事件仍在待投里
 *  - 目标会话不可用时整批退回，等下一轮
 *  - 失败后按指数退避，不空转
 *  - 装不下的事件由 done 自动放回，不丢一条
 *  - 每个 sink 各自一份批次；一个 sink 出错不影响别的 sink
 */
export function createDeliveryLoop({
  queue,
  consumer,
  sink,
  sinks,
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
  const backlogs = new Map()
  const quietUntil = new Map()
  // 有 HTTP 客户端就用它；直接给 queue 时包一层（单进程测试、脚本用）
  const api = consumer ?? queueConsumer(queue, sink ?? 'chief')

  /** 这一轮要处理哪些 sink：固定一个 / 外部给的列表 / 问守护进程要。 */
  async function destinations() {
    if (typeof sinks === 'function') {
      const list = await sinks()
      return Array.isArray(list) ? list : []
    }
    if (Array.isArray(sinks) && sinks.length) return sinks
    if (sink) return [sink]
    if (typeof api.sinks === 'function') return (await api.sinks()) ?? []
    return []
  }

  async function drain() {
    if (running || now() < retryAt) return
    running = true
    try {
      for (const destination of await destinations()) {
        try {
          await drainOne(destination)
        } catch (error) {
          log(`sink=${destination} 出错：${error?.message ?? error}`)
        }
      }
    } finally {
      running = false
    }
  }

  async function drainOne(destination) {
    // 第一轮不知道积压多深：问一次（之后全靠 take 的返回值，不再多打请求）
    let backlogSeen = backlogs.get(destination) ?? 0
    if (!backlogSeen && typeof api.backlog === 'function') {
      backlogSeen = (await api.backlog(destination).catch(() => 0)) || 0
    }

    const ceiling = effectiveLimits(batchLimits, backlogSeen)
    const taken = await api.take(Math.min(limit, ceiling.count), { sink: destination })
    const candidates = taken.events ?? []
    backlogs.set(destination, taken.backlog ?? candidates.length)
    if (!candidates.length) return

    const { batch } = pick(candidates, batchLimits, { backlog: backlogs.get(destination) })
    if (!batch.length) {
      await api.retry(taken.ticket, '一条都装不下')
      return
    }

    const agent = resolveAgent(destination)
    if (!agent) {
      await api.retry(taken.ticket, '目标会话不可用')
      // 目标会话没被打开过时这条会每 500ms 响一次，压到一分钟一次
      if (now() > (quietUntil.get(destination) ?? 0)) {
        quietUntil.set(destination, now() + 60_000)
        log(`sink=${destination} 的会话还没打开，${candidates.length} 条排队等着（在 DSH 里打开它就会自动投递）`)
      }
      return
    }

    const id = batchIdOf(batch, destination)
    try {
      await deliver(agent, { id, text: render(batch), sink: destination })
      const result = await api.done(taken.ticket, batch.map(event => event.id))
      failures = 0
      retryAt = 0
      log(`delivered ${id} sink=${destination} events=${batch.length}${result?.released ? ` 顺延=${result.released}` : ''}`)
    } catch (error) {
      await api.retry(taken.ticket, error?.message ?? String(error))
      failures += 1
      retryAt = now() + Math.min(2 ** failures * 1000, 60000)
      log(`投递失败 sink=${destination} events=${batch.length}: ${error?.message ?? error}`)
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
    async done(ticket, ids) {
      return queue.done(ticket, ids)
    },
    async retry(ticket, reason) {
      return queue.retry(ticket, reason)
    },
    async backlog() {
      return queue.pending(sink)
    },
    async sinks() {
      return queue.sinks?.() ?? [sink]
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
