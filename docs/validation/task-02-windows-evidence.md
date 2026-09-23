# 任务 02 Windows 实施证据

历史边界补充（2026-09-23）：用户已取消项目固定功能；下文固定排序/标记属于旧版本实测历史，不是现行功能或现行验收。当前以持久别名、独立拖动顺序和紧凑标签为准，见 [项目 tab 与启动回归](task-02-compact-project-tabs.md)。

日期：2026-09-22。基线：`3c1c2d1d25fb7e04a6fa3226fccab708042f5907`。本文件记录执行会话可复核结果，不代替总控验收，也不把未运行平台写成通过。

## 环境

- Windows 11 专业版 23H2，10.0.22631；Intel Core i7-11700；47.7 GiB RAM。
- Git 2.44.0.windows.1；Node 22.18.0；npm 11.12.1。
- Rust/Cargo 1.97.1，host `x86_64-pc-windows-gnu`；Edge WebView2 Runtime 153.0.4234.48。
- macOS 14+ Apple Silicon：本会话无真机，未验证。

## 自动化结果

1. `npm test -- --run`：4 个测试文件、21 项测试全部通过。包含：同名不同路径、RepoId 去重、固定排序、移除记录后的合法 active 修复、损坏/重复持久化记录清理、失效文件锚点的显式 invalidated 判定与合法回退、16 MiB/12 项 LRU 淘汰、slow-A/fast-B request gate、5 项目 30 次热模型切换。
2. 热模型切换原始摘要：`ORIS_TASK02_HOT_MODEL {"projects":5,"runs":30,"p50Ms":0.015,"p95Ms":0.058}`。这是已加载摘要和内容缓存的状态层测量，不伪装成完整 GUI 点击到绘制测量。
3. `cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features`：9 项通过；2 个显式性能探针默认忽略。真实临时 Git 仓库覆盖 staged/unstaged/all 三端点、同文件两层变化、未跟踪、删除、rename、中文/空格/特殊字符、冲突、空 HEAD、外部 add/commit/checkout revision 变化、只读安全与 stale 丢弃。
4. `cargo test ... task02_five_repository_switch_probe -- --ignored --nocapture`：5 个真实临时仓库、每仓库 100 文件/20 变化、30 次新鲜本地快照；P50 663 ms、P95 742 ms、测试进程 working set 6.58 MiB。该结果属于未缓存 Git 重读，低于“首次打开 3 s”预算，但不能替代热 GUI 切换指标。
5. `cargo check --manifest-path src-tauri/Cargo.toml`：通过，包含 Tauri 命令与 `notify 8.2.0` watcher 编译。
6. `npm run build`：TypeScript 与 Vite 生产构建通过；主 bundle 约 674.9 kB，Vite 给出大于 500 kB 的非阻断提示。
7. 在命令作用域补入仓库既有 GNU resource tools 后运行 `npm run tauri -- build --no-bundle`：通过，生成 `src-tauri/target/release/oris.exe`；定向补齐后的 SHA-256 为 `1F21FCA03BB23EC9B5E068F26AC8B6CFD28346E5322630C2C28C1DEDC2B216C8`。
8. `git diff --check`：通过；仅显示工作区既有的 LF/CRLF 转换提示。

## 可观察实现链路

- 多项目：版本化 `oris.workspace.v2` 只保存项目元信息、固定/最近顺序与每项目阅读锚点；应用只挂载一个 DiffViewer。旧 `oris.recentRepository.v1` 可一次迁移恢复。
- 三比较范围：`unstaged = Index → WorkingTree`、`staged = HEAD/EmptyTree → Index`、`all = HEAD/EmptyTree → WorkingTree`。文件列表来自 NUL 分隔 Git 输出，路径读取使用 base64url `pathId`，不靠展示字符串拼接定位。
- 外部变化：Rust watcher 覆盖 worktree、gitDir/commonDir，前端 300 ms 合并事件；窗口聚焦与 5 秒可见核对作为补偿；手动刷新调用同一本地 snapshot 命令，链路中没有 fetch。
- 隔离：仓库/范围 revision + RepoId + requestId 同时校验；RequestGate 丢弃过期结果；内容缓存按 RepoId/scope/revision/pathId 建键并按 16 MiB/12 项淘汰。
- 失败状态：无变化、筛选无匹配、未知、恢复失败、旧快照、冲突、非 UTF-8 路径读取不支持、过预算内容均有独立表达。

## Windows release GUI

- 使用上述 release 二进制与 WebView2 CDP 对 5 个真实临时 Git 仓库跑完整桌面链路；原始机读结果在忽略目录 `artifacts/task-02/runtime/windows-gui-full.json`，截图为同目录 `windows-gui-full.png`。结果 `passed: true`。
- A02/A03：5 个同名仓库以完整路径区分；重复添加仍为 5 项；项目搜索命中 1 项；固定顺序生效；移除后项目记录从 5 降为 4 且目录仍存在；重新添加成功。结束时保存第 3 个项目、`全部`、过滤词 `file-005`、文件 `files/file-005.txt`。
- A04/A12：真实 UI 逐项读到 unstaged 的未跟踪/删除/双层变化，staged 的双层变化/中文 rename，以及 all 的合并集合；端点分别显示 `HEAD → Index` 与 `HEAD → Working Tree`；空 HEAD 显示 `空树 → Working Tree`；未解决冲突明确降级；前后文件导航回到 `files/file-005.txt`，复制路径处理器收到相同完整相对路径。
- A05：进程外写工作区、`git add`、`git commit`、`git checkout -b` 均由 watcher 驱动 UI 更新；分支显示 `external-checkout`。手动本地刷新前后 refs 完全相同，未触发远端操作。
- 隔离：向慢仓库一次加入 500 个未跟踪文件，10 ms 后切换到快仓库并等待 2.2 s；active 与选中文件保持快仓库，且无错误，证明迟到的 A 结果未污染 B。
- 失效阅读锚点：在 GUI 中选中 `files/file-011.txt` 后，由进程外 `git checkout -- files/file-011.txt` 让该变化消失；watcher 刷新后出现“阅读位置已调整 / 此前选中的文件已不在当前比较范围中”提示，并把持久化锚点修复为合法的 `files/file-000.txt`。缓存切换与新快照接受共用同一解析契约，两个入口均按 invalidated 标志提示并修复锚点。
- 5 项目已加载后的真实 GUI 点击到状态栏/选中项收敛测量 30 次：P50 11.1 ms、P95 29.4 ms，低于 200 ms 预算；同一时刻 Oris 主进程 working set 26.61 MiB、peak 30.15 MiB、private 9.73 MiB。内容缓存仍受 16 MiB/12 项 LRU 上限约束。
- 关闭并重新启动同一 release 二进制后，机读结果 `artifacts/task-02/runtime/windows-gui-restore.json` 为 `passed: true`：恢复 5 项目、固定标记、活动项目、比较范围、过滤词、选中文件与两个编辑器。截图为同目录 `windows-gui-restore.png`。

## 剩余门禁

- macOS 14+ Apple Silicon 文件监听、WKWebView 与 GUI 启动仍未验证；本文件不把 Windows 结果外推为双平台通过。
- 总控内部 `/root/task02_coverage` 已完成 Windows 基础需求定向复查，确认唯一的失效阅读锚点缺口已关闭、其余既定覆盖成立；该复查未重跑测试，也不是全量技术深审。
- 当前结论为“Windows 实现与基础覆盖通过；双平台最终验收因 macOS 未验证而 `Blocked`”。任务文档只勾选有独立 Windows 证据的验收项，Win/Mac 联合门禁保持未完成。
