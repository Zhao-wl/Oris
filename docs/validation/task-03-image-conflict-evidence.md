# 任务 03 — 图片与冲突只读查看实现证据

日期：2026-09-23。执行会话 `01a0cd01-3e4f-70d3-a066-e97cfa7e9e43`，角色：任务 03 执行；父会话 `01a0c6f9-8a2d-7432-aaac-0d1e3bb20ea2`。

状态：**Blocked／待平台验收**。A/B 可执行实现及非 GUI 自动验证完成，源码与非 GUI 自动验证基础覆盖检查已通过。**不宣称 Windows WebView2 / macOS WKWebView 最终通过**，任务完成勾选保持未勾选。

总控内部 `task03_coverage` 只读基础检查已通过：当前源码及既有非 GUI 自动验证基本覆盖 A/B，未发现明确实现遗漏。此次检查未重跑测试，也不是技术深审；不替代真实平台验收。

## 基线和授权

用户已明确授权任务 03 开发，按 A→B 执行；01/02 原 macOS、GUI/watcher 真机证据缺口不阻断本轮非 GUI 开发，但没有解除最终门禁。未启动任务 04–06。

实际开始时 HEAD 为 `12444f61e11b494e5f05404641f4507b2b2ac4a1`，不是交接中的 `3c1c2d1`。开始时已有 `scripts/task02-feedback-projects.mjs` 修改。执行期间另有共享工作区修改出现于 `scripts/build-release.ps1`、`src/DiffViewer.tsx`、`src/diff-scroll.ts`、`src/diff-scroll.test.ts` 及 `src/styles.css` 的既有布局规则，均保留，不归属为本任务实现。最终产物基于共享工作区实际文件构建，源码 SHA256 清单区分实际版本。

未 stage、commit、push、reset、unstage；未重建 Git、切分支或创建 worktree。未改用户 README、AGENTS、研究/设计效果文件，也未修改“阅读位置已调整”的既有逻辑。

## 实现

- 后端 `src-tauri/src/git/media.rs`：按真实 blob OID 读取原始内容，工作区逐层拒绝 symlink/非普通文件；20 MiB 有界读取，签名/容器/尺寸/动画预检及完整图片解码验证。仅开启 image crate 的 PNG/JPEG/WebP codecs，锁定版本见 Cargo.lock。
- `src/ImageViewer.tsx`：并排、滑动、共用坐标/等比例缩放、适应/原尺寸、棋盘格/浅深背景，逐侧字节、格式、存储/展示尺寸、EXIF 方向；缺失侧单栏，失败侧保留原因与另一侧。滑动叠层具有独立背景，不把透明像素与旧图混合成伪新图。
- JPEG 明确采用 EXIF 方向展示；后端测试 EXIF 1–8 的元信息和定向尺寸，前端使用 WebView `image-orientation: from-image`。**WebView2/WKWebView 实际方向及色彩渲染尚未验证**，不承诺专业校色或像素一致性。
- `src-tauri/src/git.rs`：以 `ls-files --unmerged -z` 获取冲突路径，按 stage mode/OID 原样读取；默认 stage 2→3，可选择 Base/stage 2/stage 3/当前 WT。特殊 mode 明确降级，无 Accept、编辑、写 index、merge/rebase 或下载入口。版本名称不解释成“我的/远端”。
- 缺失、已有空文件、读取失败、未知字节数分开表达；未知大小不显示为 0。普通内容中的冲突标记不触发冲突判断。一侧文本失败仍复用现有阅读器显示可用侧；跨侧差异计数不可计算时不显示伪 0。
- 不缓存图片载荷或冲突四版本。图片 Blob URL 在替换/卸载时 revoke；IPC 内容读取串行，排队的旧请求拒绝，取消在读取开始/两侧之间/返回后检查。已经进入第三方同步解码的单侧工作会运行到有界解码返回，不能承诺中途抢占该解码器。
- repo/request/revision 校验保留；图片/冲突额外核对 watcher generation，外部变化清除旧显示并等待符合既有 focus+visible 条件的刷新；显式本地刷新可用。未重写现有项目标签、轨道、文本搜索与主题逻辑。

## 固定预算与证据边界

实施前固定：每侧输入 ≤20 MiB，边长 ≤16,384，单图及双侧总计 ≤40,000,000 像素；受控图片分配参考 ≤256 MiB。保留既有文本 5 MiB、100,000 行、单行 100,000 字符限制。

图片预检还使用 `max(RGBA像素×4, decoder.total_bytes) + 输入字节×8` 估算载荷/IPC/base64/Blob 占用，并从双侧 256 MiB 预算扣除，解码器本身设置分配限额。超估算预算也明确降级。**这是受控估算，不等于原生解码器、GPU 或全进程树的真实硬上限**；全进程树实测尚缺。

| 验收子集 | 本轮运行证据 | 范围/限制 |
| --- | --- | --- |
| F01 三范围 | `real_git_three_scopes_missing_empty_bad_and_readonly`：同一路径 HEAD PNG 2×3、Index JPEG 4×5、WT WebP 6×7，逐侧尺寸/内容对照 | 真 Git blob 和 WT；包含扩展名与签名不同 |
| F02 存在性 | 空 `.png` 解码失败与真正缺失分开；新增/删除单栏组件测试；冲突空 stage 2 与缺 stage 分开 | 组件为 jsdom，非原生 UI |
| F06/F07 | PNG/JPEG/WebP 完整解码；透明 RGBA、不同尺寸；EXIF 1–8；截断、零字节、APNG、动画 WebP 降级 | 动画检测使用容器 chunk，非压缩字节子串匹配 |
| F08 | 20 MiB 字节临界±1有界文件读取；边长16,384及+1；像素/双侧剩余额度/分配预算边界；显式40 MP完整解码探针通过 | 字节边界夹具为不可解码填充数据，用于验证读取预算，不宣称所有20 MiB图像都能显示 |
| F09/F10 真实操作 | UU、AA、UD、DU、rename/delete、rename/rename、binary、真实PNG冲突、rebase；三范围×六种双端组合逐侧对照 Git OID/内容；删除WT冲突标记仍为冲突 | 真实 merge/rebase 只运行于本轮临时仓库 |
| F10 受控index | DD/AU/UA及所有缺stage组合；stage2为空blob | `update-index --index-info` 夹具，明确不冒充真实merge生成证据 |
| 错误/安全mode | 缺对象保留OID且不是missing；120000 mode拒绝；普通标记文本不判冲突；一侧失败保留可读侧 | 未实现专用LFS、submodule、symlink查看 |
| 外部变化/取消 | 外部add解决后旧revision拒绝、新列表无conflict；前端旧版本结果/读取中失效结果丢弃；取消后可再次读取；后端两侧之间取消 | watcher事件在组件测试中受控注入，非原生watcher验收 |
| F14 只读 | 对三范围及冲突六组合，临时仓库包括`.git`的全文件字节清单前后相同；另检查index/config与driver/filter/textconv/fsmonitor标记程序未运行 | 产品只运行只读命令，夹具搭建写操作与产品读取分开 |
| F15 资源 | 30次组件重挂载，60个图片URL全部释放；不进入文本缓存；30次真实文本/图片/冲突混合后端读取 | 未运行原生WebView和跨平台全进程树性能测试 |

## 命令与结果

运行日志在 `artifacts/task-03/runtime/`（本地、不纳入源码）：

- `npm test`：73 passed，10 files；含既有01/02回归及本轮组件/路由/过期隔离测试。`frontend-tests.log`。
- `npm run build`：通过；保留 Vite 原有 >500 kB chunk 提示，不属于运行失败。`frontend-build.log`。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib`：**20 passed，0 failed，4 ignored**，119.27 s；4个默认跳过项中本轮图片边界与混合探针已单独执行通过，另2个为01/02旧性能探针。本轮没有重复宣称旧探针通过。`backend-tests.log`。
- `cargo test ... forty_megapixel_decode_boundary -- --ignored --nocapture`：通过，完整40 MP解码及拒绝边界，12.64 s。`pixel-boundary.log`。
- `cargo test ... thirty_mixed_reads -- --ignored --nocapture`：通过，30次，图片1280×720 RGBA；后端P50 **586.63 ms**、P95 **694.61 ms**；每次读取结果释放后工作集采样最大 **7.45 MiB**、末次 **7.43 MiB**。`backend-performance.log`。

上述后端时延包括每次snapshot+内容读取，不含WebView传输/首屏；工作集是每次释放后的采样，不是解码瞬时峰值。未用这些数值宣称 S 数据集热切换、未缓存首屏、400 MiB进程树或F15完整通过，既有性能目标未放宽。

构建命令级环境：`CARGO_TARGET_DIR=D:/Projects/Research/Oris/artifacts/task-03/build`；保留Rust运行库优先，只为该命令加入现有MinGW binutils及MSYS2 gcc路径。`npm run tauri -- build --no-bundle` 输出独立 `artifacts/task-03/build/release/oris.exe`，不覆盖旧交付exe，没有启动该窗口。最终SHA见下方交付版本。

## GUI 安全、平台与未验证项

本轮审查 `scripts/focus-task02-window.ps1` 与 `task02-feedback-*.mjs`：focus脚本直接throw，不调用窗口API；反馈入口保持throw/import禁用guard。**本轮没有修改或重新启用危险调用**；已有脚本WIP保留。未调用ShowWindow、SetForegroundWindow、AppActivate，未选择/操纵Codex、ChatGPT或其他窗口，未结束任何用户已有应用。

只执行无窗口Git/Rust测试、前端jsdom测试及构建。没有创建原生GUI测试窗口，临时Git仓库由tempfile清理；没有覆盖窗口遗留。

- Windows x64：后端测试、受控React/jsdom组件、前端构建及release编译有运行证据；**WebView2真实图像显示、方向/透明/滑动视觉、原生焦点、真实watcher联动以及进程树内存均未验收**。
- macOS 14+ Apple Silicon/WKWebView：本环境无设备，未运行，门禁保留。
- 不能把DOM/jsdom、EXIF元信息或静态CSS检查等同原生Windows焦点测试/跨平台图像渲染通过。
- 总控只读基础覆盖检查已通过；整体 A/B 与双平台最终验收仍未通过，验收框保持未勾选，验收标准不降低。04–06 未启动，不释放后继。

## 交付版本

- HEAD：`12444f61e11b494e5f05404641f4507b2b2ac4a1`，工作区未提交。
- 独立EXE：`artifacts/task-03/build/release/oris.exe`。
- EXE SHA256：`11482EC65B986EA3D7F3D2EEA19E9EED8F5589798ED27EF994F8CDA079CCFB9B`。
- 本轮编译后的全部前后端源码/锁文件SHA256：`artifacts/task-03/SHA256SUMS.txt`，包括共享工作区其他已保留修改，供总控核对实际基线。
- release构建日志：`artifacts/task-03/runtime/release-build.log`。此EXE仅编译，未进行原生GUI运行验收。

结论：实现及本轮可执行的非 GUI 验证已交付，源码与既有非 GUI 自动验证基础覆盖检查通过；任务整体为 **Blocked／待平台验收**。阻塞项为真实 WebView2/WKWebView 显示交互、原生 watcher/focus、跨平台 GUI 30 次混合切换与全进程树峰值/稳态内存证据。内部检查只读、未重跑测试、非技术深审；整体 A/B 和双平台最终验收未通过，验收框保持未勾选，04–06 未启动、不释放后继。

本次仅回写三份授权状态文档，未改产品或 build、未重测、未 stage/commit/push；HEAD 与上述 release SHA256 已只读复核未变，所有并行 WIP 保留。
