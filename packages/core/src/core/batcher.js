import { LINE_OVERHEAD, bodyOf } from './render.js'

/**
 * 一批装多少：条数与字数双限流。
 *
 * 默认值与 config.limits 一致（50 条 / 4000 字；积压时放大到 200 条 / 20000 字）。
 * 这里只回答"这一批装哪几条"，不读库、不改状态、不认识 sink。
 */
export const DEFAULT_LIMITS = Object.freeze({
  count: 50,
  chars: 4000,
  backlogCount: 200,
  backlogChars: 20000,
})

/**
 * 单条事件的估算字数：每行固定开销 + 正文长度。
 *
 * 正文长度必须与 render 的行模板一致，所以直接用 render 的 bodyOf：
 * 换行折成空格、空正文补「附件/隐去」占位——估算与真正投出去的那一行同一份正文。
 * 表头不计入：一批省下来的那点余量正好盖住表头。
 */
export function costOf(event) {
  return LINE_OVERHEAD + bodyOf(event).length
}

/**
 * 这一轮生效的上限。
 *
 * 只有待投条数**超过** backlogCount 时才放大。放大是为了少唤醒几次，
 * 不是为了少投几条：装不下的仍在队列里等下一批，事件状态不变。
 */
export function effectiveLimits(limits = {}, backlog = 0) {
  const count = positive(limits.count, DEFAULT_LIMITS.count)
  const chars = positive(limits.chars, DEFAULT_LIMITS.chars)
  const backlogCount = positive(limits.backlogCount, DEFAULT_LIMITS.backlogCount)
  const backlogChars = positive(limits.backlogChars, DEFAULT_LIMITS.backlogChars)
  return backlog > backlogCount
    ? { count: backlogCount, chars: backlogChars, enlarged: true }
    : { count, chars, enlarged: false }
}

/**
 * 从候选里裁出这一批：条数先到或字数先到就停，剩下的原序进 rest。
 *
 * 不变式（调用方可以依赖）：
 *  - `batch ∪ rest === events`，顺序不变，一条不多一条不少
 *  - `events` 非空则 `batch` 非空
 *  - 单条本身超字数上限 → 该条独占一批，**不截断**
 *  - 从不丢弃：装不下的只是留到下一批
 */
export function pick(events = [], limits = {}, { backlog = 0 } = {}) {
  const list = Array.isArray(events) ? events : []
  const ceiling = effectiveLimits(limits, backlog)
  const batch = []
  let chars = 0

  for (const event of list) {
    const cost = costOf(event)
    if (batch.length > 0 && (batch.length + 1 > ceiling.count || chars + cost > ceiling.chars)) break
    // 第一条无条件收下：它自己就超长时独占一批，绝不截断正文
    batch.push(event)
    chars += cost
  }

  return { batch, rest: list.slice(batch.length) }
}

/** 上限只认正的有限数：0 / NaN / undefined 一律退回默认值，不做静默放大或清空。 */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}
