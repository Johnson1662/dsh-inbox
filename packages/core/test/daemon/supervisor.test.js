import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSupervisor, discover, sourceEnv } from '../../src/daemon/supervisor.js'

/** 一个临时 sources 目录 + 静音日志。 */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'pc-supervisor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lines = []
  return {
    root,
    stateDir: join(root, 'state'),
    lines,
    log: message => lines.push(message),
  }
}

/** 轮询等待条件成立；超时就把日志一起抛出来，方便定位。 */
async function until(check, { timeout = 5000, interval = 10, describe = '', lines = [] } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(interval)
  }
  throw new Error(`等待超时：${describe}\n日志：\n${lines.join('\n')}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const envelope = (id, extra = {}) => ({
  id,
  source: 'telegram',
  at: '2026-11-14T19:40:00+08:00',
  actor: 'other',
  text: `正文 ${id}`,
  meta: { chat: '自然语言处理', chat_id: '-1001234', sender: '王老师', sender_id: '42' },
  ...extra,
})

// ------------------------------------------------------------------ 发现规则

test('发现规则：.js 交给 node，.py 交给 python3', t => {
  const { root } = workspace(t)
  writeFileSync(join(root, 'alpha.js'), '// stub', 'utf8')
  writeFileSync(join(root, 'beta.py'), '# stub', 'utf8')

  const js = discover('alpha', { root })
  assert.equal(js.command, process.execPath, 'js 用当前 node 可执行文件，别依赖 PATH')
  assert.equal(js.path, join(root, 'alpha.js'))
  assert.deepEqual(js.args, [join(root, 'alpha.js')])

  const py = discover('beta', { root })
  assert.equal(py.command, 'python3')
  assert.equal(py.path, join(root, 'beta.py'))
})

test('发现规则：两种实现都在时用 .js，都没有则返回 null', t => {
  const { root } = workspace(t)
  writeFileSync(join(root, 'both.js'), '// stub', 'utf8')
  writeFileSync(join(root, 'both.py'), '# stub', 'utf8')
  assert.equal(discover('both', { root }).command, process.execPath)
  assert.equal(discover('nothing-here', { root }), null)
})

test('发现规则：来源名不能当路径用', t => {
  const { root } = workspace(t)
  assert.equal(discover('../package', { root }), null)
  assert.equal(discover('', { root }), null)
  assert.equal(discover(undefined, { root }), null)
})

// ------------------------------------------------------------------ env 映射

test('env 映射：stateDir、来源名、camelCase → UPPER_SNAKE', () => {
  const env = sourceEnv(
    'telegram',
    {
      enabled: true,
      intervalMs: 8000,
      apiId: 123456,
      apiHash: 'hash-value',
      session: '~/.dsh/state/tg',
      chats: ['-1001234', '777000'],
      backfill: 0,
      proxy: null,
    },
    { stateDir: '/tmp/state', env: { PATH: '/usr/bin', HOME: '/home/x' } },
  )

  assert.equal(env.PERSONAL_CONTEXT_STATE_DIR, '/tmp/state')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_NAME, 'telegram')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_INTERVAL_MS, '8000')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_API_ID, '123456')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_API_HASH, 'hash-value')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_SESSION, '~/.dsh/state/tg')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_CHATS, '-1001234,777000')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_BACKFILL, '0')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_ENABLED, '1')
  // null 直接不设，别把 "null" 塞给子进程
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_PROXY, undefined)
  // 父进程的变量原样在
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/x')
})

test('env 映射：父进程已有的 PERSONAL_CONTEXT_TELEGRAM_* 不被覆盖，来源名不被配置改掉', () => {
  const env = sourceEnv(
    'telegram',
    { name: '假的', intervalMs: 5000 },
    { stateDir: '/tmp/state', env: { PERSONAL_CONTEXT_TELEGRAM_API_HASH: 'from-parent', PERSONAL_CONTEXT_SOURCE_NAME: 'stale' } },
  )
  assert.equal(env.PERSONAL_CONTEXT_TELEGRAM_API_HASH, 'from-parent')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_NAME, 'telegram')
  assert.equal(env.PERSONAL_CONTEXT_SOURCE_INTERVAL_MS, '5000')
})

// ------------------------------------------------------------------ 管道

test('坏行记日志丢掉，不影响后面的好行', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const received = []
  const supervisor = createSupervisor({
    root,
    stateDir,
    log,
    restartDelayMs: 20,
    ingest: item => received.push(item),
  })
  t.after(() => supervisor.stopAll())

  // 第一行不是 JSON；第二行缺 source；第三、四行合法
  const script = [
    "console.log('这一行根本不是 JSON')",
    "console.log(JSON.stringify({ at: '2026-11-14T19:40:00+08:00' }))",
    `console.log(JSON.stringify(${JSON.stringify(envelope('telegram:-1001234:1'))}))`,
    `console.log(JSON.stringify(${JSON.stringify(envelope('telegram:-1001234:2', { text: '多行\n正文原样保留' }))}))`,
    'setInterval(() => {}, 1000)',
  ].join('\n')
  writeFileSync(join(root, 'lines.js'), script, 'utf8')

  supervisor.start('lines', { intervalMs: 1000 })

  await until(() => received.length === 2, { describe: '收到两条合法信封', lines })
  assert.deepEqual(received.map(item => item.id), ['telegram:-1001234:1', 'telegram:-1001234:2'])
  // 正文不截断、换行原样
  assert.equal(received[1].text, '多行\n正文原样保留')
  // normalize 补过的字段在
  assert.equal(received[0].source, 'telegram')
  assert.equal(received[0].actor, 'other')
  // 两个坏行各留了一条 WARN
  assert.equal(lines.filter(line => line.startsWith('WARN lines:')).length, 2)
  assert.equal(supervisor.status()[0].dropped, 2)
})

test('凭据规则在进 ingest 之前生效：命中后正文清空', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const received = []
  const supervisor = createSupervisor({
    root,
    stateDir,
    log,
    credentials: { matches: item => item.meta?.chat_id === '777000' },
    ingest: item => received.push(item),
  })
  t.after(() => supervisor.stopAll())

  writeFileSync(
    join(root, 'creds.js'),
    [
      `console.log(JSON.stringify(${JSON.stringify(
        envelope('telegram:777000:9', { text: '登录码 123456', meta: { chat: 'Telegram', chat_id: '777000' } }),
      )}))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
    'utf8',
  )
  supervisor.start('creds', {})

  await until(() => received.length === 1, { describe: '收到一条', lines })
  assert.equal(received[0].text, '')
  assert.equal(received[0].meta.redacted, true)
})

test('子进程崩了会重启，重启后继续收', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const received = []
  const supervisor = createSupervisor({ root, stateDir, log, restartDelayMs: 20, ingest: item => received.push(item) })
  t.after(() => supervisor.stopAll())

  // 第一次退出码 7；第二次吐出消息后常驻
  writeFileSync(
    join(root, 'flaky.js'),
    [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "const marker = `${process.env.PERSONAL_CONTEXT_STATE_DIR}/runs`",
      "mkdirSync(process.env.PERSONAL_CONTEXT_STATE_DIR, { recursive: true })",
      'const runs = existsSync(marker) ? Number(readFileSync(marker, \'utf8\')) : 0',
      'writeFileSync(marker, String(runs + 1))',
      'if (runs === 0) process.exit(7)',
      `console.log(JSON.stringify(${JSON.stringify(envelope('telegram:-1001234:7'))}))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
    'utf8',
  )

  supervisor.start('flaky', {})
  await until(() => received.length === 1, { describe: '重启后收到消息', lines })

  const [state] = supervisor.status()
  assert.equal(state.name, 'flaky')
  assert.equal(state.restarts, 1)
  assert.equal(state.running, true)
  // 子进程确实拿到了 PERSONAL_CONTEXT_STATE_DIR 才写得出 runs 文件
  assert.equal(readFileSync(join(stateDir, 'runs'), 'utf8'), '2')
})

test('退出码 0 也按退避重启，不当作干完了', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const received = []
  const supervisor = createSupervisor({ root, stateDir, log, restartDelayMs: 20, ingest: item => received.push(item) })
  t.after(() => supervisor.stopAll())

  // 第一次干净退出（exit 0）；第二次吐出消息后常驻
  writeFileSync(
    join(root, 'finisher.js'),
    [
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "const marker = `${process.env.PERSONAL_CONTEXT_STATE_DIR}/runs0`",
      "mkdirSync(process.env.PERSONAL_CONTEXT_STATE_DIR, { recursive: true })",
      'const runs = existsSync(marker) ? Number(readFileSync(marker, \'utf8\')) : 0',
      'writeFileSync(marker, String(runs + 1))',
      'if (runs === 0) process.exit(0)',
      `console.log(JSON.stringify(${JSON.stringify(envelope('telegram:-1001234:9'))}))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
    'utf8',
  )

  supervisor.start('finisher', {})
  await until(() => received.length === 1, { describe: 'exit 0 之后被拉起并收到消息', lines })

  const [state] = supervisor.status()
  assert.equal(state.running, true)
  assert.equal(state.restarts, 1)
  assert.ok(lines.some(line => line.includes('退出码 0') && line.includes('后重启')))
  assert.equal(readFileSync(join(stateDir, 'runs0'), 'utf8'), '2')
})

test('SIGTERM 之后不再重启，也不会再收新东西', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const received = []
  const supervisor = createSupervisor({ root, stateDir, log, restartDelayMs: 20, ingest: item => received.push(item) })
  t.after(() => supervisor.stopAll())

  writeFileSync(
    join(root, 'patient.js'),
    [
      // 先挂好信号处理再报 ready，否则 SIGTERM 可能落在解释器启动的空当里
      "process.on('SIGTERM', () => process.exit(0))",
      "console.error('ready')",
      `console.log(JSON.stringify(${JSON.stringify(envelope('telegram:-1001234:11'))}))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
    'utf8',
  )

  supervisor.start('patient', {})
  await until(() => received.length === 1, { describe: '收到一条', lines })
  await until(() => lines.includes('patient: ready'), { describe: '子进程挂好信号处理', lines })

  const before = supervisor.status()[0].restarts
  await supervisor.stop('patient')
  assert.equal(supervisor.status()[0].running, false)

  // 等够两个重启周期：如果还在重启，这里会变
  await sleep(150)
  assert.equal(supervisor.status()[0].restarts, before)
  assert.equal(received.length, 1)
  assert.equal(supervisor.status()[0].running, false)
})

test('停不下来就 SIGKILL，不会卡住 close', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const supervisor = createSupervisor({ root, stateDir, log, stopTimeoutMs: 50, restartDelayMs: 20 })
  t.after(() => supervisor.stopAll())

  // 无视 SIGTERM 的进程
  writeFileSync(
    join(root, 'stubborn.js'),
    ["process.on('SIGTERM', () => {})", "console.error('ready')", 'setInterval(() => {}, 1000)'].join('\n'),
    'utf8',
  )
  supervisor.start('stubborn', {})
  await until(() => lines.includes('stubborn: ready'), { describe: '子进程挂好信号处理', lines })
  assert.equal(supervisor.status()[0].running, true)

  const startedAt = Date.now()
  await supervisor.stop('stubborn')
  assert.ok(Date.now() - startedAt < 3000, 'SIGKILL 兜底后应该很快返回')
  assert.equal(supervisor.status()[0].running, false)
  assert.ok(lines.some(line => line.includes('SIGKILL')))
})

// ------------------------------------------------------------------ 只拉 enabled

test('只拉 enabled 的来源，没实现的只 WARN 不崩', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const received = []
  const supervisor = createSupervisor({ root, stateDir, log, restartDelayMs: 20, ingest: item => received.push(item) })
  t.after(() => supervisor.stopAll())

  writeFileSync(
    join(root, 'live.js'),
    [
      `console.log(JSON.stringify(${JSON.stringify(envelope('telegram:-1001234:21'))}))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'),
    'utf8',
  )

  const started = supervisor.startEnabled({
    sources: {
      live: { enabled: true },
      off: { enabled: false },
      missing: { enabled: true, intervalMs: 8000 },
    },
  })

  assert.deepEqual(started, ['live'])
  assert.deepEqual(supervisor.status().map(item => item.name), ['live'])
  await until(() => received.length === 1, { describe: 'live 的消息进来了', lines })
  assert.ok(lines.some(line => line.startsWith('WARN 来源 missing')))
  // 没实现的来源不会被当成错误抛出来
  assert.equal(supervisor.status().some(item => item.name === 'missing'), false)
})

test('startEnabled 遇到没有 sources 的配置就是空转', () => {
  const supervisor = createSupervisor({ log: () => {} })
  assert.deepEqual(supervisor.startEnabled({}), [])
  assert.deepEqual(supervisor.startEnabled(undefined), [])
  assert.deepEqual(supervisor.status(), [])
})

// ------------------------------------------------------------------ 收尾

test('stopAll 收掉所有子进程，PID 不再存活', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  const supervisor = createSupervisor({ root, stateDir, log, stopTimeoutMs: 200 })
  t.after(() => supervisor.stopAll())

  for (const name of ['one', 'two']) {
    writeFileSync(
      join(root, `${name}.js`),
      "process.on('SIGTERM', () => process.exit(0))\nconsole.error('ready')\nsetInterval(() => {}, 1000)",
      'utf8',
    )
  }
  supervisor.start('one', {})
  supervisor.start('two', {})
  await until(
    () => lines.includes('one: ready') && lines.includes('two: ready'),
    { describe: '两个子进程都挂好信号处理', lines },
  )

  const pids = supervisor.status().map(item => item.pid)
  assert.equal(pids.filter(Boolean).length, 2)

  await supervisor.stopAll()
  for (const pid of pids) {
    await until(() => !alive(pid), { describe: `pid ${pid} 已经没了`, lines })
  }
  assert.equal(supervisor.status().every(item => item.running), false)
  assert.equal(supervisor.status().every(item => item.stopping), true)
})

/** kill(pid, 0) 在没有权限时报 EPERM，也算活着 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// ------------------------------------------------------------------ 拉不起来也算异常

test('子进程起不来（spawn 抛错或 emit error）也会退避重启', async t => {
  const { root, stateDir, log, lines } = workspace(t)
  writeFileSync(join(root, 'broken.js'), '// 只是为了让 discover 找到它', 'utf8')

  const { EventEmitter } = await import('node:events')
  const attempts = []
  const supervisor = createSupervisor({
    root,
    stateDir,
    log,
    restartDelayMs: 20,
    // 第一次抛错，之后返回一个只会 emit('error') 的假子进程
    spawn: () => {
      attempts.push(Date.now())
      if (attempts.length === 1) throw new Error('没有 node 这个命令')
      const fake = new EventEmitter()
      fake.pid = undefined
      fake.stdout = null
      fake.stderr = null
      fake.kill = () => {}
      setTimeout(() => fake.emit('error', new Error('ENOENT')), 5)
      return fake
    },
  })
  t.after(() => supervisor.stopAll())

  supervisor.start('broken', {})
  // 等到第三次尝试、而且那次也已经挂了：running 归零才算把异常走完
  await until(() => attempts.length >= 3 && !supervisor.status()[0].running, {
    describe: '反复尝试拉起',
    lines,
    timeout: 3000,
  })
  assert.ok(lines.some(line => line.includes('没有 node 这个命令')))
  assert.ok(lines.some(line => line.includes('ENOENT')))
  const [state] = supervisor.status()
  assert.ok(state.restarts >= 2)
  assert.equal(state.running, false)
})
