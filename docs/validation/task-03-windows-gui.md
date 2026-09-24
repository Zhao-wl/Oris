# 任务 03 Windows WebView2 界面证据（界面验证批次）

日期：2026-09-23。依据：[任务 03](../tasks/03-image-conflict-diff.md)、[收尾记录](task-03-closeout.md)、[V1 验收 §2 任务 03 边界](v1-acceptance.md)、V2-D27。

## 被测版本

- V1 基线 release：源码 `main` @ `90ecf47`，`D:\Projects\Research\Oris-builds\v1-baseline\target\release\oris.exe`，SHA-256 `C39695EAF8A70ACE7A3FDBBC7AD005841C97C1096E4C77605AB7D96058814239`；`WebView2Loader.dll` SHA-256 `8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C`。
- 平台：Windows 11 Pro 10.0.22631，WebView2 Runtime 153.0.4234.48，Git 2.44.0.windows.1。
- 脚本：`scripts/perf/gui-probe.mjs --suite task03`（夹具由 `scripts/perf/gui-fixtures.mjs` 在 `%TEMP%\oris-gui\` 下生成，结束后删除）。原始结果：`artifacts/gui-probe/v1-baseline-run1/task03.json` 与同目录截图 `task03-*.png`（本地，已被忽略）。

## 夹具（全部在仓库外的临时目录中由真实 Git 生成）

- 图片仓库：`img/photo.png`（HEAD 64×48 → 工作区 96×64）、`img/alpha.png`（半透明 RGBA，暂存修改）、`img/orient.jpg`（同一像素数据，HEAD 为 EXIF 1，工作区为 EXIF 6；左上 10×10 红块用于方向判定）、`img/pic.webp`（WebView2 自身的 canvas 编码器生成的 WebP）、`img/broken.png`（工作区截断为 40 字节）、`img/anim.png`（工作区为带 `acTL` 的 APNG）、`img/added.png`（未跟踪）、`img/removed.png`（工作区删除）、`notes.txt`（文本修改）。
- 冲突仓库：真实 `git merge` 得到 `c.txt`（UU 文本）、`img.png`（UU 图片：stage 2 为 24×32 红、stage 3 为 32×24 蓝）、`md.txt`（UD：theirs 删除），另有未暂存修改 `plain.txt`。`git ls-files --unmerged` 的 stage OID 记录在 `task03.json` 的 `fixtures.unmerged`。

## 逐项结果

判定来自 WebView2 的实际解码结果（`<img>` 的 `complete` / `naturalWidth`）与截图像素（CDP `Page.captureScreenshot` 后在 node 中解码 PNG 取样），不是 jsdom。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 并排：两侧 PNG 由 WebView2 解码，元数据显示 64×48 / 96×64 | 通过 | `task03-split-sizes.png` |
| 滑动：单画布叠层，分界 30% 时叠层 `clip-path: inset(0 70% 0 0)`，画布宽按较大图 | 通过 | `task03-slide-30.png` |
| 缩放：原始尺寸 100%（工作区图显示宽 96 px）→ 放大 125%（120 px）→ 缩小回 100% | 通过 | `task03-zoom-125.png` |
| 透明：透明像素取样为棋盘格灰 `#DDDDDD`、深色 `#222222`、浅色 `#FFFFFF`；不透明区域为图片颜色 | 通过 | `task03-alpha-checker.png`、`task03-alpha-dark.png` |
| 方向：EXIF 1 显示 40×20 且红块在左上；EXIF 6 显示 20×40 且红块在右上（像素取样） | 通过 | `task03-orientation.png` |
| WebP：两侧由 WebView2 解码 | 通过 | `task03-webp.png` |
| 坏图降级：截断 PNG 一侧显示“PNG 块截断”，HEAD 侧仍显示 | 通过 | `task03-broken.png` |
| 动画 APNG 降级并说明原因（“动画 APNG/WebP 不支持预览”） | 通过 | `task03-apng.png` |
| 新增（未跟踪）单栏，滑动选项不可用 | 通过 | `task03-added-single.png` |
| 删除单栏 | 通过 | `task03-removed-single.png` |
| 冲突 UU 文本：默认 stage 2 → stage 3 | 通过 | `task03-conflict-default.png` |
| 冲突：选择 Base（stage 1）→ stage 2 | 通过 | `task03-conflict-base-ours.png` |
| 冲突：选择 stage 3 → 当前工作区（含冲突标记） | 通过 | `task03-conflict-theirs-wt.png` |
| 冲突图片：stage 2 / stage 3 由图片阅读器显示正确尺寸 | 通过 | `task03-conflict-image.png` |
| 冲突 UD：stage 3 显示“缺失 / 删除”，stage 2 可读并显示 mode / OID | 通过 | `task03-conflict-ud.png` |
| 30 次图片 / 文本 / 冲突混合切换全部完成 | **失败**：22/30 完成，8 次冲突项（`c.txt`、`img.png` 各 4 次）15 s 内未显示 | `task03.json` 的 `mixed30` |
| 只读：两个夹具仓库的工作区与 `.git`（不含 objects / logs）读取前后逐字节不变 | 通过（29 / 31 个文件，0 处变化） | `task03.json` 的 `readonly` |

混合切换（22 次成功样本）：P50 367.0 ms、P95 389.1 ms、最大 465.4 ms；整个进程树工作集开始 438.5 MiB、峰值 440.6 MiB、结束 430.8 MiB，私有字节峰值 372.1 MiB。

### 混合切换失败的原因

8 次失败全部发生在“切到冲突仓库后读取冲突文件”。复现（`artifacts/long-chain/d3.mjs`，订阅 `repository-invalidated` 事件）显示：切回冲突项目时，V1 的后台刷新执行 `git --no-optional-locks diff --name-status`，Git 在 stat 过期时创建 `.git/index.lock` 并回写 index，V1 自身的 watcher 把它当作全局外部变化，冲突读取因此被判为“读取期间收到外部变化，旧内容已丢弃，请刷新”。这是 V1 只读路径的缺陷（F1，见 [V1 基线](v2-baseline-v1.md#发现)），不是测试脚本问题。另一个可见现象：切回冲突项目时已选中的冲突文件先被清空为“选择一个变化文件开始阅读”。

## 状态结论

- 在 V1 基线版本上，图片与冲突的界面功能在真实 WebView2 中逐项通过，但“30 次混合切换”因 F1 失败，**Windows 界面证据不齐全，任务 03 保持原状态（Blocked／待平台验收）**。
- F1 由 V2-01 修复后，在 V2-01 最终 release（`9f52588`，SHA-256 `F703A0F2…`）上重跑同一套件：17/17 通过，混合切换 30/30（P50 13.2 / P95 25.1 ms，进程树工作集 442.0 → 峰值 488.5 → 485.1 MiB），见 [V2-01 结果](v2-01-results.md#任务-03-回归)。据此任务 03 更新为“Windows 基础通过，macOS 待验证”。
- macOS 14+ Apple Silicon / WKWebView：未运行。

## GUI 安全说明（AGENTS.md 交付要求）

- **危险调用**：本轮开始前复查了 `scripts/focus-task02-window.ps1`（仍然只抛出“Native window activation is disabled”）与 `scripts/task02-feedback-*.mjs`（`focus`、`interrupted` 首行直接抛错；`smoke`、`projects`、`stages`、`switch` 首行导入 `task02-gui-disabled.mjs` 后立即抛错）。静态搜索 `scripts/` 下的 `SetForegroundWindow`、`ShowWindow`、`AppActivate`，只在新脚本 `gui-lib.mjs` 的注释（声明不调用）中出现。本轮没有修改或运行这些旧脚本，也没有复用其中的抢焦点逻辑。
- **如何确保不操作其他应用窗口**：新脚本只启动自己的 `oris.exe` 子进程，使用独立 WebView2 profile 与应用缓存目录；在连接 CDP 前只读核验 PID、可执行文件完整路径、主窗口句柄（非 0、标题为 Oris）以及 CDP 端口的监听进程属于该 PID 的进程树，核验失败即结束本实例并中止。全部交互经 CDP 在页面内完成；原生层只有只读的进程 / 端口查询和结束本实例（先 `taskkill /PID <已核验 PID>` 温和关闭，超时才 `/T /F`）。没有调用 `SetForegroundWindow`、`ShowWindow`、`AppActivate`，没有按进程名或窗口标题选择窗口，没有触碰 Codex、ChatGPT 或其他应用窗口；每轮结束后本实例进程均已退出（日志记录 graceful 或 forced-tree），profile 与临时目录已删除。
- **真实焦点**：测试期间测试窗口从未获得原生焦点（`plugin:window|is_focused` 始终为 false）。本报告中的所有交互都属于 **CDP / DOM 模拟**，不能作为真实 Windows 前后台切换或真实鼠标操作的证据；真实焦点相关行为（例如回到前台后的自动核对）未验证。
