# dsh-personal-context

给个人 agent 装一个**常驻的感知层**：外部世界发生的事——群消息、邮件、日程变更、CI 失败——第一时间自己走进它的上下文，不用等人转述。

```
任意来源 ──▶ 统一信封 ──▶ 常驻队列 ──▶ 任意 agent 的任意会话
```

来源可以随便加，接收端可以随便换，两端各有一个几十行就能实现的契约。今天接的是 Telegram 和飞书——那只是最早的两个实现。

[Node.js](https://nodejs.org) · [MIT](LICENSE)

---

## 它解决什么

14:03，老板在群里说「这个方案今天下班前改好」。你在开会。

| 方式 | 消息什么时候到你眼前 | 空闲时的代价 |
|---|---|---|
| 定时任务 | 到下一次扫描，几分钟后；而且通常只记一行日志 | 每扫一次就是一个模型回合，没消息也烧 token |
| MCP | 你想起来去问的时候——而你可能压根没看到那条消息 | 不问就不花，也永远不知道 |
| 这里 | 8 秒轮询内入队，0.5 秒内作为一条消息投进你指定的会话，agent 当场开始这一轮 | **0** |

**扫描不思考，思考不扫描。** 轮询是一个普通进程，零 token，几秒一次也无所谓；只有真有消息才唤醒 agent。于是成本跟事件数成正比，跟时间无关：一天 10 条消息就花 10 次唤醒，一天 0 条一次都不花——而扫描一直在跑。

---

## 能接什么

凡是有「新东西出现」的地方都能接。从重到轻：

| 来源 | 接法 | 工作量 |
|---|---|---|
| 邮件、日历、RSS、网页变更、屏幕 OCR | 写一个来源包 | 几十到两百行 |
| 自家服务 webhook、CI、Git 事件、手机快捷指令 | `POST /v1/event` | **不用写代码** |
| 别人写好的来源包 | `npm i` 一个包 | **一行** |
| Telegram、飞书 | 已内置 | 零 |

来源不认识收件人，接收端不认识来源——所以加任何一端，另一端都不用动。

---

## 两个契约

### 一、接一个来源

一个包加一个进程。`package.json` 里声明自己：

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

### 二、接一个 agent

三个 HTTP 动作，不需要 SDK：

```
POST /v1/take   {"sink":"…","limit":50}  → {"ticket":"…","events":[…],"backlog":N}
POST /v1/done   {"ticket":"…","ids":[…]} → {"delivered":n,"released":m}
POST /v1/retry  {"ticket":"…","reason":"…"}
```

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

## 装一下

需要 Node.js ≥ 22（用了内置的 `node:sqlite`）。

```bash
git clone <本仓库地址> && cd <仓库目录>
node packages/core/bin/personal-context.mjs init     # 问凭据、装开机自启、起服务
personal-context status                              # 队列与来源状态
```

然后接上 agent。**目前的接收端实现是 [DSH](https://deepseek.com)**：插件 → 添加插件 → 本地目录 → 选本仓库，装完在它的**设置 → 个人上下文**里打开来源、选收件会话。

换别的 agent，只需实现上面那个契约，中枢与所有来源都不用动。

凭据、环境变量、命令、排错见 [docs/operations.md](docs/operations.md)。

---

## 更多

- [docs/design.md](docs/design.md) —— 设计与取舍
- [docs/adr/](docs/adr/) —— 架构决策记录
- 加来源、加接收端都欢迎，两条硬约定见 [CONTRIBUTING](docs/operations.md#参与)：来源进程不依赖本项目与任何 agent 客户端；队列只有一个写者

## 许可

[MIT](LICENSE)。
