# 研究 08：VS Code 配色方案与移植方式

日期：2026-09-23。用途：为任务 V2-06（设置与外观）提供配色方案的来源、结构、许可与移植方法依据。本文是证据资料，不是最终范围；范围以 [V2 产品规格](../specs/v2-product.md) R-APPEARANCE 为准。

## 1. 来源与版本

- 仓库：[microsoft/vscode](https://github.com/microsoft/vscode)，调研时 main 分支提交 `e81ea68fc0228ba2eb01fc9848c30d2e41a26d56`（2026-09-23）。移植时必须固定到具体提交，并在生成结果中记录该提交。
- 内置主题分布在 `extensions/theme-defaults/themes/` 和 9 个 `extensions/theme-*` 扩展中（`theme-seti`、`theme-modern-icons` 是图标主题，不在范围内）。
- VS Code 当前默认：深色 `Dark 2026`、浅色 `Light 2026`、高对比 `Default High Contrast` / `Default High Contrast Light`（`workbenchThemeService.ts` 的 `ThemeSettingDefaults`）。
- VS Code 的“跟随系统”做法：`window.autoDetectColorScheme` 开启后，按系统浅深色在 `workbench.preferredLightColorTheme` 与 `workbench.preferredDarkColorTheme` 之间切换。Oris 可以沿用这个模型。

## 2. 主题清单

| 显示名 | 类型 | 文件 | 继承 | 来源与许可 |
| --- | --- | --- | --- | --- |
| Dark 2026（默认深色） | 深色 | `theme-defaults/themes/2026-dark.json` | Dark Modern | Microsoft，MIT |
| Light 2026（默认浅色） | 浅色 | `theme-defaults/themes/2026-light.json` | Light Modern | Microsoft，MIT |
| Dark Modern | 深色 | `dark_modern.json` | Dark+ | Microsoft，MIT |
| Light Modern | 浅色 | `light_modern.json` | Light+ | Microsoft，MIT |
| Dark+ | 深色 | `dark_plus.json` | Dark (Visual Studio) | Microsoft，MIT |
| Light+ | 浅色 | `light_plus.json` | Light (Visual Studio) | Microsoft，MIT |
| Dark (Visual Studio) | 深色 | `dark_vs.json` | — | Microsoft，MIT |
| Light (Visual Studio) | 浅色 | `light_vs.json` | — | Microsoft，MIT |
| Dark High Contrast | 高对比深色 | `hc_black.json` | — | Microsoft，MIT |
| Light High Contrast | 高对比浅色 | `hc_light.json` | — | Microsoft，MIT |
| Abyss | 深色 | `theme-abyss` | — | 源自 Colorsublime-Themes，MIT |
| Kimbie Dark | 深色 | `theme-kimbie-dark` | — | 同上 |
| Monokai | 深色 | `theme-monokai` | — | 同上 |
| Monokai Dimmed | 深色 | `theme-monokai-dimmed` | — | 同上 |
| Quiet Light | 浅色 | `theme-quietlight` | — | 同上 |
| Red | 深色 | `theme-red` | — | 同上 |
| Solarized Dark | 深色 | `theme-solarized-dark` | — | 同上 |
| Solarized Light | 浅色 | `theme-solarized-light` | — | 同上 |
| Tomorrow Night Blue | 深色 | `theme-tomorrow-night-blue` | — | 同上 |

许可：VS Code 仓库为 MIT（Copyright Microsoft Corporation）；9 个第三方主题的 `cgmanifest.json` 均登记来源 [Colorsublime-Themes](https://github.com/Colorsublime/Colorsublime-Themes)，其 MIT 声明（Copyright (c) 2015 Colorsublime.com）收录在 VS Code 的 `ThirdPartyNotices.txt`。移植后需要在 Oris 的第三方声明中同时保留这两份版权与许可文本。

## 3. 主题文件结构

- 格式为 JSONC（允许注释与尾逗号），不能直接用 `JSON.parse` 解析。
- `include`：继承链，例如 Dark 2026 → Dark Modern → Dark+ → Dark (VS)。子主题的颜色覆盖父主题，`tokenColors` 追加在父主题之后。
- `colors`：界面颜色键，例如 `editor.background`、`sideBar.background`、`list.activeSelectionBackground`、`diffEditor.insertedTextBackground`。
- `tokenColors`：TextMate scope → 前景色 / 字体样式的规则数组，用于语法高亮。
- `semanticTokenColors`：语义高亮规则。Oris 使用 CodeMirror 6 + Lezer，没有语义 token，这部分不移植。

### 关键发现：大部分颜色不在主题文件里

主题文件只覆盖一部分颜色键，其余的由 VS Code 内部的**颜色注册表**按主题类型（dark / light / hcDark / hcLight）提供默认值，其中不少默认值是由其他颜色派生出来的（加透明度、变亮、变暗）。解析继承链后的实测（调研提交）：

| 颜色键 | 在主题文件中定义的主题 |
| --- | --- |
| `editor.background` | 除 Light High Contrast 外全部 |
| `sideBar.background`、`titleBar.activeBackground`、`statusBar.background` | Dark/Light 2026、Dark/Light Modern、9 个第三方主题；Dark+/Light+/VS/高对比系列没有 |
| `diffEditor.insertedTextBackground` / `removedTextBackground` | 只有 Dark/Light 2026、Abyss、Quiet Light 等少数几个 |
| `diffEditor.insertedLineBackground` / `removedLineBackground` | 只有 Dark 2026 |
| `editorGutter.modifiedBackground` / `addedBackground` | 只有 Dark/Light 2026、Dark/Light Modern |
| `gitDecoration.*ResourceForeground` | 只有 Dark/Light 2026 |
| Light High Contrast | 整个主题只定义了 6 个颜色键 |

因此移植必须包括：主题文件本身 + Oris 用到的那部分颜色键的注册表默认值与派生规则。示例默认值（调研提交）：

| 颜色键 | dark | light | 定义位置 |
| --- | --- | --- | --- |
| `diffEditor.insertedTextBackground` | `#9ccc2c33` | `#9ccc2c40` | `src/vs/platform/theme/common/colors/editorColors.ts` |
| `diffEditor.removedTextBackground` | `#ff000033` | `#ff000033` | 同上 |
| `diffEditor.insertedLineBackground` / `removedLineBackground` | `rgba(155,185,85,.2)` / `rgba(255,0,0,.2)` | 同 dark | 同上 |
| `diffEditor.diagonalFill` | `#cccccc33` | `#22222233` | 同上 |
| `editorGutter.modifiedBackground` | `#1B81A8` | `#2090D3` | `src/vs/workbench/contrib/scm/common/quickDiff.ts` |
| `editorGutter.addedBackground` | `#487E02` | `#48985D` | 同上 |
| `editorGutter.deletedBackground` | 派生自 `editorError.foreground` | 同左 | 同上 |
| `gitDecoration.modifiedResourceForeground` | `#E2C08D` | `#895503` | `extensions/git/package.json` |
| `gitDecoration.untrackedResourceForeground` | `#73C991` | `#007100` | 同上 |
| `gitDecoration.conflictingResourceForeground` | `#e4676b` | `#ad0707` | 同上 |

高对比主题的注册表默认值多为 `null`，界面改用 `contrastBorder` / `contrastActiveBorder` 描边来区分元素。Oris 需要为高对比类型提供“描边代替底色”的样式分支，不能只替换颜色变量。

## 4. 与 Oris 的差异与冲突

1. **diff 颜色语义不同（需要用户决定）。** VS Code 的 diff 只有“新增 = 绿、删除 = 红”，修改行表现为左删右增，没有单独的“修改”颜色。Oris 已确认的语义是“修改 = 蓝、新增 = 绿、删除 = 灰”（V1 D02、[UI 基准](../design/02-approved-ui.md)第 4 条）。可选做法：
   - A（推荐）：保持 Oris 语义，色值从主题中取。修改取 `editorGutter.modifiedBackground`（各主题都是蓝系），新增取 `diffEditor.inserted*` / `editorGutter.addedBackground`，删除用主题前景色与背景色混合出的中性灰。不改变已确认的阅读语义。
   - B：完全采用 VS Code 的红绿。需要推翻 V1 已确认的配色语义，底栏图例、非颜色辅助标识也要跟着改。
   - C：在设置中提供“diff 配色：Oris 语义 / 跟随主题（红绿）”开关。多一个设置项和一套验收。
2. **语法高亮的机制不同。** VS Code 用 TextMate scope，CodeMirror 6 用 Lezer highlight tags。需要一张 scope → tag 的映射表（例如 `keyword`、`storage.type` → `tags.keyword`；`entity.name.function` → `tags.function(tags.variableName)`；`entity.name.type`、`support.class` → `tags.typeName`；`constant.numeric` → `tags.number`；`comment` → `tags.comment`），按 TextMate 最长前缀匹配规则选色。结果只能做到“接近 VS Code”，不能逐 token 一致：Lezer 的 token 粒度与 TextMate 语法不同，没有语义高亮；当前语言支持只有 `@codemirror/lang-javascript`，其他语言的高亮取决于 V1 任务 05 的语言加载范围。
3. **界面结构不同。** VS Code 的颜色键面向活动栏、标签页等 VS Code 特有部件。Oris 只需要其中一部分，需要建立“Oris 颜色变量 ← VS Code 颜色键（带回退链）”的映射，详见[技术方案 §9](../architecture/v2-architecture.md)。
4. **当前实现的颜色是写死的。** `src/styles.css` 里有 117 处十六进制颜色，只有 66 处使用了 CSS 变量；深色语法高亮直接用了 `@codemirror/theme-one-dark`。切换配色前要先把这些颜色全部收拢为变量。

## 5. 推荐的移植方式

- **离线转换，而不是运行时解析**：用一个脚本读取固定提交的 VS Code 主题文件，解析 JSONC 与继承链，用移植过来的注册表默认值补齐缺失的键，再按映射表生成 Oris 自己的主题数据（界面变量、diff 颜色、Lezer 高亮规则）。把生成结果和来源提交一起提交入库；应用运行时不读取 VS Code 格式的文件。
- 生成时自动检查对比度（正文、次要文字、选中文字与背景），不达标的项目列入报告，不静默修改主题颜色。
- 每套主题的生成数据只有几 KB，可以按需加载，不会明显增加包体积。
- 升级 VS Code 来源版本时重新运行脚本，比较生成结果的差异，而不是手工修改生成文件。
