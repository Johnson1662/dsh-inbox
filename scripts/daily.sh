#!/usr/bin/env bash
# 每天往 daily.log 追加一行快照：条数守恒 + 每来源 + 飞书状态。跑满一天后看这个文件就能回答票 6。
set -uo pipefail
state="${PC_STATE_DIR:-$HOME/.dsh/state/personal-context}"
token=$(cat "$state/token" 2>/dev/null || echo '')
stats=$(curl -s --max-time 5 "http://${PC_HTTP_LISTEN:-127.0.0.1:7788}/v1/stats" -H "Authorization: Bearer $token" || echo '{}')
feishu=$(jq -c . "$state/sources/feishu.status.json" 2>/dev/null || echo '{}')
check=$(node "$(dirname "$0")/check.mjs" 2>&1 | tail -1)
printf '%s stats=%s feishu=%s %s\n' "$(date -Iseconds)" "$stats" "$feishu" "$check" >> "$state/daily.log"
