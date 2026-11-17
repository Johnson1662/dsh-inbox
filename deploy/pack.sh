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
for dir in packages/core packages/sources/telegram packages/sources/feishu packages/sources/wx packages/sources/github; do
  pack_one "$root/$dir"
done

echo "打包壳包："
tmp=$(mktemp -d)
cp "$root/cordis.patch.yml" "$tmp/"
jq --arg pkgs "$pkgs" '
  .dependencies = {
    "dsh-inbox-core": ("file:" + $pkgs + "/dsh-inbox-core-" + .version + ".tgz"),
    "dsh-inbox-source-telegram": ("file:" + $pkgs + "/dsh-inbox-source-telegram-" + .version + ".tgz"),
    "dsh-inbox-source-feishu": ("file:" + $pkgs + "/dsh-inbox-source-feishu-" + .version + ".tgz"),
    "dsh-inbox-source-wx": ("file:" + $pkgs + "/dsh-inbox-source-wx-" + .version + ".tgz"),
    "dsh-inbox-source-github": ("file:" + $pkgs + "/dsh-inbox-source-github-" + .version + ".tgz")
  }' "$root/package.json" > "$tmp/package.json"
( cd "$tmp" && npm pack --silent >/dev/null )
tgz=$(ls -t "$tmp"/*.tgz | head -1)
cp "$tgz" "$pkgs/$(basename "$tgz")"
rm -rf "$tmp"
echo "  $(jq -r .name "$root/package.json") → $pkgs/$(basename "$tgz")"
