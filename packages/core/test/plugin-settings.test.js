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


test('每个来源一张卡：开关、节奏、投给谁都在同一组，且 source 键能对上 config.sources', async () => {
  const { buildGroups } = await import('../src/plugin/route.js')
  const bots = [{ id: 'session-a', name: 'Chief', role: '' }, { id: 'session-b', name: 'QA', role: '验收' }]
  const groups = buildGroups(bots, { telegram: 'session-a', feishu: 'session-b' }, DEFAULTS)

  const titles = groups.map(group => group.title)
  assert.deepEqual(titles, ['Telegram', '飞书', '投递'])

  const feishu = groups.find(group => group.title === '飞书')
  const target = feishu.items.find(item => item.kind === 'target')
  assert.equal(target.key, 'target:feishu', '中文标题不能靠 toLowerCase 猜出来')
  assert.equal(target.value, 'session-b', '回填当前选中的会话')
  assert.equal(target.options.length, 2)

  const telegram = groups.find(group => group.title === 'Telegram')
  assert.deepEqual(telegram.items.map(item => item.kind), ['boolean', 'number', 'target'], '开关在最前，投给谁在最后')

  const delivery = groups.find(group => group.title === '投递')
  assert.ok(delivery.items.every(item => item.kind === 'number'))
  assert.ok(groups.every(group => group.note), '每张卡都有一句说明')
})
