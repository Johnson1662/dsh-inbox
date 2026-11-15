import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildConfig, buildEnvFile, buildLaunchdPlist, buildSystemdUnit, cleanValue, servicePlan } from '../src/cli/plan.js'

test('env 文件只写有值的项，凭据不落进 config.json', () => {
  const env = buildEnvFile({ telegram: { apiId: '123', apiHash: 'abc', session: '/tmp/x.session', proxy: 'socks5://127.0.0.1:7897' } })
  assert.match(env, /PC_TELEGRAM_API_ID=123/)
  assert.match(env, /PC_TELEGRAM_PROXY=socks5:\/\/127.0.0.1:7897/)
  assert.doesNotMatch(env, /PC_FEISHU_LARK_CLI/)

  const config = buildConfig({ telegramEnabled: true })
  assert.doesNotMatch(JSON.stringify(config), /abc/, 'config.json 里不该出现 apiHash')
})

test('chats 数组拼成逗号串，空值不写', () => {
  const env = buildEnvFile({ telegram: { chats: [1, 2, 3], apiHash: '' } })
  assert.match(env, /PC_TELEGRAM_CHATS=1,2,3/)
  assert.doesNotMatch(env, /API_HASH/)
})

test('换行注入被拒', () => {
  assert.throws(() => cleanValue('a\nPC_TELEGRAM_API_HASH=evil', 'apiHash'), /换行/)
})

test('systemd 单元把 node 与 node bin 路径烘进去，PATH 带上 lark-cli 所在目录', () => {
  const unit = buildSystemdUnit({ node: '/opt/node/bin/node', nodeBin: '/opt/node/bin', workdir: '/repo', stateDir: '/state' })
  assert.match(unit, /ExecStart=\/opt\/node\/bin\/node \/repo\/src\/daemon\/index.js/)
  assert.match(unit, /Environment=PATH=\/opt\/node\/bin:/)
  assert.match(unit, /EnvironmentFile=\/state\/sources.env/)
  assert.match(unit, /WantedBy=default.target/)
})

test('launchd plist 有 KeepAlive 与日志路径', () => {
  const plist = buildLaunchdPlist({ node: '/usr/local/bin/node', workdir: '/repo', stateDir: '/state' })
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
  assert.match(plist, /\/state\/daemon.log/)
})

test('平台映射', () => {
  assert.equal(servicePlan('linux', '/h').kind, 'systemd')
  assert.equal(servicePlan('darwin', '/h').kind, 'launchd')
  assert.equal(servicePlan('win32', '/h').kind, 'none')
})
