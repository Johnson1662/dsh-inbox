# dsh-inbox

> 给个人 agent 装一个**常驻的感知层**：外部世界发生的事——群消息、邮件、日程变更、CI 失败——第一时间自己走进它的上下文，不用等人转述。

**核心定位**：这是一条**管道**，不是一个插件。任意来源 → 统一信封 → 常驻队列 → 任意 agent 的任意会话。来源可以随便加，接收端可以随便换，两端各有一个几十行就能实现的契约。

今天接的是 Telegram、飞书、微信和 GitHub 通知——那是**前四个实现**，不是这个项目的边界。

[Node.js](https://nodejs.org) · [MIT](LICENSE)

---

## 快速开始（5 分钟）

需要 Node.js ≥ 22（用了内置的 `node:sqlite`）。

```bash
git clone <本仓库地址> && cd <仓库目录>
node packages/core/bin/personal-context.mjs init   # 问凭据 → 装开机自启 → 起服务
personal-context status                            # 队列与来源状态
```

GitHub 那一路不填凭据：命令行里 `gh auth login` 过一次，它就用那个登录态读未读通知。

然后接上 agent。**目前的接收端实现是 [DSH](https://deepseek.com)**：插件 → 添加插件 → 本地目录 → 选本仓库，装完在它的**设置 → 个人上下文**里打开来源、选收件会话。

换别的 agent 只需实现[下面那个契约](#二接一个-agent)，中枢与所有来源都不用动。凭据怎么拿、环境变量、排错见 [docs/operations.md](docs/operations.md)。

---

## 它解决什么

14:03，老板在群里说「这个方案今天下班前改好」。你在开会。

| 方式 | 消息什么时候到你眼前 | 空闲时的代价 |
|---|---|---|
| 定时任务 | 到下一次扫描，几分钟后；而且通常只记一行日志 | 每扫一次就是一个模型回合，没消息也烧 token |
| MCP | 你想起来去问的时候——而你可能压根没看到那条消息 | 不问就不花，也永远不知道 |
| 这里 | 8 秒轮询内入队，0.5 秒内作为一条消息投进你指定的会话，agent 当场开始这一轮 | **0** |

**扫描不思考，思考不扫描。** 轮询是一个普通进程，零 token，几秒一次也无所谓；只有真有消息才唤醒 agent。于是成本跟事件数成正比，跟时间无关：一天 10 条消息就花 10 次唤醒，一天 0 条一次都不花——而扫描一直在跑。

这也是 [Anthropic 对 always-on agent 的拆解](https://claude.com/resources/articles/building-always-on-agents)里的第一块原语——**event inbox**。其余四块不在这里：memory 和 permissions 属于会话，outbox 我们只做了一半（往会话里投，不做回程），timers 见[后续](#后续)。

---

## 三层结构

**每一层都能单独替换，这是整个设计的目的。**

```
来源          telegram   feishu   wx   github   imap   screen   …随便加
              ↓ 只输出统一信封，不认识收件人
中枢          去重入库 → 按路由排队 → 发小票（唯一写者，不认识任何 agent）
              ↓ HTTP：take / done / retry
接收端        DSH 插件   你的脚本   别的 agent   …五十行接一个
```

| 你想干的事 | 改哪一层 | 不用碰 |
|---|---|---|
| 加一路来源 | 写一个来源包 | 中枢、接收端、其他来源 |
| 让某路事件换一个会话 | 改一行路由配置 | 所有代码 |
| 换一个 agent 接收 | 换接收端那一层 | 来源、中枢 |
| 关掉 agent 客户端、重启机器 | 什么都不用做 | 采集照跑，回来再投 |

---

## 两个契约

### 一、接一个来源

一个包加一个进程。`package.json` 里声明自己：

```json
{
  "name": "dsh-inbox-source-imap",
  "dsh": {
    "source": {
      "name": "imap",
      "runtime": "python",
      "entry": "worker.py",
      "fields": [
        { "key": "enabled", "label": "采集邮箱", "type": "boolean", "default": false },
        { "key": "intervalMs", "label": "轮询间隔", "type": "number", "min": 5000, "default": 60000 }
      ]
    }
  }
}
```

`worker.py` 只守三条：配置从环境变量读；**标准输出一行一个 JSON 信封**，日志走标准错误；收到 SIGTERM 干净退出。

```json
{ "id": "imap:INBOX:42", "source": "imap", "at": "2026-11-15T09:00:00+08:00",
  "actor": "other", "text": "正文", "meta": { "chat": "收件箱", "sender": "张三" } }
```

`id` 是幂等键，`at` 必须带时区，`actor` 是 `self`/`other`/`system`。`fields` 里的每一项会直接渲染成设置界面的控件——加来源的人不写任何前端代码。

不想写常驻进程，就一次 HTTP 调用：

```bash
curl -X POST http://127.0.0.1:7788/v1/event \
  -H "Authorization: Bearer $(cat ~/.dsh/state/personal-context/token)" \
  -H 'content-type: application/json' \
  -d '{"source":"manual","at":"2026-11-15T09:00:00+08:00","actor":"other","text":"正文"}'
```

> 加来源的写法参照了 [DSH superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 `SourceKind`——它也支持双向回复、鉴权与线程上下文。我们只做单向投递，所以把那份接口砍到只剩声明 + 一个往标准输出写信封的进程。

### 二、接一个 agent

三个 HTTP 动作，不需要 SDK：

```
POST /v1/take   {"sink":"…","limit":50}   → {"ticket":"…","events":[…],"backlog":N,"expiresAt":"…"}
POST /v1/done   {"ticket":"…","ids":[…]}  → {"delivered":n,"released":m}
POST /v1/retry  {"ticket":"…","reason":"…"} → {"released":n,"ids":[…]}
```

事件里每条的字段：`id / source / at / actor / text / meta / attempts`。这几行形状由 `packages/core/test/contract.test.js` 钉住——改它就得同时改文档。

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

`take` 拿走一批并持有租约，到期自动收回；`done` 只把点名的标记为已投，没点名的放回；`retry` 整张退回重来。

> 为什么不直接读数据库：那等于把表结构和状态机抄进每个适配器，我们改一次 schema 全部适配器一起坏。三个动作覆盖同样的语义，见 [ADR 0006](docs/adr/0006-适配器只认三个动作.md)。

---

## 三条保证

1. **不丢** —— 事件只有「待投」和「已投」两种状态。不摘要、不截断、不判断重要性，队列再多也全给。
2. **不重** —— 同一个 `id` 重复提交只入一行。重采一次、重投一遍，库里还是一条。
3. **常驻** —— 采集跑在独立进程，agent 客户端关闭、重启、升级都不影响。投成功才标记送达，失败退回重试。

---

## 目录结构

```
.
├── packages/core/                中枢：信封、队列、投递循环、HTTP、设置面板、命令行
│   ├── src/core/                 信封校验、SQLite 队列、渲染成一条消息
│   ├── src/daemon/               常驻进程：收事件、看护来源子进程、跑投递
│   ├── src/cli/                  init / status / sources / log
│   └── src/plugin/               接收端：take / done / retry 的第一个实现（DSH）
├── packages/sources/             来源，一路一个包
│   ├── telegram/                 Telegram（Python + Telethon）
│   ├── feishu/                   飞书（lark-cli，以你本人身份读）
│   ├── wx/                       微信（调 wx-cli 读本地聊天库，白名单）
│   └── github/                   GitHub 通知（轮询未读，token 走 gh 登录态）
├── cordis.patch.yml              接收端：DSH 的组合补丁（装三个组件）
├── deploy/                       打包、systemd 单元、重启脚本
└── docs/                         设计说明、ADR、运维手册
```

---

## 后续

按价值排序，都是补语义、不动架构的：

- **timers** —— agent 给自己设的截止时间，到期变成一条事件回队列（"明早提醒我"）。五原语里唯一还缺的一块。
- **坏信封进死信区** —— 现在格式不对会被直接拒掉、不入库，零丢失在这里有个口子，应该入库且可见。
- **sink 注册** —— "同一会话同时只有一个投递方"目前靠约定，没有机制。
- **上下文格式** —— 参照 [grapeot/context-infrastructure](https://github.com/grapeot/context-infrastructure) 的 `contexts/` 分层，把 `meta`、`ref` 与落盘目录整理成可长期积累的形状。
- **可观测** —— 队列深度、投递延迟、来源健康，现在只有一个 `status`。

---

## 更多

- [docs/design.md](docs/design.md) —— 设计与取舍，含每条后续的现状与做法
- [docs/operations.md](docs/operations.md) —— 凭据、环境变量、命令、排错
- [docs/adr/](docs/adr/) —— 架构决策记录
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 加来源、加接收端、质量底线
- [AGENTS.md](AGENTS.md) —— 在这个仓库里写代码的 agent 读的那份

## 许可

[MIT](LICENSE)。
