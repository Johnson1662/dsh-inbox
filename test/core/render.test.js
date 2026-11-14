import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalize } from '../../src/core/envelope.js'
import { render } from '../../src/core/render.js'

const envelope = (source, at, text, meta) =>
  normalize({ source, at, actor: 'other', text, meta })

test('同来源多条渲染成一条消息，一个表头', () => {
  const output = render([
    envelope('telegram', '2026-11-14T19:40:00+08:00', '作业 DDL 改到 25 号', { chat: '自然语言处理', sender: '王老师' }),
    envelope('telegram', '2026-11-14T19:41:00+08:00', '收到', { chat: '自然语言处理', sender: '李同学' }),
  ])
  assert.equal(output, [
    '[telegram] 2 条新消息',
    '· 自然语言处理 | 王老师 | 19:40 | 作业 DDL 改到 25 号',
    '· 自然语言处理 | 李同学 | 19:41 | 收到',
  ].join('\n'))
})

test('跨来源各起一段表头', () => {
  const output = render([
    envelope('telegram', '2026-11-14T19:40:00+08:00', '一', { chat: 'A', sender: '甲' }),
    envelope('feishu', '2026-11-14T19:41:00+08:00', '二', { chat: 'B', sender: '乙' }),
  ])
  assert.equal(output, [
    '[telegram] 1 条新消息',
    '· A | 甲 | 19:40 | 一',
    '[feishu] 1 条新消息',
    '· B | 乙 | 19:41 | 二',
  ].join('\n'))
})

test('正文换行折成空格，一条事件只占一行', () => {
  const output = render([envelope('telegram', '2026-11-14T19:40:00+08:00', '第一行\n第二行', { chat: 'A', sender: '甲' })])
  assert.equal(output, '[telegram] 1 条新消息\n· A | 甲 | 19:40 | 第一行 第二行')
})

test('空正文标注为附件，不留空行', () => {
  const output = render([envelope('telegram', '2026-11-14T19:40:00+08:00', '', { chat: 'A', sender: '甲', media: 'photo' })])
  assert.equal(output, '[telegram] 1 条新消息\n· A | 甲 | 19:40 | （附件：photo）')
})

test('凭据类标注为隐去，不冒充附件', () => {
  const redacted = normalize({ source: 'telegram', at: '2026-11-14T19:40:00+08:00', text: '', meta: { chat: '账号安全中心', sender: '系统', redacted: true } })
  assert.equal(render([redacted]), '[telegram] 1 条新消息\n· 账号安全中心 | 系统 | 19:40 | （正文已隐去：凭据类）')
})

test('空批次渲染成空串', () => {
  assert.equal(render([]), '')
})
