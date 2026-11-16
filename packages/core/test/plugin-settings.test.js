import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULTS,
  defaultsFor,
  fieldsFor,
  sourceFields,
  toLayered,
  toSettings,
  validate,
} from '../src/plugin/settings.js'

/** 假的来源清单：形状和真实 `dsh.source` 声明一致。 */
const MANIFESTS = [
  {
    name: 'telegram',
    label: 'Telegram',
    fields: [
      { key: 'enabled', label: '采集 Telegram', type: 'boolean', default: false },
      { key: 'intervalMs', label: '轮询间隔（毫秒）', type: 'number', min: 1000, max: 300000, step: 500 },
    ],
  },
  {
    name: 'feishu',
    label: '飞书',
    fields: [
      { key: 'enabled', label: '采集飞书', type: 'boolean', default: false },
      { key: 'intervalMs', label: '轮询间隔（毫秒）', type: 'number', min: 1000, max: 300000, step: 500 },
    ],
  },
  {
    name: 'wx',
    label: '微信',
    fields: [
      { key: 'enabled', label: '采集微信', type: 'boolean', default: false },
      { key: 'intervalMs', label: '轮询间隔（毫秒）', type: 'number', min: 5000, max: 600000, step: 1000 },
      { key: 'chats', label: '只采这些会话', type: 'list', default: '' },
    ],
  },
]

const FIELDS = fieldsFor(MANIFESTS)
const base = () => toSettings({}, FIELDS)

test('每个装了的来源都会出现在设置项里，加一路来源就自动多一组', () => {
  const groups = new Set(sourceFields(MANIFESTS).map(field => field.source))
  assert.deepEqual([...groups].sort(), ['feishu', 'telegram', 'wx'])

  const wxFields = sourceFields(MANIFESTS).filter(field => field.source === 'wx')
  assert.deepEqual(wxFields.map(field => field.key), ['wxEnabled', 'wxIntervalMs', 'wxChats'], '扁平键 = 来源名 + 字段名首字母大写')
  assert.deepEqual(wxFields.map(field => field.sourceKey), ['enabled', 'intervalMs', 'chats'])

  // 再加一路来源，不用改 settings.js
  const more = fieldsFor([...MANIFESTS, { name: 'imap', label: '邮箱', fields: [{ key: 'enabled', type: 'boolean' }] }])
  assert.ok(more.some(field => field.key === 'imapEnabled'))
})

test('来源没声明 fields 时也有兜底：至少能关、能调节奏', () => {
  const fields = sourceFields([{ name: 'bare', label: '裸来源' }])
  assert.deepEqual(fields.map(field => field.key), ['bareEnabled', 'bareIntervalMs'])
})

test('分层配置往返不丢值（含 list 型）', () => {
  const settings = {
    ...base(),
    telegramEnabled: true,
    feishuIntervalMs: 3000,
    batchCount: 7,
    wxChats: '111@chatroom,222@chatroom',
  }
  const layered = toLayered(settings, FIELDS)
  assert.deepEqual(layered.sources.wx.chats, ['111@chatroom', '222@chatroom'], 'list 落盘是数组')
  assert.deepEqual(toSettings(layered, FIELDS), settings, '读回来还是一行逗号分隔')
})

test('缺字段时用默认值补齐', () => {
  const settings = toSettings({ delivery: { intervalMs: 250 } }, FIELDS)
  assert.equal(settings.intervalMs, 250)
  assert.equal(settings.batchCount, DEFAULTS.batchCount)
  assert.equal(settings.telegramEnabled, false)
  assert.equal(settings.wxChats, '')
})

test('合法输入全部收下：数字字符串、开关、逗号分隔的名单', () => {
  const { settings, errors } = validate(
    { intervalMs: '1000', telegramEnabled: true, feishuIntervalMs: 2000, wxChats: ' a@chatroom , b@chatroom ' },
    base(),
    FIELDS,
  )
  assert.deepEqual(errors, [])
  assert.equal(settings.intervalMs, 1000)
  assert.equal(settings.telegramEnabled, true)
  assert.equal(settings.feishuIntervalMs, 2000)
  assert.equal(settings.wxChats, 'a@chatroom,b@chatroom', '规整成逗号分隔，去掉空格')
})

test('越界、类型错、未知键都拒', () => {
  const run = input => validate(input, base(), FIELDS).errors
  assert.match(run({ intervalMs: 10 })[0], /投递间隔/)
  assert.match(run({ batchCount: 99999 })[0], /单批最多几条/)
  assert.match(run({ telegramEnabled: 'yes' })[0], /开关值/)
  assert.match(run({ wxChats: 123 })[0], /必须是文本/)
  assert.match(run({ nonsense: 1 })[0], /不认识的设置项/)
})

test('整单拒绝：合法的也不落盘', () => {
  const { errors } = validate({ intervalMs: 800, batchCount: -1 }, base(), FIELDS)
  assert.equal(errors.length, 1)
})

test('每个设置项都有默认值，数字项的默认值在范围内', () => {
  const defaults = defaultsFor(FIELDS)
  for (const field of FIELDS) {
    assert.ok(field.key in defaults, `${field.key} 缺默认值`)
    if (field.type !== 'number') continue
    const value = defaults[field.key]
    assert.ok(value >= field.min && value <= field.max, `${field.key} 默认值越界`)
  }
})

test('每个来源一张卡：开关、节奏、投给谁都在同一组，且 source 键能对上 config.sources', async () => {
  const { buildGroups } = await import('../src/plugin/route.js')
  const bots = [{ id: 'session-a', name: 'Chief', role: '' }, { id: 'session-b', name: 'QA', role: '验收' }]
  const groups = buildGroups(bots, { telegram: 'session-a', feishu: 'session-b', wx: '' }, base(), { fields: FIELDS })

  assert.deepEqual(groups.map(group => group.title), ['Telegram', '飞书', '微信', '投递'])

  const feishu = groups.find(group => group.title === '飞书')
  const target = feishu.items.find(item => item.kind === 'target')
  assert.equal(target.key, 'target:feishu', '中文标题不能靠 toLowerCase 猜出来')
  assert.equal(target.value, 'session-b', '回填当前选中的会话')
  assert.equal(target.options.length, 2)

  const telegram = groups.find(group => group.title === 'Telegram')
  assert.deepEqual(telegram.items.map(item => item.kind), ['boolean', 'number', 'target'], '开关在最前，投给谁在最后')

  const wx = groups.find(group => group.title === '微信')
  assert.deepEqual(wx.items.map(item => item.kind), ['boolean', 'number', 'list', 'target'], '微信多一个白名单输入框')

  const delivery = groups.find(group => group.title === '投递')
  assert.ok(delivery.items.every(item => item.kind === 'number'))
  assert.ok(groups.every(group => group.note), '每张卡都有一句说明')
})
