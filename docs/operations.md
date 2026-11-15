# 运维手册

首页只放定位与契约，具体操作都在这一页。

## 目录

- [凭据怎么拿](#凭据怎么拿)
- [配置](#配置)
- [命令](#命令)
- [排错](#排错)
- [目录结构](#目录结构)
- [参与](#参与)

---

## 凭据怎么拿

**Telegram**：到 [my.telegram.org](https://my.telegram.org) 创建应用，拿 `api_id` 与 `api_hash`；`session` 是 [Telethon](https://docs.telethon.dev) 的用户会话文件，首次需交互登录（`python3 -m pip install telethon` 后按提示输入手机号与验证码）。

**飞书**：安装 [lark-cli](https://www.npmjs.com/package/@larksuite/cli)（`npm i -g @larksuite/cli`），再执行 `lark-cli config init --as user` 完成一次登录。全程以你本人身份读消息，不依赖机器人事件订阅。

`init` 会依次问你凭据 → 写 `~/.dsh/state/personal-context/sources.env`（权限 0600）→ 安装开机自启（Linux 用 systemd 用户服务，macOS 用 launchd）→ 启动 → 打印状态。已有配置不会被覆盖。

脚本里非交互：

```bash
node packages/core/bin/personal-context.mjs init --yes \
  --telegram-api-id 123456 \
  --telegram-api-hash abcdef0123456789 \
  --telegram-session ~/.config/telegram/session
```

---

## 配置

分两层：**开关和节奏在设置界面改，凭据只放环境变量**。

### 设置界面

对应文件 `~/.dsh/state/personal-context/config.json`：投递间隔、单批条数与字数、积压阈值、每路来源的开关与轮询间隔、每路来源投给哪个会话。

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

## 目录结构

```
packages/core/                中枢：队列、投递、设置面板、命令行
packages/sources/telegram/    来源：Telegram
packages/sources/feishu/      来源：飞书
cordis.patch.yml              接收端：DSH 的组合补丁
deploy/                       打包脚本、systemd 单元、重启脚本
docs/                         设计说明、架构决策记录
```

---

## 参与

欢迎加来源、加接收端、修问题。有两条硬约定，破了整个架构就散了：

1. **来源进程不得依赖本项目或任何 agent 客户端** —— 只能读环境变量、往标准输出写信封。这条保证采集能在 agent 之外独立运行。
2. **队列只有一个写者** —— 接收端一律走 `take / done / retry`，不得直接访问数据库。

提交前请跑 `npm test`（143 个用例）。设计取舍记录在 [design.md](design.md) 与 [adr/](adr/)。
