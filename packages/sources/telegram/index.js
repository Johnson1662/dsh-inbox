/**
 * Telegram 来源的宿主半端。
 *
 * 它什么都不采集——采集由守护进程 spawn worker.py 完成（DSH 关着也照跑）。
 * 这一行的作用只有一个：让 DSH 知道自己装了这路来源，并把它的字段并进设置面板。
 */
export const name = 'dsh-inbox-source-telegram'

export function apply(ctx) {
  const hub = typeof ctx.get === 'function' ? ctx.get('personalContext') : undefined
  if (!hub?.registerSource) return
  hub.registerSource({ name: 'telegram', label: 'Telegram', runtime: 'python', entry: 'worker.py' })
}
