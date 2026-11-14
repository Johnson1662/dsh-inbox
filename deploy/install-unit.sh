#!/usr/bin/env bash
# 装/更新 systemd 用户服务。Node 路径每次重探，避免写死版本目录。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node=$(readlink -f "$(command -v node)")
[ -x "$node" ] || { echo "找不到 node" >&2; exit 1; }
unit="$HOME/.config/systemd/user/personal-context-daemon.service"
mkdir -p "$(dirname "$unit")"
sed "s|@NODE@|$node|" "$here/personal-context-daemon.service" > "$unit"
systemctl --user daemon-reload
systemctl --user enable --now personal-context-daemon.service
sleep 1
systemctl --user --no-pager --lines=5 status personal-context-daemon.service || true
