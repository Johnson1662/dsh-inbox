# Personal-Context

个人 agent 的**上下文基础设施**：把各来源的信息收进来，中转一下，投进某个 agent 的某个会话。

**状态：已跑起来。** 采集常驻（systemd 用户服务，开机自启），两路来源在跑（Telegram 8 秒、飞书 5 秒），设置界面在 DSH 的「设置 → 个人上下文」里，队列条数守恒。

---

## 一句话

**两个程序，三段，一份契约。**

```text
常驻侧（开机自启，DSH 关着也跑）
├─ ① 来源进程（一来源一进程，只采不懂）
│      telegram │ 飞书 │ curl 手工一条 │ …以后随便加
│               ↓ 统一信封（唯一的契约）
└─ ② 队列与库（SQLite，唯一写者）
       收下 → 去重落盘 → 按路由匹配 → 待投递
                ↓ 每 500ms 拉一批
agent 侧（插件，很薄）
└─ ③ 投递 adapter（一 agent 一份）
       渲染成一条可读消息 → 某个 agent 的某个会话
```

加来源不改投递，换 agent 不改采集。**这是“基础设施”，不是一个插件。**

---

## 为什么这么分

| 你想干的事 | 要改的地方 | 不用碰 |
|---|---|---|
| 加一路来源 | 写一个来源进程 + 一条配置 | 队列、投递、其他来源 |
| 让某路事件去另一个会话 | 改路由一行 | 所有代码 |
| 换一个 agent 接收 | 换那层薄 adapter（十几行） | 来源、队列 |
| 关掉 DSH / 重启机器 | 什么都不用做 | 采集照跑、事件照样入库，回来再投 |

可插拔的五条验收：

1. 加一路来源 = 一个进程 + 一份配置，**不用动投递**
2. 来源崩了，其他来源和投递不受影响
3. 来源不需要认识 agent，只把事件交上来
4. 换投递目标 = 改配置，不改来源
5. 任何一路单独拿掉，剩下的照样跑

---

## 契约：统一信封

所有来源交上来的是同一种东西。这是整个系统**唯一**的接口。

```json
{
  "id": "telegram:-1001234:55501",
  "source": "telegram",
  "at": "2026-11-14T19:40:00+08:00",
  "actor": "other",
  "text": "作业 DDL 改到 25 号",
  "ref": "blobs/2026/11/14/1940.json",
  "meta": { "chat": "自然语言处理", "sender": "王老师" }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | **幂等键**。同一件事必须稳定不变；有天然 ID 就用，没有就内容哈希 |
| `source` | 是 | 哪一路，小写：`telegram` / `feishu` / `manual` … |
| `at` | 是 | 事件发生时间（不是提交时间），ISO 8601 带时区 |
| `actor` | 是 | `self` 本人 / `other` 他人 / `system` 系统 |
| `text` | 否 | 能读的原文。消息正文、OCR 结果都放这儿 |
| `ref` | 否 | 原始件位置（附件、录音、截图） |
| `meta` | 否 | 该来源自己的细节，原样保留、不解释 |

四条铁律：

- **来源不写收件人。** 投给谁是路由配置的事。
- **`id` 相同就不重复入库。** 重采一次、重投一遍，库里只有一行。
- **原始件不删不改。** 库永久保留，不设过期。
- **凭据类不投。** 验证码、密码短信只记"有这么一条"，正文不入库——它不是信息，是钥匙。

**第一版不做可信度分级、不做敏感度分类。** 全部原样接收。等接屏幕那一路（"屏幕上瞥到的"和"你自己说的"差别巨大）时，再往信封里加两个可选字段。

---

## 中转：队列做什么 / 不做什么

**做**：去重落盘、按路由排队、等着被取走、失败重试、计数。

**不做**：

- 不判断这条重不重要（判断交给接收的会话）
- 不摘要、不压缩、不改写正文
- 不认识 DSH、不认识任何 agent、不 import 任何 agent 的代码
- 不做项目、待办、DDL、提醒排期
- 不对公网开放（只听 `127.0.0.1`）

**入口只有一个，用户有两个**：内部来源进程往上交，外部程序 `curl` 一条。同一条路，同一个表。

| 方式 | 谁用 | 形态 |
|---|---|---|
| HTTP 交一条 | 来源进程、手机快捷指令、你自己的脚本 | `POST 127.0.0.1/v1/event` |
| 落文件 | 最笨，什么都能接 | 往 spool 目录写一行，改后缀 |

---

## 每个来源投给哪个会话

在 `设置 → 个人上下文 → 收件会话` 里，每路来源一个下拉框，选项来自 DSH 里的 bot 列表。选完保存即写进 `config.json` 的 `routes`，守护进程立刻重新加载（旧事件保持原路由，新事件按新路由走）。

**一个前提**：目标会话得在 DSH 里被打开过（哪怕一次），否则 DSH 里没有它的 agent 实例，消息会**排队等着而不是丢掉**——你打开那个会话，积压的消息立刻投进去。这一步是 DSH 的机制，不是我们的选择。

## 接自己的 agent：三个动作

队列只有一个写者（守护进程）。适配器不碰数据库，只做三件事——**这是给别人的唯一契约**：

```
POST /v1/take   {"sink":"chief","limit":50}   → {"ticket":"t:…","events":[…],"backlog":N,"expiresAt":"…"}
POST /v1/done   {"ticket":"t:…","ids":[…]}    → {"delivered":n,"released":m}
POST /v1/retry  {"ticket":"t:…","reason":"…"} → {"released":n}
```

- **小票**：`take` 拿到的这批被划走，别人取不到；`done` 只把点名的标已投，没点名的自动放回。
- **租约**：默认 5 分钟没回话，守护进程自己收回——适配器崩了也不会把消息锁死。
- **鉴权**：`Authorization: Bearer <token>`，token 在 `~/.dsh/state/personal-context/token`（0600）。

五十行的最小适配器长这样：

```js
const call = (path, body) => fetch(`http://127.0.0.1:7788${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json())

const { ticket, events } = await call('/v1/take', { sink: 'chief', limit: 50 })
if (events.length) {
  try {
    await myAgent.send(render(events))          // ← 这里换成你的 agent
    await call('/v1/done', { ticket, ids: events.map(e => e.id) })
  } catch (e) {
    await call('/v1/retry', { ticket, reason: String(e) })
  }
}
```

DSH 插件就是按这个写法实现的（`src/plugin/api-client.js`），它是**第一个第三方适配器**，没有任何特权。

## 投递：每 500ms 一批，批内不丢

投递循环每 500ms 取一次待投事件。**如果这 500ms 里攒了多条，它们被打包成一条消息**投进会话——但**批内每条事件都完整保留**，一行一条，不做摘要、不改写、不合并内容。

**延迟预算**：来源轮询间隔 + 投递间隔。Telegram 默认 8 秒、飞书 5 秒，投递 ≤0.5 秒，所以「发出去到出现在会话里」最坏是一个轮询周期。实测入库→投递 138ms。要更快就调 `PERSONAL_CONTEXT_TELEGRAM_INTERVAL_MS` / `PERSONAL_CONTEXT_FEISHU_INTERVAL_MS`，不用改代码。

**上限与溢出**：单批 50 条 / 4000 字。装不下就顺延到下一批；积压超过 200 条时上限放大到 200 条 / 20000 字——放大是为了少唤醒几次，**不是为了少投几条**。

**零丢失**：事件只有「待投」「已投」两种状态。没有过期、没有 `stale`、没有截断、没有丢弃。漏一条的代价远大于多几条消息。

一批长这样：

```text
[telegram] 3 条新消息
· 自然语言处理 | 王老师 | 19:40 | 作业 DDL 改到 25 号
· 自然语言处理 | 李同学 | 19:41 | 收到
· 私聊 | 张工 | 19:41 | 明天上午的会改到十点
[feishu] 1 条新消息
· 项目群 | 陈 | 19:41 | 合同我看过了
```

四条语义：

- **零丢失**：装不下留到下批，积压就多发几条，永不丢。
- **收件人只有一种：某个 agent 的某个会话。** 不是人，也不是脚本、不是第三方应用。
- **至少一次**：投完才标记；失败保留、重试，不静默丢。
- **同一会话同时只有一个投递方**，否则会互相打断对话。

`dsh-inbox` 现在用 60 秒定时器（为了攒批），机制一样，把间隔压到 500ms 就是“及时”。

---

## 路由：一个来源只去一个会话

```json
{
  "routes": [
    { "sources": ["telegram"], "sink": "chief" },
    { "sources": ["feishu"],   "sink": "chief" }
  ],
  "sinks": {
    "chief": { "kind": "dsh-session", "session": "chief" }
  }
}
```

- **一个来源只指向一个会话**；**多个来源可以共用一个会话**
- 所以每条事件只有一个收件人，投递状态按事件记一行就够
- `sink` 只是个名字。它对应哪个会话、哪个 Bot，队列一概不知道——那是 adapter 的事

每个来源可单独配节奏，没配的走默认：

```json
{
  "sources": {
    "telegram": { "enabled": true, "interval_ms": 8000 },
    "feishu":   { "enabled": true, "interval_ms": 8000 },
    "_default": { "interval_ms": 60000 }
  }
}
```

---

## 配置：三层，没有一处写死

优先级 **环境变量 > 配置文件 / 设置界面 > 代码里的默认值**。要改行为，改这三层中的一层；代码里不出现魔法数字。

### 设置界面

DSH 没有「按 schema 自动生成表单」这回事（那是 Koishi 的行为）。要界面，插件得自己带浏览器半端：

- `package.json` 声明 `dsh.client = { platform: 'web' }` 与 `exports["./client"]`
- `src/plugin/client.js` 在 `settings.section` 槽里注册一个 React 面板
- 面板读写 `src/plugin/route.js` 挂在宿主 web 上的 `/personal-context/config`（**不能放 `/api/` 前缀下**，那是 Remote RPC 网关的地盘，POST 会被掐断）

面板里的九项：投递间隔、单批条数字数、积压阈值、Telegram/飞书 的开关与轮询间隔。保存即写 `config.json`：

- 投递参数由插件**就地热更新**，下一批就按新值走
- 来源开关由守护进程**看着 `config.json`** 增删子进程（`来源变更：feishu: 关`），水位在文件里，重启不重投

### 环境变量（凭据只走这里）

| 变量 | 作用 | 默认 |
|---|---|---|
| `PERSONAL_CONTEXT_STATE_DIR` | 状态目录 | `~/.dsh/state/personal-context` |
| `PERSONAL_CONTEXT_CONFIG` | 守护进程读的配置文件 | `<stateDir>/config.json` |
| `PERSONAL_CONTEXT_HTTP_LISTEN` | 收事件的地址 | `127.0.0.1:7788` |
| `PERSONAL_CONTEXT_HTTP_TOKEN` | 收事件的 token | 首次启动生成，存 `<stateDir>/token`（0600） |
| `PERSONAL_CONTEXT_SINK` | 投递目标名 | `chief` |
| `PERSONAL_CONTEXT_DELIVERY_INTERVAL_MS` | 投递循环间隔 | `500` |
| `PERSONAL_CONTEXT_BATCH_COUNT` / `PERSONAL_CONTEXT_BATCH_CHARS` | 单批上限 | `50` / `4000` |
| `PERSONAL_CONTEXT_BACKLOG_COUNT` / `PERSONAL_CONTEXT_BACKLOG_CHARS` | 积压放大时的上限 | `200` / `20000` |
| `PERSONAL_CONTEXT_TELEGRAM_INTERVAL_MS` | TG 轮询间隔（默认值，设置界面可改） | `8000` |
| `PERSONAL_CONTEXT_TELEGRAM_API_ID` / `PERSONAL_CONTEXT_TELEGRAM_API_HASH` / `PERSONAL_CONTEXT_TELEGRAM_SESSION` | TG 凭据与会话文件 | 无（启用即必填） |
| `PERSONAL_CONTEXT_FEISHU_INTERVAL_MS` | 飞书轮询间隔（默认值，设置界面可改） | `5000` |
| `PERSONAL_CONTEXT_TELEGRAM_PROXY` | TG 走的代理（`socks5://host:port`） | 无 |
| `PERSONAL_CONTEXT_TELEGRAM_CHATS` | 只采这些会话，逗号分隔；空=全部 | 空 |
| `PERSONAL_CONTEXT_TELEGRAM_BACKFILL` | 首次见到一个会话时回填最近几条；`0` = 只从当前最新开始，不回溯历史 | `0` |
| `PERSONAL_CONTEXT_TELEGRAM_ONCE` | 只跑一轮就退出，手工验活用（**别写进 `sources.env`**，否则常驻进程起来采集一轮就停） | 无 |
| `PERSONAL_CONTEXT_CREDENTIAL_CHATS` / `PERSONAL_CONTEXT_CREDENTIAL_PATTERNS` | 凭据类判定规则 | `777000` / 验证码词表 |

启用了某路来源却缺凭据时，**启动直接报错并点名缺什么**，不会静默关掉。

**凭据校验只在守护进程一侧做**。插件要投递，但不认识来源，它看不到 `sources.env`——让插件也校验凭据，只会让插件行在 DSH 里变成「异常」。

**来源的开与关不在环境变量里**，在设置界面（写 `config.json`）。环境变量只放凭据与默认节奏——因为环境变量优先级最高，一旦把开关写进 `sources.env`，界面上的开关就再也关不掉了（实测踩过）。

### 来源进程拿到什么

守护进程把 `config.sources.<name>` 摊成环境变量交给子进程，键名转成 `PERSONAL_CONTEXT_SOURCE_<UPPER_SNAKE>`：`intervalMs` → `PERSONAL_CONTEXT_SOURCE_INTERVAL_MS`、`apiId` → `PERSONAL_CONTEXT_SOURCE_API_ID`。外加 `PERSONAL_CONTEXT_STATE_DIR` 与 `PERSONAL_CONTEXT_SOURCE_NAME`。**来源进程只认环境变量，不读配置文件**，所以新增一路来源不需要改守护进程。

凭据落在 `~/.dsh/state/personal-context/sources.env`（0600），systemd 用 `EnvironmentFile` 加载；不进 git、不进设置界面。

## 加一路来源（不动投递）

1. 写 `src/sources/<name>.js` 或 `<name>.py`：从 `PERSONAL_CONTEXT_SOURCE_*` 读配置，往 stdout 写一行一个信封，日志走 stderr。
2. 在配置里加 `sources.<name>.enabled = true`（和它自己需要的键）。

守护进程按文件名约定发现，没有注册表要改；投递侧一行都不用动。

**水位**存 `<stateDir>/watermarks/<name>.json`，原子写。**首轮不回溯历史**——`backfill` 控制回补多少条，默认 0。

看护规则：非零退出 10 秒后重启（指数退避封顶 60 秒），SIGTERM 后不再重启。来源崩了不影响别的来源，也不影响投递。

## 现在做 / 现在不做

**第一批来源（已定）**：Telegram、飞书。屏幕、麦克风、邮件都推后。

**做**：来源进程 → 统一信封 → 队列 → 500ms 一批投进一个会话。采集常驻（不依赖 DSH 开着），零丢失。

**不做**（已明确排除，不提前设计）：

- 项目树、待办、DDL 面板
- 触发器、提醒排期、“该不该叫你”的判定
- Chief 分工、验收、回写
- 摘要与压缩
- 可信度分级、敏感度分类
- 给人发任何通知——系统只对 agent 说话
- 回查接口（先把“投得进去”跑通）
- 面板、网页 UI

---

## 后续（已知缺口）

按价值排序。前三条是补语义、不动架构；第四条是新原语。

### 1. timers

[Anthropic 的 always-on agent 拆解](https://claude.com/resources/articles/building-always-on-agents)把 timers 列为五个原语之一，我们没有。它有两种：follow-up（agent 给自己设的截止时间）和 schedule（每天 9 点）。

价值在于：agent 说完「明早提醒我」之后能自己把自己叫醒。**不需要新概念**——到期的 timer 就是一条事件回队列，走现有的去重、路由、投递。

方向：`timers` 表（`due_at`、`sink`、`payload`、`recurrence`）+ 调度循环 + `POST /v1/timer`。调度器只做一件事：扫到期的，转成事件写进队列。

### 2. 坏信封进死信区

现在 `normalize()` 对格式不对的信封返回 `{ error }`，HTTP 回 400，**不入库**。来源写错一个时区，这条就没了——和「零丢失」直接冲突。这是目前唯一的破口。

方向：`rejected` 表，存原始 JSON + 拒绝原因 + 来源 + 时间；`status` 里显示「3 条被拒：invalid_at ×2、invalid_actor ×1」。仍然不投递（它本来就无法投），但要看得见。

### 3. sink 注册

`/v1/take` 接受任意 `sink` 名，不认识就返回空批。「同一会话同时只有一个投递方」现在只有文字约定，没有机制——两个 adapter 配同一个 sink 会互相抢，谁也发现不了。

方向：adapter 启动时 `POST /v1/sink { name, pid }` 注册并续租；`take` 校验；第二个 adapter 抢同一个 sink 时拿到 409。租约到期自动注销，适配器崩了不会锁死。

### 4. 可观测

现在只有一个 `status`。常驻基础设施最怕「它还在跑吗、卡在哪」。缺的是：队列深度随时间、投递延迟（入库 → 投递的 p50/p95）、每路来源的最后成功轮询时间、被拒与重试计数。

方向：先做 `status --json` 给脚本用，再把最关键的四项画进设置面板。不做时序数据库。

### 明确不做（重申）

回程（outbox 的另一半、给人发通知）、memory、permissions 都不归这层管——它们属于会话与 agent 客户端。管道只负责把事件完整、及时、幂等地送进去。

---

## 目录

- 术语表：[GLOSSARY.md](./GLOSSARY.md)
- v1 接口级规格与验收：[.scratch/v1-ingest-pipeline/spec.md](./.scratch/v1-ingest-pipeline/spec.md)
- 代码仓库设计（模块、接口、接缝、测试面）：[docs/repo-design.md](./docs/repo-design.md)
- 架构决策记录：[docs/adr/](./docs/adr/) —— 为什么两个程序、为什么只投 agent、为什么飞书只能轮询、为什么零丢失
- Agent 工具配置：[AGENTS.md](./AGENTS.md)、[docs/agents/](./docs/agents/)
