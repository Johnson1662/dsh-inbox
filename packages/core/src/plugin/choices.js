/**
 * 「可选值」的通用取值：来源在字段声明里写清怎么问它要清单，
 * 面板只负责把名字画出来，用户永远不用知道 username 长什么样。
 *
 * 声明长这样（来源自己的 package.json）：
 *   "options": {
 *     "command": "wx", "args": ["sessions", "--json"],
 *     "path": "sessions",          // 从 JSON 里取哪一层数组
 *     "value": "username",         // 提交上去的值
 *     "label": "chat",             // 给人看的名字
 *     "group": { "field": "is_group", "true": "群聊", "false": "联系人" }
 *   }
 *
 * 这里只认识「命令行吐 JSON」这一种取法——够用，且不需要在插件进程里跑来源代码。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CACHE_MS = 60_000

const valueAt = (object, path) => {
  let cursor = object
  for (const key of String(path ?? '').split('.').filter(Boolean)) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

/** 把来源吐出来的 JSON 变成 [{ value, label, group }]，纯函数，好测。 */
export function pickChoices(payload, descriptor = {}) {
  const rows = descriptor.path ? valueAt(payload, descriptor.path) : payload
  const list = Array.isArray(rows) ? rows : Array.isArray(payload) ? payload : []
  const out = []
  const seen = new Set()
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const value = String(row[descriptor.value ?? 'value'] ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    const rawLabel = String(row[descriptor.label ?? 'label'] ?? '').trim()
    const label = rawLabel && rawLabel !== value ? rawLabel : value
    // 分组二选一：声明里给了映射就查表（is_group 1/0 → 群聊/联系人），
    // 没给映射就把那一列的值直接当组名（GitHub 的仓库清单自己带「组织」「协作」）。
    const group = descriptor.group
      ? String(descriptor.group[String(row[descriptor.group.field])] ?? row[descriptor.group.field] ?? '') || undefined
      : undefined
    out.push(group ? { value, label, group } : { value, label })
  }
  // 组顺序由声明决定（群聊在联系人前面），面板直接按这个顺序铺 optgroup
  const order = descriptor.group?.order
  if (Array.isArray(order) && order.length) {
    const rank = value => {
      const index = order.indexOf(value)
      return index === -1 ? order.length : index
    }
    out.sort((left, right) => rank(left.group) - rank(right.group))
  }
  return out
}

/**
 * 按字段声明取清单，带 60 秒缓存——面板每次自动刷新不必都去问一遍 CLI。
 * 取不到就返回空清单：宁可不给选，也不能让整个设置页炸掉。
 */
export function createChoiceLoader({ exec = run, log = () => {}, cacheMs = CACHE_MS } = {}) {
  const cache = new Map()

  async function one(key, descriptor) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < cacheMs) return hit.value
    try {
      const { stdout } = await exec(descriptor.command, descriptor.args ?? [], {
        timeout: descriptor.timeoutMs ?? 20_000,
        maxBuffer: 16 * 1024 * 1024,
      })
      const value = pickChoices(JSON.parse(stdout), descriptor)
      cache.set(key, { at: Date.now(), value })
      return value
    } catch (error) {
      log(`可选值取不到（${key}）：${error?.message ?? error}`)
      // 失败时退回上一次的好结果，面板不至于突然清空
      return hit?.value ?? []
    }
  }

  /** fields 里所有带 options 的项 → { 扁平键: [选项] } */
  async function load(fields = []) {
    const out = {}
    await Promise.all(fields.filter(field => field.options?.command).map(async field => {
      out[field.key] = await one(field.source ? `${field.source}:${field.sourceKey}` : field.key, field.options)
    }))
    return out
  }

  return { load, clear: () => cache.clear() }
}
