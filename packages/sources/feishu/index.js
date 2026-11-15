/**
 * 飞书来源的宿主半端：只做登记，采集在守护进程那边。
 */
export const name = 'dsh-personal-context-source-feishu'

export function apply(ctx) {
  const hub = typeof ctx.get === 'function' ? ctx.get('personalContext') : undefined
  if (!hub?.registerSource) return
  hub.registerSource({ name: 'feishu', label: '飞书', runtime: 'node', entry: 'worker.js' })
}
