# Oris 任务 01 运行说明

## 已锁定环境与依赖

- 桌面壳：Tauri 2；Rust 依赖的实际解析版本以 `src-tauri/Cargo.lock` 为准。
- 前端：React/TypeScript/Vite；npm 依赖使用精确版本并由 `package-lock.json` 锁定。
- Diff：CodeMirror 6 的 `@codemirror/merge`；不依赖私有 DOM 补丁。
- Git：本机 Git CLI，最低版本 2.31.0。该基线提供本实现使用的 `rev-parse --path-format=absolute`，同时支持固定参数数组、NUL 分隔列表和 `--no-optional-locks`。

Oris 不安装 Git，也不修改 `safe.directory`。自动发现失败时，可在“Git 设置”中填写 Git 可执行文件绝对路径。

## Windows 11 x64

推荐使用 Rust MSVC 工具链和 Visual Studio 2022 C++ Build Tools。当前验证机使用已安装的 GNU 工具链，因此构建命令只在当前进程补入既有 MinGW 工具路径，没有更改全局 PATH：

```powershell
$env:PATH = 'D:\Tools\Rust\msys2\msys64\mingw64\bin;D:\Tools\Rust\mingw-binutils\mingw64\bin;' + $env:PATH
npm install
npm run tauri -- dev
```

生产构建：

```powershell
npm run tauri -- build --no-bundle
```

输出为 `src-tauri/target/release/oris.exe`。本任务只验证未签名的内部原型，不把它称为正式发布包。

## macOS 14+ arm64

需要 Apple Silicon Mac、Xcode Command Line Tools、Node 22+、Rust stable 和本机 Git 2.31+：

```bash
npm install
npm run tauri -- dev
npm run tauri -- build --no-bundle
```

必须从 Finder/产物启动再验证 Git 自动发现与手动路径，不能只在开发终端 PATH 下通过。本轮没有 macOS 14+ M1/arm64 资源，因此上述入口已建立但未运行，WKWebView 兼容性仍是验收门禁。

## 测试

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
cargo check --manifest-path src-tauri/Cargo.toml
```

GNU 工具链运行 Rust 测试时，应让 Rust 自带运行库目录排在 MSYS2 运行库前；构建 Tauri 资源时则需保证 `gcc`、`dlltool` 和 `windres` 可发现。测试记录中的命令使用命令级 PATH，未污染用户全局配置。

## 内容保护与线程位置

- 常规全文 diff：每侧最多 5 MiB、100,000 行；单行最多 100,000 字符。
- 超预算、非 UTF-8、NUL/二进制内容会显示明确降级原因，不会静默截断或显示“无差异”。
- Git 进程等待和内容读取位于 Tauri async runtime 的 blocking worker；diff 在 Web Worker 中计算；UI 线程只接受当前 `requestId/repoId/revision/contentId` 对应的结果。
- 当前任务只实现 tracked 未暂存的 Index → Working Tree。暂存、全部本地改动、未跟踪、空白忽略和完整编码覆盖由后续既定任务补齐，不改变 V1 范围。
- 当前 Diff 的应用内搜索最多接收 512 字符；全局结果计数/导航最多保留 10,000 个并显示截顶，选中同词只装饰当前可见范围且每侧最多 200 个。显式 `.*` 搜索可解释正则，鼠标选择始终按字面文本匹配并继承 Aa/全字设置。
- Ctrl+F/Cmd+F 由 Oris 搜索面板接管；它只搜索当前 Diff，不执行全仓库搜索或替换。色标槽 viewport band 使用逻辑行范围，旁边 thumb 仍表示本侧像素滚动 viewport，两者含义不可互换。
