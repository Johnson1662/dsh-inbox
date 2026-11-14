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
sleep 1
echo "重新启动…"
setsid nohup env DISPLAY="${DISPLAY:-:0}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  "$app" >/tmp/dsh-restart.log 2>&1 < /dev/null &
sleep 5
pgrep -f '/opt/DeepSeek Harness/deepseek-harness$' >/dev/null \
  && echo "DSH 已起来" \
  || { echo "启动失败，看 /tmp/dsh-restart.log" >&2; exit 1; }
