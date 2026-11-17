import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createPoller,
  isNewer,
  nextPage,
  parseRepos,
  resolveToken,
  toEnvelope,
} from '../worker.js'

function thread(id, updatedAt, { repo = 'Johnson1662/dsh-inbox', type = 'Issue', title = '标题', reason = 'mention', number = 12 } = {}) {
  return {
    id,
    unread: true,
    reason,
    updated_at: updatedAt,
    subject: {
      title,
      type,
      url: number ? `https://api.github.com/repos/${repo}/issues/${number}` : null,
      latest_comment_url: null,
    },
    repository: { full_name: repo },
  }
}

/** 假 GitHub：按调用顺序返回预先排好的响应，并记下每次请求的头。 */
function fakeApi(responses) {
  const calls = []
  return {
    calls,
    async request(url, headers) {
      calls.push({ url, headers })
      const next = responses[Math.min(calls.length - 1, responses.length - 1)]
      if (typeof next === 'function') return next(url, headers)
      return { status: 200, headers: new Headers(), body: [], ...next }
    },
  }
}

function createTestPoller(t, { request, repos, prepare, backfill = 999 } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'github-poll-'))
  if (prepare) prepare(stateDir)
  const emitted = []
  const poller = createPoller({
    request,
    stateDir,
    repos,
    backfill,
    intervalMs: 1000,
    emit: envelope => emitted.push(envelope),
    log: () => {},
  })
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  return { poller, emitted, stateDir }
}

test('通知 → 信封：id 带线程与更新时间，正文两行内', () => {
  const envelope = toEnvelope(thread('27289696632', '2026-11-17T08:19:42Z'))
  assert.equal(envelope.id, 'github:27289696632:2026-11-17T08:19:42Z')
  assert.equal(envelope.source, 'github')
  assert.equal(envelope.at, '2026-11-17T08:19:42Z')
  assert.equal(envelope.actor, 'other')
  assert.match(envelope.text, /^Issue Johnson1662\/dsh-inbox #12：标题（mention）/)
  assert.match(envelope.text, /\nhttps:\/\/api\.github\.com\/repos\/Johnson1662\/dsh-inbox\/issues\/12$/)
  assert.deepEqual(envelope.meta, {
    chat: 'Johnson1662/dsh-inbox',
    chat_username: 'Johnson1662/dsh-inbox',
    sender: 'mention',
    type: 'Issue',
    reason: 'mention',
    thread_id: '27289696632',
    number: 12,
    url: 'https://api.github.com/repos/Johnson1662/dsh-inbox/issues/12',
  })
})

test('通知 → 信封：CI 没有序号也没有 url 时不留空尾巴', () => {
  const envelope = toEnvelope(
    thread('1', '2026-11-17T08:19:42Z', { type: 'CheckSuite', title: 'CI workflow run failed', reason: 'ci_activity', number: null }),
  )
  assert.equal(envelope.text, 'CI Johnson1662/dsh-inbox：CI workflow run failed（ci_activity）')
  assert.equal(envelope.meta.number, undefined)
  assert.equal(envelope.meta.url, undefined)
})

test('通知 → 信封：缺 id 或时间就返回 null，不猜', () => {
  assert.equal(toEnvelope({ updated_at: '2026-11-17T08:19:42Z' }), null)
  assert.equal(toEnvelope({ id: '1' }), null)
  assert.equal(toEnvelope({ id: '1', updated_at: '不是时间' }), null)
})

test('同线程只有更新时间严格变新才算新', () => {
  assert.equal(isNewer({ updated_at: '2026-11-17T08:19:42Z' }, undefined), true)
  assert.equal(isNewer({ updated_at: '2026-11-17T08:19:42Z' }, '2026-11-17T08:19:42Z'), false)
  assert.equal(isNewer({ updated_at: '2026-11-17T08:20:00Z' }, '2026-11-17T08:19:42Z'), true)
  assert.equal(isNewer({ updated_at: '2026-11-16T08:19:42Z' }, '2026-11-17T08:19:42Z'), false)
})

test('Link 头里只取 rel=next', () => {
  const link =
    '<https://api.github.com/notifications?page=2>; rel="next", <https://api.github.com/notifications?page=9>; rel="last"'
  assert.equal(nextPage(link), 'https://api.github.com/notifications?page=2')
  assert.equal(nextPage('<https://api.github.com/notifications?page=1>; rel="prev"'), null)
  assert.equal(nextPage(''), null)
})

test('仓库白名单：空 = 全部，大小写不敏感', () => {
  assert.deepEqual(parseRepos(''), [])
  assert.deepEqual(parseRepos(' Johnson1662/dsh-inbox , a/b '), ['johnson1662/dsh-inbox', 'a/b'])
})

test('一轮：交信封、记水位，第二轮 304 不重复交', async t => {
  const rows = [thread('1', '2026-11-17T08:19:42Z'), thread('2', '2026-11-17T09:00:00Z', { repo: 'a/b' })]
  const api = fakeApi([
    { status: 200, headers: new Headers({ etag: 'W/"abc"', 'last-modified': 'Tue, 17 Nov 2026 09:00:00 GMT' }), body: rows },
    { status: 304, headers: new Headers({ etag: 'W/"abc"' }), body: [] },
  ])
  const { poller, emitted, stateDir } = createTestPoller(t, { request: api.request })

  assert.equal(await poller.pollOnce(), 2)
  assert.deepEqual(emitted.map(item => item.meta.thread_id), ['1', '2'])
  // 第二轮带上条件头，304 就直接结束
  assert.equal(await poller.pollOnce(), 0)
  assert.equal(emitted.length, 2)
  assert.equal(api.calls[1].headers['If-None-Match'], 'W/"abc"')
  assert.equal(api.calls[1].headers['If-Modified-Since'], 'Tue, 17 Nov 2026 09:00:00 GMT')

  const saved = JSON.parse(readFileSync(join(stateDir, 'watermarks', 'github.json'), 'utf8'))
  assert.equal(saved.etag, 'W/"abc"')
  assert.deepEqual(saved.threads, { 1: '2026-11-17T08:19:42Z', 2: '2026-11-17T09:00:00Z' })
})

test('同一线程来了新评论：更新时间变了就再交一条', async t => {
  const api = fakeApi([
    { status: 200, headers: new Headers(), body: [thread('1', '2026-11-17T08:19:42Z')] },
    { status: 200, headers: new Headers(), body: [thread('1', '2026-11-17T10:00:00Z')] },
  ])
  const { poller, emitted } = createTestPoller(t, { request: api.request })
  await poller.pollOnce()
  await poller.pollOnce()
  assert.deepEqual(emitted.map(item => item.at), ['2026-11-17T08:19:42Z', '2026-11-17T10:00:00Z'])
})

test('仓库白名单：不在名单里的通知不交，但也不会把水位推到它头上', async t => {
  const api = fakeApi([
    { status: 200, headers: new Headers(), body: [thread('1', '2026-11-17T08:19:42Z', { repo: 'a/b' }), thread('2', '2026-11-17T09:00:00Z', { repo: 'c/d' })] },
  ])
  const { poller, emitted } = createTestPoller(t, { request: api.request, repos: ['a/b'] })
  assert.equal(await poller.pollOnce(), 1)
  assert.deepEqual(emitted.map(item => item.meta.thread_id), ['1'])
  assert.deepEqual(Object.keys(poller.threads()), ['1'])
})

test('翻页：按 Link 取到下一页，最多 maxPages 页', async t => {
  const api = fakeApi([
    {
      status: 200,
      headers: new Headers({ link: '<https://api.github.com/notifications?page=2>; rel="next"' }),
      body: [thread('1', '2026-11-17T08:19:42Z')],
    },
    { status: 200, headers: new Headers(), body: [thread('2', '2026-11-17T08:20:00Z')] },
  ])
  const { poller, emitted } = createTestPoller(t, { request: api.request })
  assert.equal(await poller.pollOnce(), 2)
  assert.equal(emitted.length, 2)
  assert.match(api.calls[1].url, /page=2$/)
})

test('401 / 403 明确报错，不静默当成空', async t => {
  const api = fakeApi([{ status: 401, headers: new Headers(), body: { message: 'Bad credentials' } }])
  const { poller } = createTestPoller(t, { request: api.request })
  await assert.rejects(() => poller.pollOnce(), /token 无效或已过期/)

  const forbidden = fakeApi([{ status: 403, headers: new Headers(), body: { message: 'rate limit' } }])
  const second = createTestPoller(t, { request: forbidden.request })
  await assert.rejects(() => second.poller.pollOnce(), /403/)
})

test('token：环境变量优先，没有才问 gh', async () => {
  assert.equal(await resolveToken({ env: { PERSONAL_CONTEXT_SOURCE_TOKEN: ' ghp_x ' } }), 'ghp_x')
  assert.equal(
    await resolveToken({ env: { PERSONAL_CONTEXT_GITHUB_TOKEN: 'ghp_y' } }),
    'ghp_y',
  )
  assert.equal(await resolveToken({ env: {}, exec: async () => ({ stdout: 'ghp_z\n' }) }), 'ghp_z')
  await assert.rejects(
    () => resolveToken({ env: {}, exec: async () => { throw new Error('gh: not logged in') } }),
    /拿不到 GitHub token：gh: not logged in/,
  )
})

test('第一次运行只记基线：一条都不交，水位写好', async t => {
  const api = fakeApi([
    { status: 200, headers: new Headers({ etag: 'W/"x"' }), body: [thread('1', '2026-11-17T08:19:42Z'), thread('2', '2026-11-17T09:00:00Z')] },
  ])
  const { poller, emitted, stateDir } = createTestPoller(t, { request: api.request, backfill: 0 })
  assert.equal(await poller.pollOnce(), 0)
  assert.equal(emitted.length, 0)
  const saved = JSON.parse(readFileSync(join(stateDir, 'watermarks', 'github.json'), 'utf8'))
  assert.deepEqual(saved.threads, { 1: '2026-11-17T08:19:42Z', 2: '2026-11-17T09:00:00Z' })
  assert.equal(saved.initialized, true)
})

test('基线之后新来的通知照常交', async t => {
  const api = fakeApi([
    { status: 200, headers: new Headers(), body: [thread('1', '2026-11-17T08:19:42Z')] },
    { status: 200, headers: new Headers(), body: [thread('1', '2026-11-17T08:19:42Z'), thread('3', '2026-11-17T10:00:00Z')] },
  ])
  const { poller, emitted } = createTestPoller(t, { request: api.request, backfill: 0 })
  await poller.pollOnce()
  assert.equal(emitted.length, 0)
  assert.equal(await poller.pollOnce(), 1)
  assert.deepEqual(emitted.map(item => item.meta.thread_id), ['3'])
})

test('第一次跑但配了 backfill：补最近 N 条，其余只记基线', async t => {
  const api = fakeApi([
    {
      status: 200,
      headers: new Headers(),
      body: [thread('1', '2026-11-17T08:00:00Z'), thread('2', '2026-11-17T09:00:00Z'), thread('3', '2026-11-17T10:00:00Z')],
    },
  ])
  const { poller, emitted } = createTestPoller(t, { request: api.request, backfill: 2 })
  assert.equal(await poller.pollOnce(), 2)
  assert.deepEqual(emitted.map(item => item.meta.thread_id), ['2', '3'])
})
