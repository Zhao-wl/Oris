# 对齐变化：滚动卡顿、闪动与底部错位

日期：2026-10-19。验证对象为当前工作区源码。

## 修复

- 滚轮、触屏、键盘和概览轨道输入不再触发清空全部对齐占位；滚动结束后的增量校正继续保留。
- 接管一侧时保留另一侧尚未送达的同步标记，记录浏览器实际接受的滚动值。对齐模式下，从属侧的测量滚动不再反过来接管主控侧。
- 对齐模式按相同像素坐标同步，避免在占位中重复执行差异块映射；对齐完成后重新同步视口。搜索、跳行和差异导航显式选择滚动主控侧。
- 文件末尾的行块高度已经包含该位置的占位，计算差异边界前扣除它，避免重复计入和反复调整。

## 验证

- `npm test`：449 项通过，1 项跳过。
- `npm test -- src/DiffViewer.test.tsx src/diff-scroll.test.ts`：最终同步修正后，39 项通过。
- `npm run build`：通过；保留现有大 bundle 提示。
- `npm run test:gui-safety`：3 项通过。
- `node scripts/verify-aligned-scroll.mjs`：使用独立 profile 和 CDP 端口启动无界面 Edge，渲染真实 DiffViewer 与项目 CSS。覆盖短文件、大段新增、尾部新增、无末尾换行、新增与删除混合、自动换行、折叠上下文，并保留关闭对齐的对照场景。对左右侧分别执行浏览器滚轮向下、反向滚动及到底操作；逐帧检查占位、回跳、主控侧，以及可见相同文字行的位置差。另模拟从属侧测量引起的滚动，检查主控侧不被拉回且从属侧恢复同步。结果保存在 `artifacts/aligned-scroll/result.json`。
- jsdom 回归只验证同步事件和输入的行为，模拟几何不作为实际布局证据。

浏览器最终结果：40 个采样状态（36 个开启对齐、4 个关闭对齐的对照），全部断言通过。开启对齐的 36 个状态中，可见相同文字行的最大位置差均为 **0 px**；逐帧未发现占位清空或向下滚动回跳，主控侧保持正确，反向滚动和从属侧测量后的恢复同步均通过。

## Windows GUI 安全边界与清理

已检查 `scripts/focus-task02-window.ps1` 和全部六个 `scripts/task02-feedback-*.mjs`。它们保持永久拒绝执行的状态，本次无需修改危险调用。新增验证没有窗口枚举、激活、显示、隐藏或移动调用；CDP 仅连接本轮创建的独立 profile 所记录的端口及精确测试 URL，没有操作用户已有应用窗口。

本次未执行真实 Windows 前后台焦点切换，也未把 DOM/CDP 操作当作此项通过的证据。用户正在运行的桌面程序未被替换。

正常验证实例在 finally 中关闭浏览器、服务器并清理自己的 profile。早期调试遗留的以下三个目录，对其执行经绝对路径核验的 PowerShell 删除时被宿主策略拒绝（`blocked by policy`），因此保留，未换用其他入口删除；对应浏览器进程已关闭：

- `D:\Projects\Research\Oris\artifacts\aligned-scroll\profile-9yR80Q`
- `D:\Projects\Research\Oris\artifacts\aligned-scroll\profile-z3eVvp`
- `C:\Users\zhaowenlong\AppData\Local\Temp\oris-aligned-scroll-T2NQ7v`

## 本地测试包

按用户要求，在 PowerShell 中运行 `scripts/build-release.ps1`，Release 构建和 `verify_release_entry` 均通过：`CUSTOM_PROTOCOL=true`、26 个嵌入资源、`ENTRY_ASSETS_PASS`，主入口 JS 为 `index-BH4gnUxk.js`。包含当前未提交的对齐滚动修复，版本号保留 0.9.0。

- 免安装包：`D:\Projects\Research\Oris-builds\aligned-scroll-20261019\Oris-aligned-scroll-win64.zip`（14,584,010 字节）。
- 可执行文件：`D:\Projects\Research\Oris-builds\aligned-scroll-20261019\Oris-aligned-scroll-win64\oris.exe`。
- 包内包含匹配的 `WebView2Loader.dll`、第三方许可证、运行说明和 `build-info.json`；已核对压缩包条目及包内 EXE 哈希与构建产物一致。
- EXE SHA-256：`8EC3D559CAEB4D573CFB9E59EEEA24E0E178B668C8B234A19CFA76F2639F50DC`。
- ZIP SHA-256：`6FACDEBA219253A68441FEEB1B8DEBA86F04B66BD09B60B272E8C06F9500737B`。

## 第二次反馈：实际文件底部仍不齐（r2）

第一轮的合成夹具没有覆盖实际文件的空行组合。现以 `E:/Tap4fun/X20_2/game-workspace/client` 中截图文件 `Assets/X1/FootballPresentation/Animation/Editor/Observation/FootballAnimatorPlayersWindow.cs` 的暂存区与工作区内容进行只读复现。修复前位置误差最大为 18.1875 px；右侧滚到底时，两侧滚动上限相差 18 px，色块和连接带随之倾斜。

根因在 `computeDiff` 的行级范围转换：空行同时满足行首、行尾条件，旧逻辑将两侧起点各跳过一个换行；纯插入的一侧终点随后被截到新起点，另一侧的终点却没有对应移动，导致范围少包含一行。新增 `lineHunks` 保留共同空行的起点，并保留原有相邻块合并和 EOF 截断规则。字符级 `changes` 的内容不变。随机用例增加“块外文本必须逐段对应”的断言，补充连续空行的新增、删除和文件开头/末尾回归。

最终验证：

- `npm test`：454 项通过，1 项跳过。
- 实际文件普通视图、块标题、自动换行共 18 个状态，以及合成夹具 46 个状态通过；开启对齐的状态中文字与色块下边界最大误差均为 0 px。
- 实际文件证据：`artifacts/aligned-scroll/feedback-before.json`、`feedback-result.json`、`feedback-after.png`。复现命令：`node scripts/verify-aligned-scroll.mjs --repo E:/Tap4fun/X20_2/game-workspace/client --file Assets/X1/FootballPresentation/Animation/Editor/Observation/FootballAnimatorPlayersWindow.cs`。
- PowerShell Release 构建与 `verify_release_entry` 通过，`CUSTOM_PROTOCOL=true`、26 个嵌入资源、`ENTRY_ASSETS_PASS`；JS 为 `index-O2MxmcQY.js`，diff Worker 为 `diff-worker-nBCdK5Hd.js`。
- 继续使用无界面 Edge，旧窗口激活脚本及六个调用方保持禁用，本次没有新增危险窗口调用，没有操作其他应用窗口；未执行真实 Windows 焦点切换。测试浏览器与其临时 profile 均正常关闭、清理。

修订包：`D:\Projects\Research\Oris-builds\aligned-scroll-20261019-r2\Oris-aligned-scroll-r2-win64.zip`（14,583,091 字节）。解压目录中的 EXE、DLL 和压缩包内容哈希已核对一致；版本仍为 0.9.0，包名以 r2 区分。

- EXE SHA-256：`BD75E5919BA03516B43F73C22D956F3693DEC56CEDF286B95698E16147D268B1`。
- ZIP SHA-256：`68E2908C523C7CD0992920CB9559A46176D208C8617D160A47A411AB1556F38F`。

用户已于 2026-10-19 确认 r2 验证通过，并要求合入主干、发布新版本。本次验收对应上述 EXE SHA-256，发布内容为这次对齐滚动和空行范围修复。
