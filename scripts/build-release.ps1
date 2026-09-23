<#
.SYNOPSIS
  一键构建 Oris release，更新 src-tauri\target\release 中的产物。

.PARAMETER Bundle
  同时生成安装包（src-tauri\target\release\bundle）。默认只构建 oris.exe（--no-bundle）。

.PARAMETER Test
  构建前先运行 npm test。

.EXAMPLE
  npm run package
  npm run package -- -Bundle -Test
#>
[CmdletBinding()]
param(
  [switch]$Bundle,
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root 'src-tauri\target\release'
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

  $buildArgs = @('run', 'tauri', '--', 'build')
  if (-not $Bundle) { $buildArgs += '--no-bundle' }
  $started = Get-Date
  Invoke-Step "构建 release (npm $($buildArgs -join ' '))" { npm @buildArgs }
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
      Get-ChildItem $bundleDir -Recurse -File -Include *.msi, *.exe |
        ForEach-Object { Write-Host "    $($_.FullName)" }
    }
  }
}
finally {
  Pop-Location
}
