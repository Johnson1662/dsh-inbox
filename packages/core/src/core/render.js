/** 按来源模板把一批事件渲染成一条消息：表头一行、每条事件一行。不摘要、不省略。 */
export function render(batch) {
  if (!batch.length) return ''
  const groups = new Map()
  for (const envelope of batch) {
    if (!groups.has(envelope.source)) groups.set(envelope.source, [])
    groups.get(envelope.source).push(envelope)
  }
  const lines = []
  for (const [source, list] of groups) {
    lines.push(`[${source}] ${list.length} 条新消息`)
    for (const envelope of list) lines.push(renderLine(envelope))
  }
  return lines.join('\n')
}

/** 正文里的换行折成空格：一条事件必须占一行，否则 agent 数不清有几条。 */
export function renderLine(envelope) {
  const chat = envelope.meta?.chat ?? envelope.meta?.chat_name ?? '未知会话'
  const sender = envelope.meta?.sender ?? envelope.meta?.sender_name ?? '?'
  return `· ${chat} | ${sender} | ${timeOf(envelope.at)} | ${bodyOf(envelope)}`
}

/**
 * 行内正文：折行后的正文，或空正文时的占位说明。
 * batcher 的估算与这一行渲染共用它，两边不会算出两种长度。
 */
export function bodyOf(envelope) {
  const body = String(envelope.text ?? '').replace(/\s*\n\s*/g, ' ').trim()
  return body || (envelope.meta?.redacted
    ? '（正文已隐去：凭据类）'
    : `（附件：${envelope.meta?.media ?? '无正文'}）`)
}

/** 取事件自带时区里的 HH:MM，不做时区换算——渲染要确定，测试才好写。 */
export function timeOf(at) {
  return typeof at === 'string' ? at.slice(11, 16) : ''
}

/** batcher 估算字数用的每行固定开销，必须与上面的模板一致。 */
export const LINE_OVERHEAD = 20
