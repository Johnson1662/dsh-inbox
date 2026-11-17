/**
 * @johnson1662/dsh-inbox 的入口。
 *
 * 包自带全部实现，装下来的就是这一个包：core 负责投递与设置页，四路来源各带一份
 * `dsh.source` 清单（采集在守护进程里跑，DSH 这端只按清单长出设置字段）。
 * cordis.patch.yml 只插一行插件，就是本包本身。
 */
export { Config, inject, name } from './packages/core/src/plugin/index.js'
export { apply } from './packages/core/src/plugin/index.js'
