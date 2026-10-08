# 拓展-01 / issue #24：精细 diff 与提交组织

日期：2026-10-08。基线：Oris 0.8.2，main `4caedcb55d9aa97a31f3858fa4f68f29a7fb3608`。
工单：[issue #24](https://github.com/Zhao-wl/Oris/issues/24)。本单不更新版本号、依赖锁文件或发行配置。

## 使用与实现

在“未暂存”或“已暂存”范围点击“选行 / 拆块”，或块标题的“拆分 / 选行…”。后者打开对应 Git 块。可用 Ctrl / Cmd 点击变化行切换选择、Shift 点击扩展同侧变化行，或使用面板中的复选框。并排与统一视图都支持；上下文、对齐占位和折叠行不会进入选区。

Git 的零上下文块拆成按行序配对的选择单元。替换两侧可独立选择，不假定语义对应：暂存只选旧行时删除该行，只选新增行时在对应旧行之后插入，同时选两侧时原位替换。取消暂存还原选中的旧行、移除选中的新增行。无末尾换行的行若会被部分选择放到文件中间，拒绝操作并要求成对选择。用户先查看补丁预览，再确认执行。

前端仅提交 `pathId`、两侧 `contentIds`、`expectedRevision`、Git 块范围/摘要和块内行偏移。仓库身份随 IPC 的 `repoId` 传入，比较端点由 unstaged（index → worktree）或 staged（HEAD → index）及 revision 确定。后端重新扫描、核对端点内容和选区，由 Git 原始字节生成有限上下文补丁；预览和执行都做 `git apply --cached --check`。执行要求补丁摘要与预览一致，预检后再次核对状态。写操作走既有 OperationRunner、仓库锁、前置检查和结束刷新；只写 index，保留工作区及剩余修改。没有行级丢弃，既有整块丢弃及备份流程保留。

“移动候选”标明两行以上、含足够非空文本、两侧唯一且完全一致的整段文本，行末边框和悬停提示给出配对编号。重复、单行、改写过的移动和 Git/阅读器分块差异可能无法识别；保留普通 diff，不能据此证明语义等价。

“淡化格式噪声”筛选仅淡化整块中只有行内空白差异的行，不移除正文、修改计数、搜索结果或导航。忽略空白沿用原有阅读计算，仍禁用写操作；写操作始终核验真实 Git 差异。两项阅读开关不发起 Git 写请求，装饰更新不重建编辑器。行提交信息继续使用独立的当前行标记。

原始行映射支持 UTF-8（含 BOM）、LF、CRLF、autocrlf 转换、无末尾换行，以及明确选择 Latin-1 字节显示后的非 UTF-8 内容。UTF-16/NUL、单独 CR 换行、改变行内容的 clean filter 提前返回 `lineBlocked`，禁用行操作并说明原因。新增/删除文件、冲突、子模块、符号链接、重命名、“全部”范围、超预算内容等沿用文件级限制；纯增/纯删的改动行支持。非 UTF-8 补丁预览可能显示替代字符，写入仍保留原始字节。

## 验证

环境：Linux 云环境，Node 24.19.0、Rust 1.99.0、Git 2.52.0。前端证据为 jsdom DOM 测试；后端为真实临时 Git 仓库。没有把 DOM 焦点或静态检查当成 Windows 原生 GUI 证据。

| 项目 | 验证 |
| --- | --- |
| 混合块精确暂存 | `feature old → feature new` 被暂存，`debug old → debug new` 保留未暂存；断言 `git diff` / `--cached` 正文、index 字节和工作区。只有 index 指纹变化。[前后证据](issue-24-evidence/lines-mixed-hunk-stage.json) |
| 取消暂存 | 暂存单元的完整逆向，以及混合块全部已暂存时只取消目标行、其余仍已暂存 |
| 纯增、纯删、替换、单侧选择 | 真实 Git 分别断言 index 字节；相邻块上下文来自实际 index，不误带其他改动 |
| 编码与换行 | UTF-8/BOM、Latin-1 原始字节、CRLF/LF、autocrlf、无末尾换行往返；UTF-16 强制文本、单独 CR 和 clean filter 拒绝并保留仓库 |
| 过期和异常请求 | 外部工作区/index/其他文件变化、过期 revision/contentId、伪造预览摘要、越界行、外部 index.lock 拒绝写入；不删除外部锁，不重试 |
| 前端闭环 | 暂存与取消暂存接线、先预览后确认、迟到预览失效、映射读取失败提示、不可映射时禁用；真实 IPC camelCase 形状经 Rust serde 解码 |
| 两种视图与阅读 | split/unified 的新增和删除行映射、Ctrl/Shift 选择、软换行与对齐配置、保留当前行提交信息；移动与格式筛选实际文本断言、计数不变、装饰更新保留编辑器实例；原有搜索/阅读位置/主题回归 |
| 规模回归 | 100,000 行阅读分析；100,000 行块只渲染 200 个可见选择单元并可翻页，块列表每页 20 块；20,000 行连续替换只选中部一对，补丁少于 500 字节，映射、两次预览与执行本机约 0.46–0.52 秒 |

复现命令（Rust 工具需在 PATH 中）：

```sh
npm test -- --maxWorkers=2
npm run build
ORIS_HUNK_EVIDENCE=/tmp/oris-24-evidence cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --lib git::ops::hunk -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-default-features --lib -- --test-threads=3
```

最终检查：前端 48 个文件、383 项测试通过；TypeScript/Vite 生产构建通过（保留原有大 chunk 提示）；相关 Rust 21 项通过。无桌面全量后端 190 通过、7 失败、5 忽略，失败与基线一致。

测试主体：`src-tauri/src/git/ops/hunk_tests.rs`、`src/fine-diff-model.test.ts`、`src/FineDiffPanel.test.tsx`、`src/DiffViewer.test.tsx`、`src/App.hunk.test.tsx`、`src/hunk-model.test.ts`。实现主体：`line_patch.rs`、`fine-diff-model.ts`、`fine-diff-decorations.ts`、`FineDiffPanel.tsx` 及阅读器的小补丁；共享入口仅做增量接入。

## 全量后端基线与平台缺口

无桌面全量 Rust 测试有 7 项失败。用 `git archive 4caedcb55d9aa97a31f3858fa4f68f29a7fb3608` 提取未修改基线，在同一环境、同一命令下复现同样的 7 项；基线 181 通过、7 失败、5 忽略。本单相关测试均通过，全量不能描述为全部通过。

| 原有失败 | 原因 |
| --- | --- |
| `a10_cancel_ends_the_process_tree_and_reports_refs`、`a10_no_output_timeout_ends_the_process_tree_and_reports_refs`、`b12_pull_times_out_without_output_and_push_can_be_cancelled_ending_the_process_tree` | 临时 shell 脚本未设 Unix 执行位，Git 返回 Permission denied |
| `b05_failed_stage_reports_git_error_and_leaves_repository_unchanged`、`rejects_paths_outside_the_worktree` | 使用 Windows 驱动器路径断言，Linux Path 语义不同 |
| `v2_d65_fetch_blocked_by_a_ref_lock_offers_removal_and_retry` | Git 2.52 的既存引用错误文本未匹配 staleLock 分支 |
| `ignored_storm_is_silent_and_real_changes_are_batched` | 10,000 次写入触发 inotify Rescan 的全局失效，零通知预期不成立 |

GUI 安全检查已读取 `AGENTS.md`、`scripts/focus-task02-window.ps1`，并检索全部脚本调用方，尤其 `task02-feedback-*.mjs`。当前危险脚本已在基线禁用，仅抛出错误、不调用窗口 API；调用方没有调用该脚本或原生激活 API。本单未修改危险调用，未启动或操作任何非测试应用窗口，未使用抢焦点逻辑。

未验证：Windows PowerShell desktop/release 构建、原生窗口焦点、真实滚动几何/长时 GUI 性能和 macOS。当前环境不提供隔离 Windows 桌面，未进行真实焦点测试。已有 GUI 性能历史数据不作为本单实测证据。测试临时仓库由 TempDir 清理；DOM 编辑器和事件监听器在卸载时清理。
