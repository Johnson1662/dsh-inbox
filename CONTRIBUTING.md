# 贡献指南

这个项目的价值在**两端各自可替换**：来源谁都能加，接收端谁都能接。所以最有用的贡献往往不是改核心，而是**多一路来源**或**多一个 agent 的适配**。

## 能贡献什么

| 想做的事 | 难度 | 要做的事 |
|---|---|---|
| 加一路来源（邮件、RSS、日历、网页变更、屏幕 OCR…） | 小～中 | 一个包：声明 + 一个写标准输出的进程 |
| 接一个新的 agent（不是 DSH 的） | 小 | 一个包：调三个 HTTP 动作 |
| 加一个不用写代码的入口（webhook、快捷指令） | 很小 | 用现成的 `POST /v1/event`，补一份示例 |
| 修缺陷、补测试、改文档 | 小 | 直接来 |
| 改契约、改队列语义 | 大 | **先开 issue 讨论，再写 ADR** |

不确定该不该做？先开 issue 说清「谁在用、缺了会怎样」。比闷头写完被拒好。

## 开始之前

```bash
git clone <本仓库地址> && cd <仓库目录>
node -v                 # 需要 ≥ 22，用了内置的 node:sqlite
npm run check           # 不装任何依赖就能跑：语法 + 全部用例
```

**零运行时依赖**是硬约束：`npm install` 一个包都不装。请保持这一点——加依赖需要在 issue 里说服人。

跑起来（会真的读你的消息，建议先用测试账号）：

```bash
node packages/core/bin/personal-context.mjs init
personal-context status
```

## 提交前

```bash
npm run check
```

它做三件事：JS 与 Python 的全量语法检查、跑所有测试、确认 `deploy/pack.sh` 还能打出四个包。**没跑过不要开 PR。**

可选，看代码坏味道再跑一遍（配置在 `.fuckucoderc.json`，已排除测试与文档）：

```bash
npx -p eff-u-code fuck-u-code analyze .
```

它按复杂度、长度、嵌套、重复、错误处理给 0~100 分。注意上游 bug：npm 安装时语法解析会静默退化成正则，嵌套函数的长度被算到外层作用域末尾（详见 [AGENTS.md](AGENTS.md#可选坏味道扫描)）。脚本已指向修好的分支；**运行结果若出现 `falling back to regex parser`，数字一律不可信**。

改了投递或界面，再手动验一遍：真发一条消息，确认它进了会话，且 `personal-context status` 里队列守恒（`待投 + 已投 = 总数`）。

## 质量底线

评审只会挡这几件事，但都会挡：

1. **破坏不变量** —— 加过期、截断、静默丢弃；把「投成功才标记」改成「先标记」；让接收端直接读库。
2. **破坏可替换性** —— 来源进程 `import` 中枢；把某个来源的特殊逻辑写进投递循环；为单个来源手写面板。
3. **硬编码** —— 把间隔、路径、凭据写进代码。所有可变量走三层：环境变量 > 配置文件 > 代码默认值。
4. **裸的 `catch {}`** —— 静默吞错。失败要留痕，哪怕只记一行日志。
5. **没测试的行为变更** —— 新行为要有用例；修缺陷要有能复现的用例。
6. **大而全的 PR** —— 一次一件。顺手重构请单独开。
7. **改了对外形状却没动 `contract.test.js`** —— 那不是测试挂了，是契约变了，要先写 ADR。

## 加一路来源：完整清单

以 IMAP 为例，五步：

**1. 建包** `packages/sources/imap/`

```json
{
  "name": "dsh-personal-context-source-imap",
  "version": "0.0.0",
  "files": ["worker.py", "index.js", "package.json"],
  "dsh": {
    "source": {
      "name": "imap",
      "label": "邮箱",
      "runtime": "python",
      "entry": "worker.py",
      "fields": [
        { "key": "enabled", "label": "采集邮箱", "type": "boolean", "default": false },
        { "key": "intervalMs", "label": "轮询间隔（毫秒）", "type": "number", "min": 5000, "default": 60000 }
      ]
    }
  }
}
```

`fields` 会**自动渲染成设置界面的控件**，不用写任何前端代码。

**2. 写 `index.js`**（宿主半端，只登记，不采集）：

```js
export const name = 'dsh-personal-context-source-imap'
export function apply(ctx) {
  ctx.get('personalContext')?.registerSource({ name: 'imap', label: '邮箱', runtime: 'python', entry: 'worker.py' })
}
```

**3. 写 worker**，只守三条：

- 配置从 `PERSONAL_CONTEXT_SOURCE_*` 环境变量读（`intervalMs` → `PERSONAL_CONTEXT_SOURCE_INTERVAL_MS`）
- **标准输出一行一个 JSON 信封**，日志走标准错误——写错地方会污染事件流
- 收到 SIGTERM 干净退出；异常时退出码非 0（中枢 10 秒后重启，指数退避封顶 60 秒）

信封形状（`at` 必须带时区，`id` 必须稳定）：

```json
{ "id": "imap:INBOX:42", "source": "imap", "at": "2026-11-15T09:00:00+08:00",
  "actor": "other", "text": "正文", "meta": { "chat": "收件箱", "sender": "张三" } }
```

**4. 登记四处**：根 `package.json` 的 `file:` 依赖、`cordis.patch.yml` 一行、`deploy/pack.sh` 的循环、`README.md` 目录树。

**5. 写测试** `packages/sources/imap/test/`：缺配置时报错并点名、正常轮询产出合法信封、同一消息两次输出同一个 `id`。

> 想先看现成的？`packages/sources/telegram/`（Python）与 `packages/sources/feishu/`（Node）是两个可照抄的样板。

## 加一个接收端

不需要 SDK，三个动作：

```
POST /v1/take   {"sink":"…","limit":50}  → {"ticket":"…","events":[…],"backlog":N}
POST /v1/done   {"ticket":"…","ids":[…]} → {"delivered":n,"released":m}
POST /v1/retry  {"ticket":"…","reason":"…"}
```

`token` 在 `~/.dsh/state/personal-context/token`。参考实现见 `packages/core/src/plugin/api-client.js`，契约测试见 `packages/core/test/api-client.test.js`——**把它跑在你的实现上就够验收**。

要求只有一条：**别读数据库**。读库等于把表结构和状态机抄一份，我们改 schema 你的适配器就坏。

## 改契约或改语义

信封字段、三个动作、不变量——这些是别人依赖的东西。流程：

1. 开 issue 说明动机与影响
2. 写一条 ADR 到 `docs/adr/`（编号递增，中文标题，写清「不这么做会怎样」）
3. 实现 + 兼容期（旧行为保留一版，启动时打警告）
4. 同步 `README.md` 契约段、`GLOSSARY.md`、`docs/design.md`

## PR 怎么写

- 标题一句话说清改了什么
- 正文三行：**为什么**、**怎么验的**、**影响谁**
- 界面/行为变化带截图或命令行输出
- 一条 PR 一件事

## 评审与合并

评审看三样，按顺序：**有没有破坏不变量**、**有没有测试**、**后来的人能不能看懂**。

- 两个工作日内会有人看
- 需要改动时会说清是哪条底线
- 合并到 `main`，小步快跑，不发版也可以合

## 装进 DSH

改完插件本身要装一次才算验证：

```bash
# 1. bump 版本（同名 tgz 会被 pnpm 复用缓存，不 bump 装到旧的）
# 2. 打包
bash deploy/pack.sh
# 3. 装
cd ~/.dsh/profiles/desktop && pnpm install --no-frozen-lockfile --prefer-offline
# 4. 重启 DSH，然后打开界面看一眼设置分区是否在
```

细节与坑见 [AGENTS.md](AGENTS.md#踩过的坑别重踩)。

## 许可

贡献即同意以 [MIT](LICENSE) 发布。
