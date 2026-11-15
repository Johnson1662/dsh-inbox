# dsh-personal-context

给个人 agent 装一个**常驻的感知层**：让外部世界发生的事——群消息、邮件、日程变更、CI 失败——第一时间自己走进它的上下文，而不是等人来转述。

用 [Node.js](https://nodejs.org) 写的管道，[MIT 许可](LICENSE)。

来源可以随便接，接收端也可以随便换。两端各有一个几十行就能实现的契约，中间是一个常驻中枢：

```
任意来源 ──▶ 统一信封 ──▶ 常驻队列（唯一写者） ──▶ 任意 agent 的任意会话
```

---

## 目录

- [现在的实现](#现在的实现)
- [能接什么](#能接什么)
- [为什么需要它](#为什么需要它)
- [它长什么样](#它长什么样)
- [跑起来](#跑起来)
- [工作原理](#工作原理)
- [契约一：接入一个来源](#契约一接入一个来源)
- [契约二：接入一个 agent](#契约二接入一个-agent)
- [配置](#配置)
- [命令](#命令)
- [排错](#排错)
- [项目状态](#项目状态)
- [参与](#参与)
- [目录结构](#目录结构)
- [许可](#许可)

---

## 现在的实现

| 元件 | 现状 | 说明 |
|---|---|---|
| **来源** | Telegram、飞书 | 最早的两个实现。加第三、第四、第十路来源，不改中枢一行代码 |
| **接收端** | DSH | **目前唯一实现**。契约对任何 agent 开放，换一个只需实现三个 HTTP 动作 |
| **中枢** | 本仓库 | 队列、去重、路由、租约；不认识任何具体来源，也不认识任何 agent |

三件事分开看：这个项目的主体是**中间那条管道和两端的契约**，上表后两列只是当前填入的实现。

---

## 能接什么

凡是「**有新东西出现**」的地方都能接。接入方式从重到轻：

| 想要的来源 | 接入方式 | 工作量 |
|---|---|---|
| 邮件（IMAP）、日历（CalDAV）、RSS、网页变更监控 | 写一个 worker 包，轮询 | 几十到两百行 |
| 屏幕、麦克风（OCR / 语音转写） | 写一个 worker 包，本地跑 | 取决于采集端 |
| 自家服务的 webhook、CI 状态、Git 事件 | `POST /v1/event` 直接投递 | **不用写代码** |
| 手机快捷指令 | `POST /v1/event`（同局域网） | **不用写代码** |
| 别人写好的来源包 | `npm i dsh-personal-context-source-xxx` | **一行** |
| 现有的 Telegram、飞书 | 已内置 | **零** |

```
今天可用        telegram   feishu
明天加一个      imap   caldav   rss   web-monitor   ci-hook   screen-ocr   voice   …
```

**为什么能做到**：来源只负责「发现新东西并写一行 JSON」，它不知道队列、路由、收件人是谁；接收端只负责「把一批消息放进某个会话」，它不知道消息从哪来。两端互不认识，也不认识中枢的表结构。所以加任何一端，另一端都不用动。

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
- **本方案**：14:03:08 左右消息进入队列，0.5 秒内作为一条消息投进你指定的会话，**agent 当场开始这一轮**。你人在开会，处理已经在发生。

### 扫描不思考，思考不扫描

定时任务把两件事绑在一起：每次扫描都是一次大模型回合。于是两头都受限——扫得太勤，token 空烧；扫得太稀，消息卡在空档里。

这里把它们拆开：轮询是一个普通进程，零 token，可以几秒一次；只有真有消息时，才唤醒 agent 跑一轮。**成本与事件数成正比，与时间无关**：一天 10 条消息就只花 10 次唤醒，一天 0 条就一次都不花——而扫描一直在跑。

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

**设置界面**（每路来源一张卡，新增来源会自动多一张）：

```
设置 → 个人上下文
┌ Telegram ─────────────────────────────────────┐
│ 关掉就停止采集；采到的消息投进下面选的会话。   │
│ 采集 Telegram                          [✓]    │
│ 轮询间隔（毫秒）          8000                │
│ 投给哪个会话    需要该会话打开过      Chief ▾  │
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

## 跑起来

中枢是一个独立的常驻进程，与 agent 客户端无关：它只被客户端**读取**，不被客户端**托管**。所以下面分两步——先把中枢跑起来，再接上你用的 agent。

### 前提

- **Node.js ≥ 22**（用了内置的 `node:sqlite`）

  ```bash
  brew install node@22        # macOS
  # 或 nvm install 22 && nvm use 22
  node -v                     # 应输出 v22 或更高
  ```

- 至少一路来源的凭据（见下）。也可以先只跑中枢看界面。

### 1. 拿到代码

```bash
git clone <本仓库地址> && cd <仓库目录>
```

> 尚未发布到 npm，所以下面用「本地目录」安装。

### 2. 起中枢与来源

```bash
node packages/core/bin/personal-context.mjs init
```

依次问你凭据 → 写 `~/.dsh/state/personal-context/sources.env`（权限 0600）→ 安装开机自启（Linux 用 systemd 用户服务，macOS 用 launchd）→ 启动 → 打印状态。已有配置不会被覆盖。

脚本里跑（非交互）：

```bash
node packages/core/bin/personal-context.mjs init --yes \
  --telegram-api-id 123456 \
  --telegram-api-hash abcdef0123456789 \
  --telegram-session ~/.config/telegram/session
```

### 3. 接上 agent

**当前已实现的接收端是 DSH**（[DeepSeek Harness](https://deepseek.com)，桌面 AI agent 客户端）：侧栏 → 插件 → 添加插件 → 本地目录 → 选本仓库。装完显示三个组件，可分别启停：

```
dsh-personal-context
├─ dsh-personal-context-core             队列、投递、设置面板
├─ dsh-personal-context-source-telegram  来源：Telegram
└─ dsh-personal-context-source-feishu    来源：飞书
```

然后在它的 **设置 → 个人上下文** 里打开来源、选收件会话。

**换别的 agent**：实现[契约二](#契约二接入一个-agent)的三个 HTTP 动作即可，中枢与所有来源都不用动。

### 4. 验证

往被采集的会话发一条消息。几秒后它应该出现在你选的会话里。也可以直接查队列：`personal-context status`。

### 凭据怎么拿

**Telegram**：到 [my.telegram.org](https://my.telegram.org) 创建应用，拿 `api_id` 与 `api_hash`；`session` 是 [Telethon](https://docs.telethon.dev) 的用户会话文件，首次需交互登录（`python3 -m pip install telethon` 后按提示输入手机号与验证码）。

**飞书**：安装 [lark-cli](https://www.npmjs.com/package/@larksuite/cli)（`npm i -g @larksuite/cli`），再执行 `lark-cli config init --as user` 完成一次登录。全程以你本人身份读消息，不依赖机器人事件订阅。

---

## 工作原理

```
        ┌──────────── 来源（可插拔） ────────────┐
        │  telegram   feishu   imap   screen …  │   各自独立进程 / 或一个 HTTP 调用
        └───────────────┬──────────────────────┘   只输出统一信封
                        │
                        ▼
        ┌──────────── 中枢（常驻） ──────────────┐
        │  去重入库 → 按路由排队 → 发小票        │   唯一写者，不认识任何 agent
        └───────────────┬──────────────────────┘
                        │ HTTP：take / done / retry
                        ▼
        ┌──────────── 接收端（可插拔） ──────────┐
        │   DSH 插件   你的脚本   别的 agent …   │   五十行就能接一个
        └───────────────────────────────────────┘
```

### 六条不变式

这套东西的价值全在这六条上。加来源、换接收端、改配置都不能破坏它们：

1. **零丢失** —— 事件只有「待投」和「已投」两种状态。没有过期、没有截断、没有丢弃。
2. **幂等** —— 同一个 `id` 重复提交只入一行。重采一次、重投一遍，库里还是一条。
3. **至少一次** —— 投成功才标记送达；失败退回重试；接收端崩溃时租约到期自动收回。
4. **常驻** —— 采集跑在独立进程，agent 客户端关闭、重启、升级都不影响。
5. **单写者** —— 只有中枢写数据库。任何接收端只通过 HTTP 结算，不碰表结构。
6. **凭据隔离** —— 验证码、密码类消息只记「有这么一条」，正文不入库、不投递。

第 3、4 条合起来就是时效保证：事件到达即投递，投递即唤醒；进程常驻，所以不依赖任何人当时开着什么。

---

## 契约一：接入一个来源

### 方式 A：一个包（适合轮询、需要常驻）

在 `package.json` 里声明自己：

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

同目录下的 `worker.py` 守三条：

1. 配置从 `PERSONAL_CONTEXT_SOURCE_*` 环境变量读（`intervalMs` → `PERSONAL_CONTEXT_SOURCE_INTERVAL_MS`）
2. **标准输出只写信封**，一行一个 JSON；日志走标准错误
3. 收到 SIGTERM 干净退出；异常时退出码非 0（中枢会在 10 秒后重启它）

装进扫描目录后会被自动发现：采集侧多一路进程，**不改中枢一行代码**。`fields` 里的每一项会直接渲染成设置界面里的控件（布尔 / 数字），所以加来源的人不写任何前端代码。

### 方式 B：一次 HTTP 调用（适合推送、脚本、快捷指令）

不想写常驻进程，直接投一条：

```bash
curl -X POST http://127.0.0.1:7788/v1/event \
  -H "Authorization: Bearer $(cat ~/.dsh/state/personal-context/token)" \
  -H 'content-type: application/json' \
  -d '{"source":"manual","at":"2026-11-15T09:00:00+08:00","actor":"other","text":"正文"}'
```

同一个信封格式，同样走去重、路由与凭据规则。手机快捷指令、CI 脚本、自家服务的 webhook 都用这条路。

### 信封

```json
{ "id": "imap:INBOX:42",
  "source": "imap",
  "at": "2026-11-15T09:00:00+08:00",
  "actor": "other",
  "text": "正文",
  "ref": "blobs/2026/11/15/0900.json",
  "meta": { "chat": "收件箱", "sender": "张三" } }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 幂等键。重采不能变；没有天然 ID 就按内容哈希 |
| `source` | 是 | 哪一路，小写 |
| `at` | 是 | 事件发生时间，ISO 8601 **必须带时区** |
| `actor` | 是 | `self` 本人 / `other` 他人 / `system` |
| `text` | 否 | 能读的正文 |
| `ref` | 否 | 原始件位置 |
| `meta` | 否 | 来源自己的细节，原样保留 |

**来源不需要知道队列、路由、收件人**——那是中枢和配置的事。

---

## 契约二：接入一个 agent

接收端只需要三个 HTTP 动作，不需要 SDK：

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

> 为什么不让接收端直接读数据库？读库意味着复制表结构与状态机，换一个 agent 就得抄一遍，我们改一次 schema 所有适配器一起坏。三个动作覆盖同样的语义，见 [ADR 0006](docs/adr/0006-适配器只认三个动作.md)。

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

每个来源自己的凭据按同一约定加：`PERSONAL_CONTEXT_<来源名>_<字段>`。

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
| 消息迟迟不出现，但来源显示运行中 | 目标会话没被打开过。打开它，积压会立刻投进去 |
| `feishu 未运行` | 没装 `lark-cli` 或未登录：`lark-cli config init --as user` |
| `telegram` 起不来 | 缺 `telethon`，或 session 文件路径不对 |
| 新装的来源没被认出来 | 包没在扫描目录里，或 `package.json` 少了 `dsh.source`。看日志里的「发现来源包」一行 |
| 7788 端口被占用 | 改 `PERSONAL_CONTEXT_HTTP_LISTEN`，接收端同步改 |
| 设置界面里找不到 | 接收端的客户端模块没加载，看它的开发者工具 Console |
| 想彻底重来 | 停服务，删 `~/.dsh/state/personal-context/`（⚠️ 会丢队列里的消息） |

日志：`personal-context log -f`，或 `journalctl --user -u personal-context-daemon -f`。

---

## 项目状态

- 日常使用中：两路来源长期运行，队列条数守恒
- 测试：143 个用例，`npm test`
- 尚未发布到 npm，安装走本地目录
- 版本策略：0.x 期间接口可能变，会写进提交信息

### 路线

- [ ] 发布到 npm，支持按包名安装来源
- [ ] 订阅型来源（webhook 接收端）的开箱实现
- [ ] 更多来源：邮件（IMAP）、RSS、网页变更监控
- [ ] 更多接收端：别的 agent 的参考实现
- [ ] Windows 开机自启

---

## 参与

欢迎加来源、加接收端、修问题。有两条硬约定，破了整个架构就散了：

1. **来源进程不得依赖本项目或任何 agent 客户端** —— 只能读环境变量、往标准输出写信封。这条保证采集能在 agent 之外独立运行。
2. **队列只有一个写者** —— 接收端一律走 `take / done / retry`，不得直接访问数据库。

提交前请跑 `npm test`。设计取舍记录在 [docs/design.md](docs/design.md) 与 [docs/adr/](docs/adr/)。

---

## 目录结构

```
packages/core/                中枢：队列、投递、设置面板、命令行
packages/source-telegram/     来源：Telegram
packages/source-feishu/       来源：飞书
cordis.patch.yml              接收端：DSH 的组合补丁
deploy/                       打包脚本、systemd 单元、重启脚本
docs/                         设计说明、架构决策记录
```

## 许可

[MIT](LICENSE)。
