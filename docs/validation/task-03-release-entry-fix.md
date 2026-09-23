# Task 03：仓外 EXE 目录索引入口回归

## 确切原因

上轮交付 `EC343D1363F10FEDDEFA8BF8454C723774C2C417BFB915719BCF8D183B7302FA` 时，我在临时配置里把 `frontendDist` 写成了 `D:/Projects/Research/Oris-builds/task03-stale-fix/dist`，且只验证编译，没有验证编译后的应用入口。这是本次回归的直接配置错误。

实际安装的 Tauri 解析器（tauri-utils 2.9.3）将 `FrontendDist` 定义为 untagged 枚举，先尝试 `Url`，再尝试 `Directory`。本轮对旧配置执行生产构建解析，实际输出：

```text
Oris production frontendDist parsed as Url(Url { scheme: "d", ... path: "/Projects/Research/Oris-builds/task03-stale-fix/dist", ... })
```

证据链：

1. 旧 `build-config.json` 确实传入上述带盘符字符串；旧 tauri 编译指纹包含 `custom-protocol`，所以本次不是遗漏该 feature。
2. tauri-codegen 2.6.3 `src/context.rs` 182–193：`FrontendDist::Url` 生成空资产集合；`Directory` 才从文件目录嵌入资源。
3. tauri 2.11.6 `src/manager/mod.rs` 的 `get_app_url`：production 的 Url 直接作为应用 URL。`src/manager/webview.rs` 默认 `App(index.html)` 分支直接使用 base URL，不再追加 index.html。
4. 旧 EXE 二进制偏移 14398056 确实包含 `d:/Projects/Research/Oris-builds/task03-stale-fix/dist`；旧 index 引用的 JS/CSS/Worker 文件名未检出。字符串扫描单独不是资源缺失的充分证明，与实际配置解析、codegen 分支及用户截图共同构成证据。
5. 用户截图显示的正是该目录的索引及 `assets/`、`index.html`，而不是 React 应用。WebView 如何把盘符 scheme 转为文件导航未另做原生浏览器内部追踪，不将该内部转换细节冒充已测。

## 最小修复与防回归

- `scripts/build-release.ps1 -OutputRoot ...` 生成相对 `frontendDist`：`../../Oris-builds/task03-entry-fix/dist`，不再把 Windows 盘符交给 URL/目录联合解析器。不同盘符无法生成相对目录时明确报错。
- 独立前端构建通过 PowerShell 的结构化参数执行 TypeScript 与 Vite，临时配置将 `beforeBuildCommand` 设为 null，避免再拼接嵌套 shell 引号。
- release 构建显式启用 `tauri/custom-protocol`；`build.rs` 使用相同 Tauri 类型检查最终 frontendDist，拒绝 Url，并要求目录内有 index.html。旧配置的负向回归现在在构建阶段明确失败，日志 `bad-config-rejected.log`，未覆盖旧 EXE。
- 抽取原有 `tauri::generate_context!()` 为 `application_context()`；主程序继续使用该函数启动，独立 `verify_release_entry` example 读取同一函数提供的编译上下文，不创建 Builder、应用、WebView 或窗口。
- 探针检查非 dev/custom-protocol、Directory 类型、主窗口 `App(index.html)`、实际读取嵌入 index、React root、HTML 所引用 JS/CSS 的嵌入数据及 diff worker。脚本只有在探针通过后才报告“打包完成”。
- Tauri 默认只给 bins 链接 Windows Common Controls manifest；为无窗口 example 链接同一资源，运行时从 release 目录查找匹配 WebView2Loader。该调整只涉及验证程序启动条件。

## 构建与验证记录

本轮独立输出：`D:/Projects/Research/Oris-builds/task03-entry-fix`。

实际主命令：

```powershell
powershell -NoProfile -File scripts/build-release.ps1 -OutputRoot D:/Projects/Research/Oris-builds/task03-entry-fix
```

脚本调用 `tauri build --features tauri/custom-protocol --config .../build-config.json --no-bundle`，随后调用 `cargo run --manifest-path src-tauri/Cargo.toml --release --example verify_release_entry --features tauri/custom-protocol`。

前端 82 passed / 11 files；TypeScript 构建检查通过。后端 stale/图片/冲突算法本轮未修改，不重述上轮 30 项结果为本轮重跑。新产物包含共享工作区已有的 DiffViewer.tsx 变化，本轮未编辑或回退它；其余前轮 App/git/read_guard/media 修复保持原散列。

中间失败保留：第一版嵌套 beforeBuildCommand 的引号被传给 Vite 作为路径字符，已改为结构化参数；一次前端构建顺序错误导致 CLI 找不到 dist，已调整到 Tauri 构建之前；初版无窗口 example 因 Windows 动态库入口加载条件不全未执行测试体，不能据此声称入口验证通过。最终运行结果与产物散列补记如下。

## GUI 与工作区边界

本轮没有启动主 Oris EXE，没有新建或激活 GUI 窗口，没有 ShowWindow/SetForegroundWindow/AppActivate，没有操作 Codex 或其他应用窗口，也没有结束用户实例。未调用或重新启用旧 focus/task02-feedback GUI 脚本，未修改其危险调用。无窗口资源读取证明编译配置及嵌入资源查找链，不等于 WebView2 执行 JavaScript/绘制界面或真实 Windows 焦点测试。真实 GUI、WKWebView、焦点切换与进程树资源仍未验证。

未 stage/commit/push；未修改产品功能、GUI 规则、总体门禁或共享设计文档。旧运行 EXE、旧错误交付 EXE 均保留。源码/依赖/配置/脚本/example 共 47 文件快照已记录，用于核对构建期间漂移。

## 最终入口验证及产物

构建流程整体通过，367.7 秒。随后将探针 EXE 与匹配 DLL 复制到 `isolated-probe`（没有 index、JS、CSS 或 dist），在该目录执行也通过，见 `isolated-entry-probe.log`：

```text
ENTRY_DIST=Some(Directory("../../Oris-builds/task03-entry-fix/dist"))
CUSTOM_PROTOCOL=true
EMBEDDED_ASSETS=4
WINDOW_URL=App("index.html")
RESOURCE_OK=/assets/index-CxxL6XLO.js bytes=712642
RESOURCE_OK=/assets/index-BYwYbE0N.css bytes=19126
ENTRY_ASSETS_PASS index_bytes=442 scripts=1 styles=1 root_request=index.html
```

Worker 存在断言亦通过。探针从编译上下文取得 index 内容，再按其中的 URL 读取嵌入 JS/CSS；没有从磁盘 dist 加载这些数据。结合 Tauri Windows production Directory → `http://tauri.localhost` → 空请求映射 `index.html` 的实现，入口链已通过配置/编译资源/运行时资产查找验证；仍不等于 WebView2 实际执行 JS 的 GUI 验证。

- 新 EXE：`D:/Projects/Research/Oris-builds/task03-entry-fix/target/release/oris.exe`，29,252,239 字节；SHA256 `23FEB41D0AEACA2AF7605D4CE30496E5EBB226C2B40F25DB0ABD915507CC666D`。
- 同目录保留匹配 `WebView2Loader.dll`，SHA256 `8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C`；此 GNU 构建移动/分发时须将其与 EXE 一起保留。
- `source-manifest.json`：47 文件，SHA256 `3CD2CFFE1EE2668446CCC8B3BC07873382B8C78A51F12D14C1C898E1DB0F8D61`；构建和探针完成后核对无漂移。
- 旧错误 EXE 仍为 `EC343D1363F10FEDDEFA8BF8454C723774C2C417BFB915719BCF8D183B7302FA`，没有被覆盖；不再推荐使用它。
- 新 EXE 内可直接检出当前 JS/CSS/Worker 资源键，旧外部 dist URL 已不在新 EXE 中，见 `new-exe-entry-evidence.json`。该静态检查辅助上述运行时探针，不独立替代它。

本轮入口修复与自查完成，交总控验收；不改变任务 03 总体门禁。

## 总控入口基础覆盖检查

2026-09-23，内部 `task03_coverage` 入口基础检查通过，未发现明确遗漏：旧配置实际解析为 `Url`（scheme `d`）、负向构建拒绝、`Directory` 与 index 检查、主程序共用 context，以及隔离目录中的嵌入 assets 查找均有覆盖。

本次检查只读、未重跑测试，不是技术深审。主 EXE 未开窗；无窗口 context/asset 查找通过不代表 WebView 实际执行 JavaScript 或 GUI 验证通过。交付时必须将匹配的 `WebView2Loader.dll` 与 `oris.exe` 保持在同一目录。

本次仅追加本报告，未修改代码、构建产物、散列清单或总体门禁，未重测或提交。
