# 代码仓库设计

2026-11-14 · 设计稿，未实现。配合 [v1 规格](../.scratch/v1-ingest-pipeline/spec.md) 阅读。

四个模块，两个进程组，一份契约。设计标准：**接口小、实现深**——调用方要知道的越少，能做的越多。

---

## 1. 目录

```text
Personal-Context/
├── src/
│   ├── core/                    ← 纯逻辑。不 import @deepseek-ai/*，不 spawn 进程，不读环境
│   │   ├── envelope.js            normalize(raw) → Envelope | Rejected
│   │   ├── queue.js               ingest / take / ack / fail / stats
│   │   ├── batcher.js             pick(events, limits) → { batch, rest }
│   │   └── render.js              render(batch) → string
│   ├── daemon/                  ← 组合根：配置、拉起来源子进程、HTTP 入口、自愈
│   │   └── index.js
│   └── plugin/                  ← DSH 插件（投递 adapter）
│       ├── index.js
│       └── cordis.patch.yml
├── sources/                     ← 来源进程：一来源一文件
│   ├── telegram.py                Telethon 用户会话（Python：唯一必须用 Python 的一路）
│   └── lark.js                    起 lark-cli 拉消息（Node）
├── test/
├── config.example.json
├── package.json                 ← dsh.bundle.patch 指向插件
└── docs/  .scratch/  README.md  GLOSSARY.md  AGENTS.md
```

依赖方向单向：`plugin → core`、`daemon → core`、`sources → （无）`。**core 不认识 DSH，也不认识进程。**

---

## 2. 模块与接口

### `core/envelope.js` — 信封的准入

```js
normalize(raw, { now })        → Envelope | { error }
stripCredentials(env, rules)   → Envelope        // 命中则清空 text，只留 id/at/source/meta
```

藏在里面的：必填校验、`id` 推导（无天然 ID 时按 来源+时间+文本哈希）、时间解析与强制带时区、`actor` 枚举、未知字段丢弃、凭据规则匹配。

**不变式**：返回的 Envelope 一定合法；`stripCredentials` 之后 `text` 要么完整、要么为空，**绝不部分截断**。

### `core/queue.js` — 状态（最深的一个）

```js
open(path, { routes })         → Queue
queue.ingest(env)              → { id, duplicate }
queue.take(sink, limit)        → Event[]        // 只读，不改状态
queue.ack(ids)                 → void
queue.fail(ids, reason)        → void
queue.stats()                  → { pending, delivered, perSource }
```

藏在里面的：DDL 与迁移、`id` 唯一索引带来的幂等、路由解析（`source → sink`，在 ingest 时定下并存成列）、排序（`at` 升序，同 `at` 按自增序）、重试计数、WAL 与 `busy_timeout`、ack/fail 的事务边界。

**不变式**（写进接口文档，调用方必须知道）：

- `ingest` 同 `id` 重复 → `duplicate: true`，不是错误
- `take` 不改状态；调用 `ack`/`fail` 才改
- `ack` 幂等
- **没有任何删除、过期、截断路径**（ADR-0004）
- 同一 `sink` 同时只有一个消费者（由调用方保证，队列不挡）

### `core/batcher.js` — 批次策略（纯函数）

```js
pick(events, limits) → { batch, rest }
```

藏在里面的：按条数与字数双重限流、积压放大（待投 > 200 时上限放大）、单条超长时独占一批。

**不变式**：`batch ∪ rest = events`，一条不多一条不少；`events` 非空则 `batch` 非空。

字数按 `text.length` + 每行固定开销估算，**这一条与 `render` 的约定必须一致**（render 不得增删正文，只加固定前缀）。

### `core/render.js` — 呈现（纯函数）

```js
render(batch) → string
```

按来源选模板，表头一行、每条事件一行、正文折行、不省略。

### 来源进程的接口

每个来源进程只需满足三件事：

1. 启动：参数是一个配置文件路径
2. stdout：逐行 JSON 信封；日志一律走 stderr
3. 退出：非零 = 不可恢复（daemon 10 秒后重启）；SIGTERM = 正常收尾

**不写库、不知道 sink、不认识 agent。** 水位、分页、并发、429 退避全在自己的实现里。

### `daemon` — 组合根

读配置 → 打开队列 → 拉起来源子进程 → 逐行读 stdout（`normalize` → `stripCredentials` → `ingest`）→ 提供 `POST /v1/event`（外部 `curl` 走同一条路）、`GET /v1/health`、`GET /v1/stats` → 子进程崩溃 10 秒自愈。

组合根允许薄，但**不放业务逻辑**：它只接线。

### `plugin` — 投递 adapter

每 500 ms：`take(sink, 200)` → `pick(limits)` → `render` → `agent.followup(freezeMessage({ id: "pc:<hash>(ids)" }))` → `ack`；抛错则 `fail`。

会话解析复用 `dsh-inbox` 的 `target()`（稳定 Bot ID → 当前 sessionId，跟随换 part）。

---

## 3. 两个接缝（seam）

| 位置 | 为什么是真接缝 |
|---|---|
| **来源进程 ↔ daemon**：stdout NDJSON + 配置文件 | 两个 adapter 已经在用（TG 是 Python/Telethon，飞书是 Python 调 `lark-cli`），加上 HTTP 外部入口是第三个写法——同一形状三种来源。 |
| **plugin ↔ core**：`take/ack/fail` | 生产是 SQLite，测试是临时库文件——第二个 adapter 已经在计划里，不算空想。 |

**故意不设的接缝**：

- **不做 sink 接口**。真实 adapter 只有一个（DSH）。按“一个 adapter 是假接缝”，多一层抽象只是绕路；等第二个 agent 出现再抽，那时改动局在一个文件里。
- **不做来源插件注册表**。两路来源都在仓内，配置里写明进程命令就够；不搞动态加载、不搞生命周期钩子。
- **不给队列做 port/adapter**。SQLite 是本地可替代依赖（临时库文件就是测试替身），按依赖分类属于第 2 类，不需要在接口上开孔。

---

## 4. 为什么是四个 core 模块，不是一个

删除测试：

| 删掉 | 会怎样 |
|---|---|
| `envelope` | 校验逻辑在 daemon、TG、飞书、HTTP 四处重写一遍 → 复杂度回来了 |
| `queue` | 状态机、幂等、排序、重试在 daemon 和 plugin 各写一遍 → 复杂度回来了 |
| `batcher` | 批次策略在每个投递 adapter 里重写；零丢失要靠每处都记得 |
| `render` | 模板散到各处，加一路来源要改 N 个文件 |

四个都过删除测试，所以都留着。反过来，**没有** `config`、`logger`、`types` 这类模块——它们是直通层，加了只会让调用方多学一个名字。

---

## 5. 测试面

**接口就是测试面**——每个模块的测试都从它自己的接口打进去，不打内部。

| 模块 | 怎么测 |
|---|---|
| `envelope` | 表驱动：合法 / 缺字段 / 时间无时区 / 凭据命中 / 未知字段 |
| `queue` | 临时 sqlite 文件，只用 5 个方法断言：重复 ingest、take 不改状态、ack 幂等、fail 后重投、无删路径 |
| `batcher` | 属性：`batch ∪ rest = input`；单条超长独占一批；积压放大生效 |
| `render` | 金标字符串（TG / 飞书各一份） |
| `sources/*` | 注入假客户端（Telethon stub / 假 `lark-cli` 二进制），断言 stdout 的 NDJSON |
| `plugin` | 假 `queue` + 假 `agent`：断言 `followup` 一次、`MessageId` 稳定、`ack` 一次、抛错时 `fail` |
| 整体 | e2e：起 daemon + 一个 stub 来源 + `curl` 一条，断言事件进了库、又被假的 adapter 取走 |

`core` 的测试**不需要 DSH**：`node --test test/core/*.test.js` 就能跑完。这是把 DSH 挡在 `plugin/` 之外的唯一理由，也是最实际的理由。

---

## 6. 落地顺序

| 阶段 | 做什么 | 完成判据 |
|---|---|---|
| P0 | `core` 四模块 + 单测 | `node --test` 全绿；队列无删路径 |
| P1 | `daemon` + HTTP 入口 + stub 来源 | `curl` 一条 → 库里有；`/v1/stats` 对得上 |
| P2 | `plugin` 投递循环 | curl 一条 → 500ms 内出现在目标会话，只出现一次 |
| P3 | `sources/telegram.py` | 真实 TG 消息 → 1 秒内到会话 |
| P4 | `sources/lark.js` + 5 秒轮询 + 429 降频 | 真实飞书消息 → 10 秒内到；跑一天看 `degraded` 次数 |

P0–P2 全部可以在没有真实来源的情况下验收——这是分层带来的最大好处：**先让管道对，再往里灌数据。**
