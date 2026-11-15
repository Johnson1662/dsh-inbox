# dsh-personal-context

**Personal agent 的上下文基础设施。**

外部世界的信息每天都在发生——群里的通知、邮件、日程变更、网页上的变更——但它们进不了 agent 的视野：agent 只看得见你在对话框里打给它的字。

这个项目把这件事抽象成一条管道：**任意来源 → 统一信封 → 常驻队列 → 任意 agent 的任意会话**。来源和投递端都是可插拔的，两端各有一个人人可实现的契约。

目前支持 **Telegram**、**飞书** 两个来源，投递端是 **DSH**。这两个只是最早的两个实现，不是这个项目的边界。

---

## 现在有什么

| 层 | 状态 | 说明 |
|---|---|---|
| 来源 · Telegram | 可用 | Telethon 用户会话，轮询，支持代理 |
| 来源 · 飞书 | 可用 | `lark-cli --as user` 轮询，含 429 退避 |
| 来源 · 其他 | 待接 | 邮件、RSS、屏幕、麦克风、Git webhook……只要写一个 worker |
| 中枢 | 可用 | SQLite 队列，去重、路由、租约、重试 |
| 投递 · DSH | 可用 | 每路来源各自选定收件会话；投进去即唤醒 agent |
| 投递 · 其他 agent | 契约就绪 | 三个 HTTP 动作，见下 |

## 为什么要它：谁先动

消息进入 agent 的视野，有三条路：

| 方式 | 消息到你眼前要多久 | 谁先动 | 隐性代价 |
|---|---|---|---|
| 定时任务 / 定期扫描 | 到下一次扫描（分钟级） | 定时器 | 没消息也要跑一遍，空转也是钱 |
| MCP / 工具调用 | 你想起去问一次 | **你** | 你得在场、得知道有事；否则它永远不知道 |
| 本方案 | 一个轮询周期（默认 8 秒，可调到 1 秒） | **事件** | 无事时完全不唤醒 |

差别不在「拿不拿得到」，在**谁先动**。

举个具体的：14:03 老板在群里说「这个方案今天下班前改好」。

- **定时任务**：14:10 那次扫描才发现，而且多半只记一行日志，没人读。
- **MCP**：agent 不会知道，直到你 15:30 开完会想起来，自己再跟它说一遍——而你可能压根没看到那条消息。
- **本方案**：14:03:08 左右（一个轮询周期内）消息进队列，0.5 秒内作为一条消息投进你指定的会话，**agent 当场开始这一轮**。你人在开会，处理已经在发生。

嫌 8 秒慢就把 `轮询间隔` 调到 1 秒——代价是对 TG 的请求频率，自己权衡；订阅型来源（webhook）则没有这个上限。

这也是为什么投递端必须是「会话」而不是「查询接口」：**只有投进去才会唤醒它**。一个能被轮询的 API 依然要等你想起来去查。

## 六条不变式

这套东西的价值全在这六条上，加来源、换投递、改配置都不能破坏它们：

1. **零丢失** —— 事件只有「待投」和「已投」两种状态。没有过期、没有截断、没有丢弃。
2. **幂等** —— 同一个 `id` 重复提交只入一行。重采一次、重投一遍，库里还是一条。
3. **至少一次** —— 投成功才标记送达；失败退回重试；适配器崩了租约到期自动收回。
4. **常驻** —— 采集跑在独立进程，agent 客户端关闭、重启、升级都不影响。
5. **单写者** —— 只有中枢写数据库。任何投递端只通过 HTTP 结算，不碰表结构。
6. **凭据隔离** —— 验证码、密码类消息只记「有这么一条」，正文不入库、不投递。

第 3、4 条合起来就是**时效**：事件到达即投递、投递即唤醒；进程常驻，所以这件事不依赖任何人当时开着什么。

## 架构

```
        ┌──────────── 来源（可插拔） ────────────┐
        │  telegram   feishu   imap   screen …  │   各自是独立进程，
        └───────────────┬──────────────────────┘   只往 stdout 写信封
                        │ 统一信封（唯一数据契约）
                        ▼
        ┌──────────── 中枢（常驻） ──────────────┐
        │  去重入库 → 按路由排队 → 发小票        │   唯一写者，不认识任何 agent
        └───────────────┬──────────────────────┘
                        │ HTTP: take / done / retry
                        ▼
        ┌──────────── 投递（可插拔） ────────────┐
        │   DSH 插件   你的脚本   别的 agent …   │   五十行就能接一个
        └───────────────────────────────────────┘
```

两端各一个契约，中间一个实现：

- **来源契约**：读环境变量，往 stdout 写 NDJSON 信封
- **投递契约**：`take` 拿一批、`done` 结算、`retry` 退回
- **中枢**：本仓库实现，单文件 SQLite，不依赖数据库服务

## 快速开始

需要 **Node ≥ 22**、**DSH 桌面端**、以及你要接的来源的凭据。

```bash
git clone <repo> && cd <repo>
```

> 尚未发布到 npm，暂走「本地目录」安装。

**① 装进 DSH**：侧栏 → 插件 → 添加插件 → 本地目录 → 选仓库根目录。装完是三个组件：

```
dsh-personal-context
├─ dsh-personal-context-core             队列、投递、设置面板
├─ dsh-personal-context-source-telegram  来源
└─ dsh-personal-context-source-feishu    来源
```

**② 起常驻采集**：

```bash
node packages/core/bin/personal-context.mjs init
```

写凭据到 `~/.dsh/state/personal-context/sources.env`（0600），装 systemd 用户服务（macOS 为 launchd），启动并打印状态。已有配置不会被覆盖。

**③ 在设置里选收件会话**：设置 → 个人上下文 —— 每路来源的开关、节奏、**投给哪个会话**。

**④ 验证**：`personal-context status`，然后往被采集的会话发一条消息。

## 契约一：来源

一个来源是一个包，声明自己：

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

`worker.py` 守三条：

1. 配置从 `PERSONAL_CONTEXT_SOURCE_*` 读（`intervalMs` → `PERSONAL_CONTEXT_SOURCE_INTERVAL_MS`）
2. **stdout 只写信封**，一行一个 JSON；日志走 stderr
3. SIGTERM 干净退出；异常退出码非 0（中枢 10 秒后重启）

信封：

```json
{ "id": "imap:INBOX:42", "source": "imap", "at": "2026-11-15T09:00:00+08:00",
  "actor": "other", "text": "正文", "ref": "blobs/2026/11/15/0900.json",
  "meta": { "chat": "收件箱", "sender": "张三" } }
```

`id` 是幂等键，`at` 必须带时区。来源**不需要**知道队列、路由、收件人——那是中枢和配置的事。

装进 profile 的 `node_modules` 后自动被发现：设置页多一组字段，采集侧多一路进程，不用改一行核心代码。

**不想写常驻 worker 也可以**：中枢另有一个一次性入口，适合推送型来源、手机快捷指令、临时脚本：

```bash
curl -X POST http://127.0.0.1:7788/v1/event \
  -H "Authorization: Bearer $(cat ~/.dsh/state/personal-context/token)" \
  -H 'content-type: application/json' \
  -d '{"source":"manual","at":"2026-11-15T09:00:00+08:00","actor":"other","text":"正文"}'
```

同一个信封格式，同样走去重、路由、凭据规则。

## 契约二：投递

三个 HTTP 动作，无需 SDK：

```
POST /v1/take   {"sink":"…","limit":50}   → {"ticket":"…","events":[…],"backlog":N}
POST /v1/done   {"ticket":"…","ids":[…]}  → {"delivered":n,"released":m}
POST /v1/retry  {"ticket":"…","reason":"…"}
```

- `take` 拿走一批并持有租约（默认 5 分钟，超时自动收回）
- `done` 只把点名的标为已投，同一张小票里没点名的自动放回
- `retry` 整张退回，`attempts` 加一

最小适配器：

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

token 在 `~/.dsh/state/personal-context/token`。参考实现：`packages/core/src/plugin/api-client.js`；契约测试：`packages/core/test/api-client.test.js`。

## 命令

```bash
personal-context init      # 装/改凭据、开机自启、起服务
personal-context status    # 队列与来源状态
personal-context sources   # 每路来源收了多少、丢了多少
personal-context log -f    # 跟日志
```

未全局安装时用 `node packages/core/bin/personal-context.mjs <命令>`。

## 配置

**设置界面**（`~/.dsh/state/personal-context/config.json`）：投递节奏、单批条数字数、积压阈值、每路来源的开关与间隔、每路来源的收件会话。

**环境变量**（`sources.env`，0600）：只放凭据与地址。

| 变量 | 用途 |
|---|---|
| `PERSONAL_CONTEXT_TELEGRAM_API_ID` / `_API_HASH` / `_SESSION` | Telethon 凭据与会话文件 |
| `PERSONAL_CONTEXT_TELEGRAM_PROXY` | 代理，如 `socks5://127.0.0.1:7897` |
| `PERSONAL_CONTEXT_TELEGRAM_CHATS` | 只采这些会话，逗号分隔；空=全部 |
| `PERSONAL_CONTEXT_FEISHU_LARK_CLI` | lark-cli 路径（默认走 PATH） |
| `PERSONAL_CONTEXT_STATE_DIR` | 状态目录，默认 `~/.dsh/state/personal-context` |
| `PERSONAL_CONTEXT_HTTP_LISTEN` | 中枢监听地址，默认 `127.0.0.1:7788` |
| `PERSONAL_CONTEXT_SOURCE_DIRS` | 额外扫描来源包的目录，冒号分隔 |

### 凭据怎么拿

**Telegram**：[my.telegram.org](https://my.telegram.org) 建应用拿 `api_id` / `api_hash`；`session` 是 Telethon 用户会话文件，首次需交互登录（`python3 -m pip install telethon`）。

**飞书**：`npm i -g @larksuite/cli`，再 `lark-cli config init --as user` 完成登录。全程以你本人身份读消息，不依赖机器人事件订阅。

两路可只用其一。

## 排错

| 现象 | 原因 |
|---|---|
| 设置里没有「个人上下文」 | 客户端 bundle 没加载，看 DSH 开发者工具 Console |
| 消息迟迟不出现，来源在跑 | 目标会话没在 DSH 里打开过——打开即补投 |
| `feishu 未运行` | 缺 `lark-cli` 或未登录 |
| `telegram` 起不来 | 缺 `telethon` 或 session 路径不对 |
| 7788 被占用 | 改 `PERSONAL_CONTEXT_HTTP_LISTEN`，两端同步 |

日志：`personal-context log -f`。

## 设计取舍

细节见 [docs/design.md](docs/design.md) 与 [docs/adr/](docs/adr/)，三条最关键的：

- **为什么不吃长连接**（TG 用轮询）：先把「收得到」跑通，实时性让位给简单性。间隔可配。
- **为什么投递端不能直接读库**：读库意味着复制表结构与状态机，换一个 agent 就得抄一遍。三个动作能覆盖同样的语义。
- **为什么不判断重要性**：判断属于接收方会话，不属于管道。管道只保证完整与及时。

## 已知限制

- 目标会话需在 DSH 里打开过（DSH 的 agent 实例是按需加载的）
- Telegram 为轮询（默认 8 秒），单条最坏延迟一个周期
- 飞书只能轮询：user 身份不支持事件订阅
- 推送型来源还没有开箱的包（可用上面的 `POST /v1/event` 自行接入）
- 开机自启仅支持 Linux / macOS

## 参与贡献

两条不能破的约定：

1. **来源 worker 不得依赖 DSH**——只能读环境变量、往 stdout 写信封。这条保证采集能在 agent 客户端之外独立运行。
2. **队列只有一个写者**——投递端一律走 `take / done / retry`，不得直接访问数据库。

`npm test`，143 个用例。

## 目录

```
packages/core/                中枢：队列、投递、设置面板、命令行
packages/source-telegram/     Telegram worker
packages/source-feishu/       飞书 worker
cordis.patch.yml              壳包：把组件插进 DSH 组合
deploy/                       打包脚本、systemd 单元、重启脚本
docs/                         设计说明与 ADR
```

## 许可

[MIT](LICENSE)
