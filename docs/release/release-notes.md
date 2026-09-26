# Oris 0.1.0 发行说明（草稿）

状态：**草稿，未发布**。本文件随一期 06 合并发布验收编写；没有 tag、没有 GitHub Release、没有上传任何安装包。正式发布需要用户另行下达发布指令，并先完成签名 / 公证与 macOS 最终版本复测（见[发布验收结果](../validation/v1-06-release-results.md)）。

版本：0.1.0（`package.json`、`src-tauri/Cargo.toml`、`tauri.conf.json` 一致）。各产物的 SHA-256 与对应提交记录在[发布验收结果 · 构建与产物](../validation/v1-06-release-results.md#构建与产物)。

## 内容

一期（V1）与二期（V2）合并发布（[V2-D19](../decisions/v2-decisions.md)）：

- 多项目本地 Git 差异阅读：未暂存 / 已暂存 / 全部三个范围，并排与统一视图、词级高亮、折叠与逐段展开、搜索、同步滚动、软换行、专注模式、空白处理；图片对比（并排、滑动、缩放）与冲突版本（Base / Ours / Theirs / 工作区）只读查看；二进制、编码不支持、超预算、LFS 指针、子模块、符号链接、仅 mode 变化都有明确说明。
- 历史：提交日志与拓扑、分支筛选、提交搜索、两提交 / 两分支比较、文件历史。
- 写操作（全部由用户显式触发）：文件级与差异块级暂存 / 取消暂存 / 丢弃（丢弃可撤销）、提交（可勾选“提交并推送”）、撤销最近提交、stash、分支新建 / 切换 / 重命名 / 删除 / 设置上游、获取、拉取（默认仅快进）、推送（不提供强推）、合并与中止合并。
- 设置：外观（19 套配色方案、浅色 / 深色 / 跟随系统、字号）与 Git 可执行文件路径。

## 支持平台

| 平台 | 架构 | 安装包 | 状态 |
| --- | --- | --- | --- |
| Windows 11 | x64 | NSIS 安装程序（`Oris_0.1.0_x64-setup.exe`） | 本轮只输出**内部测试包（未签名）** |
| macOS 14 及以上 | Apple Silicon（arm64，M1 起） | DMG | 本轮未构建；用户按 [macOS 交接清单](macos-checklist.md) 构建与复测 |

不提供 Intel Mac、Universal、Windows ARM64 原生包。

- Windows 使用系统的 WebView2 运行时（Windows 11 自带）。安装程序在缺少 WebView2 时下载微软的引导程序静默安装（Tauri `downloadBootstrapper`，需要联网）；安装包本身不内置 WebView2。
- macOS 使用系统 WKWebView。

## Git 要求

- 需要系统已安装 **Git 2.31.0 或更高版本**。Oris 不打包 Git，不自动安装开发工具。
- 默认从 `PATH` 自动发现 `git`（Windows 上从开始菜单 / 资源管理器启动时，使用系统与用户环境变量中的 `PATH`）。也可以在“设置 → Git”中指定 git 可执行文件的完整路径；新路径先校验版本，校验失败时保留原来的有效设置。
- 找不到 Git 或版本低于 2.31.0 时，打开项目会给出原因与处理方法（安装 / 升级 Git，或在设置中指定路径），不会显示为“没有变化”。
- 远端认证使用用户已有的 Git 凭据环境（Windows：Git Credential Manager；macOS：osxkeychain；SSH：ssh-agent）。Oris 不保存、不读取、不显示凭据；网络操作禁止 Git 在终端中询问凭据，需要首次交互认证（例如确认 SSH 主机指纹）时，请先在终端完成一次。

## 安全边界

- **普通浏览只读**：浏览、刷新、切换项目 / 范围 / 文件、查看历史、启动与快照恢复不修改工作区、index、refs、config（仅在限定时机由 Git 回写 index 的 stat 缓存，[V2-D09](../decisions/v2-decisions.md)）。只读读取禁用外部 diff、textconv、fsmonitor，不跟随越出仓库的符号链接，不修改 `safe.directory`。
- **fetch、pull、push 及其余写操作只由用户显式触发**；没有自动获取、自动拉取或定时同步。
- **写操作会执行用户仓库的 hooks 与 filter**（与命令行 Git 一致，不提供 `--no-verify`）；签名按用户的 git config 执行。
- 丢弃前自动备份（单文件 ≤ 50 MiB，超出时确认框标注“不可撤销”）；写操作不自动重试；外部持有 `index.lock` 时报错且不删除锁；不支持的进行中状态（rebase、cherry-pick、revert、bisect）下写操作全部禁用。
- 不收集遥测，不加载远程代码；界面资源全部打包在应用内（CSP 只允许应用自身资源）。

## 内容预算

超出预算的内容显示明确的降级说明，不显示为“没有变化”：

| 内容 | 预算 |
| --- | --- |
| 文本全文 diff | 每侧 ≤ 5 MiB 且 ≤ 100,000 行；单行 ≤ 100,000 字符 |
| 图片 | 每侧压缩输入 ≤ 20 MiB，边长 ≤ 16,384，单图与双侧总像素 ≤ 40 MP（PNG、JPEG、WebP 静态图） |
| 文本编码 | UTF-8（含 BOM）、带 BOM 的 UTF-16 LE / BE；其他编码显示说明，可选择“按单字节（Latin-1）显示” |
| 丢弃备份 | 单文件 ≤ 50 MiB |
| 常驻 Git 读取进程 | ≤ 5 个；关闭项目后回收 |
| 提交日志 | 分页读取（每页 ≤ 1,000）；文件历史 ≤ 10,000 条；stash 列表 ≤ 500 条 |

## 已知限制

- **外部变化的自动刷新只在 Oris 窗口处于前台时进行**；窗口在后台时标记待刷新，切回后刷新（也可随时“本地刷新”）。
- 双层修改抵消判断按字节比较，不应用 clean filter / EOL 转换：配置了转换的仓库中，实际无变化的文件可能留在“全部”范围。
- `.gitignore` 变化后，“已跟踪但被忽略”的文件清单要到重新打开项目才重算。
- 不支持 fsmonitor 加速；十万文件级仓库的 status 约 150–200 ms。
- 差异块操作在“全部”范围、忽略空白、冲突、二进制、只有一侧可读、新增 / 删除整个文件时不可用（均有原因说明）；非 UTF-8 文件需要先选择“按单字节显示”。
- 拉取不执行 rebase（`pull.rebase=true` 时界面说明并仍以合并执行）；不提供强制推送、交互式 rebase、cherry-pick、submodule 更新等操作。
- stash 列表最多 500 条；Git 拒绝切换分支时只列出 Git 输出中的前若干路径。
- 推送预览中的“领先 N 个提交”来自本地快照，不代表服务器实时状态。
- 性能与内存：发布性能报告（`docs/validation/v1-06-performance.md`）尚未完成；在其完成前不对时延与内存作承诺。

## 安装与卸载

**Windows（内部测试包）**

- 运行 `Oris_0.1.0_x64-setup.exe`。安装程序**未签名**，Windows SmartScreen 可能提示“未知发布者”；这是本轮内部测试包的已知状态，不要为此关闭系统保护。
- 按当前用户安装（不需要管理员权限）到 `%LOCALAPPDATA%\Oris`，并创建开始菜单快捷方式。
- 安装目录中有 `oris.exe`、`WebView2Loader.dll`（WebView2 加载器）与 `THIRD-PARTY-NOTICES.txt`（第三方组件许可证全文，含 VS Code 与 Colorsublime 配色声明）。
- 本轮没有在本机执行安装 / 卸载测试（用户选择只构建）；步骤见 [Windows 安装 / 卸载交接清单](windows-install-checklist.md)。
- 卸载：“设置 → 应用 → 已安装的应用”中卸载 Oris，或运行安装目录中的卸载程序。**卸载不会删除你的 Git 仓库**（Oris 只登记仓库路径，从不移动或删除仓库）。卸载程序提供“删除应用数据”选项，默认不勾选；不勾选时下文的应用数据保留，重新安装后项目列表与设置恢复。

**macOS**：DMG 拖入“应用程序”安装，拖到废纸篓卸载；卸载同样不删除仓库。应用数据保留在下表位置，需要时手动删除。（macOS 安装包本轮未构建，见交接清单。）

## 应用数据位置

| 内容 | Windows | macOS |
| --- | --- | --- |
| 项目列表、设置、提交草稿、获取时间（WebView 本地存储） | `%LOCALAPPDATA%\com.oris.viewer\EBWebView` | WKWebView 网站数据（系统管理，按应用标识 `com.oris.viewer` 存放；待 macOS 复测确认具体路径） |
| 快照缓存（重启后先显示上次结果，最多 20 个、每个 ≤ 2 MiB） | `%LOCALAPPDATA%\com.oris.viewer\snapshots` | `~/Library/Caches/com.oris.viewer/snapshots` |
| 丢弃备份（用于撤销丢弃） | `%APPDATA%\com.oris.viewer\discard-backups` | `~/Library/Application Support/com.oris.viewer/discard-backups` |

Oris 不在仓库中写入自己的文件；仓库里的变化只来自你显式触发的 Git 写操作。

## 更新

**没有自动更新**，Oris 不检查新版本。新版本需要手动下载安装（覆盖安装保留应用数据）。

## 第三方许可

依赖许可证清单见 [third-party-licenses.md](third-party-licenses.md)，许可证全文随安装包附带（`THIRD-PARTY-NOTICES.txt`）。配色方案的 VS Code 与 Colorsublime（MIT）声明同时显示在“设置 → 外观”。
