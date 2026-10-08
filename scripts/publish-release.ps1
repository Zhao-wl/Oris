<#
.SYNOPSIS
  发布 Oris 新版本到 GitHub Releases，供应用内自动更新使用。

.DESCRIPTION
  流程：升版本号（package.json / package-lock.json / Cargo.toml / tauri.conf.json）→ 签名构建 NSIS 安装包
  → 生成 latest.json → 提交版本号并打 tag → 推送 → gh release create 上传安装包、签名与 latest.json。
  应用读取 https://github.com/Zhao-wl/Oris/releases/latest/download/latest.json 判断是否有新版本。

.PARAMETER Version
  新版本号（x.y.z），必须大于当前版本。

.PARAMETER Notes
  更新说明，显示在应用的更新提示与 Release 页面。也可用 -NotesFile 指定文件。

.PARAMETER DryRun
  不改版本号、不提交、不上传：按当前版本签名构建并生成 latest.json，用于检查发版流程。

.PARAMETER InitSigningKey
  生成更新签名密钥对（带口令），并把公钥写入 src-tauri\tauri.conf.json。只需在首次发版前执行一次；
  之后更换密钥会让已安装的旧版本无法校验新版本。已存在私钥时拒绝执行，不会覆盖。

.PARAMETER GeneratePassword
  与 -InitSigningKey 一起使用：生成随机口令并保存到私钥旁的 .password 文件（发版时自动读取），
  适合无法交互输入的环境。

.EXAMPLE
  powershell -NoProfile -File scripts\publish-release.ps1 -InitSigningKey
  powershell -NoProfile -File scripts\publish-release.ps1 -DryRun
  powershell -NoProfile -File scripts\publish-release.ps1 -Version 0.2.0 -Notes "新增自动更新"
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Notes,
  [string]$NotesFile,
  [switch]$DryRun,
  [switch]$InitSigningKey,
  [switch]$GeneratePassword,
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.tauri\oris-updater-release.key')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$repo = 'Zhao-wl/Oris'
$confPath = Join-Path $root 'src-tauri\tauri.conf.json'
$cargoPath = Join-Path $root 'src-tauri\Cargo.toml'
$utf8 = New-Object Text.UTF8Encoding($false)
# 口令来源依次为：TAURI_SIGNING_PRIVATE_KEY_PASSWORD、私钥旁的 .password 文件、交互输入。
$passwordPath = "$KeyPath.password"

function Invoke-Native([string]$title, [scriptblock]$action) {
  Write-Host "==> $title" -ForegroundColor Cyan
  & $action
  if ($LASTEXITCODE -ne 0) { throw "$title 失败（exit $LASTEXITCODE）" }
}

function Read-Password([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-CurrentVersion {
  ((Get-Content -Raw $confPath -Encoding UTF8) | ConvertFrom-Json).version
}

Push-Location $root
try {
  if ($InitSigningKey) {
    # 从不覆盖已有私钥：覆盖后已安装的版本将无法校验用新密钥签名的更新。
    if (Test-Path $KeyPath) { throw "已存在私钥 $KeyPath；如确需更换，请先手动移走该文件，或用 -KeyPath 指定新路径" }
    # PowerShell 5.1 无法向原生命令传递空字符串，因此必须设置非空口令。
    if ($GeneratePassword) {
      $bytes = New-Object byte[] 32
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    } elseif ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
      $password = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    } else {
      $password = Read-Password '设置私钥口令（不能为空）'
      if (-not $password) { throw '口令不能为空' }
      if ($password -ne (Read-Password '再次输入口令')) { throw '两次输入的口令不一致' }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KeyPath) | Out-Null
    Invoke-Native '生成签名密钥对' { npx tauri signer generate -w $KeyPath --ci -p $password }
    if ($GeneratePassword) { [IO.File]::WriteAllText($passwordPath, $password, $utf8) }
    $pubkey = (Get-Content -Raw "$KeyPath.pub").Trim()
    $conf = [IO.File]::ReadAllText($confPath)
    $updated = [regex]::Replace($conf, '("pubkey"\s*:\s*")[^"]*(")', { param($m) $m.Groups[1].Value + $pubkey + $m.Groups[2].Value })
    if ($updated -eq $conf -and -not $conf.Contains($pubkey)) { throw "未在 $confPath 中找到 plugins.updater.pubkey" }
    [IO.File]::WriteAllText($confPath, $updated, $utf8)
    Write-Host ''
    Write-Host "私钥：$KeyPath（请备份到安全位置；丢失后无法再给已安装的版本推送更新）" -ForegroundColor Green
    if ($GeneratePassword) { Write-Host "口令：$passwordPath（发版时自动读取；如改存到密码管理器，删除该文件后发版时会提示输入）" -ForegroundColor Green }
    Write-Host '公钥已写入 src-tauri\tauri.conf.json，请提交该改动。'
    return
  }

  $current = Get-CurrentVersion
  if ($DryRun) {
    if (-not $Version) { $Version = $current }
  } else {
    if (-not $Version) { throw '请指定 -Version x.y.z' }
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式应为 x.y.z：$Version" }
    if ([version]$Version -le [version]$current) { throw "新版本 $Version 必须大于当前版本 $current" }
    if (git status --porcelain) { throw '工作区有未提交的改动，请先提交或清理后再发版' }
    if (git tag --list "v$Version") { throw "tag v$Version 已存在" }
    Invoke-Native '检查 gh 登录状态' { gh auth status -h github.com }
  }
  if ($NotesFile) { $Notes = [IO.File]::ReadAllText((Resolve-Path $NotesFile)) }
  if (-not $Notes) { $Notes = "Oris $Version" }

  if (-not (Test-Path $KeyPath)) { throw "未找到签名私钥 $KeyPath，请先运行 -InitSigningKey" }
  $savedKey = $env:TAURI_SIGNING_PRIVATE_KEY
  $savedPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $KeyPath).Trim()
  if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = if (Test-Path $passwordPath) { [IO.File]::ReadAllText($passwordPath).Trim() } else { Read-Password '私钥口令' }
  }

  try {
    if (-not $DryRun) {
      Write-Host "==> 版本号 $current → $Version" -ForegroundColor Cyan
      Invoke-Native '更新 package.json / package-lock.json' { npm version $Version --no-git-tag-version --allow-same-version }
      $conf = [IO.File]::ReadAllText($confPath)
      [IO.File]::WriteAllText($confPath, ([regex]'("version"\s*:\s*")[^"]*(")').Replace($conf, "`${1}$Version`${2}", 1), $utf8)
      $cargo = [IO.File]::ReadAllText($cargoPath)
      # 只替换 [package] 段的第一个 version（依赖版本写在花括号里，不以行首 version 开头）。
      $cargo = ([regex]'(?m)^version = "[^"]*"').Replace($cargo, "version = `"$Version`"", 1)
      [IO.File]::WriteAllText($cargoPath, $cargo, $utf8)
      if ((Get-CurrentVersion) -ne $Version) { throw 'tauri.conf.json 版本号更新失败' }
    }

    # 发布关口按文件顺序运行测试：部分 App 集成测试在并行高负载下会偶发失败。
    Invoke-Native '运行测试（按文件顺序）' { npx vitest run --no-file-parallelism }
    # 复用当前 PowerShell 的命令和模块环境，避免嵌套 shell 丢失 Get-FileHash 等构建依赖。
    Invoke-Native '签名构建 NSIS 安装包' { & (Join-Path $PSScriptRoot 'build-release.ps1') -Bundle -Bundles nsis -UpdaterArtifacts }

    $targetDir = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $root 'src-tauri\target' }
    $nsisDir = Join-Path $targetDir 'release\bundle\nsis'
    $setupName = "Oris_${Version}_x64-setup.exe"
    $setup = Join-Path $nsisDir $setupName
    $sig = "$setup.sig"
    if (-not (Test-Path $setup) -or -not (Test-Path $sig)) { throw "未找到安装包或签名：$setup(.sig)" }

    $latestPath = Join-Path $nsisDir 'latest.json'
    $latest = [ordered]@{
      version = $Version
      notes = $Notes
      pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
          signature = (Get-Content -Raw $sig).Trim()
          url = "https://github.com/$repo/releases/download/v$Version/$setupName"
        }
      }
    }
    [IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 5), $utf8)
    Write-Host "  安装包     : $setup"
    Write-Host "  签名       : $sig"
    Write-Host "  latest.json: $latestPath"

    if ($DryRun) {
      Write-Host ''
      Write-Host 'DryRun 完成：未修改版本号、未提交、未上传。' -ForegroundColor Green
      return
    }

    Invoke-Native '提交版本号' { git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json; git commit -m "chore(release): v$Version" }
    Invoke-Native "创建 tag v$Version" { git tag -a "v$Version" -m "Oris $Version" }
    # 发布提交总是进 main（可在独立的发布 worktree 中运行）；非快进时整体失败，不会创建 Release。
    Invoke-Native '推送提交与 tag 到 main' { git push --atomic origin HEAD:refs/heads/main "v$Version" }
    $notesPath = Join-Path $nsisDir 'release-notes.md'
    [IO.File]::WriteAllText($notesPath, $Notes, $utf8)
    Invoke-Native '创建 GitHub Release 并上传' { gh release create "v$Version" $setup $sig $latestPath -R $repo --verify-tag --title "Oris $Version" --notes-file $notesPath }
    Write-Host ''
    Write-Host "已发布 Oris $Version：https://github.com/$repo/releases/tag/v$Version" -ForegroundColor Green
  } finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $savedKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $savedPassword
  }
} finally {
  Pop-Location
}
