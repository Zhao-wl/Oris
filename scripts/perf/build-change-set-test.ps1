param([Parameter(Mandatory = $true)][string]$OutputDirectory, [string]$SourceCommit = 'HEAD')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$destination = [IO.Path]::GetFullPath($OutputDirectory)
$artifacts = Join-Path $root 'artifacts'
if (-not $destination.StartsWith($artifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '性能测试包必须写入当前仓库的 artifacts 子目录。'
}
if (Test-Path -LiteralPath $destination) { throw '请为本轮测试指定新目录。' }

function Invoke-Checked([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败（退出码 $LASTEXITCODE）" }
}

$savedConfig = $env:TAURI_CONFIG
$savedTarget = $env:CARGO_TARGET_DIR
$savedBuildDir = $env:CARGO_BUILD_BUILD_DIR
Push-Location $root
try {
    $source = Invoke-Checked { git rev-parse --verify --end-of-options "${SourceCommit}^{commit}" }
    New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
    $canonicalArtifacts = (Resolve-Path -LiteralPath $artifacts).Path
    if ($canonicalArtifacts -ne $artifacts -or ((Get-Item -LiteralPath $artifacts).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'artifacts 不得指向其他目录。'
    }
    if ((Split-Path -Parent $destination) -ne $artifacts) { throw '请使用 artifacts 的直接子目录。' }
    New-Item -ItemType Directory -Path $destination | Out-Null
    $archive = Join-Path $destination 'source.tar'
    $snapshot = Join-Path $destination 'source'
    New-Item -ItemType Directory -Path $snapshot | Out-Null
    Invoke-Checked { git archive --format=tar --output=$archive $source }
    Invoke-Checked { tar.exe -xf $archive -C $snapshot }
    Set-Location -LiteralPath $snapshot
    $config = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json -AsHashtable
    $window = $config.app.windows[0]
    $window.focus = $false
    $window.focusable = $false
    $overlay = @{ identifier = 'com.oris.viewer.perf'; app = @{ windows = @($window) };
      plugins = @{ updater = @{ endpoints = @() } } }
    $env:TAURI_CONFIG = $overlay | ConvertTo-Json -Depth 10 -Compress
    $env:CARGO_TARGET_DIR = Join-Path $destination 'target'
    $env:CARGO_BUILD_BUILD_DIR = Join-Path $root 'src-tauri/target'
    Invoke-Checked { node (Join-Path $root 'node_modules/typescript/bin/tsc') -b }
    Invoke-Checked { node (Join-Path $root 'node_modules/vite/bin/vite.js') build }
    Invoke-Checked { cargo +stable-x86_64-pc-windows-msvc build --locked --release --jobs 4 --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol }

    $exe = Join-Path $destination 'oris.exe'
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/oris.exe') -Destination $exe
    $manifest = @{ format = 'oris-change-set-test-v1'; source = $source; version = $config.version;
      identifier = $overlay.identifier; focus = $window.focus; focusable = $window.focusable;
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'test-build.json') -Encoding utf8
    Write-Output (Join-Path $destination 'test-build.json')
} finally {
    $env:TAURI_CONFIG = $savedConfig
    $env:CARGO_TARGET_DIR = $savedTarget
    $env:CARGO_BUILD_BUILD_DIR = $savedBuildDir
    Pop-Location
}
