/**
 * 可选的收件会话：DSH 的 bot state 里每一个 bot 就是一个会话。
 *
 * 这个文件是唯一的"会话从哪来"的知识点。换个运行环境要改，就改这里。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BOT_STATE = join(homedir(), '.dsh', 'bot', 'state.json')

/** @returns {{id: string, name: string, role: string, sessionId: string|null}[]} */
export function listBots(path = DEFAULT_BOT_STATE) {
  if (!existsSync(path)) return []
  let state
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const bots = state?.bots ?? {}
  return Object.entries(bots)
    .map(([id, bot]) => ({
      id,
      name: String(bot?.name ?? id),
      role: String(bot?.role ?? ''),
      sessionId: bot?.sessionId ? String(bot.sessionId) : null,
    }))
    .filter(bot => bot.sessionId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 从 routes 里读出「每个来源投给谁」：取第一条匹配该来源的规则。 */
export function targetOfSource(routes = [], source) {
  const list = routes.map(route => ({ sources: (route.sources ?? []).map(String), sink: String(route.sink) }))
  const exact = list.find(route => route.sources.includes(String(source)))
  if (exact) return exact.sink
  const wildcard = list.find(route => route.sources.includes('*'))
  return wildcard ? wildcard.sink : ''
}

/** 由「来源 → 目标」映射生成 routes，末尾保留兜底规则。 */
export function routesFromTargets(targets = {}, { fallbackSink } = {}) {
  const routes = []
  for (const [source, sink] of Object.entries(targets)) {
    if (!sink) continue
    routes.push({ sources: [String(source)], sink: String(sink) })
  }
  const fallback = fallbackSink ?? routes[0]?.sink
  if (fallback) routes.push({ sources: ['*'], sink: String(fallback) })
  return routes
}
