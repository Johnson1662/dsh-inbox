#!/usr/bin/env bash
# 重启 DSH 桌面端：沿用当前进程的环境（DISPLAY/WAYLAND/DBUS），不做猜测。
set -euo pipefail
pid=$(pgrep -f '/opt/DeepSeek Harness/deepseek-harness$' | head -1)
[ -n "$pid" ] || { echo "找不到 DSH 主进程" >&2; exit 1; }
envdump=$(mktemp)
tr '\0' '\n' < "/proc/$pid/environ" > "$envdump"
app="/opt/DeepSeek Harness/deepseek-harness"
echo "停止 DSH (pid $pid)…"
kill -TERM "$pid"
for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" || true
sleep 1
echo "重新启动…"
setsid nohup env -i $(grep -E '^(DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|HOME|USER|PATH|LANG|SHELL|XDG_DATA_HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME)=' "$envdump" | sed 's/ /\\ /g' | tr '\n' ' ') \
  "$app" >/tmp/dsh-restart.log 2>&1 &
rm -f "$envdump"
sleep 3
pgrep -f '/opt/DeepSeek Harness/deepseek-harness$' >/dev/null && echo "DSH 已起来" || { echo "启动失败，看 /tmp/dsh-restart.log" >&2; exit 1; }
