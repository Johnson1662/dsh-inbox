# AGENTS.md

给**在这个仓库里写代码的 agent** 看的。人看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 这是什么

个人 agent 的感知层：外部世界的事件 → 统一信封 → 常驻队列 → 某个 agent 的某个会话。

三段，各自可替换：

```
来源（一路一个包，独立进程）  →  中枢（SQLite 唯一写者）  →  接收端（一个 adapter）
```

## 地图

| 路径 | 职责 | 什么时候动它 |
|---|---|---|
| `packages/core/src/core/` | 信封校验、队列、渲染。纯函数为主 | 改语义、改数据形状 |
| `packages/core/src/daemon/` | 常驻进程：HTTP、看护来源子进程、投递循环 | 改生命周期、改 HTTP 接口 |
| `packages/core/src/plugin/` | 接收端（DSH）：`take/done/retry` 的参考实现 + 设置面板 | 改投递行为、改界面 |
| `packages/core/src/cli/` | `init / status / sources / log` | 加命令 |
| `packages/sources/*/` | 各路来源：`package.json` 声明 + `index.js` 宿主半端 + worker（telegram / feishu / wx） | 加来源、改采集 |
| `cordis.patch.yml` | 壳包：把三个组件插进 DSH 组合 | 加/删组件 |
| `deploy/pack.sh` | 打 tgz，壳包依赖指向本地 tgz | 加新包 |

## 坏不得的东西

改任何一处之前先确认这五条还成立。它们不是建议，是产品的全部价值：

1. **零丢失** —— 事件只有「待投 / 已投」。不许加过期、截断、静默丢弃、`stale` 状态。
2. **幂等** —— 同一个 `id` 只入一行。给来源加字段时不能改变 `id` 的推导。
3. **至少一次** —— 投成功才 `done`；失败 `retry`；租约到期自动收回。
4. **单写者** —— 只有中枢写数据库。接收端走 HTTP，不许 import 队列模块。
5. **来源不认识收件人** —— 来源只输出信封，不读路由、不 import 中枢。

第 5 条有物理保证：来源进程只拿环境变量 + 标准输出。**引入一条 `import` 就破了它。**

## 常见任务

### 加一路来源

1. `packages/sources/<name>/` 下建 `package.json`：
   ```json
   { "name": "dsh-personal-context-source-<name>",
     "files": ["worker.py", "index.js", "package.json"],
     "dsh": { "source": { "name": "<name>", "label": "…", "runtime": "python|node",
       "entry": "worker.py", "fields": [{ "key": "enabled", "type": "boolean", "default": false }] } } }
   ```
2. `index.js`（宿主半端，什么都不采集，只登记）：
   ```js
   export const name = 'dsh-personal-context-source-<name>'
   export function apply(ctx) {
     ctx.get('personalContext')?.registerSource({ name: '<name>', label: '…', runtime: 'python', entry: 'worker.py' })
   }
   ```
3. worker 守三条：配置从 `PERSONAL_CONTEXT_SOURCE_*` 读；**标准输出只写信封，一行一个 JSON**，日志走标准错误；收到 SIGTERM 干净退出。
4. 登记到这四处：根 `package.json` 的 `file:` 依赖、`cordis.patch.yml` 一行、`deploy/pack.sh` 的循环、`README.md` 的目录树。
5. 测试放 `packages/sources/<name>/test/`，至少覆盖：配置缺失时报错、正常轮询产出信封、幂等键稳定。

**验收**：`npm test` 绿 + 不装这个包时其他来源照跑 + 打开 DSH 设置面板能看到它的字段。

### 加一个接收端

只准用三个 HTTP 动作，不许读库。参考 `packages/core/src/plugin/api-client.js` 与其测试。

### 改配置项

三层优先级：环境变量 > `config.json`（设置界面写）/ `cordis.patch.yml` > 代码默认值。**代码里不许出现魔法数字**，默认值写在 `core/config.js`。

来源自己的字段走 `dsh.source.fields`，会被自动渲染成控件——不要为单个来源写面板代码。

### 改数据结构

`queue.js` 建表用 `CREATE TABLE IF NOT EXISTS`，加列走 `PRAGMA table_info` 检查后 `ALTER TABLE`。破坏性变更不行——数据是长期资产。改契约或数据库形状要写 ADR（`docs/adr/`，编号递增，中文名）。

## 写代码的约定

- **ESM、零运行时依赖**。用 `node:` 内置：`node:sqlite`、`node:http`、`node:crypto`。加依赖要说服人。
- **纯函数优先**。信封校验、渲染、批次切分都不该碰 IO——它们现在是测试最密的地方。
- **错误要具体**。`invalid_at` 比 `bad request` 有用；启动失败要点名缺哪个环境变量。
- **中文注释解释「为什么」**，不复述代码。
- 不格式化全文件。改动只落在相关行，避免 diff 噪音。
- **动了对外形状就更新 `test/contract.test.js`** —— 信封字段、`take / done / retry` 的返回、错误码，都由它逐字钉住。红了说明你在改契约：先写 ADR，再改测试和文档。

## 验证（必须真跑，不许声称）

```bash
npm run check     # JS 与 Python 语法全量 + 全部用例
npm test          # 只要测试
```

动到投递或界面时，额外手动验一遍：`node packages/core/bin/personal-context.mjs status` 看队列守恒，真发一条消息看它进会话。

动到打包/安装时看 [CONTRIBUTING.md](CONTRIBUTING.md#装进-dsh)。

## 代码索引（codegraph）

仓库已建索引，`.codegraph/` 本地生成、不入库。查符号、看调用链比 rg 快：

```bash
codegraph explore "投递循环"      # 相关符号源码 + 调用路径
codegraph query createDeliveryLoop
codegraph sync                    # 改了代码增量更新，不用重建
```

新 clone 下来第一次：`codegraph init`。

## 可选：坏味道扫描

```bash
npm run rot     # 配置在 .fuckucoderc.json（已排除测试与文档）
```

跑的是**我们自己的 fork**：[Johnson1662/fuck-u-code](https://github.com/Johnson1662/fuck-u-code) tag `v2.2.2-fork.1`。上游自 2026-09-07 起没再动过（修复提过 [PR #165](https://github.com/Done-0/fuck-u-code/pull/165)，已关），而它的 2.2.2 在 npm / npx 下是坏的：wasm 路径写死成包内 `node_modules`（那是 pnpm 的布局），npm 会提升依赖 → 语法解析全部 ENOENT → **静默退化成正则**，嵌套函数的结束位置被算到外层作用域末尾（`record()` 报 250 行、实际 20 行）。

fork 里改了两处：

1. 先用模块解析器找 wasm，找不到再回落到嵌套路径（兼容 pnpm）
2. **降级不再静默**：语法加载失败会立刻告警，并在报告末尾列出受影响的语言

判断结果可不可信：**加 `-v` 看有没有 `falling back to regex parser`**。有就是数字全错。

看趋势，不看单条；真要看某个函数，自己数行数。

## 踩过的坑（别重踩）

1. **设置面板的路由不能挂 `/api/` 前缀** —— 那是 DSH Remote RPC 的地盘，GET 通、POST 被掐成 `Failed to fetch`。用 `/personal-context/*`。
2. **客户端 bundle 必须整文件包 IIFE** —— 多个插件的 client 拼在同一作用域，顶层 `const` 撞名直接 `SyntaxError`，而且宿主不报错、面板一行都不注册。
3. **`loader.load({ id })` 必须等于包名**，否则 `duplicate factory registration`。
4. **中文标题不能拿来推配置 key** —— `'飞书'.toLowerCase()` 还是 `'飞书'`，字段必须显式带 `source`。
5. **装包前先 bump 版本** —— 同名 tgz 会被 pnpm 复用缓存，改了代码装到旧的。
6. **不要让 profile 跑裸 `pnpm install`** —— frozen 模式可能先清空 `node_modules` 再报错。用 `--no-frozen-lockfile --prefer-offline`。
7. **目标会话的 id 会变** —— 路由存 `botId`，别存 `sessionId`（DSH 重启后 `sessionId` 会变）。

## 规格与进度

特性和规格写成 markdown 放在 `.scratch/<feature>/spec.md`，实现票放 `.scratch/<feature>/issues/NN-*.md`（约定见 `docs/agents/issue-tracker.md`）。`.scratch/` 不入版本库——开源协作请用 GitHub issue，把结论沉淀进 `docs/`。

## 文档义务

改行为就改文档，一处都不能少：

| 改了 | 顺带改 |
|---|---|
| 信封字段 | `README.md` 契约、`GLOSSARY.md`、`docs/design.md` |
| 不变量 / 架构取舍 | 新写一条 `docs/adr/` |
| 环境变量 / 命令 | `docs/operations.md` |
| 目录结构 | `README.md` 目录树、本文件的「地图」 |

**README 只留精华**：定位、时效性、可扩展性、三条保证、怎么装。细节进 `docs/`。
