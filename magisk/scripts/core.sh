#!/system/bin/sh
# 内核下载 / 信息 / 更新 / 回滚。releases 资产命名兼容 liuran001/mihomo：mihomo-linux-arm64-vX.Y.Z(.gz)。
. "${0%/*}/common.sh"

abi_asset() {
  case "$(uname -m)" in
    aarch64|arm64) echo "linux-arm64" ;;
    x86_64)        echo "linux-amd64" ;;
    *)             return 1 ;;
  esac
}

latest_json() {
  repo=$(core_repo); tag=$(core_tag); mirror=$(core_mirror)
  if [ -n "$tag" ]; then
    url="https://api.github.com/repos/$repo/releases/tags/$tag"
  else
    url="https://api.github.com/repos/$repo/releases/latest"
  fi
  curl -fsSL -m 30 "${mirror}${url}" 2>/dev/null || curl -fsSL -m 30 "$url"
}

download() {
  # $1 force
  asset=$(abi_asset) || { echo '{"ok":false,"error":"不支持的架构"}'; return 1; }
  json=$(latest_json) || { echo '{"ok":false,"error":"获取 release 信息失败"}'; return 1; }
  tag=$(printf '%s' "$json" | sed -n 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/p' | head -n 1)
  # 找匹配资产（兼容 .gz 后缀与 smart 分支命名 mihomo-linux-arm64-smart-...）
  url=$(printf '%s' "$json" | grep -o '"browser_download_url"[^,]*' | grep "$asset" | head -n 1 | sed 's/.*"\(http[^"]*\)".*/\1/')
  if [ -z "$url" ]; then
    printf '{"ok":false,"error":"release %s 中没有 %s 架构的内核"}\n' "$tag" "$asset"
    return 1
  fi
  mirror=$(core_mirror)
  dl="$url"
  [ -n "$mirror" ] && dl="${mirror}${url}"
  tmp="$RUN_DIR/mihomo.new"
  ensure_dirs
  if ! curl -fSL -m 600 -o "$tmp" "$dl"; then
    if [ -n "$mirror" ]; then
      curl -fSL -m 600 -o "$tmp" "$url" || { echo '{"ok":false,"error":"下载失败"}'; return 1; }
    else
      echo '{"ok":false,"error":"下载失败"}'
      return 1
    fi
  fi
  case "$url" in
    *.gz)
      mv "$tmp" "$tmp.gz"
      gunzip -f "$tmp.gz" || { echo '{"ok":false,"error":"解压失败"}'; return 1; }
      ;;
  esac
  chmod 755 "$tmp"
  if ! "$tmp" -v >/dev/null 2>&1; then
    rm -f "$tmp"
    echo '{"ok":false,"error":"下载的文件无法在本机运行（架构不匹配？）"}'
    return 1
  fi
  [ -f "$BIN" ] && cp -f "$BIN" "$BIN_PREV"
  mv -f "$tmp" "$BIN"
  ver=$("$BIN" -v 2>/dev/null | head -n 1 | sed 's/.*Mihomo Meta \([^ ]*\).*/\1/')
  printf '{"ok":true,"version":"%s","tag":"%s"}\n' "$(json_escape "$ver")" "$(json_escape "$tag")"
}

info() {
  if [ -x "$BIN" ]; then
    ver=$("$BIN" -v 2>/dev/null | head -n 1)
    prev=""
    [ -f "$BIN_PREV" ] && prev="yes"
    printf '{"ok":true,"installed":true,"version":"%s","can_rollback":"%s"}\n' \
      "$(json_escape "$ver")" "$prev"
  else
    printf '{"ok":true,"installed":false}\n'
  fi
}

rollback() {
  if [ -f "$BIN_PREV" ]; then
    cp -f "$BIN" "$BIN_PREV.tmp" 2>/dev/null
    mv -f "$BIN_PREV" "$BIN"
    mv -f "$BIN_PREV.tmp" "$BIN_PREV" 2>/dev/null
    chmod 755 "$BIN"
    echo '{"ok":true}'
  else
    echo '{"ok":false,"error":"没有可回滚的旧版本"}'
  fi
}

case "$1" in
  download) download ;;
  info)     info ;;
  rollback) rollback ;;
  settings)
    # $2 repo $3 tag $4 mirror（空字符串用 - 占位传入）
    [ "$2" != "-" ] && setting_set core_repo "$2"
    [ "$3" != "-" ] && setting_set core_tag "$3"
    [ "$4" != "-" ] && setting_set core_mirror "$4"
    echo '{"ok":true}'
    ;;
  get_settings)
    printf '{"ok":true,"repo":"%s","tag":"%s","mirror":"%s"}\n' \
      "$(json_escape "$(core_repo)")" "$(json_escape "$(core_tag)")" "$(json_escape "$(core_mirror)")"
    ;;
  *) echo "用法: $0 {download|info|rollback|settings|get_settings}" >&2; exit 2 ;;
esac
