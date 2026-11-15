#!/usr/bin/env bash
# 打本地安装包：core + 两路来源各打一个 tgz，再把壳包指向这些 tgz。
# 发布到 npm 时这一步不需要——依赖直接写版本号；本地开发用它模拟同样的结果。
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
pkgs="$HOME/.dsh/local-pkgs"
mkdir -p "$pkgs"

pack_one() {
  local dir="$1" name version
  name=$(jq -r .name "$dir/package.json")
  version=$(jq -r .version "$dir/package.json")
  ( cd "$dir" && npm pack --silent >/dev/null )
  local tgz
  tgz=$(ls -t "$dir"/*.tgz | head -1)
  cp "$tgz" "$pkgs/$(basename "$tgz")"
  rm -f "$tgz"
  echo "  $name@$version → $pkgs/$(basename "$tgz")"
}

echo "打包组件："
for dir in packages/core packages/sources/telegram packages/sources/feishu; do
  pack_one "$root/$dir"
done

echo "打包壳包："
tmp=$(mktemp -d)
cp "$root/cordis.patch.yml" "$tmp/"
jq --arg pkgs "$pkgs" '
  .dependencies = {
    "dsh-personal-context-core": ("file:" + $pkgs + "/dsh-personal-context-core-" + .version + ".tgz"),
    "dsh-personal-context-source-telegram": ("file:" + $pkgs + "/dsh-personal-context-source-telegram-" + .version + ".tgz"),
    "dsh-personal-context-source-feishu": ("file:" + $pkgs + "/dsh-personal-context-source-feishu-" + .version + ".tgz")
  }' "$root/package.json" > "$tmp/package.json"
( cd "$tmp" && npm pack --silent >/dev/null )
tgz=$(ls -t "$tmp"/*.tgz | head -1)
cp "$tgz" "$pkgs/$(basename "$tgz")"
rm -rf "$tmp"
echo "  dsh-personal-context → $pkgs/$(basename "$tgz")"
