/**
 * GitHub 来源的宿主半端。
 *
 * 它什么都不采集——采集由守护进程 spawn worker.js 完成（DSH 关着也照跑）。
 * 这一行的作用只有一个：让 DSH 知道自己装了这路来源，并把字段并进设置面板。
 *
 * token 走 `gh auth token`（或 PERSONAL_CONTEXT_SOURCE_TOKEN），不进 config.json。
 */
export const name = 'dsh-inbox-source-github'

export function apply(ctx) {
  const hub = typeof ctx.get === 'function' ? ctx.get('personalContext') : undefined
  if (!hub?.registerSource) return
  hub.registerSource({ name: 'github', label: 'GitHub', runtime: 'node', entry: 'worker.js' })
}
