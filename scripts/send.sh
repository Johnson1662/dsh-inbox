#!/usr/bin/env bash
# 手工交一条事件：scripts/send.sh "正文" [来源] [actor]
set -euo pipefail
state="${PC_STATE_DIR:-$HOME/.dsh/state/personal-context}"
token="${PC_HTTP_TOKEN:-$(cat "$state/token")}"
listen="${PC_HTTP_LISTEN:-127.0.0.1:7788}"
text="${1:?用法: send.sh <正文> [来源] [actor]}"
source="${2:-manual}"
actor="${3:-other}"
at=$(date -Iseconds)
body=$(jq -nc --arg s "$source" --arg t "$text" --arg a "$actor" --arg at "$at" \
  '{source:$s, at:$at, actor:$a, text:$t, meta:{chat:"手工"}}')
curl -sS -X POST "http://$listen/v1/event" \
  -H "Authorization: Bearer $token" -H 'content-type: application/json' -d "$body"
echo
