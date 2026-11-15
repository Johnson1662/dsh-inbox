/**
 * 设置项的单一事实来源：范围、默认值、扁平设置 ↔ 分层配置的换算。
 *
 * 浏览器面板（client.js）和宿主路由（index.js）都从这里取，两边不可能对不上。
 * 值一律校验后再落盘——面板传什么都不能绕过这里。
 */

/** 每项：类型、范围、说明。客户端照着渲染，宿主照着校验。 */
export const FIELDS = [
  { key: 'intervalMs', group: '投递', label: '投递间隔（毫秒）', type: 'number', min: 100, max: 60000, step: 100 },
  { key: 'batchCount', group: '投递', label: '单批最多几条', type: 'number', min: 1, max: 1000, step: 1 },
  { key: 'batchChars', group: '投递', label: '单批最多多少字', type: 'number', min: 200, max: 100000, step: 100 },
  { key: 'backlogCount', group: '投递', label: '积压多少条后放大上限', type: 'number', min: 1, max: 10000, step: 1 },
  { key: 'backlogChars', group: '投递', label: '放大后的字数上限', type: 'number', min: 200, max: 400000, step: 100 },

  { key: 'telegramEnabled', group: 'Telegram', label: '采集 Telegram', type: 'boolean' },
  { key: 'telegramIntervalMs', group: 'Telegram', label: '轮询间隔（毫秒）', type: 'number', min: 1000, max: 300000, step: 500 },

  { key: 'feishuEnabled', group: '飞书', label: '采集飞书', type: 'boolean' },
  { key: 'feishuIntervalMs', group: '飞书', label: '轮询间隔（毫秒）', type: 'number', min: 1000, max: 300000, step: 500 },
]

export const DEFAULTS = Object.freeze({
  intervalMs: 500,
  batchCount: 50,
  batchChars: 4000,
  backlogCount: 200,
  backlogChars: 20000,
  telegramEnabled: false,
  telegramIntervalMs: 8000,
  feishuEnabled: false,
  feishuIntervalMs: 5000,
})

/** 分层配置 → 扁平设置。缺的键用默认值。 */
export function toSettings(config = {}) {
  const delivery = config.delivery ?? {}
  const limits = config.limits ?? {}
  const telegram = config.sources?.telegram ?? {}
  const feishu = config.sources?.feishu ?? {}
  return {
    intervalMs: delivery.intervalMs ?? DEFAULTS.intervalMs,
    batchCount: limits.batchCount ?? DEFAULTS.batchCount,
    batchChars: limits.batchChars ?? DEFAULTS.batchChars,
    backlogCount: limits.backlogCount ?? DEFAULTS.backlogCount,
    backlogChars: limits.backlogChars ?? DEFAULTS.backlogChars,
    telegramEnabled: telegram.enabled ?? DEFAULTS.telegramEnabled,
    telegramIntervalMs: telegram.intervalMs ?? DEFAULTS.telegramIntervalMs,
    feishuEnabled: feishu.enabled ?? DEFAULTS.feishuEnabled,
    feishuIntervalMs: feishu.intervalMs ?? DEFAULTS.feishuIntervalMs,
  }
}

/** 扁平设置 → 分层 patch（直接给 persistConfig 合并进 config.json）。 */
export function toLayered(settings) {
  return {
    delivery: { intervalMs: settings.intervalMs },
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

/**
 * 校验并合并：只接受 FIELDS 里声明过的键，逐项查范围。
 * 返回 { settings, errors }——有一个不合法就整单拒绝，不做部分保存。
 */
export function validate(input = {}, base = DEFAULTS) {
  const settings = { ...base }
  const errors = []
  for (const field of FIELDS) {
    const value = input[field.key]
    if (value === undefined) continue
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') { errors.push(`${field.label} 必须是开关值`); continue }
      settings[field.key] = value
      continue
    }
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) { errors.push(`${field.label} 必须是数字`); continue }
    if (parsed < field.min || parsed > field.max) {
      errors.push(`${field.label} 超出范围 ${field.min}–${field.max}`)
      continue
    }
    settings[field.key] = Math.round(parsed)
  }
  const unknown = Object.keys(input).filter(key => !FIELDS.some(field => field.key === key))
  if (unknown.length) errors.push(`不认识的设置项：${unknown.join(', ')}`)
  return { settings, errors }
}
