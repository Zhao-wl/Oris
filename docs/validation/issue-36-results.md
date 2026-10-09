# 工单 #36：自定义变更文件忽略与 AI 配置

日期：2026-10-09。状态：用户已验收通过，授权提交及通过 MR 合并；本地构建和各项验证记录如下。

工作树：`C:\Users\zhaowenlong\.codex\worktrees\issue-36-ignore-files\Oris`。
分支：`codex/issue-36-ignore-files`。基线：`61a5dca1d4b32a3f3edee90e3b817bcd6a9a8683`（0.8.4）。

## 使用与交付

- 所有忽略操作统一放在“设置 → Git → 忽略文件”中：管理全局/当前仓库规则，添加、编辑、删除与启停；成功保存后即时生效。变更侧栏与文件右键菜单不提供忽略入口。
- 设置中的规则支持精确路径、任意目录精确文件名及 glob。`**/.DS_Store` 覆盖根目录和任意目录层级；规则可选择大小写敏感性。
- 同一设置页显示当前比较范围命中的数量；勾选“临时显示被忽略文件”可恢复列表，取消勾选再次筛选。规则和临时显示按实际成员仓库应用，不按父工作区混合匹配。
- 三种本地比较范围、树状/平铺、路径搜索和可见文件导航消费同一筛选结果。隐藏当前文件后移到可见文件，全部隐藏则结束旧读取并清除阅读。历史比较不应用规则。
- AI 示例：`@设置 当前项目忽略所有目录下的 .DS_Store`、`@设置 全局忽略所有目录下的 .DS_Store`、`@设置 停用当前项目的忽略规则`、`@设置 显示当前生效的忽略规则`。复用已有 AI 路由、调用与执行入口；读取通过回答，写入通过受限 `fileIgnore` 操作。
- 批量/指定路径写操作不会静默消费仍隐藏的文件；AI 的 `stage/unstage pathIds=all` 排除规则命中文件，不受临时搜索文本影响。明确显示后可按具体文件选择操作。
- Git 状态、暂存计数保持真实。提交面板列出被规则命中的已暂存文件，提示仍会提交；普通 AI 提交遇到这些文件时停止并引导核对提交面板。AI 独立文件提交也检查隐藏目标。

## 生产调用链与证据边界

手动表单或 AI `parseAiAction(response, { repoId, rules })`（应用生成新增 ID、绑定当前仓库并补齐默认属性）→ `parseFileIgnoreOperation` / `applyFileIgnoreOperation` → `SettingsStore.update(fileIgnore.rules)` → 校验并先保存到 `oris.settings.v1` → 广播设置变化 → App 中的 matcher / `filterReadableFiles` → FileTree 与阅读选择。

AI 上下文包含当前仓库及全局规则、作用范围和能力说明；执行核对规划时仓库与规则快照，失败保留原值。规则保存失败不改变内存列表，也不报告成功。已有 v1 设置缺少规则时加载空规则，不重置其他设置。

匹配器限定规则/模式长度，不把用户 glob 编译为回溯正则，重复路径结果使用有上限的缓存。支持 `*`、`?`、完整段 `**`，不支持取反、字符组、花括号或绝对/上溯路径。Windows 风格分隔符规范化为 `/`；精确文件名/路径中的非通配字符按字面匹配。

## 已执行验证

| 验证 | 命令与结果 | 证明范围 |
| --- | --- | --- |
| 全量前端回归 | `npx vitest run --maxWorkers=2`：47 个文件，382 项通过，59.06 秒 | 规则模型、设置升级/持久化、保存失败、App 实际 React 接线、手动添加/编辑/删除/启停、AI 类型化配置及过期/错误目标、三种范围、批量范围和提交提示；既有回归 |
| 生产前端 | `npm run build`：TypeScript 与 Vite 通过 | 当前源代码编译/打包；既有大 bundle 提示仍存在 |
| Windows desktop | PowerShell 执行 `cargo check --locked --features desktop`：通过 | 包含新增 AI kind 的 desktop 源码可编译；没有生成或启动安装包 |
| 真实 Git 夹具 | `node scripts/issue36-git-smoke.mjs`：通过 | 实际 Git 仓库中 5 个变化文件，4 个 .DS_Store；未暂存/已暂存/全部筛选正确；工作区字节、index、refs、diff、已暂存 diff、本地配置、Git ignore 文件前后相同；脚本 finally 清理本轮夹具 |
| 匹配性能采样 | 同一脚本：10000 个输入，32 条规则，9000 个可见文件；冷筛选 142.39 ms，缓存后搜索 2.73 ms | 合成数据的核心 matcher 采样，不是完整应用 UI 时延或既有全量性能预算验收 |
| 补丁格式 | `git diff --check`：通过 | 无补丁空白错误 |

首轮默认并发的全量回归为 365 项通过、一个既有 DiffViewer 样式表测试超过 5 秒；限制并发后该项通过。最终完整回归以表中 382 项通过为准。首次 cargo check 因进程 PATH 缺少 GNU `dlltool.exe` 失败；按既有 `scripts/build-release.ps1` 的方式，仅给本次进程补齐 `D:\Tools\Rust\mingw-binutils\mingw64\bin` 和 gcc 目录后通过，未修改系统 PATH。

## Windows GUI 安全与未验证项

已检查 `scripts/focus-task02-window.ps1` 及 `scripts/task02-feedback-*.mjs`：原生激活脚本已经直接 throw；focus/interrupted 脚本已经直接 throw；其余 feedback 脚本先导入 `task02-gui-disabled.mjs`，该入口直接 throw。检索脚本调用方未发现对禁用焦点脚本的活动调用。本单没有重新启用或修改危险调用。

本次使用 jsdom DOM 测试、真实 Git 临时目录和编译检查，没有启动 Oris 原生 GUI、CDP 或其他应用窗口，没有调用 ShowWindow/SetForegroundWindow/AppActivate，没有创建覆盖窗口或抢占桌面焦点。夹具 Git 进程使用 windowsHide，夹具由脚本创建并在 finally 删除；node_modules 和构建输出保留在独立工作树供继续开发。

真实 Windows 前后台焦点切换未验证。真实 WebView2 界面布局、真实 AI API/CLI 模型自然语言输出、macOS/WKWebView 及 macOS 安装包未验证；AI DOM 测试中的模型响应由受控替身提供，不能视为真实模型冒烟通过。正式发布性能预算没有全量复测。


## 2026-10-09 本地可执行版本

按用户要求，在本工作树用 PowerShell 执行 `npm run package`，生成 Windows x64 release（版本号仍为 0.8.4，包含当前未提交的 #36 实现）。应用编译耗时 6m45s；无窗口入口验证随后通过：`ENTRY_DIST=Directory("../dist")`、`CUSTOM_PROTOCOL=true`、`EMBEDDED_ASSETS=26`、`WINDOW_URL=App("index.html")`、`ENTRY_ASSETS_PASS index_bytes=479 scripts=2 styles=1 root_request=index.html`。所嵌入前端为 `index-nxj9J7R0.js` 与 `index-B5jWj-_E.css`，包含忽略规则和 fileIgnore AI 能力。

脚本在完成上述编译和验证后，仅于摘要阶段因子进程 Windows PowerShell 找不到 `Get-FileHash` 而退出非零；这不是编译或入口验证失败。随后用 Python hashlib 补齐 SHA-256，核对 exe 的 PE 签名与 x64 machine，复制 exe 与 WebView2Loader.dll，并用 zipfile 完成 ZIP CRC 及逐项 SHA-256 一致性检查。未改动构建脚本或系统环境，未重新跑测试、未启动 GUI。

本地交付：

- `artifacts/issue36-local/oris.exe`：42.82 MiB；同目录必须保留 `WebView2Loader.dll`。
- `artifacts/issue36-local/Oris-issue36-windows-x64.zip`：13.29 MiB，包含 exe、DLL、README.txt、build-info.json；解压后运行 exe。
- exe SHA-256：`1e47177df8521c16654f326f4664e899c86e8691056550a15ea2f5ae96822b28`。
- ZIP SHA-256：`3e4679cb4a0dde015fd8b693744e6d50ad97d7131f669fbc81d3cc253996b151`。

ZIP 完整性与文件字节核对通过；原始编译产物仍在 `src-tauri/target/release`。没有生成安装程序、运行原生窗口或发布版本，本地打包不替代真实 GUI/模型及 macOS 验收。


## 2026-10-09 用户反馈修正（r2）

### 改动与根因

- 原 `.ignore-status` 插在侧栏第四个网格位置，占据原本属于文件列表的 `1fr` 高度，文件列表变为第五项 `auto`；因此出现巨大空白。本轮删除整个侧栏忽略区域及文件右键忽略操作，文件列表恢复为第四项。“临时显示被忽略文件”和命中数量移到设置页。
- “忽略文件”改为 Git 可展开导航下的子项，与 AI 子导航方式一致；全局/当前仓库原存储结构与旧规则兼容。
- 原 AI 能力清单要求模型填写完整持久化对象：内部 ID、repoId、enabled、caseSensitive 任一无效/缺失，都会被归结为“忽略规则无效”。已复现省略字段、使用 `.DS_Store` 作为内部 ID 时的契约问题。截图没有原始模型 JSON，不能据此确定该次真实 Onehub/DeepSeek 返回了哪个错误字段。
- AI 新增只需 `rule.pattern`（可指定 name/path/glob 和布尔属性）；Oris 生成内部 ID，默认绑定规划时当前仓库，推导省略的匹配类型并补齐布尔默认值。能力清单提供可直接解析的 `.DS_Store` JSON 示例。更新/删除/启停使用已有 ID、保留原作用范围与未修改属性；仍拒绝非法路径、错误属性类型、未知范围和其他仓库目标，执行仍检查规划快照及保存结果。

### 本轮验证

- 全量前端回归：`npx vitest run --maxWorkers=2`，47 个文件，385 项通过，29.81 秒。新增覆盖实际 App 最小 AI 响应 → 设置保存 → 列表即时筛选 → 删除恢复；嵌套导航、入口移除、临时显示；范围/类型/模式错误和局部更新。
- 无窗口布局：`node scripts/issue36-layout-smoke.mjs <Playwright/index.mjs>`。脚本启动自己的 Vitest 实例，导出真实 App React DOM（仓库数据和 DiffViewer 为替身），还原生产 `#root` 容器及控件状态，在独立 headless Chromium 中加载实际 `src/styles.css`。1280×900、980×700、720×680 均通过：文件列表是侧栏第四项，筛选框与列表间距 7 px，列表高度分别 556/356/336 px；Git 子项缩进 16 px，设置窗口没有超出视口，临时显示控件位于设置中。输出在 `artifacts/issue36-layout/results.json` 和对应截图。首次夹具缺少生产 `#root` 导致高度断言失败，修正夹具后通过；没有为使断言通过修改应用 CSS 高度。
- 真实 Git 夹具再次通过：5 个变化文件、4 个 .DS_Store，三个范围及前后 Git/文件字节一致；10k 输入性能采样冷 89.51 ms / 缓存 1.16 ms（仅核心函数采样）。
- 检查安全脚本：`focus-task02-window.ps1`、feedback 及禁用入口仍 fail closed，本轮未修改或恢复危险调用。布局脚本仅操作自己启动的无窗口 Chromium 页面，阻止页面网络请求，finally 关闭该 browser；没有枚举/激活/显示/隐藏其他应用窗口，也没有原生前台操作。
- 真实 Windows 前后台切换、Oris WebView2 原生布局、真实 Onehub/DeepSeek 模型自然语言输出仍未验证；headless 布局与受控 AI 响应不是上述测试通过的证据。

### 修正版本地打包与交付

PowerShell 执行 `npm run package`，release 和无窗口嵌入入口验证全部通过，脚本退出 0，总耗时 131.8 秒。嵌入前端 `index-Pe7aJSFD.js` / `index-lnW0kQXk.css`；`ENTRY_ASSETS_PASS index_bytes=479 scripts=2 styles=1 root_request=index.html`。本次仅给构建进程补齐 `PSModulePath` 的系统 Windows PowerShell 模块目录，摘要阶段 `Get-FileHash` 正常运行，未修改系统环境或构建脚本。

首次本轮打包在 TypeScript 阶段发现验证辅助代码直接引用 Node 模块但项目没有其类型，构建停止；已将文件导出放在仅由验证脚本加载的 `.mjs` setup 中，应用测试仅保留可选快照 hook，未安装或修改依赖。随后完整打包通过。

- `artifacts/issue36-local-r2/oris.exe`：42.82 MiB，PE x64 校验通过。
- `artifacts/issue36-local-r2/Oris-issue36-r2-windows-x64.zip`：13.29 MiB；包含 exe、同目录 DLL、README.txt、build-info.json。
- exe SHA-256：`a7997b6fe28770e4c2168d73b7f9d84c925f33287c9abff955d718b30d6d7821`。
- ZIP SHA-256：`c63fab3cd7a2c079e82b666e4c12bd54265427a081781e57a2b594c908f11be7`。
- ZIP CRC 和每个成员的 SHA-256/源文件一致性核对通过。上一版 `artifacts/issue36-local` 保留，新版不覆盖用户可能正在运行的文件。没有生成安装程序、启动原生 Oris 窗口或发布版本。
