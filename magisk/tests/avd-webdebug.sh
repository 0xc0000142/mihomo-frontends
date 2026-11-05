#!/system/bin/sh
# 测试辅助（以 root 在 AVD 内运行）：开/关 KernelSU Manager 的「WebView 调试」，便于用 CDP 检查模块 WebUI。
#   sh avd-webdebug.sh on|off
F=/data/data/me.weishu.kernelsu/shared_prefs/settings.xml
B=/data/local/tmp/ksu-settings.bak
am force-stop me.weishu.kernelsu
case "$1" in
  on)
    [ -f "$B" ] || cp "$F" "$B"
    grep -q enable_web_debugging "$F" || sed -i 's#</map>#    <boolean name="enable_web_debugging" value="true" />\n</map>#' "$F"
    ;;
  off)
    [ -f "$B" ] && cp "$B" "$F" && rm -f "$B"
    ;;
esac
grep -c enable_web_debugging "$F"
