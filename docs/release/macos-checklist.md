# macOS 交接清单（一期 06，最终版本复测）

状态：**待用户执行**。Oris 自动化没有 macOS 环境；此前的 macOS 结论为“用户在 macOS 真机上验证（2026-09-25），Oris 自动化未复核；机型 / 芯片、内存、macOS 版本、被测构建、覆盖范围、原始记录位置：用户口头确认，范围未记录”。一期 05、V2-05 与本阶段的改动都晚于该次验证，需要在**最终合并版本**上重新执行本清单。

执行结果请按下文“记录格式”写入 `docs/validation/v1-06-release-results.md` 的 macOS 一节（或交给 Oris 整理）。凭据、证书、Apple ID、公证密码 / API 密钥**不要**写进仓库、日志或报告。

## 0. 准备

| 项 | 要求 | 记录 |
| --- | --- | --- |
| 下限机器 | macOS **14.x**、Apple **M1**（或等效真机），记录内存 | 机型 / 芯片 / 内存 / 系统版本（`sw_vers`） |
| 较新版本 smoke | 发布时选定的较新受支持 macOS（例如 15.x 或更新），记录具体版本 | 同上 |
| 源码版本 | 最终 main 的提交（`git rev-parse HEAD`，应与发布验收结果中的 Windows 构建同一提交） | 提交 SHA |
| 工具 | Xcode Command Line Tools、Rust（aarch64-apple-darwin）、Node（与 `package-lock.json` 兼容）、系统或 Homebrew 的 Git ≥ 2.31.0 | `rustc -V`、`node -v`、`git --version` |

## 1. 构建 DMG

1. `npm ci`
2. `npx tsc -b && npx vitest run`（前端测试应全部通过；记录数量）
3. 后端测试：`cd src-tauri && cargo test --no-default-features --lib`（记录通过 / 忽略数量；macOS 上的符号链接、进程组取消等分支在此首次执行）
4. 构建：`npm run tauri -- build --bundles app,dmg --target aarch64-apple-darwin`
5. 记录产物路径与 SHA-256：`shasum -a 256 <Oris_0.1.0_aarch64.dmg>`，以及 `Oris.app/Contents/MacOS/oris`
6. 许可证：DMG 中的 `Oris.app/Contents/Resources/` 应包含 `THIRD-PARTY-NOTICES.txt`（用 `scripts/release/third-party-licenses.mjs --notices` 生成后，按 Windows 构建相同的方式通过 `bundle.resources` 加入；如未加入，记为缺陷）；“设置 → 外观”底部的第三方许可应显示 VS Code 与 Colorsublime 声明

## 2. 签名与公证

需要 Apple Developer ID Application 证书与公证凭据（**由用户在本机钥匙串 / 环境变量中提供，不写入仓库**）。

1. 签名：设置 `APPLE_SIGNING_IDENTITY`（或 `tauri.conf.json > bundle > macOS > signingIdentity`，不要提交证书名以外的任何秘密），重新构建。
2. 公证：按 Tauri 文档设置 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`（或 App Store Connect API 密钥）后构建，bundler 自动提交公证并 staple。
3. 核对：
   - `codesign --verify --deep --strict --verbose=2 Oris.app`
   - `spctl --assess --type execute --verbose Oris.app`（应为 `accepted`，`source=Notarized Developer ID`）
   - `xcrun stapler validate Oris_0.1.0_aarch64.dmg`
4. 没有证书 / 账号时：输出未签名 DMG 作为内部测试包，签名 / 公证项记为“阻塞：缺证书”，**不要**用 `xattr -d com.apple.quarantine`、关闭 Gatekeeper 等方式绕过系统保护来宣称通过（未签名包的本机测试可在“隐私与安全性”中对单个应用选择“仍要打开”，并在记录中注明）。

## 3. 安装、启动、退出、重新打开、卸载

在 macOS 14 / M1 下限机器上执行全部；较新版本执行 smoke（带 * 的项）。

| # | 步骤 | 预期 |
| --- | --- | --- |
| I1* | 打开 DMG，把 Oris 拖入“应用程序” | 安装完成 |
| I2* | 从 **Finder / 启动台 / Spotlight** 启动（不要从终端启动，终端的 PATH 与 GUI 不同） | 窗口正常显示，无配色闪烁 |
| I3* | 添加一个真实仓库（含中文与空格路径） | 文件列表出现；底部状态栏显示 Git 版本 |
| I4 | 设置 → Git：“实际使用”显示的 git 路径与版本 | GUI 启动下找到的是 `/usr/bin/git`（Xcode CLT）或 Homebrew 的 git；记录是哪一个 |
| I5 | 设置 → Git：输入不存在的路径 | 提示“找不到或无法启动 Git …”，保留原设置 |
| I6 | 设置 → Git：输入低于 2.31.0 的 git（如有；没有可跳过并注明） | 提示版本不支持，保留原设置 |
| I7 | 设置 → Git：输入有效的其他 git 完整路径 | 校验通过；重新载入项目后“实际使用”变为新路径 |
| I8 | 缺 Git：在没有 Xcode CLT 的机器 / 用户上（或临时把设置指向不存在的路径后重新载入项目） | 打开项目时提示找不到 Git 与处理方法，不显示为“没有变化” |
| I9* | 退出（⌘Q），重新打开 | 项目列表、设置、提交草稿恢复；先显示上次快照并标“校验中”，随后替换为新鲜结果 |
| I10 | 拖到废纸篓卸载，清空前确认仓库目录仍在 | 仓库未被删除；应用数据保留在 `~/Library/Application Support/com.oris.viewer`、`~/Library/Caches/com.oris.viewer` 与 WKWebView 数据目录（记录实际路径，用于补全发行说明） |
| I11 | 重新安装后启动 | 项目列表与设置仍在（应用数据保留） |

## 4. 远端（B12 macOS 部分）

使用已授权的测试远端（`git@github.com:Zhao-wl/AgentHub.git`），**只创建 `oris-test/<运行编号>/` 下的分支**，结束后删除；不碰 main 与已有分支。

| # | 场景 | 预期 |
| --- | --- | --- |
| R1 | HTTPS 克隆（凭据在 osxkeychain 中已保存）：获取、拉取（仅快进）、推送测试分支 | 静默认证成功；领先 / 落后刷新 |
| R2 | SSH 克隆（ssh-agent 已加载密钥）：同上 | 成功 |
| R3 | 推送被拒绝（远端测试分支先被另一克隆推进） | 提示先拉取，不提供强推 |
| R4 | 网络操作中取消 | 进程组全部结束，如实报告 refs（macOS 进程组取消首次执行） |
| R5 | 认证失败（例如临时使用无权限的 URL） | 可操作提示，不弹出凭据输入 |
| R6 | 结束后用 `git ls-remote` 核对只剩开工时的引用 | 测试分支已删除 |

## 5. 需要在 macOS 上复测的验收 ID

| 验收 ID | 内容 | 本轮 Windows 状态 |
| --- | --- | --- |
| A01、A04、A06、A11、A12 | 阅读主路径、本地范围与冲突、diff 阅读体验、图片与特殊文件、路径 / 编码 / EOL（WKWebView 渲染） | Windows 自动化通过 |
| A13、B17、B18 | 恶意 external diff / textconv / fsmonitor 不执行；符号链接不越界；浏览前后仓库不变 | Windows 后端测试与界面脚本通过 |
| A15 | 安装 / 启动 / 系统 Git 探测 / 路径设置 / 缺 Git 提示 / 签名公证（本清单 §1–§3） | Windows 部分见发布验收结果 |
| B05–B08、B15、B16 | 文件级与块级暂存 / 丢弃 / 撤销丢弃、提交与撤销、hooks 取消（进程组）、外部锁 | Windows 通过 |
| B09、B10、B13、B14 | stash、分支操作、合并、进行中状态 | Windows 通过 |
| B11、B12 | 同步与远端（§4） | Windows 本地 bare remote 与 AgentHub 通过 |
| B19–B22 | 设置、Git 路径、配色（跟随系统时用**真实系统外观切换**验证）、字号快捷键 ⌘= / ⌘- / ⌘0 | Windows 通过（跟随系统为 CDP 模拟） |
| 性能 / 内存 | 按 [发布性能测试](../validation/v1-06-performance.md) 同一脚本与数据集：S 数据集 core / restart / trace、阅读与外观（含长文件滚动后的字号切换）、memory（5 / 10 项目，分层私有工作集按 macOS 对应口径记录） | Windows：24 项中 21 项达标，字号切换未达标 |

快捷键在 macOS 上应为 ⌘：⌘F 搜索、⌘, 设置、⌘⇧Enter 专注模式、⌘1…9 切换项目。

## 记录格式

每项写：机器（机型 / 芯片 / 内存）、macOS 版本、被测提交与 DMG SHA-256、步骤编号、结果（通过 / 失败 / 未运行 + 原因）、截图或日志位置。无法执行的项写“未运行”及原因，不以旧版本结果代替。
