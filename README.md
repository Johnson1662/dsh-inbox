# dsh-personal-context

一个用 [Node.js](https://nodejs.org) 写的常驻消息管道：把你在 **Telegram** 和 **飞书** 里收到的消息，在几秒内投进你的 AI agent 会话，让 agent 自己开始处理，而不是等你复述一遍。以 [MIT 许可](LICENSE) 发布。

写给每天用 AI agent 干活、但信息散落在各种聊天软件里的人。当前版本 0.7.5（2026 年 11 月）。

**它不是什么**：不是聊天机器人，不是定时任务，不是把消息转发到手机的推送服务，也不是一个需要你在对话框里手动调用的工具。

---

## 目录

- [为什么需要它](#为什么需要它)
- [它长什么样](#它长什么样)
- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [配置](#配置)
- [命令](#命令)
- [排错](#排错)
- [接入新来源](#接入新来源)
- [接入其他 agent](#接入其他-agent)
- [项目状态](#项目状态)
- [参与](#参与)
- [目录结构](#目录结构)
- [许可](#许可)

---

## 为什么需要它

消息要进入 agent 的视野，通常有三条路。差别不在「能不能拿到」，在**谁先动**，以及**扫描要不要花 token**：

| 方式 | 消息到你眼前要多久 | 谁先动 | 空闲时的代价 | 扫描能有多密 |
|---|---|---|---|---|
| 定时任务 | 到下一次扫描，分钟级 | 定时器 | 每扫一次就是一次大模型回合，没有新消息也要计费 | 受回合成本与平台限制，通常只能几分钟一次 |
| MCP 工具（[Model Context Protocol](https://modelcontextprotocol.io)，让模型按需查询外部数据） | 你想起去问一次 | **你** | 你不问就没有成本，但也永远不知道 | — |
| 本方案 | 一个轮询周期，默认 8 秒 | **事件** | **0**：轮询是普通进程，不碰模型 | 5 秒一次也无所谓，因为不花 token |

举一个具体的例子。14:03，老板在群里说「这个方案今天下班前改好」：

- **定时任务**：14:10 那次扫描才发现，而且多半只记一行日志，没人读。
- **MCP**：agent 不会知道，直到你 15:30 开完会想起来，自己再跟它说一遍——而你可能压根没看到那条消息。
- **本方案**：14:03:08 左右（一个轮询周期内）消息进入队列，0.5 秒内作为一条消息投进你指定的会话，**agent 当场开始这一轮**。你人在开会，处理已经在发生。

### 扫描不思考，思考不扫描

定时任务把两件事绑在一起：每次扫描都是一次大模型回合。于是两头都受限——扫得太勤，token 空烧（一天 288 次空跑，每次几千 token，换来的全是「没有新消息」）；扫得太稀，消息就卡在空档里。

这里把它们拆开：轮询是一个 python / node 普通进程，零 token，可以几秒一次；只有真有消息时，才把它投进会话、唤醒 agent 跑一轮。**成本与事件数成正比，与时间无关。**一天 10 条消息，就只花 10 次唤醒；一天 0 条，一次都不花——而扫描一直在跑。

---

## 它长什么样

**投进会话的消息**——一批合成一条，一条事件一行，不摘要、不改写：

```
[telegram] 2 条新消息
· 产品群 | 老板 | 14:03 | 这个方案今天下班前改好
· 产品群 | 李四 | 14:04 | 收到

[feishu] 1 条新消息
· 项目群 | 陈 | 14:05 | 合同我看过了
```

**设置界面**（在 agent 客户端里，每路来源一张卡）：

```
设置 → 个人上下文
┌ Telegram ─────────────────────────────────────┐
│ 关掉就停止采集；采到的消息投进下面选的会话。   │
│ 采集 Telegram                          [✓]    │
│ 轮询间隔（毫秒）          8000                │
│ 投给哪个会话    需要在 DSH 里打开过  Chief ▾  │
└───────────────────────────────────────────────┘
┌ 飞书 ─────────────────────────────────────────┐
│ 采集飞书                               [✓]    │
│ 轮询间隔（毫秒）          5000                │
│ 投给哪个会话                          Chief ▾ │
└───────────────────────────────────────────────┘
┌ 投递 ─────────────────────────────────────────┐
│ 投递间隔 500 · 单批 50 条 / 4000 字 · 积压 200 │
└───────────────────────────────────────────────┘
```

**命令行**：

```
$ personal-context status
队列 64 条：待投 0 / 已投 64（清空）
  feishu     待投 0  已投 6
  manual     待投 0  已投 56
  telegram   待投 0  已投 2
来源：
  telegram   运行中  pid 449152
  feishu     运行中  pid 449153
```

---

## 快速开始

### 前提

- **Node.js ≥ 22**（用了内置的 `node:sqlite`）

  ```bash
  brew install node@22        # macOS
  # 或 nvm install 22 && nvm use 22
  node -v                     # 应输出 v22 或更高
  ```

- **DSH 桌面端**（[DeepSeek Harness](https://deepseek.com)，一个桌面 AI agent 客户端）。本项目当前以它作为投递端。
- 你要接的来源的凭据（见下）。可以只接一路。

### 1. 拿到代码

```bash
git clone <本仓库地址> && cd <仓库目录>
```

> 尚未发布到 npm，所以下面用「本地目录」安装。发布之后可以直接在插件页填包名。

### 2. 装进 DSH

DSH 侧栏 → **插件** → **添加插件** → **本地目录** → 选刚 clone 的目录。

装完插件页会显示三个组件，可分别启停：

```
dsh-personal-context
├─ dsh-personal-context-core             队列、投递、设置面板
├─ dsh-personal-context-source-telegram  来源：Telegram
└─ dsh-personal-context-source-feishu    来源：飞书
```

### 3. 起常驻采集

```bash
node packages/core/bin/personal-context.mjs init
```

它会依次问你凭据 → 写 `~/.dsh/state/personal-context/sources.env`（权限 0600）→ 安装开机自启（Linux 用 systemd 用户服务，macOS 用 launchd）→ 启动 → 打印状态。已有配置不会被覆盖。

脚本里跑（非交互）：

```bash
node packages/core/bin/personal-context.mjs init --yes \
  --telegram-api-id 123456 \
  --telegram-api-hash abcdef0123456789 \
  --telegram-session ~/.config/telegram/session
```

### 4. 在设置里选收件会话

DSH **设置 → 个人上下文**：打开要用的来源，选它投给哪个会话。改完保存即生效，不用重启任何东西。

### 5. 验证

往被采集的会话发一条消息。几秒后它应该出现在你选的 agent 会话里，形式如上面的「它长什么样」。

也可以直接查状态：`personal-context status`。

### 凭据怎么拿

**Telegram**：到 [my.telegram.org](https://my.telegram.org) 创建应用，拿 `api_id` 与 `api_hash`；`session` 是 [Telethon](https://docs.telethon.dev) 的用户会话文件，首次需交互登录一次（`python3 -m pip install telethon` 后按提示输入手机号与验证码）。

**飞书**：安装 [lark-cli](https://www.npmjs.com/package/@larksuite/cli)（`npm i -g @larksuite/cli`），再执行 `lark-cli config init --as user` 完成一次登录。全程以你本人身份读消息，不依赖机器人事件订阅。

---

## 工作原理

```
        ┌──────────── 来源（可插拔） ────────────┐
        │  telegram   feishu   imap   screen …  │   各自是独立进程，
        └───────────────┬──────────────────────┘   只往标准输出写 JSON
                        │ 统一信封（唯一数据契约）
                        ▼
        ┌──────────── 中枢（常驻） ──────────────┐
        │  去重入库 → 按路由排队 → 发小票        │   唯一写者，不认识任何 agent
        └───────────────┬──────────────────────┘
                        │ HTTP：take / done / retry
                        ▼
        ┌──────────── 投递（可插拔） ────────────┐
        │   DSH 插件   你的脚本   别的 agent …   │   五十行就能接一个
        └───────────────────────────────────────┘
```

两端各一个契约，中间一个实现（本仓库）。加一路来源不用改投递，换投递端不用改来源。

### 六条不变式

这套东西的价值全在这六条上。加来源、换投递、改配置都不能破坏它们：

1. **零丢失** —— 事件只有「待投」和「已投」两种状态。没有过期、没有截断、没有丢弃。
2. **幂等** —— 同一个 `id` 重复提交只入一行。重采一次、重投一遍，库里还是一条。
3. **至少一次** —— 投成功才标记送达；失败退回重试；投递端崩溃时租约到期自动收回。
4. **常驻** —— 采集跑在独立进程，agent 客户端关闭、重启、升级都不影响。
5. **单写者** —— 只有中枢写数据库。任何投递端只通过 HTTP 结算，不碰表结构。
6. **凭据隔离** —— 验证码、密码类消息只记「有这么一条」，正文不入库、不投递。

第 3、4 条合起来就是时效保证：事件到达即投递，投递即唤醒；进程常驻，所以不依赖任何人当时开着什么。

---

## 配置

分两层：**开关和节奏在设置界面改，凭据只放环境变量**。

### 设置界面

对应文件 `~/.dsh/state/personal-context/config.json`。包含：投递间隔、单批条数与字数、积压阈值、每路来源的开关与轮询间隔、每路来源投给哪个会话。

### 环境变量

存在 `sources.env`（权限 0600，不进版本库）：

| 变量 | 用途 |
|---|---|
| `PERSONAL_CONTEXT_TELEGRAM_API_ID` / `_API_HASH` / `_SESSION` | Telethon 凭据与会话文件路径 |
| `PERSONAL_CONTEXT_TELEGRAM_PROXY` | 代理，如 `socks5://127.0.0.1:7897` |
| `PERSONAL_CONTEXT_TELEGRAM_CHATS` | 只采这些会话，逗号分隔；留空表示全部 |
| `PERSONAL_CONTEXT_FEISHU_LARK_CLI` | lark-cli 可执行文件路径（默认走 PATH） |
| `PERSONAL_CONTEXT_STATE_DIR` | 状态目录，默认 `~/.dsh/state/personal-context` |
| `PERSONAL_CONTEXT_HTTP_LISTEN` | 中枢监听地址，默认 `127.0.0.1:7788` |
| `PERSONAL_CONTEXT_SOURCE_DIRS` | 额外扫描来源包的目录，冒号分隔 |

---

## 命令

```bash
personal-context init      # 装/改凭据、装开机自启、起服务
personal-context status    # 队列与来源状态
personal-context sources   # 每路来源收了多少、丢了多少
personal-context log -f    # 跟日志
```

没有全局安装时，用 `node packages/core/bin/personal-context.mjs <命令>`。

---

## 排错

| 现象 | 原因与解法 |
|---|---|
| 设置里没有「个人上下文」 | 插件没装好，或前端模块加载失败。打开 DSH 的开发者工具看 Console |
| 消息迟迟不出现，但来源显示运行中 | 目标会话没在 DSH 里打开过。打开它，积压会立刻投进去 |
| `feishu 未运行` | 没装 `lark-cli` 或未登录：`lark-cli config init --as user` |
| `telegram` 起不来 | 缺 `telethon`，或 session 文件路径不对 |
| 7788 端口被占用 | 改 `PERSONAL_CONTEXT_HTTP_LISTEN`，投递端同步改 |
| 想彻底重来 | 停服务，删 `~/.dsh/state/personal-context/`（⚠️ 会丢队列里的消息） |

日志：`personal-context log -f`，或 `journalctl --user -u personal-context-daemon -f`。

---

## 接入新来源

一个来源是一个 npm 包，在 `package.json` 里声明自己：

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

同目录下的 `worker.py` 守三条约定：

1. 配置从 `PERSONAL_CONTEXT_SOURCE_*` 环境变量读（`intervalMs` → `PERSONAL_CONTEXT_SOURCE_INTERVAL_MS`）
2. **标准输出只写信封**，一行一个 JSON；日志走标准错误
3. 收到 SIGTERM 干净退出；异常时退出码非 0（中枢会在 10 秒后重启它）

信封格式：

```json
{ "id": "imap:INBOX:42",
  "source": "imap",
  "at": "2026-11-15T09:00:00+08:00",
  "actor": "other",
  "text": "正文",
  "ref": "blobs/2026/11/15/0900.json",
  "meta": { "chat": "收件箱", "sender": "张三" } }
```

`id` 是幂等键，`at` 必须带时区。来源**不需要**知道队列、路由、收件人——那是中枢和配置的事。

装进 profile 的 `node_modules` 后会被自动发现：设置页多出一组字段，采集侧多一路进程，不用改一行核心代码。

**不想写常驻进程也可以**：中枢另有一个一次性入口，适合推送型来源、手机快捷指令、临时脚本——

```bash
curl -X POST http://127.0.0.1:7788/v1/event \
  -H "Authorization: Bearer $(cat ~/.dsh/state/personal-context/token)" \
  -H 'content-type: application/json' \
  -d '{"source":"manual","at":"2026-11-15T09:00:00+08:00","actor":"other","text":"正文"}'
```

同一个信封格式，同样走去重、路由与凭据规则。

---

## 接入其他 agent

投递端只需要三个 HTTP 动作，不需要 SDK，五十行足够：

```
POST /v1/take   {"sink":"…","limit":50}   → {"ticket":"…","events":[…],"backlog":N}
POST /v1/done   {"ticket":"…","ids":[…]}  → {"delivered":n,"released":m}
POST /v1/retry  {"ticket":"…","reason":"…"}
```

- `take` 拿走一批并持有租约（默认 5 分钟，超时自动收回）
- `done` 只把点名的标为已投，同一张小票里没点名的自动放回
- `retry` 整张退回，失败次数加一

```js
const call = (path, body) => fetch(`http://127.0.0.1:7788${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json())

const { ticket, events } = await call('/v1/take', { sink: 'chief', limit: 50 })
if (events.length) {
  try {
    await myAgent.send(render(events))
    await call('/v1/done', { ticket, ids: events.map(e => e.id) })
  } catch (error) {
    await call('/v1/retry', { ticket, reason: String(error) })
  }
}
```

`token` 在 `~/.dsh/state/personal-context/token`。参考实现见 `packages/core/src/plugin/api-client.js`，契约测试见 `packages/core/test/api-client.test.js`。

> 为什么不让投递端直接读数据库？因为读库意味着复制表结构与状态机，换一个 agent 就得抄一遍。三个动作覆盖同样的语义，见 [ADR 0006](docs/adr/0006-适配器只认三个动作.md)。

---

## 项目状态

- 日常使用中：两路来源长期运行，队列条数守恒
- 测试：143 个用例，`npm test`
- 尚未发布到 npm，安装走本地目录
- 版本策略：0.x 期间接口可能变，会写进提交信息

### 路线

- [ ] 发布到 npm，支持按包名安装
- [ ] 订阅型来源（webhook 接收端）的开箱实现
- [ ] 更多来源：邮件（IMAP）、RSS、网页变更监控
- [ ] Windows 开机自启

---

## 参与

欢迎加来源、改投递、修问题。有两条硬约定，破了整个架构就散了：

1. **来源进程不得依赖本项目或 agent 客户端** —— 只能读环境变量、往标准输出写信封。这条保证采集能在 agent 客户端之外独立运行。
2. **队列只有一个写者** —— 投递端一律走 `take / done / retry`，不得直接访问数据库。

提交前请跑 `npm test`。设计取舍记录在 [docs/design.md](docs/design.md) 与 [docs/adr/](docs/adr/)。

---

## 目录结构

```
packages/core/                中枢：队列、投递、设置面板、命令行
packages/source-telegram/     Telegram 来源
packages/source-feishu/       飞书来源
cordis.patch.yml              壳包：把三个组件插进 DSH 的组合
deploy/                       打包脚本、systemd 单元、重启脚本
docs/                         设计说明、架构决策记录
```

## 许可

[MIT](LICENSE)。
