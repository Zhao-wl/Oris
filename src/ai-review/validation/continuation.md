# #26 前置完成后的开发与验收记录

日期：2026-10-09（Asia/Shanghai）。本轮接续用户“前置工单已经完成，可以后续开发了”的授权。

## 基线与范围

#38 的 PR #40 合入本单分支后的基线为 `6ac2be2d48c48986ee2b016aaf1fb5001562f099`；#38 用户验收记录见 `docs/validation/issue-38-ui-feedback.md`。已整合最新 main `da5ae0d2da2aa48779af538ac775b289813b19f7` 的 #36 忽略规则，保留共享选择入口、统一 AI 输入及忽略提交提示；共享 App/GitPanel/styles/系统提示词冲突由增量整合解决，相关前端回归通过。

继续复用统一附件选择与默认上下文，不恢复旧的强制勾选面板。按 #38 最终决定，不提供分支端点附件，分支仅筛选提交；后端及旧显式请求保留兼容能力。

## 本轮实现

- 审查编排归属 `src/ai-review/review.ts`。以有界原文窗口联合核对多个文件和续页，替代逐片段独立调用；不会把模型生成的摘要当作原文。
- 关联引用包含原文来源、行号与非空原文片段；主引用及全部关联引用逐一校验，虚构关联使整个问题标为未核实、禁止定位。可点击各关联原文，仍沿已有 contentId/revision/端点核验与只读 diff 跳转。
- 网络投影保留每份来源的侧别、端点及比较范围，内部路径 ID、内容哈希与定位请求留在本地。相同路径/标题但不同内容或端点的问题不被错误去重。
- 当前对话的有效性回调进入读取循环，取消、关闭或切换项目后不能因迟到响应继续调用模型或发布部分结果。提供方错误、非法操作计划、来源过期均停止。
- 单次和累计预算沿用 #38 路由设置；显示保守 token 估算及遍历/窗口覆盖。预算耗尽只返回已验证覆盖，明确剩余未审查。保留只读提交组织建议，不新增 #24/#25 接口。

## 已执行验证

- 前端全量：54 文件通过、1 文件显式跳过，441 项通过、1 项显式跳过。随后补齐来源端点/range 投影，对涉及的审查与压缩模块专项 19 项再次通过。
- TypeScript / Vite 生产构建通过，保留已有 bundle 体积提示。
- PowerShell Windows desktop `cargo check --manifest-path src-tauri/Cargo.toml --features desktop` 通过。
- Rust 全量 `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib -- --test-threads=4`：212 通过、0 失败、8 项显式忽略；不是把被忽略测试计为通过。
- 关联引用 DOM 测试验证分别回传各自的可信来源和原始行号；App 集成验证主定位、单侧非文本阅读、提供方失败、过期和取消；真实 Git 后端测试仍验证暂存/未暂存、提交、根提交/改名与只读状态。模型架构及主流程测试不代表原生 GUI 测试。

## 真实模型生产链路

执行 `ORIS_REAL_REVIEW=1` 的 `src/ai-review/real-pipeline.test.js`（普通测试跳过，不默认联网）。TypeScript 的 Tauri invoke 边界由本轮 Rust 测试桥接到真实 GitAdapter 与生产 CLI；模型响应不是测试桩预填。调用链：真实临时 Git 仓库 → 生产 review_inventory/review_context_page → 生产 reviewAttachments/compactEvidence → 生产 planAiAction → Rust action_system/run_cli → Codex 实际模型 → 生产 parseReview 与关联来源校验 → 再读版本核验。

最新运行：`gpt-6.1-sol`，1 次联合模型请求，四个文件/八份侧别来源，1 个核验通过的问题，累计保守估算 6,603 / 96,000。模型正确指出 `price(2)` 从 4 变为 1，主定位为 price.ts，关联原文包括修改前实现、caller.ts 和 price.test.ts；没有从未被消费的 config.factor 推断行为，也未声称运行测试。源码包含提交伪指令，实际保持 answer。临时仓库文件原始字节、index、HEAD、refs 与 status 前后相同。

原始上下文、模型返回、可信定位请求及前端校验结果：`joint-real-model.json`。无凭据，仅包含本轮临时 fixture。最新完整链路运行 77.30 秒（含桥接进程启动，不当作纯模型耗时）。另一次同链路运行亦通过；记录以最新结果为准。

可复现命令（PowerShell，本机工具链补 PATH 仅限本进程）：

```powershell
$env:PATH = 'D:\Tools\Rust\msys2\msys64\mingw64\bin;' + $env:PATH
$env:CARGO_BUILD_JOBS = '4'
$env:ORIS_REAL_REVIEW = '1'
$env:ORIS_REVIEW_SMOKE_MODEL = 'gpt-6.1-sol'
$env:ORIS_REVIEW_PIPELINE_EVIDENCE = Join-Path (Get-Location) 'src\ai-review\validation\joint-real-model.json'
npm test -- src/ai-review/real-pipeline.test.js --maxWorkers=1
```

## 安全、限制与待验收

GUI 验证前检查了 `scripts/focus-task02-window.ps1`、全部 `task02-feedback-*.mjs` 及 `task02-gui-disabled.mjs`：基线危险流程仍直接 throw 或首先导入禁用入口，无须新增修正；本轮没有新增、修改或调用 ShowWindow / SetForegroundWindow / AppActivate，没有操作任何非测试应用窗口。UI 验证只有 jsdom/CodeMirror DOM，不是 Windows 原生焦点证据。真实 Windows 前后台切换、原生 WebView 点击和布局仍未验证。

临时 Git 仓库由 Rust TempDir 清理，测试桥接子进程由测试回收，模型 CLI 沿生产 ProcessTree 清理；没有结束用户已有应用或遗留覆盖窗口。

联合推理仅覆盖预算内同一窗口；多个窗口间未做全量联合推理，可能漏掉远距离关联。未附加依赖及二进制/超长行/底层读取上限需如实保留限制。选择助手的提供方限制沿用 #38。当前测试结果不等于用户已验收 #26；PR #37 保持 Draft，工单保持 open，供本地试用后确认。不修改版本号、不发布远程安装包、不合入 main。
## 本地试用包

PowerShell `scripts/build-release.ps1` 编译及无窗口入口检查通过：`ENTRY_ASSETS_PASS`，26 个嵌入资源，JS/CSS/Worker 均存在。脚本执行耗时约 194.7 秒。此环境缺少 Get-FileHash，当前命令进程提供了等效 .NET SHA256 函数供脚本最后输出校验值，没有修改构建脚本或系统环境。

产物：`artifacts/issue26/Oris-issue26-joint-review-20261009.zip`，包含 oris.exe 与同目录 WebView2Loader.dll；已重读 ZIP 内的 exe 校验与构建结果一致。exe SHA256：`B103797D5D42A2FB507B77B9D3252C5E717CBDA25DBF7C73EA78971026FDED24`。这是当前 #26 的本地试用版本，版本号仍为 0.8.4，需要系统 WebView2 Runtime 与 Git，不是远程正式发行。没有启动该 exe 或操作原生窗口。

## 附件解释与默认范围反馈修正（2026-10-09）

用户截图显示 59 个文件附件、0 个正文片段。根因是 @解释 使用目录导航协议，模型可在没有发出 contextRead 时直接给出最终回答；这允许只看到目录便反问文件范围。

本轮让 @解释 和 @审查 共用 context-selection/windows.ts 的主动原文分页与有界窗口：在模型调用前读取附件的真实左右侧原文，只有 @解释 也直接解释实际范围，不再要求二次选择。普通对话的目录按需读取能力保留。更新推荐解释规则，避免默认提示词将范围描述为单个当前文件；已有自定义规则保持原值，运行时解释合同明确以本轮附件和用户描述为范围。

无附件时默认范围包括未暂存、已暂存及当前分支相对本地上游的全部未推送提交。提交逐页收集到末尾，删除首批 200 条截断；分页后续失败或取消时停止，不发布半份默认范围。上游不能确定时明确提示，不执行 fetch、不把未知提交数量当零条。附件范围全部收集与实际原文覆盖分开：正文仍受单次/累计模型预算约束，截断、非文本与未覆盖内容明确报告。

验证：前端全量 447 项通过、1 项真实模型测试默认跳过；59 文件附件 UI -> App -> 模型原文投影 -> 回答覆盖统计集成测试通过。451 条默认未推送提交跨三页收集通过；续页晚段、内容过期、空范围、取消、预算耗尽和非回答结果均有回归覆盖。生产构建通过。

真实模型补充证据见 explain-real-model.json：真实临时 Git -> 生产 TypeScript 共用窗口编排 -> 生产 CLI 与实际 gpt-6.1-sol -> 解释回答，直接输入 @解释，四个文件/八侧原文进入模型；解释指出 price(2) 从 4 变 1，以及调用方和测试未同步。审查关联引用链路同时再次核验。文件/index/HEAD/refs/status 不变；原文伪指令没有产生写操作。不把模型推断当作项目测试执行结果。

本轮再次检查 focus-task02-window.ps1 及全部 task02-feedback-*.mjs 调用方：危险入口仍为直接 throw，或首先导入 task02-gui-disabled.mjs；未修改或调用任何危险窗口 API，没有操作其他应用窗口。新增 UI 回归为 jsdom DOM，真实 Windows 焦点切换及原生 WebView 布局/点击仍未验证。真实 Git 临时目录、桥接与 CLI 子进程由本轮测试清理。


反馈修正版试用包：artifacts/issue26/Oris-issue26-context-fix-20261009.zip（14,067,137 字节），包含 oris.exe 与 WebView2Loader.dll；ZIP 内 exe 的 SHA256 已重读核对。exe SHA256：42CAA874ED33700F19DF88F83F9F8009B87BFE3FC65533DFCD8FD7A060E241C5。保留上一版 ZIP；版本号仍为 0.8.4，本轮未启动原生窗口。

PowerShell release 构建及无窗口入口检查全部通过，耗时 281.7 秒；ENTRY_ASSETS_PASS，26 个嵌入资源，JS/CSS/Worker 存在，校验输出 SHA256 与 ZIP 内 exe 一致。真实模型补充链路最新运行 102.90 秒（含桥接启动和两次实际模型请求）。
