#!/usr/bin/env bash
# 重启 DSH 桌面端。
# 从常驻 systemd 定时器里跑（systemd-run --user --on-active=…），
# 这样脚本不挂在被杀的进程树里；环境变量从调用时的 shell 继承（DISPLAY/DBUS/XDG 都在）。
set -euo pipefail
app="/opt/DeepSeek Harness/deepseek-harness"
pid=$(pgrep -f '/opt/DeepSeek Harness/deepseek-harness$' | head -1 || true)
if [ -n "$pid" ]; then
  echo "停止 DSH (pid $pid)…"
  kill -TERM "$pid"
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" || true
fi
# 端口没释放就启动会 EADDRINUSE，整棵树启动失败（踩过一次）
for _ in $(seq 1 40); do
  ss -ltn 2>/dev/null | grep -q ':3080 ' || break
  sleep 0.25
done
sleep 1
echo "重新启动…"
# 原样继承调用者的环境：GPU/ibus 这些坑都是环境不全造成的，别自作聪明裁剪
export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
setsid nohup "$app" >/tmp/dsh-restart.log 2>&1 < /dev/null &
# 起来还不够：要等到 3080 真的能应答，否则插件还挂着
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:3080/"; then
    echo "DSH 已起来（3080 已应答）"
    exit 0
  fi
  sleep 1
done
echo "启动失败，看 /tmp/dsh-restart.log" >&2
exit 1
