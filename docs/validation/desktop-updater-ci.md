# 双平台签名发布与 macOS 自动更新核验

日期：2026-10-09。实现与工作流修复已进入 main，源提交为 `8ac758d50482d4ece5892216aa7601c6a5151d1e`。

## 密钥和客户端

- 经用户明确授权，将现有 `TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 上传到本仓库 Actions Secrets。上传前核对本机 `.pub` 与客户端内置公钥一致；未生成新密钥，未改公钥，未将私钥或口令写入仓库、日志或构建附件。
- macOS 使用与 Windows 相同的 Tauri 更新签名公钥及完整双平台 `latest.json`，接入后台下载、签名校验、用户点击安装和重启。
- 原地更新仅允许正式构建：Windows 保留 NSIS 安装目录识别；Mac 仅接受系统 `/Applications` 或当前用户 `~/Applications` 中完整的 `.app/Contents/MacOS` 路径。DMG、App Translocation、开发目录等不能调用下载或安装命令进行原地更新。
- Mac 安装权限不足时，Tauri 插件可能请求系统管理员授权。取消授权或安装失败时报告错误。
- 已安装的 0.8.4 及更早 Mac 客户端仍为手动更新逻辑，必须手动安装一次带新更新链路的版本。

## 工作流验证

- 保留 `.github/workflows/release-windows.yml` 入口，扩展为一个 Desktop release 工作流。Windows 使用 PowerShell、MSVC；Mac 使用 Apple Silicon、macOS 14、ad-hoc 应用签名。
- [最终 check 运行](https://github.com/Zhao-wl/Oris/actions/runs/37937759329)：Windows 和 macOS 两个 job 均成功，publish 按模式跳过。执行前端回归、旧 GUI 入口安全测试、发布脚本测试、桌面 release 构建、无 GUI 嵌入资源核验、签名核验及产物保存；Mac 另执行 `codesign --verify --deep --strict`。
- 两平台前端各为 53 个文件通过、1 个文件跳过，447 项测试通过、1 项跳过；各自发布签名测试 2 项通过。Windows 旧 GUI 入口安全测试 3 项通过；Mac 其中 Windows helper 专项按平台跳过。两平台均验证 26 项嵌入资源。
- 本轮 check 使用远端源码版本 0.8.4，产物属于新实现的测试构建，未替换既有 v0.8.4 Release。没有创建 v0.9.0 标签、Release 或公开更新入口。
- [首轮运行](https://github.com/Zhao-wl/Oris/actions/runs/37936432998) 中 Windows 成功，Mac 因仅选择 `dmg` 而没有生成 `.app.tar.gz` 失败。根据 Tauri 明确的 updater-enabled targets 警告，修复为 `--bundles app,dmg` 后最终运行通过。
- 工作流正式发布阶段只在两平台成功后执行：再次核验文件、版本和公钥绑定的更新签名，汇总 Windows 安装包、Mac DMG/更新归档及签名，生成双平台更新清单和校验和，再原子推送版本提交与标签、上传草稿并公开。运行期间 main 前进会导致非快进推送失败，从不强推。
- 只验证了 check 模式；正式发布的版本提交、标签推送、Release 上传及公开步骤本轮未执行。

## 本地补充验证和边界

- SettingsDialog 与更新状态机：2 个文件、12 项通过；Mac 安装目录策略：1 项通过；发布版本准备及密码学签名回归：2 项通过。
- Windows PowerShell 下 MSVC desktop `cargo check`、TypeScript/Vite 和 actionlint 均通过。使用内置公钥独立验证了既有正式 0.8.4 安装包及首轮 GitHub Windows 安装包的实际签名。
- Mac 附件下载经过较长等待后完成，未执行进程终止。使用内置公钥独立验证下载后的 Mac 更新归档、签名中的版本和 trusted comment；签名通过。Mac 更新归档为 9,930,779 字节，SHA-256 为 `4afb00261f6b3c709788477f2de211b90777975ad8d36fbf6b78ddb996a182fc`。
- 本地试汇总使用首轮 Windows 与最终 Mac 下载产物（两轮间生产代码与版本一致，仅修改工作流和文档），复用实际发布汇总脚本生成清单并核验双平台签名。清单包含 `windows-x86_64`、`darwin-aarch64`，版本为测试构建的 0.8.4，未上传到公开 Release。版本提交、标签推送与正式公开步骤仍待首次 publish 验证。
- 构建、测试和下载证据保存在忽略目录 `artifacts/release-v0.9.0/`。
- 本轮未执行真实 Mac 自动更新下载→应用替换→重启、Windows 安装/卸载或已安装客户端的实际更新链路；没有 Developer ID/Apple 公证或 Windows Authenticode。应用代码签名与 Tauri 更新签名分别核验，不混为一项。
- 危险原生 helper 及六个旧反馈入口继续保持立即拒绝执行，未恢复抢焦点调用；安全测试仅检查和运行这些拒绝入口。没有操作其他应用窗口，也未启动可见测试 Oris。真实 Windows 焦点测试范围为空；jsdom 状态/界面测试及无 GUI 嵌入资源验证不代表真实焦点测试通过。

此前暂停留下的五个 0.9.0 升版文件已恢复并保留为未提交修改；本轮实现提交不包含这些升版改动。
