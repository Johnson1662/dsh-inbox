/**
 * 一键部署里所有"生成文本"的纯逻辑：env 文件、systemd 单元、launchd plist。
 *
 * 这里不碰文件系统、不跑命令，所以能直接测；真正写盘和启动在 bin/pc.mjs。
 */

/** 只允许简单的键值，防止有人从参数里注入换行写坏 env 文件。 */
export function cleanValue(value, name) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/[\r\n]/.test(text)) throw new Error(`${name} 里不能有换行`)
  return text
}

/**
 * 生成 sources.env。凭据全在这里，不写进 config.json（那边是设置界面能看到的）。
 * @param telegram {apiId, apiHash, session, proxy, chats}
 * @param feishu   {larkCli}
 */
export function buildEnvFile({ telegram = {}, feishu = {} } = {}) {
  const lines = ['# Personal-Context 来源凭据（personal-context init 生成）。0600，别提交进 git。']

  const pairs = [
    ['PERSONAL_CONTEXT_TELEGRAM_API_ID', telegram.apiId],
    ['PERSONAL_CONTEXT_TELEGRAM_API_HASH', telegram.apiHash],
    ['PERSONAL_CONTEXT_TELEGRAM_SESSION', telegram.session],
    ['PERSONAL_CONTEXT_TELEGRAM_PROXY', telegram.proxy],
    ['PERSONAL_CONTEXT_TELEGRAM_CHATS', Array.isArray(telegram.chats) ? telegram.chats.join(',') : telegram.chats],
    ['PERSONAL_CONTEXT_FEISHU_LARK_CLI', feishu.larkCli],
  ]
  for (const [key, value] of pairs) {
    const clean = cleanValue(value, key)
    if (clean) lines.push(`${key}=${clean}`)
  }
  return `${lines.join('\n')}\n`
}

/** 生成 config.json：设置界面看到的那一份，开关和节奏都在这里。 */
export function buildConfig({ stateDir, telegramEnabled = false, feishuEnabled = false, telegramIntervalMs = 8000, feishuIntervalMs = 5000 } = {}) {
  return {
    stateDir: stateDir ?? '~/.dsh/state/personal-context',
    http: { listen: '127.0.0.1:7788' },
    delivery: { intervalMs: 500, limit: 200, sink: 'chief' },
    limits: { batchCount: 50, batchChars: 4000, backlogCount: 200, backlogChars: 20000 },
    routes: [{ sources: ['*'], sink: 'chief' }],
    sources: {
      telegram: { enabled: telegramEnabled, intervalMs: telegramIntervalMs },
      feishu: { enabled: feishuEnabled, intervalMs: feishuIntervalMs },
      github: { enabled: false, intervalMs: 60000, repos: [] },
    },
  }
}

/** Linux：systemd 用户单元。node 与 lark-cli 的路径都运行时探测，不写死版本目录。 */
export function buildSystemdUnit({ node, nodeBin, workdir, stateDir }) {
  if (!node || !workdir) throw new Error('buildSystemdUnit 需要 node 与 workdir')
  return `[Unit]
Description=Personal Context daemon（来源采集 + 队列）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${workdir}
EnvironmentFile=${stateDir}/sources.env
Environment=PERSONAL_CONTEXT_CONFIG=${stateDir}/config.json
Environment=PATH=${nodeBin}:/usr/local/bin:/usr/bin:/bin
ExecStart=${node} ${workdir}/src/daemon/index.js
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
`
}

/** macOS：launchd 用户代理。 */
export function buildLaunchdPlist({ node, workdir, stateDir, label = 'com.personal.context.daemon' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${workdir}/src/daemon/index.js</string></array>
  <key>WorkingDirectory</key><string>${workdir}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PERSONAL_CONTEXT_CONFIG</key><string>${stateDir}/config.json</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${stateDir}/daemon.log</string>
  <key>StandardErrorPath</key><string>${stateDir}/daemon.log</string>
</dict>
</plist>
`
}

/** 平台 → 要怎么装。Linux/macOS 之外的平台老实说不支持。 */
export function servicePlan(platform = process.platform, home = '') {
  if (platform === 'linux') {
    return { kind: 'systemd', path: `${home}/.config/systemd/user/personal-context-daemon.service` }
  }
  if (platform === 'darwin') {
    return { kind: 'launchd', path: `${home}/Library/LaunchAgents/com.personal.context.daemon.plist` }
  }
  return { kind: 'none', path: '' }
}
