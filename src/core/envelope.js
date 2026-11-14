import { createHash } from 'node:crypto'

const ACTORS = new Set(['self', 'other', 'system'])
// 必须带时区：'2026-11-14T19:40:00' 这种裸时间在跨机器时是歧义的
const ZONED = /T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

/** 信封的准入。返回合法的 Envelope，或者 { error } —— 不做静默修补。 */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'envelope_not_object' }

  const source = typeof raw.source === 'string' ? raw.source.trim().toLowerCase() : ''
  if (!source) return { error: 'missing_source' }

  const at = typeof raw.at === 'string' && ZONED.test(raw.at) && !Number.isNaN(Date.parse(raw.at)) ? raw.at : null
  if (!at) return { error: 'invalid_at' }

  const actor = raw.actor === undefined ? 'other' : raw.actor
  if (!ACTORS.has(actor)) return { error: 'invalid_actor' }

  const text = typeof raw.text === 'string' ? raw.text : ''
  const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {}
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : deriveId(source, at, text)

  return { id, source, at, actor, text, meta }
}

/** 没有天然 ID 时按 来源+时间+正文 推导，保证同一事实重复提交得到同一个键。 */
export function deriveId(source, at, text) {
  const digest = createHash('sha1').update(`${at}\u0000${text}`).digest('hex').slice(0, 16)
  return `${source}:${digest}`
}

/** 凭据规则只编译一次；命中后整条正文清空，绝不部分截断。 */
export function createCredentialRules({ chats = [], patterns = [] } = {}) {
  const chatSet = new Set(chats.map(String))
  const regexps = patterns.map(source => new RegExp(source, 'i'))
  return {
    matches(envelope) {
      const chat = String(envelope.meta?.chat_id ?? envelope.meta?.chat ?? '')
      if (chat && chatSet.has(chat)) return true
      return envelope.text ? regexps.some(re => re.test(envelope.text)) : false
    },
  }
}

export function stripCredentials(envelope, rules) {
  if (!rules || !rules.matches(envelope)) return envelope
  return { ...envelope, text: '', meta: { ...envelope.meta, redacted: true } }
}
