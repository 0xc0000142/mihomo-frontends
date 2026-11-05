#Requires -Version 7.0
[CmdletBinding()]
param([switch]$SkipWebUiBuild)

$ErrorActionPreference = 'Stop'
$moduleRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $moduleRoot '..'))
$webUiRoot = Join-Path $moduleRoot 'webui'
$webDist = Join-Path $webUiRoot 'build/dist/wasmJs/productionExecutable'
$dist = Join-Path $repoRoot 'dist'

function Get-PackageFiles([string]$Root) {
    $directory = Get-Item -LiteralPath $Root -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "打包源必须是普通目录：$Root"
    }
    $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force)
    if ($items | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }) {
        throw "打包源不能包含符号链接或联接点：$Root"
    }
    $items | Where-Object { -not $_.PSIsContainer }
}

function Assert-DistFile([string]$Path) {
    $absolute = [System.IO.Path]::GetFullPath($Path)
    $comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    $prefix = $dist + [System.IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, $comparison) -or
        -not [System.IO.Path]::GetDirectoryName($absolute).Equals($dist, $comparison)) {
        throw "拒绝操作根 dist 之外的文件：$absolute"
    }
    $directory = Get-Item -LiteralPath $dist -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "dist 必须是普通目录：$dist"
    }
    if (Test-Path -LiteralPath $absolute) {
        $item = Get-Item -LiteralPath $absolute -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "拒绝覆盖或删除目录、符号链接或联接点：$absolute"
        }
    }
}

function Add-PackageFile($Archive, [System.IO.FileInfo]$File, [string]$EntryName, [bool]$NormalizeText) {
    $entry = $Archive.CreateEntry($EntryName)
    $target = $entry.Open()
    try {
        if ($NormalizeText) {
            $writer = [System.IO.StreamWriter]::new($target, [System.Text.UTF8Encoding]::new($false))
            try { $writer.Write([System.IO.File]::ReadAllText($File.FullName).Replace("`r`n", "`n")) }
            finally { $writer.Dispose() }
        } else {
            $source = [System.IO.File]::OpenRead($File.FullName)
            try { $source.CopyTo($target) }
            finally { $source.Dispose() }
        }
    } finally { $target.Dispose() }
}

$properties = @{}
Get-Content -LiteralPath (Join-Path $moduleRoot 'module.prop') | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { $properties[$Matches[1]] = $Matches[2] }
}
foreach ($name in @('id', 'version')) {
    if ($properties[$name] -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._+-]*\z') {
        throw "module.prop 的 $name 缺失或不适合用作文件名"
    }
}

if (-not $SkipWebUiBuild) {
    Push-Location -LiteralPath $webUiRoot
    try {
        if ($IsWindows) {
            & (Join-Path $webUiRoot 'gradlew.bat') --no-daemon wasmJsBrowserDistribution
        } else {
            & sh ./gradlew --no-daemon wasmJsBrowserDistribution
        }
        if ($LASTEXITCODE -ne 0) { throw "WebUI Gradle 构建失败，退出码：$LASTEXITCODE" }
    } finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath $webDist -PathType Container)) {
    throw "缺少 WebUI 产物：$webDist；请先构建 wasmJsBrowserDistribution"
}
$webFiles = @(Get-PackageFiles $webDist)
foreach ($name in @('index.html', 'mihomo.js', 'bootstrap.js', 'backend.js', 'config.js', 'vendor/yaml.min.js', 'vendor/YAML-LICENSE.txt', 'vendor/qrcode.js', 'vendor/QRCODE-LICENSE.txt', 'template.yaml', 'FONT-LICENSE.txt')) {
    $required = Get-Item -LiteralPath (Join-Path $webDist $name) -Force
    if ($required.PSIsContainer -or $required.Length -eq 0) { throw "WebUI 产物缺失或为空：$name" }
}
$wasmFiles = @($webFiles | Where-Object { $_.Extension -eq '.wasm' })
$fonts = @($webFiles | Where-Object { $_.Name -eq 'noto_sans_sc.otf' -and $_.Length -gt 0 })
if ($fonts.Count -eq 0) { throw 'WebUI 产物缺少离线中文字体；拒绝打包' }
if ($wasmFiles.Count -eq 0 -or (@($wasmFiles | Where-Object { $_.Length -eq 0 }).Count -gt 0)) {
    throw 'WebUI 产物缺少非空 wasm；拒绝打包旧 webroot'
}

$moduleFiles = @('module.prop', 'customize.sh', 'service.sh', 'post-fs-data.sh') |
    ForEach-Object { Get-Item -LiteralPath (Join-Path $moduleRoot $_) -Force }
$moduleFiles += @(Get-PackageFiles (Join-Path $moduleRoot 'scripts'))
foreach ($file in $moduleFiles) {
    if ($file.PSIsContainer -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "模块文件必须是普通文件：$($file.FullName)"
    }
}

if (-not (Test-Path -LiteralPath $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
$output = Join-Path $dist "$($properties.id)-magisk-$($properties.version).zip"
$temporaryOutput = Join-Path $dist ('.magisk-' + [guid]::NewGuid().ToString('N') + '.zip')
Assert-DistFile $output
Assert-DistFile $temporaryOutput
try {
    $archive = [System.IO.Compression.ZipFile]::Open($temporaryOutput, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $moduleFiles) {
            $relative = [System.IO.Path]::GetRelativePath($moduleRoot, $file.FullName).Replace('\', '/')
            $normalize = $relative -eq 'module.prop' -or $file.Extension -in @('.sh', '.awk')
            Add-PackageFile $archive $file $relative $normalize
        }
        foreach ($file in $webFiles) {
            $relative = [System.IO.Path]::GetRelativePath($webDist, $file.FullName).Replace('\', '/')
            Add-PackageFile $archive $file "webroot/$relative" $false
        }
    } finally { $archive.Dispose() }
    Assert-DistFile $temporaryOutput
    Assert-DistFile $output
    Move-Item -LiteralPath $temporaryOutput -Destination $output -Force
} finally {
    if (Test-Path -LiteralPath $temporaryOutput) {
        Assert-DistFile $temporaryOutput
        Remove-Item -LiteralPath $temporaryOutput -Force
    }
}
Write-Output "已生成 $output"
