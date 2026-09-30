# 长链总结：分支清理补登记 → 换行 + 对齐修复 → B12 真实远端 → 最终 main 功能复验（2026-09-29）

任务文件：[long-chain-prune-wrapalign-b12.md](../tasks/onetime/long-chain-prune-wrapalign-b12.md)。运行编号 lc4-20260929。授权范围：每个阶段验收后 `merge --no-ff` 并 `push origin main`；**没有**打 tag、推送 tag、创建 GitHub Release、上传安装包或发版。**本轮不做性能测试。**

## 阶段结果

| 阶段 | 分支 | 结论 | 合入 | 报告 |
| --- | --- | --- | --- | --- |
| 1 分支删除 / 清理补登记与验收 | `docs/branch-prune` | 通过；V2-D69–V2-D73 按用户答复确认，新增 V2-D74、B30；发现并修复 1 个缺陷 | `d67ebf8` | [分支清理结果](branch-prune-results.md) |
| 2 自动换行 + 对齐的错位 | `fix/wrap-align` | 修复完成：多块文件中视口落在两块之间时上下文行错开（最多约 39 px）→ 0；其余阅读状态逐项不变 | `b382461` | [换行 + 对齐结果](wrap-align-results.md) |
| 3 B12 真实远端 | `test/b12-real` | AgentHub SSH / HTTPS 14 项通过；A15 记录用户自测安装 / 卸载；真实远端上的“清理…”被权限拦截 | `4fbe76a` | [B12 结果](b12-real-remote-results.md) |
| 4 最终 main 功能复验 | main（只提交文档与测试脚本） | 复验期间其他会话合入了分级 diff（V2-D75）等产品代码，在合并后的构建上全部重跑：功能界面套件通过（WebView2 运行时的对外连接如实记录）；06 仍为 Awaiting acceptance | 本总结所在提交 | [RC 验收结果 · lc4 复验](v1-06-rc-results.md) |

## 发现并修复的问题

| 问题 | 发现于 | 处理 |
| --- | --- | --- |
| 在历史页选中某分支浏览后删除该分支，提交列表停在“无法解析引用”不恢复 | 阶段 1 界面验收 | 修复 `f46af76`：筛选的引用不存在时回到全部分支并提示 |
| 自动换行 + 对齐时，视口中的上下文行两侧错开（重新对齐也不消失） | 阶段 2 复现 | 修复 `3d6c969`：视口上方的锚定间隔 + 增量重新对齐。原登记的“73.1 px”实为视口外连接带端点，看不到 |
| 测试脚本：`repositoryFingerprint` 遍历时遇到消失的 `index.lock` 崩溃 | 阶段 3 | 修正脚本，消失的文件记入 `transient` |
| 测试脚本：v1-06-projects 在同一任务里连续派发输入与回车，别名被提交为空（`613a227` 之后在最终构建上出现） | 阶段 4 | 二分确认与产品无关（分步派发正常），脚本改为分两次派发 |
| 测试脚本：branch-prune 的等待条件把旧状态文字当成新结果；带盘符的不存在路径被 Git 当作 ssh 主机 | 阶段 1 | 改为 MutationObserver 只认新文字；失败夹具改用 `file:///` |
| 测试脚本：v2-06 的计时断言在不做性能测试时无法区分 | 阶段 1 | 新增 `--skip-timing`（只记录、不判定） |

## 测试数量变化

| 项 | 开工基线（`d005630`） | 最终 main（`664eb96`） |
| --- | --- | --- |
| 前端 vitest | 38 个文件 279 | 38 个文件 295（+3 阶段 1、+5 阶段 2、+1 其他会话 `613a227`、+7 其他会话 V2-D75） |
| 后端 | 170 / 5 忽略 | 171 / 5 忽略（+1 阶段 1） |
| `tsc -b`、`cargo check` | 通过 | 通过、无警告 |

后端 `sync_tests::b12_pull_times_out_without_output_and_push_can_be_cancelled_ending_the_process_tree` 在基线与最终 main 上都出现过“负载下偶发失败”（计时断言、读取 bare 引用），单独重跑均通过；用例与相关代码本轮未改动。

## 界面验收（最终构建 `FA92EA78…`，源码 `664eb96`）

v1-04 32、v2-02 functional 36、v2-03 24、v2-04 local 22、v2-05 functional 14、v1-05 reading 37、v2-06 `--skip-timing` 13、history-feedback 12、gui-probe task03 通过、v1-06-projects `--net-audit` 11/12（失败项为 WebView2 运行时的对外连接，Oris 与 Git 没有对外连接）、v1-06-git-discovery 10、branch-prune local 15、v1-06-ai-acceptance 37。此前在 `4fbe76a`（`FA72B2D4…`）上跑过一轮，结果相同（v1-06-projects 修正脚本后 12/12）。过程中的重跑与原因见 [RC 验收结果 · lc4 复验](v1-06-rc-results.md)。所有点击与按键都是 CDP 页面事件，不是真实鼠标、键盘或 Windows 焦点；测试实例都经 `launchOris` 核验，没有调用窗口激活 API。

## 真实远端

AgentHub（`git@github.com:Zhao-wl/AgentHub.git` / HTTPS，账号 Zhao-wl）：v1-04 real 3/3、v2-04 real 11/11；只创建并删除 `oris-test/lc4-20260929/` 下的分支，`ls-remote` 开工前后都只有 `main` = `fc9be5c`。三个套件的第一次启动都被自动权限分类器拦下，v1-04 与 v2-04 按约定单条重试后运行；`branch-prune --only real` 重试后仍被拦，未运行。

## 其他观察

- **WebView2 运行时的对外连接**：v1-06-projects `--net-audit` 的 3 次有效运行中有 2 次，WebView2 网络服务进程连接 `150.171.27.11:443`（与 RC 时的来源未确认连接相同）与一个 80 端口地址（`113.249.87.135`、`27.18.12.9`），Oris 与 Git 子进程没有对外连接；AI 验收的采样中没有出现。已按用户决定写入发行说明。WebView2 运行时在本轮期间由 153.0.4234.48 自动更新到 154.0.4258.37。
- **diff 的 scanLimit**：`src/diff-core.ts` 的 `scanLimit: 5000` 使 3,000 行、60 处小改动的文件退化为 1 个修改块（不设上限时 65 块）。本长链另开的待办已由其他会话完成并合入（分级 diff，V2-D75，PR #17）；随之登记了“对齐变化在块数多时滚动后收敛慢”的已知限制（研究 10）。阶段 4 因此在包含 V2-D75 的构建上重新复验。在同一份代码上撤回阶段 2 修复做对照：27 块夹具有修复为 0、无修复最多 39.2 px；65 块夹具完整重新对齐后两者都可能留下最多约 97 px（有修复 7 个状态、无修复 10 个），属于研究 10 的既有问题，不是本轮引入。
- **`scripts/build-release.ps1` 复用输出目录时 exe 体积增长**：前端输出目录在仓库外，Vite 不清空，旧的哈希文件累积并嵌入 exe（41.9 → 44.6 MiB）。功能不受影响；最终构建使用全新目录（41.9 MiB）。建议构建脚本在复用目录时先清空 dist（未改）。
- 本机同时有其他会话在跑 Oris 测试实例（`align-fix`、`v2-07-workspace` 构建）与编译，占用端口并增加负载；本轮套件改用不冲突的端口。

## 未验证项

- **全部性能测试（本轮不做）**：写操作时延与 Git 进程数、块操作 Git 确认（含 A/B 对比）、外观 / 阅读（字号、配色、主题模式、滚动帧间隔）、分层内存（V2-D29）与 V2-D59、常驻 Git 子进程、L 数据集；以及阶段 2 改动对滚动与字号切换的影响、阶段 1 修复的影响。RC 与发布性能测试的结论保持原状。
- 真实远端上的“清理…”（B30）：权限拦截。在主工作树 `D:\Projects\Research\Oris` 快进到最新 main（`git pull --ff-only`）后执行，使用保留的最终构建：
  `node scripts/perf/branch-prune-acceptance.mjs --exe D:/Projects/Research/Oris-builds/final-main-lc4b/target/release/oris.exe --only real --run-id lc4-20260929-user`
- macOS 全部；签名 / 公证（缺证书）；AI 真实模型冒烟；自动更新的原地安装（需正式签名的更新包）；真实鼠标、键盘与 Windows 焦点。

## 待用户决定

- 构建脚本复用输出目录时是否先清空前端产物（工程改动，建议做）。

## 建议的下一步

1. 低负载性能会话：写操作、块操作 A/B、外观 / 阅读（含换行 + 对齐的滚动与字号切换）、分层内存、常驻 Git 子进程；V2-D75 之后的大文件 diff 与已缓存切换（研究 10 记录 182 块以上 P95 超出 100 ms）。
2. 另开任务：“对齐变化”在块数多时滚动后收敛慢（只对齐视口附近的块，或在一帧内批量调整间隔；研究 10）。
3. 签名（Windows、macOS）与 macOS 最终版本复测（[交接清单](../release/macos-checklist.md)）。
4. AI 真实模型冒烟（用户自己的密钥或 codex / claude 账号）。
5. 在自己的终端补跑真实远端上的“清理…”。
6. 以上完成后，由用户下达发版指令（`oris-release`），发行说明草稿对应 v0.4.1 之后的下一版本。
