import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { findContactCache, mergeChoices, readContacts, readSessions } from '../choices.js'

/** 假联系人库：形状和 wx 解出来的明文缓存一致，只留用得上的列。 */
function cacheWith(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'wx-choices-'))
  const path = join(dir, 'c0ffee.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE contact (username TEXT, nick_name TEXT, remark TEXT, is_in_chat_room INTEGER, delete_flag INTEGER)')
  const insert = db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?)')
  for (const row of rows) {
    insert.run(row.username, row.nick_name, row.remark ?? '', row.is_in_chat_room ?? 1, row.delete_flag ?? 0)
  }
  db.close()
  return { dir, path }
}

test('联系人缓存读名字：群用群名，人优先备注；跳过已删和没名字的', () => {
  const { dir, path } = cacheWith([
    { username: '48422226990@chatroom', nick_name: '262701-自然语言处理课' },
    { username: '49469914874@chatroom', nick_name: 'AI4班', is_in_chat_room: 2 },
    { username: '59048799667@chatroom', nick_name: '已退出的群', is_in_chat_room: 0 },
    { username: '58734611842@chatroom', nick_name: '已删的群', delete_flag: 1 },
    { username: '53137664982@chatroom', nick_name: '   ' },
    { username: 'wxid_friend', nick_name: '张三', remark: '张三（同学）' },
    { username: 'wxid_noremark', nick_name: '李四' },
  ])
  try {
    const contacts = readContacts(path)
    assert.deepEqual([...contacts.keys()], ['48422226990@chatroom', '49469914874@chatroom', '59048799667@chatroom', 'wxid_friend', 'wxid_noremark'])
    assert.deepEqual(contacts.get('48422226990@chatroom'), { name: '262701-自然语言处理课', group: true, inRoom: true })
    assert.deepEqual(contacts.get('59048799667@chatroom'), { name: '已退出的群', group: true, inRoom: false })
    assert.deepEqual(contacts.get('wxid_friend'), { name: '张三（同学）', group: false, inRoom: true }, '备注优先于昵称')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('缓存打不开就当没有，不抛错', () => {
  assert.equal(readContacts('/nonexistent/nope.db').size, 0)
  assert.equal(readContacts(null).size, 0)
})

test('找联系人缓存：优先 _mtimes.json 里 contact/ 的那条', () => {
  const { dir, path } = cacheWith([{ username: '1@chatroom', nick_name: '一群' }])
  try {
    writeFileSync(join(dir, '_mtimes.json'), JSON.stringify({ 'session/session.db': { path: '/nope' }, 'contact/contact.db': { path } }))
    assert.equal(findContactCache(dir), path)

    // 没有清单也能靠表名认出来
    rmSync(join(dir, '_mtimes.json'))
    assert.equal(findContactCache(dir), path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('会话缺名字的补真名，联系人里有但没消息的群追加在后', () => {
  const sessions = [
    { username: '51659759132@chatroom', chat: '51659759132@chatroom', is_group: true },
    { username: '48422226990@chatroom', chat: '262701-自然语言处理课', is_group: true },
    { username: 'wxid_friend', chat: '张三', is_group: false },
  ]
  const groups = new Map([
    ['51659759132@chatroom', { name: 'omi 的群', group: true, inRoom: true }],
    ['48422226990@chatroom', { name: '不该覆盖的名字', group: true, inRoom: true }],
    ['44876931489@chatroom', { name: '科创技能训练营-新校区', group: true, inRoom: true }],
    ['56920815375@chatroom', { name: '数据结构-25261', group: true, inRoom: true }],
    ['18270923408@chatroom', { name: '红小豆剧组', inRoom: false }],
    ['wxid_friend', { name: '张三', group: false, inRoom: true }],
    ['wxid_ghost', { name: '没聊过的人', group: false, inRoom: true }],
  ])
  const merged = mergeChoices(sessions, groups)

  assert.deepEqual(
    merged.map(row => [row.username, row.chat]),
    [
      ['51659759132@chatroom', 'omi 的群'],
      ['48422226990@chatroom', '262701-自然语言处理课'],
      ['wxid_friend', '张三'],
      ['44876931489@chatroom', '科创技能训练营-新校区'],
      ['56920815375@chatroom', '数据结构-25261'],
    ],
    '会话顺序不动；只有缺名字的才补；新增的群排在后面，没聊过的人不新增',
  )
  assert.equal(merged[3].is_group, true)
  assert.equal(merged[3].quiet, true)
})

test('已退出的群：清单里不新增，但会话还在就用它的名字', () => {
  const sessions = [{ username: '18270923408@chatroom', chat: '18270923408@chatroom', is_group: true }]
  const merged = mergeChoices(sessions, new Map([['18270923408@chatroom', { name: '红小豆剧组', group: true, inRoom: false }]]))
  assert.deepEqual(merged.map(row => row.chat), ['红小豆剧组'], '不显示 username')
  assert.equal(merged.length, 1, '退出群不另外新增一条')
})

test('缓存没有群时原样返回，面板退化成现在的样子', () => {
  const sessions = [{ username: 'wxid_a', chat: '张三', is_group: false }]
  assert.deepEqual(mergeChoices(sessions, new Map()), sessions)
  assert.deepEqual(mergeChoices([], new Map()), [])
})

test('wx 不在时取不到会话清单，返回空数组而不是抛错', async () => {
  assert.deepEqual(await readSessions({ bin: '/nonexistent/wx', timeoutMs: 500 }), [])
})
