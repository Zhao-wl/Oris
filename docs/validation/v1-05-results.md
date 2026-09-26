# 一期 05 完整阅读体验与特殊文件：实现与验收结果

日期：2026-09-26（长链运行编号 20260926-1014）。任务：[05 完整阅读体验与特殊文件](../tasks/05-diff-experience.md)。依据：[V1 验收计划](v1-acceptance.md) A06、A11、A12、A14 的阅读部分；[研究 04](../research/04-jetbrains-diff-behavior.md)、[研究 05](../research/05-unaligned-diff-scroll.md)、[研究 06](../research/06-file-types-diff-support.md) §5；字号 / 主题复用 [V2-06](v2-06-results.md) 的设置。

结论：**功能验收通过（Windows）**。A06、A11、A12 的界面验收 37/37 通过，只读指纹无变化；本阶段相关的性能预算中，文件切换、典型滚动通过；**字号切换在“滚动到 3,000 行文件中部”时 P95 107.6 ms，超过 100 ms 预算**（main 同场景 112 ms，不是本阶段退步；本阶段已把它从 149.9 ms 降下来，文件顶部为 31 ms），交给发布性能测试按其流程处理。未验证：macOS（用户口头确认，范围未记录，见下文）、Mac Retina、真实系统高 DPI、真实鼠标键盘与 Windows 焦点。

## 版本

- 分支 `feat/v1-05`（自 main `4b9694a`）：`a12d027` 功能、第二个提交为外观切换优化与验收脚本、之后为回归与文档提交（合入信息见 [长链总结](long-chain-v1-05-v2-05-v1-06-summary.md)）。
- 验收构建：`D:\Projects\Research\Oris-builds\v1-05\target\release\oris.exe`，SHA-256 `57B70C7B49B4FB68B3ED98D1168F831FAC9FD0DD0031C263A9CAF03D1AC8EDC2`，`scripts/build-release.ps1` 在 PowerShell 中构建，`verify_release_entry` 通过。
- 测试：后端 128 通过 / 5 忽略（基线 124 / 5，新增 `content_tests` 4 项；连续 2 次）；前端 204 通过（28 个文件；基线 186 / 26，新增 `reading-model.test.ts`、`App.reading.test.tsx` 与 `diff-core` 空白规则用例）；`npx tsc -b` 通过；desktop `cargo check` 无警告。
- 平台与工具：Windows 11 专业版 10.0.22631，Intel i7-11700（16 逻辑处理器），47.7 GiB 内存，NVMe SSD；WebView2 153.0.4234.48；Git 2.44.0.windows.1；Node v22.18.0。

## 开工盘点（已有 / 部分 / 缺失）

| 项 | 开工时 | 本阶段 |
| --- | --- | --- |
| 搜索、词 / 行高亮、同步滚动、导航计数、软换行、复制、选中同词 | 已有（任务 01 提前实施的切片） | 复核；前后差异增加 F7 / Shift+F7 |
| 空白处理 | 缺失 | “保留 / 忽略空白”，规则常驻可见 |
| 上下文逐段 / 全部展开 | 部分（只有逐段；统一视图折叠占位为英文） | “全部展开”（并排与统一）；统一视图占位中文 |
| 专注模式 | 缺失 | 专注 diff |
| 解码、EOL、无末尾换行 | 部分（只有严格 UTF-8；标题只显示右侧） | UTF-8 BOM、带 BOM 的 UTF-16；两侧编码 / BOM / 换行 / 末尾换行；文本之外的变化说明 |
| 长行 / 大文件 | 已有降级 | 说明“已显示范围：无”，可继续切换 |
| 其他二进制、SVG、LFS 指针、submodule、仅 mode 变化、符号链接 | 部分 / 缺失 | 逐类说明卡片（见 A11） |
| 键盘与可见焦点 | 部分 | F7、专注快捷键、编辑器键盘焦点描边、平台快捷键文字 |

## 实现

后端（`src-tauri/src/git.rs`、`git/media.rs`、`git/content.rs`、`git/status_v2.rs`）：
- 解码只接受严格 UTF-8（可带 BOM，显示时去掉 BOM）与带 BOM 的 UTF-16 LE/BE（严格校验代理项）；含 NUL 为二进制；其他字节为“编码不受支持”，说明原因，不猜测 GBK 等编码、不用替换字符继续（V2-D51 待定）。`contentId` 始终按原始字节计算。
- `TextSide` 增加 `bom`、`kind`（text / binary / unsupportedEncoding / tooLarge / missing / image / lfsPointer / gitlink / symlink / unavailable）。
- 非图片的 LFS 指针：照常显示指针文本，标出 oid、声明大小、本地缓存中是否已有对象（只比较文件大小，不下载、不运行 filter）。
- 子模块 gitlink：对象一侧显示记录的提交；工作区一侧只读取子模块的 `.git`（文件或目录，`gitdir:` 必须指向子模块目录或父仓库 commonDir 内）、`HEAD`、引用文件得到工作区 HEAD，不启动 Git、不初始化；附带 status v2 的“提交已变 / 有已跟踪修改 / 有未跟踪文件”标志。
- 符号链接：对象一侧读取 blob（目标路径），工作区一侧 `read_link`，只显示目标，不跟随；上级目录中的符号链接仍拒绝。
- 工作区一侧记录 status 的 mode，界面据此说明“仅文件模式变化”。

前端：
- 空白规则（`diff-core.ts`）：“忽略空白”与 `git diff -w` 一致，只略去两侧都只是行内空白的差异，空行增删仍显示；计数、高亮、导航、连接带都来自同一份 `DiffDocument`；`DiffCache` 按规则分键；切换规则只重新计算，不重新读取仓库；工具栏常驻“已忽略空白 · 略去 N 处”（默认保留，V2-D50 待定）。
- `reading-model.ts`：端点两侧“UTF-8 · BOM · CRLF · 无末尾换行”；文本之外的变化（编码、BOM、换行、末尾换行、mode）；“没有差异块但字节不同”时说明原因（不说“无变化”）；特殊文件说明；LFS 说明；平台快捷键文字（macOS 显示 ⌘ / ⇧）。
- `SpecialFileView`：二进制（两侧大小、内容是否不同）、编码不受支持、超预算（“已显示范围：无”）、子模块、符号链接；替代原来笼统的“内容已降级”遮罩。
- SVG 按源代码文本显示并说明“不渲染、不执行脚本”。
- “全部展开”：并排视图展开配对折叠区；统一视图按 `@codemirror/merge` 的折叠规则派发公开的 `uncollapseUnchanged`。
- 专注 diff：隐藏项目栏、路径栏、文件侧栏与底部 Git 区（Ctrl/Cmd+Shift+Enter，Esc 退出，V2-D52 待定）。
- 键盘：F7 / Shift+F7 前后差异；编辑器键盘聚焦时显示描边。

外观切换优化（发现于本阶段性能复测，见下文）：主题 / 语法高亮 / 字号扩展按方案与字号缓存；字号改由宿主元素的 `--diff-font-size` 决定，切换时不派发 reconfigure；配色只在方案变化时 reconfigure，只处理挂在页面上的编辑器；搜索与同词两类装饰合并为一次派发、空到空不派发；字号与配色由 DiffViewer 直接订阅。

## 验收逐项

界面脚本：`scripts/perf/v1-05-acceptance.mjs`（CDP 页面事件，报告 `artifacts/gui-probe/v1-05-acceptance/report.json`，截图同目录 `shots/`）。夹具在 `%TEMP%\oris-gui\` 下用真实 Git 生成，运行结束删除。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| A06 并排 / 统一、词 / 行、连接带 | 通过（Windows） | 并排：连接带、词级与行级底色存在，计数 = 差异块数（7）；按行高亮时无词级标记；统一视图差异数与并排一致 |
| A06 折叠、逐段 / 全部展开、折叠后导航 | 通过 | 折叠后展开一段（`expandedRegions = 1`），F7 导航计数不变；并排与统一视图“全部展开”后无折叠占位；统一视图占位文字为“展开 N 行未变化内容” |
| A06 搜索 | 通过 | Ctrl+F 打开，计数 `1/k`，Enter 到 `2/k`，当前命中单独高亮；Esc 关闭 |
| A06 选择复制 | 通过 | CDP 拖选 `computeValue`，copy 事件写入的文本与选区一致；选中同词高亮 ≥ 1 |
| A06 同步滚动 | 通过 | 右侧滚轮后左侧按差异映射跟随，master 为右侧 |
| A06 软换行后对应 | 通过 | 自动换行 + 对齐变化：每个差异块两侧上下边误差 ≤ 1.5 px |
| A06 字号 / 浅深主题 | 通过 | Ctrl+= / Ctrl+0、浅色 / 深色切换后编辑器 DOM 节点不变 |
| A06 空白规则 | 通过 | 忽略空白后计数减少、标记常驻；只有空白差异的 `src/ws.ts` 显示“忽略空白后没有差异”；恢复保留后差异回来；只读指纹不变 |
| A06 专注 diff | 通过 | Ctrl+Shift+Enter 后侧栏与项目栏 `display:none`、阅读区变宽，Esc 退出，编辑器不重建 |
| A11 其他二进制 | 通过 | “二进制文件 · 内容不同”，两侧 5 / 6 字节 |
| A11 SVG | 通过 | 按文本显示 `<script>`，页面内没有渲染 SVG，脚本未执行，说明“不执行” |
| A11 LFS 指针 | 通过 | 指针文本 + “Git LFS 指针…不会自动下载…本地缓存中没有对象” |
| A11 submodule gitlink | 通过 | “子模块（gitlink）· 子模块指向的提交已改变”，两侧提交；后端测试覆盖未初始化子模块与“有未跟踪文件”标志，且不创建 `.git` |
| A11 仅 mode 变化、符号链接 | 通过 | “文本内容相同，只有文件模式：100644 → 100755（可执行）”，差异数 0；符号链接两侧目标 `docs/old.md` → `docs/new.md` |
| A11 图片（复用任务 03） | 通过（集成复核） | 图片阅读器控件都可用 Tab 到达；配色随方案（V2-06 已逐套截图） |
| A12 中文 / 空格路径与内容 | 通过 | `中文 目录/说明 文件.md` 在列表与标题中正确显示，内容可读；后端 `a12_…` 断言中文路径与 😀 |
| A12 CRLF / LF | 通过 | 两侧标出 CRLF / LF，说明“文本内容相同，只有换行符：CRLF → LF。” |
| A12 无末尾换行 | 通过 | 标题“无末尾换行”，说明“移除末尾换行” |
| A12 编码失败 | 通过 | GBK 字节：“编码不受支持 · 内容不同”，不显示编辑器、不说无变化；后端测试覆盖 Latin-1、奇数字节 UTF-16、孤立代理项、BOM 后无效 UTF-8、UTF-32 BOM |
| A12 BOM、UTF-16 | 通过 | 新增 BOM：文本相同，说明“新增 BOM”；带 BOM 的 UTF-16 LE 按文本解码（“UTF-16 LE · BOM”） |
| 超预算明确降级、可切换 | 通过 | 120,000 行与单行 120,000 字符：“超出显示预算…已显示范围：无”；之后 Alt+↓ 切到其他文件 |
| 忽略空白不改仓库、不隐藏规则 | 通过 | 见 A06 空白规则；阅读前后工作区、index、refs、config 指纹一致 |
| 全键盘主要路径与可见焦点 | 通过（CDP 按键） | Tab 经过的 12 个控件都有可见焦点样式；Alt+↓ / Alt+↑ 切换文件；F7 导航；Ctrl+F 搜索；Ctrl+1..9 切项目（任务 02 已有） |
| Win11 高 DPI | 部分：只做了模拟 | 测试实例自己的设备像素比 1.5 / 2（`Emulation.setDeviceMetricsOverride`）下连接带与色标正常，**不是真实系统缩放** |
| Mac Retina | 未运行 | 见 macOS |
| 真实大文本 / 图片的计算与渲染记录 | 通过（记录） | 见性能复测 |

## 性能复测（Windows，release，CDP，n = 30）

负载：全程每 5 s 采样，外部进程合计 CPU P95 0.9%、最大 1.0%，没有超过 10% 的采样，没有作废重测。

| 场景 | P50 / P95 / 最大（ms） | 预算 | 结果 |
| --- | --- | --- | --- |
| 已缓存文件切换（S1 两个文件来回） | 21.4 / 29.2 / 30.5 | P95 ≤ 100 | 通过 |
| 未缓存常用文件（S1、S2，非相邻） | 25.5 / 30.3 / 30.6 | P95 ≤ 400 | 通过 |
| 典型 diff 滚动：并排（3,000 行、约 60 处差异，连续 12 s CDP 滚轮） | 帧间隔 9.9 / 10.7 / 20.6，长帧（> 50 ms）0 | P95 ≤ 33 | 通过 |
| 同上：并排 + 自动换行 + 对齐变化 | 9.9 / 10.7 / 59.1，长帧 1 | 记录 | — |
| 同上：统一视图 | 10.0 / 19.3 / 48.1，长帧 0 | 记录 | — |
| 大文本（80,000 行，3 个文件轮换，点击到正文可读） | 267.5 / 318.0 / 404.4；Worker 计算 17.1 / 32.1 | 记录 | — |
| 大图片（2,500×2,500 PNG 两侧，点击到两张图片解码完成） | 124.4 / 140.6 / 141.2 | 记录 | — |
| 切换配色（滚动后的 3,000 行文件） | 52.3 / 75.4 / 100.7 | P95 ≤ 100，不重建 | 通过 |
| 切换主题模式（同上） | 49.6 / 62.3 / 68.1 | 同上 | 通过 |
| 切换字号（同上） | 86.8 / **107.6** / 109.9 | 同上 | **未达标** |

编辑器在全部外观切换中没有重建（DOM 节点标记不变）。

字号切换的定位（`scripts/perf/appearance-probe.mjs`，含 CPU 采样与时间线）：
- 同一脚本在 main（`4b9694a`，构建 `CD1D549C…`）上：文件中部字号 P50 91 / P95 112 ms，配色 78、模式 73 ms，与本阶段开工时一致，**不是本阶段退步**；V2-06 验收时只在 60 行文件的顶部测过（26 ms）。
- 主要开销：字号改变后 CodeMirror 需要按新行高重新锚定滚动位置，两个编辑器各重新测量约 4 轮；每轮更新都会读取 DOM 选区，在 WebView2 中强制整页样式与布局（每次约 4–5 ms）。本阶段去掉了我们自己引起的部分（每次切换重复生成主题类名并重算语法高亮、逐个编辑器 reconfigure、滚动期间空的高亮派发、整个 App 重新渲染），文件顶部从 P95 55 降到 31 ms，文件中部从 149.9 降到 107.6 ms；剩下的是 CodeMirror 自身的测量循环。
- 交给发布性能测试（[任务 06](../tasks/06-performance-release.md)）按其流程处理：继续优化或需要取舍时再问用户。

## 回归（同一构建 `57B70C7B…`）

| 界面验收 | 结果 | 报告 |
| --- | --- | --- |
| v1-04（历史、比较、文件历史、本地 fetch；不含真实远端） | 32/32 | `artifacts/gui-probe/v1-05-reg-v1-04/` |
| v2-03（stash 与分支） | 24/24 | `artifacts/gui-probe/ab2-v2-03-v1-05-1/`、`…-2/` |
| v2-04 `--only local`（拉取 / 推送 / 合并，本地 bare remote） | 18/18 | `artifacts/gui-probe/v1-05-reg-v2-04/` |
| v2-06（21 套配色，切换 22–47 ms） | 20 项通过 | `artifacts/gui-probe/v2-06-acceptance/` |
| history-feedback（历史页改造） | 12/12 | `artifacts/gui-probe/v1-05-reg-history-feedback/` |
| gui-probe `--suite task03`（图片与冲突） | 17/17；30 次混合切换 P95 31.7 ms | `artifacts/gui-probe/v1-05-reg-task03/` |

回归中发现并处理的问题（都不是本阶段的产品退步）：
- v1-04 A10 读取 `.log-fetch-time`，该元素在历史页改造（`866a799`，2026-09-25）中已移除，获取时间改在标题栏“同步”按钮的提示与同步弹层中显示；脚本改为读取同步按钮的提示后通过。
- v2-03 B09“弹出成功”一步在刷新之后立即点选 stash 并点“弹出”，没有等待刷新后 stash 列表重新读取完成，存在竞态：本阶段构建 4 次中 3 次失败，main 3 次都通过。脚本改为等列表稳定、选中第 0 条且详情可用后再点“弹出”，两个构建各跑 2 次都通过，选中到详情可用的时间相同（本阶段 162–166 ms，main 164–168 ms）。
- 后端 `resident_cat_file_has_no_console_host` 在并行测试下偶发失败：它假设读取会启动常驻 `cat-file`，但 BlobCache 按 OID 全局共享，别的测试（包括本阶段新增的 `content_tests`）读过相同内容 `x\n` 时直接命中缓存。改为使用唯一内容后连续 2 次全部通过。

## 与参考图和技术方案的差异

- 空白规则只有“保留 / 忽略空白”两档，放在 diff 工具栏的下拉框；参考图中的“空白规则”位置与此一致，更细的规则（忽略行尾空白、忽略空行）未做（V2-D50）。
- 专注 diff 以工具栏开关与快捷键进入，不提供全屏。
- 统一视图中删除行显示为只读块，搜索不会命中删除行（`unifiedMergeView` 的限制）；并排视图两侧都可搜索。
- 编码范围按研究 06 §5：不猜测旧式编码，也没有手动选择编码（V2-D51）。
- 技术方案 §5 `DiffDocument` 的“空白规则”字段已落地为 `whitespace` 与 `ignoredWhitespace`。

## 未验证项

- **macOS 全部**：用户在 macOS 真机上验证（2026-09-25），Oris 自动化未复核。机型 / 芯片、内存、macOS 版本、被测构建、覆盖范围、原始记录位置：用户口头确认，范围未记录。本阶段的实现晚于该次验证，一期 06 要求的最终版本 macOS 复测仍是待办，交给用户。
- Mac Retina；真实系统高 DPI（只用 WebView2 设备像素比模拟）。
- 真实鼠标、键盘与 Windows 焦点：所有界面证据都是 CDP 页面事件；焦点样式检查的是 `:focus-visible` 与描边，不等于真实 Windows 前后台焦点。
- 未初始化子模块、“有未跟踪文件”的界面展示只在后端测试与前端单元测试中覆盖，界面脚本覆盖的是已初始化且提交已改变的子模块。

## 待用户决定

V2-D50–V2-D53（[决策登记](../decisions/v2-decisions.md#待用户决定)）：空白规则的选项与默认、编码范围与是否增加手动编码白名单、F7 与专注 diff 的快捷键、符号链接 / 子模块 / LFS 的展示方式。

## 复现

```powershell
& .\scripts\build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v1-05
node scripts/perf/v1-05-acceptance.mjs --exe D:\Projects\Research\Oris-builds\v1-05\target\release\oris.exe
node scripts/perf/appearance-probe.mjs --exe D:\Projects\Research\Oris-builds\v1-05\target\release\oris.exe --scrolled --trace
```

GUI 安全：开工前复查 `scripts/focus-task02-window.ps1` 与 `scripts/task02-feedback-*.mjs`，均为直接抛错的禁用桩，没有其他脚本调用 SetForegroundWindow / ShowWindow / AppActivate；本阶段脚本只通过 `gui-lib.mjs` 的 `launchOris` 启动并核验自己的实例（PID、完整路径、主窗口句柄、CDP 端口归属），使用独立 WebView2 profile 与 `ORIS_APP_CACHE_DIR`，结束时正常关闭并删除本轮临时目录；负载监测只读查询性能计数器。
