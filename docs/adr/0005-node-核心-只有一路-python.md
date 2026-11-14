# 核心用 Node，来源里只有 Telegram 用 Python

队列、批次、渲染、信封校验、守护进程、DSH 插件全部用 Node。来源进程里，`telegram.py` 用 Python，`lark.js` 用 Node。

Telegram 必须 Python：本人账号只有 Telethon 这条路走得通，`tg_watch.py` 已经在生产跑了半年多，它的 `.session` 文件是 Telethon 的格式。换语言意味着用另一个 MTProto 客户端重新授权（手机验证码 + 两步验证），并且丢掉这段已跑通的代码。

飞书不需要 Python：它只是起一个 `lark-cli` 子进程、把 JSON 变成信封。用 Node 写，与守护进程同语言，测试工具链也只多一条。

代价：仓库里仍有两条工具链（`npm test` 与 telegram 的 Python 测试）。要彻底去掉 Python，唯一的路是把 Telegram 换成 Node 的 MTProto 客户端并重新授权——为省一条工具链，不值得。
