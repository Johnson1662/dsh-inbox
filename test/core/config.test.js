import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, enabledSources, loadConfig, persistConfig } from '../../src/core/config.js'

test('没有覆盖时全是默认值', () => {
  const config = loadConfig({}, { env: {} })
  assert.equal(config.delivery.intervalMs, 500)
  assert.equal(config.limits.batchCount, 50)
  assert.equal(config.sources.telegram.enabled, false)
  assert.equal(config.sources.telegram.intervalMs, 8000)
  assert.deepEqual(enabledSources(config), [])
})

test('环境变量覆盖默认值', () => {
  const config = loadConfig({}, { env: { PERSONAL_CONTEXT_DELIVERY_INTERVAL_MS: '250', PERSONAL_CONTEXT_BATCH_COUNT: '80', PERSONAL_CONTEXT_SINK: 'work' } })
  assert.equal(config.delivery.intervalMs, 250)
  assert.equal(config.limits.batchCount, 80)
  assert.equal(config.delivery.sink, 'work')
})

test('环境变量优先于文件配置', () => {
  const config = loadConfig({ limits: { batchCount: 10 } }, { env: { PERSONAL_CONTEXT_BATCH_COUNT: '99' } })
  assert.equal(config.limits.batchCount, 99)
})

test('文件配置优先于默认值，且未提及的字段保留默认', () => {
  const config = loadConfig({ sources: { feishu: { enabled: true, intervalMs: 3000 } } }, { env: {} })
  assert.equal(config.sources.feishu.enabled, true)
  assert.equal(config.sources.feishu.intervalMs, 3000)
  assert.equal(config.limits.batchCount, DEFAULTS.limits.batchCount)
})

test('每个来源可以单独开关与调节节奏', () => {
  const config = loadConfig({}, {
    env: {
      PERSONAL_CONTEXT_TELEGRAM_ENABLED: '1',
      PERSONAL_CONTEXT_TELEGRAM_INTERVAL_MS: '15000',
      PERSONAL_CONTEXT_TELEGRAM_API_ID: '1',
      PERSONAL_CONTEXT_TELEGRAM_API_HASH: 'h',
      PERSONAL_CONTEXT_TELEGRAM_SESSION: '/tmp/x',
    },
  })
  assert.deepEqual(enabledSources(config).map(s => s.name), ['telegram'])
  assert.equal(config.sources.telegram.intervalMs, 15000)
})

test('开启了但缺凭据，启动即失败并点名缺什么', () => {
  assert.throws(
    () => loadConfig({}, { env: { PERSONAL_CONTEXT_TELEGRAM_ENABLED: 'true' }, requireCredentials: true }),
    /telegram.*apiId/,
  )
  const config = loadConfig({}, {
    env: { PERSONAL_CONTEXT_TELEGRAM_ENABLED: 'true', PERSONAL_CONTEXT_TELEGRAM_API_ID: '1', PERSONAL_CONTEXT_TELEGRAM_API_HASH: 'h', PERSONAL_CONTEXT_TELEGRAM_SESSION: '/tmp/x' },
    requireCredentials: true,
  })
  assert.equal(enabledSources(config).length, 1)
})

test('非法数值直接报错，不静默取默认', () => {
  assert.throws(() => loadConfig({}, { env: { PERSONAL_CONTEXT_BATCH_COUNT: '十' } }), /PERSONAL_CONTEXT_BATCH_COUNT/)
  assert.throws(() => loadConfig({}, { env: { PERSONAL_CONTEXT_BATCH_COUNT: '0' } }), /PERSONAL_CONTEXT_BATCH_COUNT/)
  assert.throws(() => loadConfig({}, { env: { PERSONAL_CONTEXT_TELEGRAM_ENABLED: '呀' } }), /PERSONAL_CONTEXT_TELEGRAM_ENABLED/)
})

test('响应式配置（带 get）也能摊平', () => {
  const reactive = { limits: { get: () => ({ batchCount: 7 }) }, sources: { get: () => ({}) } }
  assert.equal(loadConfig(reactive, { env: {} }).limits.batchCount, 7)
})

test('回写配置：保留已有键，原子替换', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ stateDir: dir, custom: '保留我' }))
  const next = persistConfig(path, { delivery: { intervalMs: 250 } })
  assert.equal(next.custom, '保留我')
  assert.equal(next.delivery.intervalMs, 250)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), next)
  rmSync(dir, { recursive: true, force: true })
})

test('插件侧不校验来源凭据：看不到 sources.env 也照样能起', () => {
  const config = loadConfig({ sources: { telegram: { enabled: true, intervalMs: 8000 } } }, { env: {} })
  assert.equal(config.sources.telegram.enabled, true)
})
