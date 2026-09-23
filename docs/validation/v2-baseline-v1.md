# V2 验收 §3–§4：一期（V1）性能基线

日期：2026-09-23。用途：为 V2-01 提供同一机器、同一方法、同一数据集的 V1 对照（[V2 验收计划 §3](v2-acceptance.md)“先测基线”）。**这不是发布性能报告**，也不替代 V1 任务 06 的合并发布验收。

## 被测版本与环境

| 项目 | 值 |
| --- | --- |
| 源码 | `main` @ `90ecf47`（未含 V2-01 改动） |
| 构建 | `scripts/build-release.ps1 -OutputRoot D:\Projects\Research\Oris-builds\v1-baseline`，release + custom protocol，`verify_release_entry` 通过 |
| oris.exe SHA-256 | `C39695EAF8A70ACE7A3FDBBC7AD005841C97C1096E4C77605AB7D96058814239` |
| WebView2Loader.dll SHA-256 | `8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C` |
| 机器 | Windows 11 Pro 10.0.22631，Intel Core i7-11700（16 逻辑处理器），47.7 GiB 内存，Toshiba KXG50ZNV256G NVMe SSD |
| 运行时 | WebView2 Runtime 153.0.4234.48，Git 2.44.0.windows.1，Node 22.18.0 |

机器内存高于 V1 §4 的 16 GiB 参考机，绝对值不能直接当作参考机结论；V1 与 V2-01 的对照在这台机器上同一时间段完成，可比。

## 方法

- 脚本：`scripts/perf/gui-probe.mjs`（`gui-lib.mjs`、`gui-fixtures.mjs`）。启动本轮测试实例时使用独立 WebView2 profile（`WEBVIEW2_USER_DATA_FOLDER`）与独立应用缓存目录，开启 CDP 端口，并核验 PID、可执行文件完整路径、主窗口句柄与 CDP 端口归属；不调用 `SetForegroundWindow`、`ShowWindow`、`AppActivate`，不枚举或操作其他应用窗口。结束时先温和关闭（`taskkill` 不带 `/F`，只针对已核验的 PID），超时才强制结束本实例进程树，并删除本轮 profile 与临时目录。
- 交互：CDP 在页面内派发 DOM 事件（点击、输入）。计时从派发动作开始，到断言首次成立（`MutationObserver` + 5 ms 轮询）后的下一帧（`requestAnimationFrame` + `setTimeout 0`）为止，包含渲染。**这是 CDP / DOM 模拟，不是真实鼠标或真实 Windows 焦点。**
- 为避免遮挡导致 WebView 暂停渲染，测试实例附加 `--disable-features=CalculateNativeWinOcclusion` 等参数；V1、V2 使用同一配置。
- 数据集：`scripts/perf/generate-datasets.mjs S` 生成 5 份 S（每份 10,000 个 tracked 文件、20,000 个提交、100 个变化文件、10,000 个被忽略文件），原件在 `%TEMP%\oris-gui\pristine\`，每次运行复制到新目录后先执行一次正常 `git status` 刷新 index stat，再用只读 status 预热到连续两次在最快值 1.3 倍以内（各仓库预热耗时记录在 `core.json` 的 `warmupStatusMs`，稳定在 240–280 ms）。
- 每个响应场景 30 次，P50 / P95 取升序第 `ceil(p × n)` 个样本；内存为整个进程树（oris.exe、6 个 msedgewebview2.exe 与 git 子进程）的工作集与私有字节，来自 `Win32_Process`。
- **未做真正冷 OS 缓存**：没有清空系统文件缓存的手段，所有场景都是 OS 缓存热、应用已运行（重启场景除外）。

## 结果（第二次运行，采用预热后的方法）

原始数据：`artifacts/gui-probe/v1-baseline/core.json`、`restart.json`（本地，已被 `.gitignore` 忽略）。单位 ms，`n=30`。

| V2 §3 场景 | 指标定义（本测量） | P50 | P95 | V2 S 目标 | V1 对照目标 |
| --- | --- | ---: | ---: | --- | --- |
| 首次打开 | 在路径栏添加 S1 → 文件列表 65 行可交互（应用已运行） | 1115.6 | 1186.4 | ≤ 1500 | ≤ 3000 |
| 再次打开（重启） | 窗口就绪（页面导航开始）→ 列表出现；同进程页面重载近似 | 788.8 | 948.4 | ≤ 300（显示快照） | — |
| 再次打开（重启） | 同上 → 校验完成（V1 无快照，列表出现即完成） | 788.8 | 948.4 | 同首次打开 | — |
| 再次打开（冷进程上界） | 进程启动 → 首次 CDP 轮询看到列表（含框架开销） | 3066.0 | 3305.7 | 仅参考 | — |
| 热项目切换 | 点击标签 → 目标项目列表、选中文件与 diff 可读 | 27.5 | 30.8 | ≤ 100 | ≤ 200 |
| 后台 dirty 项目切回 | 后台项目新增未跟踪文件 1.2 s 后切回 → 新文件出现在列表 | 980.9 | 1218.7 | ≤ 800 | — |
| 切换显示区域 | 点击范围 → 新范围列表（行数正确）与选中文件 diff 可读 | 30.9 | 34.9 | ≤ 50 且不启动 Git | — |
| 已缓存文件切换 | 两个已读文件来回切换 → 正文含期望文本 | 19.6 | 24.0 | ≤ 100 | ≤ 200 |
| 相邻文件切换 | 选中文件静置 800 ms 后切到下一文件（V1 无预取，等同未缓存） | 439.6 | 452.8 | ≤ 100（预取） | — |
| 未缓存常用文件 | 从未读取且不相邻的文件 → 正文显示 | 438.4 | 485.7 | ≤ 400 | ≤ 1000 |
| 外部变化 | 外部改写选中文件 → 界面显示新内容 | 未测到 | 未测到 | ≤ 1000 | — |

- **外部变化 30/30 超时（8 s）**：测试窗口始终没有获得原生焦点（`focusAtStart` / `focusAtEnd` 均为 false），而 V1 设计上只在原生窗口获得焦点且可见时自动刷新。按 AGENTS.md 不能在共享桌面制造前台切换，因此该行记为“未测（需要真实前台焦点）”，不是性能失败，也不是通过。
- **切换显示区域的 Git 进程数**（`trace.json`，`GIT_TRACE2_EVENT` 每进程一个文件，动作后静置 1.5 s 计数）：V1 每次切换启动 6–26 个 Git 进程（范围快照过期时重新扫描），不满足“不启动 Git 进程”。首次打开 17 个、热切换 6 个、切换文件 8 个、手动刷新 14 个；静置 10 s 为 0。

| V2 §4 指标 | 结果 | 目标 |
| --- | --- | --- |
| 5 项目热切换稳态（工作集 / 私有，中位数） | 462.1 / 358.0 MiB；其中 WebView2 进程组约 391 / 303 MiB，oris.exe 约 25 / 8 MiB | ≤ 400 MiB（未达标） |
| 200 次混合切换：第 20 次后到结束的增长 | 工作集 456.4 → 459.4 MiB（+0.7 %），峰值 465.4；私有 362.6 → 348.4 MiB（−3.9 %） | ≤ 10 %，无单调上升 |
| 200 次混合切换：线性趋势 | 工作集 +5.41 MiB / 100 次，私有 +2.03 MiB / 100 次（20 个采样点，波动大于斜率） | — |
| 空闲 65 s 后常驻 Git 子进程 | 0 个 | ≤ 5 个 |
| 缓存上限 | V1 前端 ContentCache 16 MiB / 12 项（`workspace-model.test.ts` 断言）；后端无对象缓存 | — |

## 第一次运行（保留，方法有缺陷）

原始数据：`artifacts/gui-probe/v1-baseline-run1/`。与第二次的差别：

1. **首次打开**：复制夹具后立即测量，前 13 次从 5.75 s 递减到 0.9 s 后稳定（P50 989.5、P95 5752.6 ms）。推测是刚复制的 10,000+ 个文件触发系统后台扫描；第二次在预热 status 稳定后测量，P95 1186.4 ms。两次都如实保留，本基线采用第二次。
2. **重启**：第一次在进程启动后由 node 轮询，30/30 次首次轮询时列表已经显示（CDP 连接与身份核验耗时 2 s 以上），得到的 2.35 s 只是上界。第二次改为在新文档中记录页面内时间点。
3. 其他场景两次一致：热切换 P95 33.4 / 30.8，已缓存 24.0 / 24.0，未缓存 896.4 / 485.7（第一次也受首轮扫描影响），dirty 切回 1239.9 / 1218.7，5 项目稳态工作集 471.4 / 462.1 MiB。

## 发现

- **F1（新发现，V1 只读边界问题）**：在 Git 2.44.0.windows.1 上，`git --no-optional-locks diff --name-status`（未暂存与 `HEAD` 两种形式）在工作区文件 stat 信息过期时仍会创建 `.git/index.lock` 并回写 index；`status --porcelain=v2` 与 `diff --cached` 不会。V1 的普通刷新因此会改写 `.git/index`，并触发自身 watcher 的全局失效事件，导致正在读取的冲突内容被判为“读取期间收到外部变化”而丢弃（见[任务 03 Windows 界面证据](task-03-windows-gui.md)的混合切换）。复现：临时仓库中提交文件后只改 mtime，再执行上述命令并观察 `.git`。V2-01 改用 status v2 与 `diff-files` / `diff-index`（plumbing，不回写）。
- V1 在本机 5 项目稳态已超过 400 MiB 进程树预算，主要来自 WebView2 进程组本身。

## 未验证与限制

- 真实冷 OS 缓存、16 GiB 参考机、L 数据集 GUI、macOS 14+ WKWebView：未运行。
- 外部变化到界面更新：未测（需要真实前台焦点；DOM / CDP 模拟不能替代）。
- 典型 diff 滚动帧间隔（V1 §4）不在 V2 §3 范围内，本轮未测。

## 复现与清理

```powershell
node scripts/perf/gui-probe.mjs --exe D:\Projects\Research\Oris-builds\v1-baseline\target\release\oris.exe --label v1-baseline --suite core,restart --iterations 30
```

第一次运行使用 `--label v1-baseline --suite core,trace,restart,task03`，结果目录随后改名为 `v1-baseline-run1`；本基线中的 trace 与任务 03 数据来自第一次运行（这两个套件不受预热缺陷影响）。

脚本结束时自动删除本轮 `%TEMP%\oris-gui\<label>-<时间>\`（测试仓库、profile、应用缓存）；5 份 S 原件保留在 `%TEMP%\oris-gui\pristine\` 以便复测，清理命令见[长链路总结](long-chain-2026-09-summary.md)。
