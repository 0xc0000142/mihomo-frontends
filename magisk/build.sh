#!/bin/sh
# 打包 Magisk/KernelSU 模块 zip：sh magisk/build.sh
set -e

cd "$(dirname "$0")"

# 模板与 shared/ 保持一致
cp -f ../shared/template.yaml webroot/template.yaml

version=$(sed -n 's/^version=//p' module.prop | tr -d '\r')
id=$(sed -n 's/^id=//p' module.prop | tr -d '\r')
out="../dist/${id}-magisk-${version}.zip"

mkdir -p ../dist
rm -f "$out"

files="module.prop customize.sh service.sh post-fs-data.sh scripts webroot"

if command -v zip >/dev/null 2>&1; then
  zip -r -X "$out" $files >/dev/null
else
  echo "缺少 zip 命令，请手动打包：$files" >&2
  exit 1
fi

echo "已生成 $out"
