<#
.SYNOPSIS
  一键构建 Oris release，更新 src-tauri\target\release 中的产物。

.PARAMETER Bundle
  同时生成安装包（src-tauri\target\release\bundle）。默认只构建 oris.exe（--no-bundle）。

.PARAMETER Bundles
  与 -Bundle 一起使用：只生成指定格式（例如 nsis；逗号分隔）。默认按 tauri.conf.json 的 targets。

.PARAMETER Test
  构建前先运行 npm test。

.PARAMETER OutputRoot
  将前端和 Rust 产物输出到指定独立目录，使用相对 frontendDist 嵌入资源。

.EXAMPLE
  npm run package
  npm run package -- -Bundle -Test
  npm run package -- -OutputRoot D:\Projects\Research\Oris-builds\release-check
  npm run package -- -Bundle -Bundles nsis -OutputRoot D:\Projects\Research\Oris-builds\v1-06
#>
[CmdletBinding()]
param(
  [switch]$Bundle,
  [string]$Bundles,
  [switch]$Test,
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root 'src-tauri\target\release'
$savedTargetDir = $env:CARGO_TARGET_DIR
$savedConfig = $env:TAURI_CONFIG
$configPath = $null
if ($OutputRoot) {
  $output = [IO.Path]::GetFullPath($OutputRoot)
  $frontendDir = Join-Path $output 'dist'
  $tauriRootUri = [Uri]((Join-Path $root 'src-tauri') + [IO.Path]::DirectorySeparatorChar)
  $relativeUri = $tauriRootUri.MakeRelativeUri([Uri]($frontendDir + [IO.Path]::DirectorySeparatorChar))
  if ($relativeUri.IsAbsoluteUri) { throw '独立输出必须与项目位于同一磁盘，以便 frontendDist 使用相对目录。' }
  $relativeDist = [Uri]::UnescapeDataString($relativeUri.ToString()).TrimEnd('/')
  if ($relativeDist -match '^[a-zA-Z][a-zA-Z0-9+.-]*:') { throw 'frontendDist 不能是 URL 或带盘符的路径。' }
  New-Item -ItemType Directory -Force -Path $output | Out-Null
  $configPath = Join-Path $output 'build-config.json'
  $configObject = @{ build = @{
    # Build through structured arguments below, not a nested shell command.
    beforeBuildCommand = $null
    frontendDist = $relativeDist
  } }
  if ($Bundle) {
    # 安装包附带第三方许可证全文（本机 cargo metadata / package-lock.json 汇总，不联网）。
    $noticesPath = Join-Path $output 'THIRD-PARTY-NOTICES.txt'
    Push-Location $root
    try { node scripts/release/third-party-licenses.mjs --md (Join-Path $output 'third-party-licenses.md') --notices $noticesPath } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "生成第三方许可证清单失败（exit $LASTEXITCODE）" }
    $configObject.bundle = @{ resources = @{ $noticesPath = 'THIRD-PARTY-NOTICES.txt' } }
  }
  $config = $configObject | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($configPath, $config, (New-Object Text.UTF8Encoding($false)))
  $env:CARGO_TARGET_DIR = Join-Path $output 'target'
  $releaseDir = Join-Path $env:CARGO_TARGET_DIR 'release'
} elseif ($env:CARGO_TARGET_DIR) {
  $releaseDir = Join-Path ([IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)) 'release'
}
$exePath = Join-Path $releaseDir 'oris.exe'

function Invoke-Step([string]$title, [scriptblock]$action) {
  Write-Host "==> $title" -ForegroundColor Cyan
  & $action
  if ($LASTEXITCODE -ne 0) { throw "$title 失败（exit $LASTEXITCODE）" }
}

Push-Location $root
try {
  # GNU 工具链需要 mingw binutils（dlltool 等）；仅对本进程补 PATH，不改系统环境。
  $mingwBin = 'D:\Tools\Rust\mingw-binutils\mingw64\bin'
  if (-not (Get-Command dlltool -ErrorAction SilentlyContinue) -and (Test-Path $mingwBin)) {
    $env:PATH = "$mingwBin;$env:PATH"
  }
  # windres 编译 Windows 资源（图标/manifest）时需要 gcc 做预处理；追加到 PATH 末尾，不覆盖已有工具。
  $msysMingwBin = 'D:\Tools\Rust\msys2\msys64\mingw64\bin'
  if (-not (Get-Command gcc -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $msysMingwBin 'gcc.exe'))) {
    $env:PATH = "$env:PATH;$msysMingwBin"
  }

  # 仅检查运行路径正是目标 exe 的实例；不结束任何进程，由用户自行关闭。
  $running = Get-Process -Name oris -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($exePath)) }
  if ($running) {
    throw "目标 exe 正在运行（PID $($running.Id -join ', ')），请先关闭 Oris 再打包：$exePath"
  }

  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Invoke-Step '安装依赖 (npm ci)' { npm ci }
  }

  if ($Test) {
    Invoke-Step '运行测试 (npm test)' { npm test }
  }

  if ($configPath) {
    Invoke-Step '检查 TypeScript' { npx tsc -b }
    Invoke-Step '构建独立前端目录' { node node_modules/vite/bin/vite.js build --outDir $frontendDir }
  }

  $buildArgs = @('run', 'tauri', '--', 'build', '--features', 'tauri/custom-protocol')
  if ($configPath) { $buildArgs += @('--config', $configPath) }
  if (-not $Bundle) { $buildArgs += '--no-bundle' }
  elseif ($Bundles) { $buildArgs += @('--bundles', $Bundles) }
  $started = Get-Date
  Invoke-Step "构建 release (npm $($buildArgs -join ' '))" { npm @buildArgs }
  # Execute the same compiled context used by oris.exe; this creates no window.
  if ($configPath) { $env:TAURI_CONFIG = [IO.File]::ReadAllText($configPath) }
  # GNU Tauri puts the matching WebView2Loader.dll beside the app, not examples.
  $env:PATH = "$releaseDir;$env:PATH"
  Invoke-Step '验证嵌入入口、index.html 和 JS/CSS/Worker 资源（无 GUI）' {
    cargo run --manifest-path src-tauri/Cargo.toml --release --example verify_release_entry --features tauri/custom-protocol
  }

  $elapsed = (Get-Date) - $started

  $exe = Get-Item $exePath
  $hash = (Get-FileHash $exePath -Algorithm SHA256).Hash
  Write-Host ''
  Write-Host '打包完成' -ForegroundColor Green
  Write-Host ("  耗时    : {0:N1} s" -f $elapsed.TotalSeconds)
  Write-Host "  exe     : $($exe.FullName)"
  Write-Host ("  大小    : {0:N1} MiB" -f ($exe.Length / 1MB))
  Write-Host "  修改时间: $($exe.LastWriteTime)"
  Write-Host "  SHA-256 : $hash"
  if ($Bundle) {
    $bundleDir = Join-Path $releaseDir 'bundle'
    if (Test-Path $bundleDir) {
      Write-Host '  安装包  :'
      Get-ChildItem $bundleDir -Recurse -File -Include *.msi, *.exe, *.dmg |
        ForEach-Object { Write-Host "    $($_.FullName)"; Write-Host "      SHA-256 : $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
    }
  }
}
finally {
  $env:CARGO_TARGET_DIR = $savedTargetDir
  $env:TAURI_CONFIG = $savedConfig
  Pop-Location
}
