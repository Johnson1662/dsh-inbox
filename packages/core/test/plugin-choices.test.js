import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChoiceLoader, pickChoices } from '../src/plugin/choices.js'

const WX = {
  command: 'wx',
  args: ['sessions', '--json'],
  path: 'sessions',
  value: 'username',
  label: 'chat',
  group: { field: 'is_group', true: '群聊', false: '联系人' },
}

const PAYLOAD = {
  meta: { status: 'ok' },
  sessions: [
    { username: '111@chatroom', chat: '人工智能学院实习群', is_group: true },
    { username: '222@chatroom', chat: '222@chatroom', is_group: true },
    { username: 'wxid_abc', chat: '王工', is_group: false },
    { username: '111@chatroom', chat: '重复项要去重', is_group: true },
  ],
}

test('名字和 username 都在：值用 username，显示用名字', () => {
  const [first] = pickChoices(PAYLOAD, WX)
  assert.deepEqual(first, { value: '111@chatroom', label: '人工智能学院实习群', group: '群聊' })
})

test('没有名字的会话退回 username，不留空标签', () => {
  const unnamed = pickChoices(PAYLOAD, WX).find(choice => choice.value === '222@chatroom')
  assert.equal(unnamed.label, '222@chatroom')
})

test('按 is_group 分组，人话不是 true/false', () => {
  const wxid = pickChoices(PAYLOAD, WX).find(choice => choice.value === 'wxid_abc')
  assert.equal(wxid.group, '联系人')
})

test('同一个 username 只出现一次，坏数据跳过', () => {
  const values = pickChoices({ sessions: [...PAYLOAD.sessions, null, { chat: '没有 username' }] }, WX)
  assert.equal(values.filter(choice => choice.value === '111@chatroom').length, 1)
  assert.equal(values.length, 3)
})

test('结构对不上时返回空清单，不抛', () => {
  assert.deepEqual(pickChoices({ nope: 1 }, WX), [])
  assert.deepEqual(pickChoices(null, WX), [])
  assert.deepEqual(pickChoices([], {}), [])
})

test('取不到清单时不炸，退回上一次的好结果', async () => {
  let fail = false
  const exec = async () => {
    if (fail) throw new Error('wx 不在 PATH')
    return { stdout: JSON.stringify(PAYLOAD) }
  }
  const loader = createChoiceLoader({ exec, cacheMs: 0 })
  const fields = [{ key: 'wxChats', source: 'wx', sourceKey: 'chats', options: WX }]

  const first = await loader.load(fields)
  assert.equal(first.wxChats.length, 3)

  fail = true
  const second = await loader.load(fields)
  assert.equal(second.wxChats.length, 3, 'CLI 挂了也别把已经选好的会话清空')
})

test('没有 options 的字段不去问', async () => {
  let calls = 0
  const loader = createChoiceLoader({ exec: async () => { calls += 1; return { stdout: '[]' } } })
  assert.deepEqual(await loader.load([{ key: 'intervalMs' }, { key: 'wxEnabled' }]), {})
  assert.equal(calls, 0)
})

test('组按声明顺序排：群聊在联系人前面', () => {
  const withOrder = { ...WX, group: { ...WX.group, order: ['群聊', '联系人'] } }
  const groups = pickChoices(PAYLOAD, withOrder).map(choice => choice.group)
  assert.deepEqual(groups, ['群聊', '群聊', '联系人'])
})
