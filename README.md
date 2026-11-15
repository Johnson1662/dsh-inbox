# dsh-personal-context

把 **Telegram / 飞书** 的消息收进来，投进 **DSH 里你指定的那个会话**。

> Collect your messages from Telegram and Feishu, and deliver them into the DSH session you choose.

装一个插件，打开设置点两下，就够了。采集跑在独立进程里——**DSH 关着也在收**，重开时一次补齐。

---

## 它解决的问题

你在 TG 群里看到「作业 DDL 改到 25 号」，在飞书上收到「合同我看过了」。这些都在你的 agent 视野之外——它只看得见你在对话框里打给它的字。

这个插件把那些消息**搬进会话**，让 agent 直接看到，不用你复述。

## 特性

- **常驻采集**：独立守护进程，DSH 关闭、重启、升级都不影响；开机自启
- **每路来源投给谁，你自己选**：设置里一个下拉框
- **零丢失**：投成功才算送达；失败退回重试；DSH 关着时消息排队不丢
- **凭据不进正文**：验证码/密码类消息只留「有这么一条」，正文不入库
- **一条消息一批**：5 条消息合成一条，不刷屏，一条不少

## 快速开始

需要：**Node ≥ 22**、**DSH 桌面端**、以及你要接的来源的凭据（见下）。

### 1. 装插件

DSH 侧栏 → **插件** → **添加插件** → **本地目录** → 选这个仓库的根目录。

装完插件页会显示三个组件：

```
dsh-personal-context
├─ dsh-personal-context-core            队列、投递、设置面板
├─ dsh-personal-context-source-telegram Telegram 来源
└─ dsh-personal-context-source-feishu   飞书来源
```

### 2. 装常驻采集

```bash
node packages/core/bin/personal-context.mjs init
```

它会问你凭据，然后写 `~/.dsh/state/personal-context/sources.env`（0600）、装 systemd 用户服务（macOS 是 launchd）、启动，最后打印状态。已有配置不会被覆盖。

非交互（脚本里用）：

```bash
node packages/core/bin/personal-context.mjs init --yes \
  --telegram-api-id 123456 --telegram-api-hash abcdef... \
  --telegram-session /path/to/session
```

### 3. 打开设置

DSH **设置 → 个人上下文**：

- 每路来源：开/关、轮询间隔、**投给哪个会话**
- 投递：一批最多几条/多少字、积压时放大到什么程度

改完点保存，不用重启任何东西。

### 4. 验证

```bash
personal-context status        # 队列多少条、每路来源在不在跑
```

往被采集的会话发条消息，几秒内它就会出现在你选的 DSH 会话里。

## 来源凭据怎么拿

**Telegram**：到 [my.telegram.org](https://my.telegram.org) 建应用拿 `api_id` / `api_hash`；`session` 是 Telethon 的用户会话文件，第一次需要跑一次登录（`python3 -m pip install telethon` 后按提示输手机号与验证码）。

**飞书**：装 `lark-cli`（`npm i -g @larksuite/cli`），再 `lark-cli config init --as user` 完成一次登录。本插件全程以**你本人身份**读消息（`--as user`），不依赖机器人事件订阅。

两路都可以只用其一；不用的在设置里关掉即可。

## 工作原理

```
来源进程（telegram.py / feishu.js …）
      │  stdout 一行一个 JSON（统一信封）
      ▼
守护进程  唯一写数据库的人：去重入库、按路由排队、发小票
      │  HTTP：take / done / retry
      ▼
适配器    DSH 插件（也是"第一个第三方适配器"）
      │
      ▼
你选的 DSH 会话
```

三条硬性设计：

| | 为什么 |
|---|---|
| 采集在独立进程 | DSH 关着也要收 |
| 队列只有一个写者 | 适配器不用懂表结构，换任何 agent 都能接 |
| 投递按小票结算 | 适配器崩了，消息也不会被锁死 |

细节见 [docs/design.md](docs/design.md) 与 [docs/adr/](docs/adr/)。

## 命令

```bash
personal-context init        # 装/改凭据、装开机自启、起服务
personal-context status      # 队列与来源状态
personal-context sources     # 每路来源收了多少、丢了多少
personal-context log -f      # 跟日志
```

> 未全局安装时用 `node packages/core/bin/personal-context.mjs <命令>`。

## 配置

分两层，**开关和节奏在设置界面改，凭据只放环境变量**。

**设置界面 / `~/.dsh/state/personal-context/config.json`**：投递间隔、单批条数字数、积压阈值、每路来源的开关与轮询间隔、每路来源投给哪个会话。

**环境变量**（`sources.env`，0600，不进 git）：

| 变量 | 用途 |
|---|---|
| `PERSONAL_CONTEXT_TELEGRAM_API_ID` / `_API_HASH` / `_SESSION` | Telethon 凭据与会话文件 |
| `PERSONAL_CONTEXT_TELEGRAM_PROXY` | 代理，如 `socks5://127.0.0.1:7897` |
| `PERSONAL_CONTEXT_TELEGRAM_CHATS` | 只采这些会话，逗号分隔；留空=全部 |
| `PERSONAL_CONTEXT_FEISHU_LARK_CLI` | lark-cli 可执行文件路径（默认走 PATH） |
| `PERSONAL_CONTEXT_STATE_DIR` | 状态目录，默认 `~/.dsh/state/personal-context` |
| `PERSONAL_CONTEXT_HTTP_LISTEN` | 收事件的地址，默认 `127.0.0.1:7788` |
| `PERSONAL_CONTEXT_SOURCE_DIRS` | 额外扫描来源包的目录，冒号分隔 |

## 加一路来源

一个来源 = 一个包，`package.json` 里声明自己：

```json
{
  "name": "dsh-personal-context-source-imap",
  "dsh": {
    "source": {
      "name": "imap",
      "runtime": "python",
      "entry": "worker.py",
      "fields": [
        { "key": "enabled", "label": "采集邮箱", "type": "boolean", "default": false },
        { "key": "intervalMs", "label": "轮询间隔", "type": "number", "min": 5000, "max": 3600000, "default": 60000 }
      ]
    }
  }
}
```

`worker.py` 只要守三条约定：

1. 从 `PERSONAL_CONTEXT_SOURCE_*` 读配置（`intervalMs` → `PERSONAL_CONTEXT_SOURCE_INTERVAL_MS`）
2. **stdout 只写信封**，一行一个 JSON；日志走 stderr
3. SIGTERM 干净退出；错误退出码非 0（守护进程 10 秒后重启）

信封长这样：

```json
{ "id": "imap:INBOX:42", "source": "imap", "at": "2026-11-15T09:00:00+08:00",
  "actor": "other", "text": "正文", "meta": { "chat": "收件箱", "sender": "张三" } }
```

`id` 是幂等键（重采不重复），`at` 必须带时区。**不需要**认识队列、路由、agent——投给谁由配置决定。

装进 profile 的 `node_modules` 后，守护进程自动发现，设置页自动多出一组。

## 接别的 agent

适配器只认三个 HTTP 动作，五十行就够：

```js
const call = (path, body) => fetch(`http://127.0.0.1:7788${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json())

const { ticket, events } = await call('/v1/take', { sink: 'chief', limit: 50 })
if (events.length) {
  try {
    await myAgent.send(render(events))          // ← 换成你的 agent
    await call('/v1/done', { ticket, ids: events.map(e => e.id) })
  } catch (error) {
    await call('/v1/retry', { ticket, reason: String(error) })
  }
}
```

- `take` 拿走一批（发小票，租约 5 分钟）
- `done` 只把点名的标已投，没点名的自动放回
- `retry` 整张退回并记一次失败

token 在 `~/.dsh/state/personal-context/token`。参考实现是 `packages/core/src/plugin/api-client.js`，契约测试在 `packages/core/test/api-client.test.js`。

## 出问题的时候

| 现象 | 原因与解法 |
|---|---|
| 设置里没有「个人上下文」 | 插件没装好或客户端 bundle 加载失败。看 DSH 的开发者工具 Console |
| 消息一直不出现，`status` 显示来源在跑 | 目标会话没在 DSH 里打开过——打开它，积压会立刻投进去 |
| `feishu 未运行` | 没有 `lark-cli` 或未登录：`lark-cli config init --as user` |
| `telegram` 起不来 | 缺 `telethon`，或 session 文件路径不对 |
| 7788 端口被占用 | `PERSONAL_CONTEXT_HTTP_LISTEN=127.0.0.1:7799`，两边同步改 |
| 想清空重来 | 停服务，删 `~/.dsh/state/personal-context/`（⚠️ 会丢队列里的消息） |

日志：`personal-context log -f`，或 `journalctl --user -u personal-context-daemon -f`。

## 目录

```
packages/core/                队列、投递、设置面板、命令行
packages/source-telegram/     Telegram worker
packages/source-feishu/       飞书 worker
cordis.patch.yml              壳包：把三个组件插进 DSH 组合
deploy/                       打包与 systemd 单元
docs/                         设计说明与 ADR
```

## 开发

```bash
npm test                      # 143 个测试
./deploy/pack.sh              # 打本地 tgz（改代码后要 bump version）
./deploy/restart-dsh.sh       # 重启 DSH 让插件重新加载
```

## 已知限制

- **目标会话要打开过**：DSH 里没有它的 agent 实例时，消息只会排队等你打开
- **Telegram 是轮询**（默认 8 秒一次），不是长连接；单条消息最坏等一个周期
- **飞书只能轮询**：user 身份不支持事件订阅，每轮向每个会话各发一次请求
- **只投不判**：不摘要、不压缩、不排序、不判断重不重要——那是接收方会话的事
- 目前只支持 Linux / macOS 的开机自启

## 许可

[MIT](LICENSE)
