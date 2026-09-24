# V2-06 — 设置与外观

状态：**Done（Windows）**（2026-09-24）。P-V2-05／06／07 已决定（V2-D30–V2-D32）；B19–B22 与 §3 配色 / 设置时延在 Windows 通过，V2-01 预算未退步。未验证：macOS、真实系统主题切换（“跟随系统”仅 CDP 模拟）、V1 A06 中需与 V1 05 协同的部分。详见 [V2-06 结果](../../validation/v2-06-results.md)。2026-09-23 新增（V2-D20）。依赖：V2-01；排在 V2-01 之后、V2-02 之前（V2-D26）。

已有输入（2026-09-23）：
- 配色转换脚本 `scripts/themes/`、固定来源 `third_party/vscode-themes/`（含两份 MIT 声明）与 21 套生成数据 `src/themes/generated/` 已合入 main；同一来源重复生成输出一致。[对比度报告](../../../src/themes/generated/REPORT.md)列出 20 项不达标，Solarized、Abyss 的 diff 词级高亮最低到 2.82:1，可作为 P-V2-06 的依据。
- [设置窗口效果图](../../design/05-settings-ui.md)的布局已获用户确认。
- **预制模块已完成（2026-09-23，分支 `wip/v2-06-core`，只新增模块与测试，未接入界面）**：`src/settings/`（带版本号的设置模型、分类注册表、读写与迁移、订阅）与 `src/themes/runtime.ts`（按 id 懒加载方案、CSS 变量应用与高对比类名、两组 diff 颜色、HighlightStyle 与可 reconfigure 的编辑器扩展、跟随系统与预加载、首屏同步应用）。详见下方“预制模块与接入清单”。完整 V2-06 仍需等 P-V2-05–P-V2-07 决定后开工。

## 用户闭环

作为用户，我可以在一个统一的设置窗口里调整 Oris：在“外观”中选择浅色、深色或跟随系统，为浅色和深色各挑一套配色方案（包括 VS Code 的配色），调整 diff 字号；在“Git”中指定 Git 可执行文件。修改立即生效、重启后保留，切换时不打断正在阅读的 diff。

## 范围

- **设置框架（R-SETTINGS）**：标题栏设置入口与 Ctrl/Cmd+, 快捷键；分类注册机制；即时生效与自动保存；版本化持久化、损坏回退；从旧入口迁移已有取值。
- **Git 分类**：从路径栏迁入 Git 可执行文件设置，改为全局设置（V2-D24）；显示实际路径、版本与最低版本要求；修改后校验，失败时保留原值。
- **外观分类（R-APPEARANCE）**：
  - 主题模式：浅色 / 深色 / 跟随系统；
  - 浅色方案、深色方案各一个选择列表，带色板预览；
  - diff 字号（11–18），保留快捷键调整（V2-D25）。
- **颜色变量化**：把 `styles.css` 中写死的颜色全部收拢为 CSS 变量，加一条防止再写死颜色的静态检查；diff 阅读器的配色与字号改为 CodeMirror `Compartment` 切换，不再整体重建编辑器。
- **配色方案移植**：转换脚本（固定 VS Code 来源提交，解析 JSONC 与继承链，补齐注册表默认值，映射为 Oris 变量与 Lezer 高亮规则，输出对比度报告）；生成结果入库；第三方许可声明写入发布包。方案范围按 P-V2-06，默认方案按 P-V2-07。
- **高对比**：高对比方案下的“描边代替底色”样式分支。
- **首屏无闪烁**：在 React 挂载前应用已保存的配色。
- 移除旧入口：路径栏“Git 设置”、diff 工具栏字号滑块、标题栏浅 / 深色按钮。

## 验收

- [x] B19–B22：Windows 通过（B20 未验证“换成另一个 Git 后常驻 cat-file 使用新路径”，本机只有一个 Git）。
- [x] 配色切换、打开设置窗口的性能预算达标，V2-01 的预算没有退步；只加载当前使用的方案数据（Windows，同时段 A/B）。
- [ ] V1 A06 中字号 / 主题相关的检查在新设置下重新通过（与 V1 05 协同）：字号与主题切换不重建编辑器、阅读状态保持已在 Windows 验证；其余等 V1 05 实施后复核。
- [x] 两个平台分别验证“跟随系统”的实时切换；无法验证的平台明确列为未运行：Windows 以 CDP 模拟系统主题通过，未做真实系统切换；macOS 未运行。

## 交付与排除

设置窗口与“外观”“Git”两个分类、移植的配色方案、转换脚本与报告、许可声明。不包含：自定义单个颜色、导入外部 VS Code 主题或扩展、图标主题、界面字体选择、其他设置分类的具体设置项、逐项目 Git 路径覆盖。


## 体验版接入（2026-09-24，feat/v2-01；已被正式实现取代）

用户要求 P-V2-05 / P-V2-06 / P-V2-07 先做出可切换的版本直观感受，再做决定。已完成：

- 设置窗口（`src/SettingsDialog.tsx`，标题栏“⚙ 设置”或 Ctrl/Cmd+,，Esc 或点遮罩关闭）：外观、Git 两个分类；“更多分类（以后）”占位。
- 外观：主题模式（浅色 / 深色 / 跟随系统）；浅色、深色方案列表各自带色块预览，标注“高对比”和批次（Oris / 首批 / 第二批）；“只看首批”复选框用于体验 P-V2-06 的首批范围（首批 = VS Code 2026、Modern、+、Visual Studio、高对比 共 10 套，定义在 `src/appearance.ts`）；Diff 字号 11–18（Ctrl/Cmd + = / - / 0）。
- “待决定项体验”分组：P-V2-05 的 A（修改蓝 · 新增绿 · 删除灰）/ B（新增绿 · 删除红）切换，带小预览；C 即保留该开关。P-V2-07 两个按钮一键把浅 / 深色方案设为 Oris 或 VS Code Light / Dark 2026。体验版初始默认仍为 Oris 配色，不代表决定。
- diff 底部图例随 A / B 变化；CodeMirror 主题、高亮、字号经 Compartment 切换，不重建编辑器。
- Git：全局路径，失焦或回车时调用后端 `validate_git` 校验，失败保留原值并显示原因；显示当前设置、实际使用的 Git 与最低版本；旧路径栏设置已迁移。原路径栏“Git 设置”和工具栏字号滑块已移除。
- `styles.css` 颜色改为变量（剩余十六进制值均为 `var(--x, 回退)` 中的回退值或中性色）；高对比描边分支。
- 测试：`SettingsDialog.test.tsx` 4 项；前端共 122 项通过。CDP 截图：`artifacts/gui-probe/v2-06-preview-shots/`（本地，不入库）。
- 体验版 release：`D:\Projects\Research\Oris-builds\v2-06-preview\target\release\oris.exe`。

上述体验版的“待决定项体验”分组、首批过滤与 A/B 开关已按 V2-D30–V2-D32 移除；静态颜色检查、B22 许可声明、首屏同步配色均已完成，见 [V2-06 结果](../../validation/v2-06-results.md)。

## 预制模块与接入清单

状态说明：以下模块只完成了代码与单元测试，**没有接入界面**，不能据此勾选 B19–B22 或宣称 V2-06 完成。P-V2-05（diff 颜色语义）、P-V2-06（移植范围）、P-V2-07（默认配色）保持待定；模块对这三项都不做取舍：两组 diff 颜色都提供，默认配色由调用方从 `DEFAULT_SCHEME_OPTIONS` 的两组候选中传入，方案列表由 `index.json` 决定（可在接入时按 P-V2-06 过滤）。

| 模块 | 内容 | 测试 |
| --- | --- | --- |
| `src/settings/model.ts` | 设置模型（版本 1）：`appearance`（themeMode light/dark/system、lightScheme、darkScheme、fontSize 11–18、diffColorMode oris/vscode）与 `git`（executable，空为自动发现）；`createSettingsRegistry` 注册两个分类，方案选项按类型分到浅色 / 深色列表（高对比归入对应列表） | `settings.test.ts` |
| `src/settings/registry.ts` | 分类注册表：键、类型、默认值、校验、界面元数据（控件类型、选项、范围、`pendingDecision` 标记）；新增分类只需 `register`；`normalize` 逐项校验并报告被纠正的项 | 同上：新增分类不改框架、非法项逐项回退 |
| `src/settings/storage.ts` | 读写（与项目列表相同的 localStorage 机制，键 `oris.settings.v1`）；首次启动迁移“最近一次成功打开的项目（`lastOpenedAt` 最大）所用的非空 Git 路径”，其次旧版单项目记录；数据损坏 / 版本不兼容 / 部分非法分别返回 `corrupted` / `incompatible` / `corrected` 提示，不读写项目列表 | 同上：迁移、损坏、不兼容、存储抛错 |
| `src/settings/index.ts` | `SettingsStore`：修改即时校验、广播、保存，非法值保留原值；`useSettings` 基于与 V2-01 相同的 `useSyncExternalStore` 小型 store（`src/store.ts`，与 V2-01 的文件内容一致） | 同上：订阅只在真实变化时通知 |
| `src/themes/runtime.ts` | `loadScheme` 用 `import.meta.glob` 按 id 懒加载（每套一个 chunk）；`applyScheme` 写 CSS 变量（null 删除）、高对比加 `theme-high-contrast` 类、写 `data-scheme*`；`diffColors` / `schemeVariables` 提供 oris（修改块两侧同色）与 vscode（修改块左删右增）两组变量 `--diff-{added,deleted,modified-left,modified-right}-{marker,line,word}`；`highlightStyleFor` 由 scope→tag 规则生成 `HighlightStyle`（支持 `function(variableName)` 这类修饰 tag）；`createAppearanceCompartments` / `appearanceExtensions` / `reconfigureAppearance` 把主题、高亮、字号放进三个 Compartment；`AppearanceRuntime` 跟随系统时监听 `prefers-color-scheme` 并预加载另一套；`writeBootCache` / `applyBootAppearance` 为首屏无闪烁提供同步应用与最小数据（每模式 10 个关键变量） | `runtime.test.ts`：懒加载只加载当前方案、CSS 变量与高对比类名、两组 diff 颜色、HighlightStyle 构造、同一 EditorView reconfigure 后选区与文档保持、跟随系统实时切换与预加载、首屏缓存 |

依赖说明：`runtime.ts` 引用的 `@codemirror/language`、`@lezer/highlight` 已随现有依赖安装（lockfile 已锁定，`@codemirror/theme-one-dark` 同样依赖它们），本次未修改 `package.json`；正式接入时建议把这两个包按 lockfile 中的版本显式写入 `dependencies`。

### 接入时需要改动的位置

1. `index.html` / `src/main.tsx`：挂载前调用 `applyBootAppearance(localStorage, document.documentElement, matchMedia)`（首屏无闪烁）；随后创建 `SettingsStore` 与 `AppearanceRuntime`，把 `settings.get().appearance` 交给 `runtime.apply`，并订阅设置变化。
2. `src/App.tsx`：标题栏浅 / 深色按钮（`setDark`）改为“设置”入口与 Ctrl/Cmd+,；移除路径栏“Git 设置”输入，Git 路径改读 `settings.git.executable`（全局，V2-D24），调用 `openRepository` 时传入；diff 工具栏字号滑块移除，Ctrl/Cmd + `=` / `-` / `0` 改为 `settings.update("appearance", "fontSize", …)`；`<main className={dark ? …}>` 的类名改由 `applyScheme` 写在根元素上。
3. `src/DiffViewer.tsx`：去掉 `oneDark` 与 `EditorView.theme({ fontSize })`，改用 `appearanceExtensions(compartments, scheme, fontSize)`；`dark` / `fontSize` 从主 effect 依赖中移除，改为订阅设置后调用 `reconfigureAppearance(views, …)`（V2-01 已复用 EditorView，reconfigure 后阅读位置、选区、搜索状态保持）。diff 行 / 词 / 外缘轨道颜色改用 `--diff-*` 变量。
4. `src/styles.css`：把写死的颜色（调研时 117 处）收拢为 `runtime` 写入的变量；新增 `.theme-high-contrast` 下“描边代替底色”的样式分支；增加禁止写死颜色的静态检查（例如在测试中扫描 `styles.css` 的十六进制色值）。
5. 设置窗口组件（新增）：按 `registry.list()` 渲染分类与控件；`pendingDecision` 项在决定前按产品规格显示或隐藏；Git 分类修改后调用后端 `git --version` 校验，失败时不写入设置（`SettingsStore.update` 只做格式校验）。
6. 后端：新增 Git 路径校验命令，复用“可执行文件 + mtime”版本缓存（技术方案 §3、§9.1）；常驻 cat-file 在下一次空闲回收后用新路径重启。
7. 发布包加入 VS Code 与 Colorsublime 的 MIT 许可声明（B22）。
