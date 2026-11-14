import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCredentialRules, normalize, stripCredentials } from '../../src/core/envelope.js'

const base = { source: 'telegram', at: '2026-11-14T19:40:00+08:00', actor: 'other', text: 'DDL 改到 25 号' }

test('合法信封通过，并补出 id', () => {
  const result = normalize({ ...base, meta: { chat: '自然语言处理' } })
  assert.equal(result.error, undefined)
  assert.equal(result.source, 'telegram')
  assert.ok(result.id.startsWith('telegram:'))
  assert.deepEqual(result.meta, { chat: '自然语言处理' })
})

test('缺来源被拒', () => {
  assert.equal(normalize({ ...base, source: '' }).error, 'missing_source')
  assert.equal(normalize({ at: base.at }).error, 'missing_source')
})

test('不带时区的时间被拒', () => {
  assert.equal(normalize({ ...base, at: '2026-11-14T19:40:00' }).error, 'invalid_at')
  assert.equal(normalize({ ...base, at: '昨天' }).error, 'invalid_at')
})

test('actor 只认三个值', () => {
  assert.equal(normalize({ ...base, actor: 'boss' }).error, 'invalid_actor')
  assert.equal(normalize({ ...base, actor: 'self' }).actor, 'self')
  assert.equal(normalize({ ...base, actor: undefined }).actor, 'other')
})

test('同一事实重复提交得到同一个 id', () => {
  assert.equal(normalize({ ...base }).id, normalize({ ...base }).id)
  assert.notEqual(normalize({ ...base }).id, normalize({ ...base, text: '换了内容' }).id)
})

test('未知字段被丢弃，meta 原样保留', () => {
  const result = normalize({ ...base, 随机字段: 1, meta: { chat_id: '-100', 任意: true } })
  assert.equal(result.随机字段, undefined)
  assert.deepEqual(result.meta, { chat_id: '-100', 任意: true })
})

test('凭据命中：正文清空，只留定位', () => {
  const rules = createCredentialRules({ chats: ['777000'], patterns: ['验证码'] })
  const official = stripCredentials(normalize({ ...base, meta: { chat_id: '777000' } }), rules)
  assert.equal(official.text, '')
  assert.equal(official.id.startsWith('telegram:'), true)
  assert.equal(official.meta.redacted, true)

  const otp = stripCredentials(normalize({ ...base, text: '你的验证码是 839201' }), rules)
  assert.equal(otp.text, '')
})

test('凭据未命中时原样返回', () => {
  const rules = createCredentialRules({ chats: ['777000'], patterns: ['验证码'] })
  const envelope = normalize({ ...base })
  assert.equal(stripCredentials(envelope, rules), envelope)
})
