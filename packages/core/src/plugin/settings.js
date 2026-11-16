/**
 * 设置项的单一事实来源：范围、默认值、扁平设置 ↔ 分层配置的换算。
 *
 * 浏览器面板（client.js）和宿主路由（index.js）都从这里取，两边不可能对不上。
 * 值一律校验后再落盘——面板传什么都不能绕过这里。
 *
 * 来源那一半**不写死**：从已安装来源的 `dsh.source.fields` 声明里生成，所以新加
 * 一路来源，面板和配置自动就有它的开关与节奏，不用改这个文件。
 */
import { join } from 'node:path'

/** 投递侧的设置项：固定几项，与来源无关。 */
export const DELIVERY_FIELDS = [
  { key: 'intervalMs', group: '投递', label: '投递间隔（毫秒）', type: 'number', min: 100, max: 60000, step: 100 },
  { key: 'batchCount', group: '投递', label: '单批最多几条', type: 'number', min: 1, max: 1000, step: 1 },
  { key: 'batchChars', group: '投递', label: '单批最多多少字', type: 'number', min: 200, max: 100000, step: 100 },
  { key: 'backlogCount', group: '投递', label: '积压多少条后放大上限', type: 'number', min: 1, max: 10000, step: 1 },
  { key: 'backlogChars', group: '投递', label: '放大后的字数上限', type: 'number', min: 200, max: 400000, step: 100 },
]

export const DEFAULTS = Object.freeze({
  intervalMs: 500,
  batchCount: 50,
  batchChars: 4000,
  backlogCount: 200,
  backlogChars: 20000,
})

/** 来源没有声明 fields 时的兜底：至少能关、能调节奏。 */
const FALLBACK_SOURCE_FIELDS = [
  { key: 'enabled', label: '采集', type: 'boolean', default: false },
  { key: 'intervalMs', label: '轮询间隔（毫秒）', type: 'number', min: 1000, max: 300000, step: 500 },
]

const capitalize = value => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`

/**
 * 来源可以只说「清单怎么算」——写个脚本名就行，路径按来源包目录补全。
 * 这样可选值的取法可以有自己的逻辑（微信要合并联系人库），面板不用知道。
 */
function resolveOptions(options, dir) {
  if (!options?.script) return options
  if (!dir) return undefined
  const { script, ...rest } = options
  return { ...rest, command: process.execPath, args: [join(dir, script)] }
}

/**
 * 来源声明 → 设置项。
 *
 * 扁平键名 = 来源名 + 字段名首字母大写（`wx` + `chats` → `wxChats`）。
 * `source` / `sourceKey` 记住它落进 config.sources 的哪一格——中文标题不能拿来猜。
 */
export function sourceFields(manifests = []) {
  const out = []
  for (const manifest of manifests) {
    const name = String(manifest?.name ?? '').trim()
    if (!name) continue
    const declared = Array.isArray(manifest.fields) && manifest.fields.length ? manifest.fields : FALLBACK_SOURCE_FIELDS
    for (const field of declared) {
      if (!field?.key) continue
      const options = resolveOptions(field.options, manifest.dir)
      out.push({
        key: `${name}${capitalize(field.key)}`,
        source: name,
        sourceKey: field.key,
        group: manifest.label ?? name,
        label: field.label ?? field.key,
        type: field.type ?? 'boolean',
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.step === undefined ? {} : { step: field.step }),
        ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
        ...(field.hint === undefined ? {} : { hint: field.hint }),
        ...(field.default === undefined ? {} : { default: field.default }),
        ...(options ? { options } : {}),
      })
    }
  }
  return out
}

/** 全部设置项：投递固定项 + 每个来源的声明。 */
export function fieldsFor(manifests = []) {
  return [...DELIVERY_FIELDS, ...sourceFields(manifests)]
}

/** 每个设置项的默认值。 */
export function defaultsFor(fields = DELIVERY_FIELDS) {
  const out = { ...DEFAULTS }
  for (const field of fields) {
    if (field.key in out) continue
    out[field.key] = field.default
      ?? (field.type === 'boolean' ? false
        : field.type === 'list' || field.type === 'text' ? ''
        : (field.min ?? 0))
  }
  return out
}

const toList = value => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
  return []
}

/** list 型在面板里是一行逗号分隔的文本，落盘是数组。 */
const listToText = value => toList(value).join(',')

/** 分层配置 → 扁平设置。缺的键用默认值。 */
export function toSettings(config = {}, fields = DELIVERY_FIELDS) {
  const delivery = config.delivery ?? {}
  const limits = config.limits ?? {}
  const settings = {}
  for (const field of fields) {
    const fallback = field.default ?? DEFAULTS[field.key]
    if (!field.source) {
      const raw = field.key === 'intervalMs' ? delivery.intervalMs : limits[field.key]
      settings[field.key] = raw ?? fallback
      continue
    }
    const raw = config.sources?.[field.source]?.[field.sourceKey ?? field.key]
    settings[field.key] = field.type === 'list' ? listToText(raw ?? fallback) : raw ?? fallback
  }
  return settings
}

/** 扁平设置 → 分层 patch（直接给 persistConfig 合并进 config.json）。 */
export function toLayered(settings = {}, fields = DELIVERY_FIELDS) {
  const patch = { delivery: { intervalMs: settings.intervalMs }, limits: {}, sources: {} }
  for (const field of fields) {
    if (!field.source) {
      if (field.key !== 'intervalMs') patch.limits[field.key] = settings[field.key]
      continue
    }
    const bucket = patch.sources[field.source] ?? (patch.sources[field.source] = {})
    bucket[field.sourceKey ?? field.key] = field.type === 'list' ? toList(settings[field.key]) : settings[field.key]
  }
  return patch
}

/**
 * 校验并合并：只接受 fields 里声明过的键，逐项查类型与范围。
 * 返回 { settings, errors }——有一个不合法就整单拒绝，不做部分保存。
 */
export function validate(input = {}, base = DEFAULTS, fields = DELIVERY_FIELDS) {
  const settings = { ...base }
  const errors = []
  for (const field of fields) {
    const value = input[field.key]
    if (value === undefined) continue

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') { errors.push(`${field.label} 必须是开关值`); continue }
      settings[field.key] = value
      continue
    }

    if (field.type === 'list' || field.type === 'text') {
      if (typeof value !== 'string' && !Array.isArray(value)) { errors.push(`${field.label} 必须是文本`); continue }
      settings[field.key] = field.type === 'list' ? listToText(value) : String(value)
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

  const unknown = Object.keys(input).filter(key => !fields.some(field => field.key === key))
  if (unknown.length) errors.push(`不认识的设置项：${unknown.join(', ')}`)
  return { settings, errors }
}
