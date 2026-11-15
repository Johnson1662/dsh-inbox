#!/usr/bin/env node
/**
 * pc —— 一条命令把这个东西装起来。
 *
 *   personal-context init     问凭据 → 写 sources.env / config.json → 装开机自启 → 起服务 → 报告状态
 *   personal-context status   队列多少条、每路来源在不在跑、有没有停滞
 *   personal-context sources  列出来源与它们的运行情况
 *   personal-context log      跟着看守护进程日志（journalctl 或 tail）
 *
 * 平台差异（systemd / launchd）只出现在 servicePlan 里。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { buildConfig, buildEnvFile, buildLaunchdPlist, buildSystemdUnit, servicePlan } from '../src/cli/plan.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'help'
const stateDir = expand(args['state-dir'] ?? process.env.PERSONAL_CONTEXT_STATE_DIR ?? '~/.dsh/state/personal-context')

main().catch(error => {
  console.error(`✗ ${error?.message ?? error}`)
  process.exit(1)
})

async function main() {
  if (command === 'init') return init()
  if (command === 'status') return status()
  if (command === 'sources') return sources()
  if (command === 'log') return log()
  return help()
}

// ---------------------------------------------------------------- init

async function init() {
  say('Personal-Context 安装')

  const existing = readEnvFile()
  const answers = await collect(existing)

  mkdirSync(stateDir, { recursive: true })
  const envPath = join(stateDir, 'sources.env')
  writeFileSync(envPath, buildEnvFile(answers), { mode: 0o600 })
  chmodSync(envPath, 0o600)
  ok(`凭据 → ${envPath}（0600）`)

  // config.json 只在没有时写：它是设置界面那份，重装不能把用户改过的值盖回去
  const configPath = join(stateDir, 'config.json')
  if (existsSync(configPath)) {
    ok(`配置已存在，保留 → ${configPath}`)
  } else {
    writeFileSync(configPath, `${JSON.stringify(buildConfig({
      stateDir: display(stateDir),
      telegramEnabled: answers.telegramEnabled,
      feishuEnabled: answers.feishuEnabled,
    }), null, 2)}\n`, { mode: 0o600 })
    ok(`配置 → ${configPath}`)
  }

  if (args['no-service']) {
    say('\n跳过开机自启（--no-service）。手动启动：')
    say(`  node ${join(ROOT, 'src/daemon/index.js')}`)
    return
  }
  installService()
  await sleep(1500)
  await status()
}

/** 参数优先；没有就交互问（非 TTY 时用默认值，CI 里也能跑）。 */
async function collect(existing) {
  const wantTelegram = args.telegram !== false && args['no-telegram'] !== true
  const ask = args.yes || !process.stdin.isTTY ? null : createInterface({ input: process.stdin, output: process.stdout })
  const question = async (label, fallback = '') => {
    if (!ask) return fallback
    const answer = (await ask.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim()
    return answer || fallback
  }

  const telegram = {
    apiId: args['telegram-api-id'] ?? existing.PERSONAL_CONTEXT_TELEGRAM_API_ID ?? '',
    apiHash: args['telegram-api-hash'] ?? existing.PERSONAL_CONTEXT_TELEGRAM_API_HASH ?? '',
    session: args['telegram-session'] ?? existing.PERSONAL_CONTEXT_TELEGRAM_SESSION ?? '',
    proxy: args['telegram-proxy'] ?? existing.PERSONAL_CONTEXT_TELEGRAM_PROXY ?? '',
    chats: args['telegram-chats'] ?? existing.PERSONAL_CONTEXT_TELEGRAM_CHATS ?? '',
  }

  if (wantTelegram) {
    telegram.apiId = telegram.apiId || await question('Telegram api_id（my.telegram.org 拿，回车跳过）')
    telegram.apiHash = telegram.apiHash || await question('Telegram api_hash')
    telegram.session = telegram.session || await question('Telethon 会话文件路径（回车跳过 → 首次运行时生成）')
    telegram.proxy = telegram.proxy || await question('代理（可选，形如 socks5://127.0.0.1:7897）')
  }
  ask?.close()

  const feishuEnabled = args.feishu === true || args.telegram === false
  return {
    telegram,
    feishu: { larkCli: args['lark-cli'] ?? existing.PERSONAL_CONTEXT_FEISHU_LARK_CLI ?? '' },
    telegramEnabled: wantTelegram && Boolean(telegram.apiId && telegram.apiHash && telegram.session),
    feishuEnabled,
  }
}

function installService() {
  const plan = servicePlan(process.platform, homedir())
  if (plan.kind === 'none') throw new Error(`暂不支持这个平台（${process.platform}）的开机自启，用 --no-service 手动跑`)

  const node = realpath(which('node'))
  const nodeBin = dirname(node)
  mkdirSync(dirname(plan.path), { recursive: true })

  if (plan.kind === 'systemd') {
    writeFileSync(plan.path, buildSystemdUnit({ node, nodeBin, workdir: ROOT, stateDir }))
    run('systemctl', ['--user', 'daemon-reload'])
    run('systemctl', ['--user', 'enable', '--now', 'personal-context-daemon.service'])
    ok(`开机自启 → ${plan.path}`)
  } else {
    writeFileSync(plan.path, buildLaunchdPlist({ node, workdir: ROOT, stateDir }))
    run('launchctl', ['unload', plan.path], { tolerate: true })
    run('launchctl', ['load', plan.path])
    ok(`开机自启 → ${plan.path}`)
  }
}

// ---------------------------------------------------------------- status / sources / log

async function status() {
  const health = await call('/v1/health').catch(error => ({ error }))
  if (health.error) {
    console.error(`✗ 守护进程没起来：${health.error.message}`)
    console.error(`  看日志：personal-context log`)
    process.exitCode = 1
    return
  }
  const stats = await call('/v1/stats')
  const total = stats.pending + stats.delivered
  say(`队列 ${total} 条：待投 ${stats.pending} / 已投 ${stats.delivered}${stats.pending ? '' : '（清空）'}`)
  for (const [source, counts] of Object.entries(stats.perSource ?? {})) {
    say(`  ${source.padEnd(10)} 待投 ${counts.pending}  已投 ${counts.delivered}`)
  }
  const list = stats.sources ?? []
  if (list.length) {
    say('来源：')
    for (const source of list) {
      const state = source.running ? '运行中' : '未运行'
      const extra = source.restarts ? ` 重启 ${source.restarts} 次` : ''
      const err = source.lastError ? ` 最后错误：${source.lastError}` : ''
      say(`  ${source.name.padEnd(10)} ${state}  pid ${source.pid ?? '-'}${extra}${err}`)
    }
  } else {
    say('来源：没有启用的来源（去 DSH 的设置 → 个人上下文 里打开）')
  }
}

async function sources() {
  const stats = await call('/v1/stats')
  const list = stats.sources ?? []
  if (!list.length) return say('没有启用的来源。')
  for (const source of list) {
    say(`${source.name}  ${source.running ? '运行中' : '未运行'}  pid=${source.pid ?? '-'}  收下 ${source.ingested} 行  丢弃 ${source.dropped}${source.lastError ? `  ${source.lastError}` : ''}`)
  }
}

function log() {
  const follow = args.follow !== false
  if (process.platform === 'linux') {
    run('journalctl', ['--user', '-u', 'personal-context-daemon', ...(follow ? ['-f'] : ['-n', '100'])], { inherit: true })
    return
  }
  const file = join(stateDir, 'daemon.log')
  run(follow ? 'tail' : 'tail', [...(follow ? ['-f'] : ['-n', '100']), file], { inherit: true })
}

// ---------------------------------------------------------------- 小工具

async function call(path) {
  const token = readFileSync(join(stateDir, 'token'), 'utf8').trim()
  const listen = process.env.PERSONAL_CONTEXT_HTTP_LISTEN ?? '127.0.0.1:7788'
  const response = await fetch(`http://${listen}${path}`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`${path} → ${response.status}`)
  return response.json()
}

function readEnvFile() {
  const path = join(stateDir, 'sources.env')
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index > 0) out[line.slice(0, index)] = line.slice(index + 1)
  }
  return out
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2)
    if (key === 'yes' || key === 'no-service' || key === 'no-telegram' || key === 'feishu' || key === 'follow') {
      out[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) out[key] = true
    else { out[key] = value; i += 1 }
  }
  return out
}

function expand(path) { return path.startsWith('~') ? join(homedir(), path.slice(1)) : path }
function display(path) { return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path }
function say(message) { console.log(message) }
function ok(message) { console.log(`✓ ${message}`) }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

/** 在 PATH 里找可执行文件，不走 shell（省得拼字符串）。 */
function which(bin) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`找不到 ${bin}，先装 Node 再跑 personal-context init`)
}

function realpath(path) {
  try {
    return execFileSync('readlink', ['-f', path], { encoding: 'utf8' }).trim()
  } catch {
    return path
  }
}

function run(bin, argv, { inherit = false, tolerate = false } = {}) {
  try {
    return execFileSync(bin, argv, { stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8' }).trim()
  } catch (error) {
    if (tolerate) return ''
    throw new Error(`${bin} ${argv.join(' ')} 失败：${error?.stderr?.toString?.() ?? error?.message ?? error}`)
  }
}

function help() {
  say(`personal-context — Personal-Context 命令行

  personal-context init [--telegram-api-id …] [--telegram-api-hash …] [--telegram-session …]
          [--telegram-proxy …] [--telegram-chats …] [--lark-cli …]
          [--state-dir …] [--yes] [--no-service] [--no-telegram]
      问凭据、写配置、装开机自启、起服务。已有配置不会覆盖。

  personal-context status    队列与来源的当前状态
  personal-context sources   每个来源收了多少、丢了多少
  personal-context log [-f]  守护进程日志
`)
}
