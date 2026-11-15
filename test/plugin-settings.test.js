import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, FIELDS, toLayered, toSettings, validate } from '../src/plugin/settings.js'

test('分层配置往返不丢值', () => {
  const settings = { ...DEFAULTS, telegramEnabled: true, feishuIntervalMs: 3000, batchCount: 7 }
  assert.deepEqual(toSettings(toLayered(settings)), settings)
})

test('缺字段时用默认值补齐', () => {
  const settings = toSettings({ delivery: { intervalMs: 250 } })
  assert.equal(settings.intervalMs, 250)
  assert.equal(settings.batchCount, DEFAULTS.batchCount)
  assert.equal(settings.telegramEnabled, false)
})

test('合法输入全部收下', () => {
  const { settings, errors } = validate({ intervalMs: '1000', telegramEnabled: true, feishuIntervalMs: 2000 })
  assert.deepEqual(errors, [])
  assert.equal(settings.intervalMs, 1000)
  assert.equal(settings.telegramEnabled, true)
  assert.equal(settings.feishuIntervalMs, 2000)
})

test('越界、类型错、未知键都拒', () => {
  assert.match(validate({ intervalMs: 10 }).errors[0], /投递间隔/)
  assert.match(validate({ batchCount: 99999 }).errors[0], /单批最多几条/)
  assert.match(validate({ telegramEnabled: 'yes' }).errors[0], /开关值/)
  assert.match(validate({ nonsense: 1 }).errors[0], /不认识的设置项/)
})

test('整单拒绝：合法的也不落盘', () => {
  const { errors } = validate({ intervalMs: 800, batchCount: -1 })
  assert.equal(errors.length, 1)
})

test('每个设置项都有范围且默认值在范围内', () => {
  for (const field of FIELDS) {
    assert.ok(field.key in DEFAULTS, `${field.key} 缺默认值`)
    if (field.type !== 'number') continue
    const value = DEFAULTS[field.key]
    assert.ok(value >= field.min && value <= field.max, `${field.key} 默认值越界`)
  }
})
