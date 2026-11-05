#!/bin/sh
# 在 10.0.0.88 上运行：把 $DIR/webroot.tgz 与 $DIR/scripts.tgz 覆盖到 AVD 已安装模块（测试辅助，不随模块打包）。
ADB="/Volumes/data/CodexToolchains/pill-android/sdk/platform-tools/adb -s emulator-5580"
DIR=/Volumes/data/HyperOS-AVD/tmp/mihomo-test
M=/data/adb/modules/mihomo-ebpf
for part in webroot scripts; do
  [ -f "$DIR/$part.tgz" ] || continue
  $ADB push "$DIR/$part.tgz" "/data/local/tmp/$part.tgz" >/dev/null
  $ADB shell su -c "rm -rf $M/$part.new"
  $ADB shell su -c "mkdir -p $M/$part.new"
  $ADB shell su -c "tar -xzf /data/local/tmp/$part.tgz -C $M/$part.new"
  $ADB shell su -c "rm -rf $M/$part.old"
  $ADB shell su -c "mv $M/$part $M/$part.old"
  $ADB shell su -c "mv $M/$part.new $M/$part"
  $ADB shell su -c "rm -rf $M/$part.old /data/local/tmp/$part.tgz"
  echo "deployed $part"
done
$ADB shell su -c "chmod 755 $M/scripts/*.sh"
