---
name: oris-release
description: 发布 Oris 新版本到 GitHub Releases，已安装的 Oris 会通过应用内自动更新收到推送。流程包括确定版本号、写更新说明、在独立 worktree 中签名构建并推送 main 与 tag、创建 Release、从客户端视角核验、清理。Use when 用户说「发版」「发布新版本」「发 x.y.z」「推送一次更新」「/oris-release」。
---

# Oris 发版

发版会创建公开的 GitHub Release 并推送 `main`，属于对外操作。只有用户明确要求发版时才执行；版本号或更新说明不确定时，先和用户确认再动手。

背景文档：`docs/release/auto-update.md`。发版脚本：`scripts/publish-release.ps1`。

## 硬性约束

- **绝不重新生成或覆盖签名私钥**。正式私钥是 `%USERPROFILE%\.tauri\oris-updater-release.key`，口令放在同目录的 `.password` 文件里，公钥写在 `src-tauri/tauri.conf.json`。换了密钥，已安装的版本就再也收不到更新。私钥缺失时停下来告诉用户，不要执行 `-InitSigningKey`。
- **不在主目录发版**。`D:\Projects\Research\Oris` 同时被多个会话使用，发版期间 HEAD 可能被别人改动。一律从 `origin/main` 新建独立 worktree 来发。
- 构建与发版脚本必须在 **PowerShell** 中运行。Git Bash 下 windres 会失败。
- 提交身份只用 Zhao-wl（仓库本地 config 已设好），不要改全局 git config。
- 不要操作用户自己正在运行的 Oris（`D:\Tools\Oris`）窗口，更新由用户自己点击触发。

## 步骤

### 1. 确定版本号和更新说明

```bash
git fetch origin -q
git describe --tags --abbrev=0 origin/main          # 上一个版本，例如 v0.3.0
git log --oneline --no-merges <上一个tag>..origin/main
```

- 版本号按语义化版本：有 `feat` 升次版本号，只有 `fix` / `perf` 升修订号。新版本号必须大于当前版本，否则客户端不会认为有更新。
- 更新说明用中文，写给使用者看，会同时显示在应用的更新提示和 Release 页面上。分「新增」「修复」等小节，每条一句话，不写提交哈希和内部编号。只有 docs、test、chore 类改动可以不写。
- 说明写到仓库外的临时文件，例如 `$env:TEMP\oris-<版本>-notes.md`。
- 远端没有新的用户可见改动时，告诉用户，不要发空版本。

### 2. 准备发布 worktree

```bash
git worktree add -b release/v<版本> ../Oris-release origin/main
git -C ../Oris-release config user.name              # 应为 Zhao-wl
```

然后在 PowerShell 中，于 `D:\Projects\Research\Oris-release` 下运行 `npm ci --no-audit --no-fund`（新 worktree 没有 node_modules，构建脚本依赖本地的 `node_modules\vite`）。

### 3. 运行发版脚本（PowerShell，后台运行，约 20 分钟）

```powershell
Set-Location D:\Projects\Research\Oris-release
git fetch origin -q; "origin/main: $(git rev-parse --short origin/main)  HEAD: $(git rev-parse --short HEAD)"
powershell -NoProfile -File scripts\publish-release.ps1 -Version <版本> -NotesFile "$env:TEMP\oris-<版本>-notes.md"
```

脚本依次执行：检查 gh 登录 → 修改 4 个文件中的版本号 → 按文件顺序运行全量测试 → 签名构建 NSIS 安装包 → 生成 `latest.json` → 提交 `chore(release): v<版本>` 并打 tag → 用 `--atomic` 推送到远端 `main` → `gh release create`。

过滤输出时注意，`thiserror` 之类的 crate 名也会匹配到「rror」，不代表出错。

### 4. 失败处理

先弄清失败发生在哪一步，已经做了什么：

- **推送之前失败**（测试、构建、签名）：只是改了版本号，还没提交。撤回这些改动后修复问题再重跑，否则重跑会报「新版本必须大于当前版本」：
  ```bash
  git -C ../Oris-release checkout -- package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
  ```
- **推送被拒（non-fast-forward）**：说明构建期间远端 `main` 有新提交。`--atomic` 保证提交和 tag 都没推上去，也没有创建 Release。删掉本地的发版提交和 tag（`git tag -d v<版本>`，再 `git reset --hard origin/main` 前确认只丢弃这一个发版提交），然后回到第 2、3 步基于新的 `origin/main` 重来，让安装包包含最新代码。发现 `origin/main` 已经变化，也可以提前停掉构建。
- **测试失败**：先单独运行失败的测试文件，并在上一个发版 tag 上对比，判断是新引入的回归还是已有的偶发失败。不要为了发版跳过测试。偶发失败要修测试本身的时序问题，另行提交后再发。
- **Release 创建失败但推送已成功**：tag 已经在远端，修复 gh 的问题后，用生成的安装包、`.sig` 和 `latest.json` 手动执行 `gh release create v<版本> ... --verify-tag`，不要重新构建。

### 5. 从客户端视角核验（PowerShell）

```powershell
$r = Invoke-WebRequest -UseBasicParsing 'https://github.com/Zhao-wl/Oris/releases/latest/download/latest.json'
$j = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json
"latest.json version: $($j.version)"
$p = $j.platforms.'windows-x86_64'
"asset HTTP $((Invoke-WebRequest -UseBasicParsing -Method Head $p.url).StatusCode)"
$sig = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p.signature))
($sig -split "`n")[2]   # trusted comment 里应带 version:<版本>
$pub = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Content -Raw "$env:USERPROFILE\.tauri\oris-updater-release.key.pub").Trim()))
$kid = { param($l) [BitConverter]::ToString([Convert]::FromBase64String($l.Trim())[2..9]) }
"signed by release key: $((& $kid ($sig -split "`n")[1]) -eq (& $kid ($pub -split "`n")[1]))"
```

四项都要满足：版本号正确、安装包返回 200、签名绑定了新版本、签名由正式密钥签出。

### 6. 清理

```bash
git fetch origin -q
git merge-base --is-ancestor release/v<版本> origin/main && git worktree remove ../Oris-release --force && git branch -D release/v<版本>
rm -f "$TEMP/oris-<版本>-notes.md"
```

主目录的本地 `main` 只在工作区干净时用 `git merge --ff-only origin/main` 快进；工作区有改动时不要碰，告诉用户即可。

### 7. 告诉用户

报告 Release 链接、版本号与更新说明、核验结果，以及主目录 `main` 是否已快进。并说明如何在自己的安装上测试推送：在「设置 → 更新」点「检查更新」，标题栏出现「重启以更新」后点击，重启后当前版本应为新版本。本机安装的版本号可以查注册表 `HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Oris` 的 `DisplayVersion`。
