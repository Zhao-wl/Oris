# 自动更新与发版

Oris 在 Windows 上使用 Tauri 官方 `tauri-plugin-updater`，交互参考 VS Code：发现新版本后在后台下载，标题栏（「✦ AI」左侧）常驻显示「重启以更新」，点击后安装并重启。macOS 已接入同一签名更新清单，在 Applications 目录内支持后台下载、校验、安装和重启。

## 客户端行为

| 状态 | 标题栏 | 说明 |
| --- | --- | --- |
| 无更新 / 检查中 | 不显示 | 自动检查失败时静默，不打扰 |
| 下载中 | `更新 42%` | 后台下载，签名在下载完成时校验 |
| 已下载 | `重启以更新` | 悬停显示版本号与更新说明；有写操作进行中时先确认 |
| 安装中 | `正在更新…` | Windows 以 NSIS passive 模式安装（只显示进度），完成后自动启动新版本 |
| 失败 | `更新失败` | 悬停显示原因，点击重试对应阶段 |
| 免安装版 | `新版本 x.y.z` | 当前 exe 旁没有 `uninstall.exe`（例如直接运行 `target\release\oris.exe`）时不能原地替换，点击打开 Release 页面 |
| macOS 应用包 | `重启以更新` | 系统或用户 Applications 目录内的正式应用可更新；DMG、App Translocation、开发目录仍提供手动入口 |

- 检查时机：启动 5 秒后一次，之后每 4 小时一次；可在「设置 → 更新」关闭自动检查，或手动「检查更新」。开发构建（debug）不做原地安装。
- Windows 更新源：`https://github.com/Zhao-wl/Oris/releases/latest/download/latest.json`。网络请求和签名校验都在 Rust 端完成，前端 CSP 不变。
- Windows 只有**通过安装包安装**的实例能自动更新；第一个带更新功能的版本需要手动安装一次。
- Windows 和 macOS 共用签名更新源。清单必须同时包含 windows-x86_64 与 darwin-aarch64；Mac 更新包为 Oris.app.tar.gz 与对应 .sig，DMG 用于首次手动安装。
- Mac 正式应用必须位于 /Applications 或用户的 ~/Applications。DMG、App Translocation 和开发构建不允许原地更新；安装权限不足时报告失败，不提权。
- 已安装 0.8.4 及更早 Mac 用户须手动安装一次支持自动更新的版本，之后即可使用后台签名更新。旧版仍可从该版本 DMG 手动升级。

## 签名密钥

- 公钥写在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；私钥在 `%USERPROFILE%\.tauri\oris-updater-release.key`，**不进仓库**。
- 正式密钥已于 2026-09-28 用下面的命令生成（`-GeneratePassword` 生成随机口令，存到私钥旁的 `.password` 文件；不加则交互输入口令）。脚本不会覆盖已有私钥：

  ```powershell
  powershell -NoProfile -File scripts\publish-release.ps1 -InitSigningKey -GeneratePassword
  ```

- 发版时口令依次从 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`.password` 文件、交互输入获取。口令文件与私钥放在一起时，保护只剩用户目录权限；需要更强保护时把口令移到密码管理器并删除该文件。
- 请备份私钥与口令。丢失或更换私钥后，已安装的版本无法校验新版本，只能让用户手动重装。

## 发版

### 触发 Windows 与 macOS 统一构建和发布

使用同一个 `.github/workflows/release-windows.yml`（保留旧文件名），同时运行 Windows x64 和 macOS Apple Silicon 构建。Windows 使用 PowerShell 与 MSVC；Mac 使用 macos-14、aarch64-apple-darwin、ad-hoc 应用签名，最低系统版本为 14。

```bash
# 两平台签名构建与核验，不修改 main、标签或 Release
npm run release:desktop -- --check
# 两平台全部成功后统一发布
npm run release:desktop -- 0.9.0 --notes-file docs/release/v0.9.0.md
```

`release:windows` 是兼容入口，现在同样触发双平台。两种模式都需要仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，沿用原有密钥；Mac 不另建更新密钥。密钥只注入检查和构建步骤，不进入附件或日志。

构建从本轮固定的 main 提交开始，在各 runner 上准备相同版本文件，执行回归、构建安装包和更新包、核验嵌入资源及密码学签名。任一平台失败则不提交版本、不推标签、不发布。产物附件保留 14 天；check 产物虽然带签名，但未创建公开更新入口，仅用于验证。

发布任务等待两平台成功，重新核验更新包签名，汇总双平台 latest.json、安装包、更新包、签名及 SHA256SUMS.txt，再提交版本、原子推送 main 与标签，创建并上传草稿 Release，最后公开并设为 latest。main 若已有新提交，非快进推送失败，不强推。若标签已推送后上传失败，应核对并恢复原标签的草稿发布，不重新生成同版本标签。

Mac 不需要 Apple 证书即可 ad-hoc 打包，但仍可能需要用户在系统安全设置允许首次安装。Tauri 更新签名与 Apple Developer ID/公证、Windows Authenticode 相互独立。

可以从 GitHub Actions 页面选择 check/publish，或使用以上命令。尚未推送的本机修改不会进入构建。

### Windows 本机单平台工具（不用于双平台正式发布）

在 PowerShell 中执行（Git Bash 下 windres 会失败）：

```powershell
# 检查流程：按当前版本签名构建并生成 latest.json，不改版本号、不提交、不上传
powershell -NoProfile -File scripts\publish-release.ps1 -DryRun

# 正式发版
powershell -NoProfile -File scripts\publish-release.ps1 -Version 0.2.0 -Notes "新增自动更新"
```

正式发版会：

1. 要求工作区干净、tag 不存在、`gh` 已登录；
2. 把 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本号改为新版本（必须大于当前版本，否则客户端不会认为有更新）；
3. 按文件顺序运行全量测试（并行高负载下部分 App 集成测试会偶发失败），再签名构建 NSIS 安装包（`build-release.ps1 -Bundle -Bundles nsis -UpdaterArtifacts`），生成 `Oris_x.y.z_x64-setup.exe.sig`；
4. 生成 `latest.json`（版本、说明、发布时间、`windows-x86_64` 的下载地址与签名）；
5. 提交 `chore(release): vx.y.z`，打 tag，原子推送到远端 main（可在独立的发布 worktree 中运行；非快进则整体失败），`gh release create` 上传安装包、签名与 `latest.json`。

平时的 `npm run package` 不生成更新签名，不需要私钥。

## 端到端实测（本机，不影响已安装的 Oris）

用独立标识打两个版本，由本机静态服务充当更新源，通过 WebView2 CDP 只在页面内点击，不做原生窗口或焦点操作。

1. 生成一次性测试密钥（`npx tauri signer generate`，放在仓库外），为 0.1.0 / 0.1.1 各写一份配置：`productName: "OrisUpdateTest"`、`identifier: "com.oris.updatetest"`、`version`，`plugins.updater` 使用测试公钥、`http://127.0.0.1:18765/latest.json` 与 `dangerousInsecureTransportProtocol: true`。
2. 分别构建：`build-release.ps1 -Bundle -Bundles nsis -UpdaterArtifacts -OutputRoot <目录> -ExtraConfig <配置>`，用 0.1.1 的安装包与 `.sig` 写 `latest.json`。
3. `node scripts/updater-e2e/server.mjs <目录> 18765` 提供更新源；`setup.exe /S /D=<测试安装目录>` 静默安装 0.1.0。
4. 设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9341` 启动测试实例，`node scripts/updater-e2e/drive.mjs 9341 update` 记录按钮状态并点击「重启以更新」；重启后 `drive.mjs 9341 version` 应输出新版本。
5. 清理：按 PID 与完整路径结束测试实例，`uninstall.exe /S`，删除 `%LOCALAPPDATA%\com.oris.updatetest`、测试构建目录与测试密钥。

2026-09-28 实测结果：启动约 5 秒后检查到 0.1.1，后台下载约 0.4 秒后显示「重启以更新」；点击后旧进程退出，passive 安装完成约 5 秒后自动启动新实例，注册表版本与页面自报版本均为 0.1.1，新实例启动后的检查不再显示按钮。
