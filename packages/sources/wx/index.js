/**
 * 微信来源的宿主半端。
 *
 * 它什么都不采集——采集由守护进程 spawn worker.js 完成（DSH 关着也照跑）。
 * 这一行的作用只有一个：让 DSH 知道自己装了这路来源，并把字段并进设置面板。
 *
 * 白名单走环境变量 PERSONAL_CONTEXT_SOURCE_CHATS（和 Telegram 那路一致），
 * 因为面板目前只认 boolean / number / target 三种控件。
 */
export const name = 'dsh-inbox-source-wx'

export function apply(ctx) {
  const hub = typeof ctx.get === 'function' ? ctx.get('personalContext') : undefined
  if (!hub?.registerSource) return
  hub.registerSource({ name: 'wx', label: '微信', runtime: 'node', entry: 'worker.js' })
}
