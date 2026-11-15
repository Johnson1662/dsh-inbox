/**
 * 适配器与守护进程之间的三个动作，只走 HTTP，不碰数据库。
 *
 *   take(limit)     取一批，拿到小票；租约到期没回话，守护进程自动收回
 *   done(ticket,ids) 投完了：点名的标已投，没点名的放回队列
 *   retry(ticket,r)  没投成：整张退回，记一次原因
 *
 * 谁想接别的 agent，照这三个调用写五十行就行，不需要知道我们的表结构。
 */
export function createApiClient({ baseUrl, token, timeoutMs = 10_000 } = {}) {
  if (!baseUrl) throw new Error('api-client 缺 baseUrl')
  const root = baseUrl.replace(/\/+$/, '')

  async function call(path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
    } catch (error) {
      throw new Error(error?.name === 'AbortError' ? `守护进程 ${path} 超时` : `连不上守护进程：${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`守护进程 ${path} 返回了非 JSON（${response.status}）`)
    }
    if (!response.ok) throw new Error(payload?.error ?? `守护进程 ${path} 失败（${response.status}）`)
    return payload
  }

  async function get(path) {
    const response = await fetch(`${root}${path}`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`守护进程 ${path} 失败（${response.status}）`)
    return response.json()
  }

  return {
    take: (limit, extra = {}) => call('/v1/take', { limit, ...extra }),
    /** 待投条数：只在第一轮用来决定要不要放大上限，之后靠 take 的返回值。 */
    backlog: async sink => {
      const stats = await get('/v1/stats')
      return stats?.perSource?.[sink]?.pending ?? stats?.pending ?? 0
    },
    done: (ticket, ids) => call('/v1/done', { ticket, ids }),
    retry: (ticket, reason) => call('/v1/retry', { ticket, reason: String(reason ?? '').slice(0, 300) }),
  }
}
