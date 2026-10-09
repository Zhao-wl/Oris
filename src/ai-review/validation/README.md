> 此记录为 #38 前的首版验证，未通过当时的产品验收。前置完成后的当前实现与验证见 [continuation.md](continuation.md)。

# #26 验收记录

日期：2026-10-09（Asia/Shanghai）。功能基线：0.8.4 `61a5dca1d4b32a3f3edee90e3b817bcd6a9a8683`；交付前同步 `origin/main` 的发布文档提交 `02f1a578ae222572961087fd658c678e2a61589d`，该提交不修改功能代码。

本单复用现有多文件上下文能力及模型传输，增量完成明确范围、文件选择、显式相关内容、结构化证据校验、现有 diff 定位和只读提交建议。不使用 #24/#25 未合入的行级写入、整文件 blame、连续行历史或历史内容搜索接口。不改版本号、锁文件根版本、打包配置和发行说明。

## 可复现检查

以下命令在 PowerShell 中执行。本机 GNU 工具链的命令环境补充 `D:\Tools\Rust\msys2\msys64\mingw64\bin` 到 PATH 前部；没有修改用户或系统持久环境。

```powershell
npm ci
npm run build
npm test -- --maxWorkers=4
cargo check --manifest-path src-tauri/Cargo.toml --features desktop
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib -- --test-threads=4
```

- 前端 TypeScript / Vite 构建通过。保留已有的大 bundle 提示，没有扩大任务到打包重构。
- 前端全量：49 个文件，388 项测试通过。
- Rust 全量：208 通过，0 失败，6 个显式测试忽略；其中真实模型冒烟单独执行并通过，另 5 项原有显式 probe 未执行。
- Windows desktop `cargo check` 通过。

## 工单验收映射

| 项目 | 证据 |
| --- | --- |
| 真实跨文件上下文及预算 | 后端真实 Git fixture + 真实模型 fixture；变化函数、调用方、config.json 与 price.test.ts 实际文本都进入 sources；文本预算、使用量、来源、侧别、OID / revision、contentId、行号可核对。补充内容由用户显式给出，不无界搜索。 |
| 四种范围不混用 | `four_ranges_are_isolated_and_sources_are_real_without_git_writes` 检查 HEAD→工作树、HEAD→index、父提交→提交、固定 OID→OID；根提交、改名和混合暂存/未暂存数据额外验证。UI 测试分别切换四种范围，修改端点后必须重新读取。 |
| 正确点击定位与拒绝虚构引用 | 前端生产 `parseReview` 拒绝未知 source、越界行号、字符串行号和原文不匹配；App 集成验证点击来源、内容身份过期及只读阅读器；CodeMirror DOM 测试检查左右侧原始行号、折叠区域、无效行号，并验证不转移 DOM 焦点。另验证一侧为二进制时可在另一侧文本定位。 |
| 提示注入及仅回答 | 内置审查路由固定 answer，即使导入 action 设置也不扩大权限。App / 后端同时拒绝模型操作计划；真实模型 fixture 中的源码包含伪指令，实际返回 answer，Git 状态不变。 |
| 截断、缺文件、取消、过期、提供方失败 | 真实 Git 检查 UTF-8 大文件预算、缺路径、越界路径、.git 路径、重复路径、文件数量上限及 revision/ref 变化；App 测试检查停止生成、丢弃迟到响应、提供方失败及过期结果不落屏，不执行 Git 写入。 |
| 至少一个真实模型端到端冒烟 | `ai::review_smoke::real_review_model_smoke` + `real-model.test.ts`；后端实际上下文→生产 action_system 权限提示词→生产 run_cli 传输→真实模型→JSON→生产前端引用校验。不是模拟服务返回预填结果。 |
| 提交组织建议 | 只接受实际读取变化路径的建议；实际模型返回了 price.ts 的功能提交建议。界面和会话明确同文件混合改动需手动整理，不执行新行级提交。 |

## 真实模型证据

原始结构化上下文和返回内容保存在 [real-model.json](real-model.json)。不含凭据，只含临时测试仓库中的源码、身份和模型结果。

```powershell
$env:ORIS_REVIEW_SMOKE_MODEL = 'gpt-6.1-sol'
$env:ORIS_REVIEW_EVIDENCE = Join-Path (Get-Location) 'src\ai-review\validation\real-model.json'
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib real_review_model_smoke -- --ignored --nocapture
```

该命令需要本机已登录的 Codex CLI；普通 `npm test` / Rust 测试不会自动访问模型。此次共用实际应用权限提示词的运行成功：上下文读取约 2.19 秒，模型生成约 50.27 秒，1 个有依据的问题。模型识别 `price(2)` 从 4 变成 1，与调用方和测试断言不一致，并明确说明未运行被审查项目的测试。

临时仓库包含 2 个变化文件、2 个显式补充文件，8 份原文侧别来源，文本预算使用 1,065 / 40,000 字节。测试分别核对 HEAD、index 原始字节、status 一致。模型输出再经过前端生产校验，没有无效引用。

性能边界：后端 fixture 使用 5,000 行中文大文件，验证仍处于文本预算内、标记截断且不发送半个 UTF-8 字符；每轮最多 16 个文件，选择器最多列 1,000 个路径。最后加入 6 MiB index / 主变化文件边界用例：index 补充内容经既有有界 BlobReader 读取，非文本或超大一侧不再生成原始大 patch；6 项审查专项均通过。这些是有界读取/上传回归，未声称完成全仓库超大规模性能基准。

## Windows GUI 安全与未验证项

验证前检查了 `scripts/focus-task02-window.ps1` 和全部 `scripts/task02-feedback-*.mjs` 调用方。基线已禁用危险逻辑：PowerShell 脚本直接抛错，不调用窗口 API；focus/interrupted 脚本在入口抛错，其余 feedback 脚本首先导入 `task02-gui-disabled.mjs`，该模块直接抛错。本单没有重启旧脚本、没有新增或修改任何 ShowWindow / SetForegroundWindow / AppActivate 调用，因此危险调用无需再次修改。

本轮 UI 验证仅使用 jsdom / CodeMirror DOM 与 IPC 测试桩；没有创建原生测试窗口，没有按进程名或窗口标题选窗口，没有操作 Codex、ChatGPT 或其他应用窗口，也没有借用非测试窗口制造失焦。模型 CLI 使用原有隐藏控制台进程工厂和临时目录隔离。

**未验证**：真实 Windows 前后台焦点切换、原生 WebView 窗口点击与视觉布局。当前共享桌面没有符合规则的隔离焦点测试设施，按 AGENTS.md 保持该项未验证，不把 DOM 焦点测试、静态检查、编译或模型测试表述为真实 Windows 焦点通过。

测试临时 Git 仓库及 CLI 临时目录由 TempDir 生命周期清理，CLI 进程由生产 ProcessTree 回收；没有结束用户已有应用，没有遗留原生覆盖窗口。未构建或发布安装包，未修改 main，也未将 PR 创建等同于合入。
