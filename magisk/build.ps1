# 在 Windows 上没有 zip 时用 PowerShell 打包：pwsh magisk/build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Copy-Item ../shared/template.yaml webroot/template.yaml -Force
$prop = Get-Content module.prop | Where-Object { $_ -match '^(id|version)=' } | ForEach-Object { $k, $v = $_ -split '=', 2; @{ $k = $v } }
$id = ($prop | Where-Object { $_.id }).id
$version = ($prop | Where-Object { $_.version }).version
$out = "../dist/$id-magisk-$version.zip"
New-Item -ItemType Directory -Force ../dist | Out-Null
if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path module.prop, customize.sh, service.sh, post-fs-data.sh, scripts, webroot -DestinationPath $out
Write-Output "已生成 $out"
