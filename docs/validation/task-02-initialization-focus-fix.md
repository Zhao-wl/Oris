# 任务 02 初始化与自动刷新焦点边界修复

日期：2026-09-23。执行会话：`01a0cbe2-4ed0-7731-a1e4-3b29ad66e4ca`。

内部覆盖结论（总控确认）：静态调用链和受控 App 集成测试的基础覆盖通过；这不是 Windows 原生 GUI/焦点验收，也不关闭 macOS 门禁。后续项目 tab 轮补充 v2 非首活动项目、staged、实际卸载后重挂载、StrictMode、空结果、失败及无效 activeId 回退测试；仅修正了失败时侧栏误显示“未知项目状态”的文案分支。启动自动加载路径未复现新缺陷，未另行改写其生命周期。详见 [项目 tab 与启动回归](task-02-compact-project-tabs.md)。

## 复现与根因

用户截图显示项目“正在恢复”、内容区“正在读取真实仓库”、侧栏无文件。截图用于确认症状，没有把它当作根因证明；本轮未打开截图中的用户仓库。

在 jsdom 中挂载实际 `App`，控制 Tauri 焦点桥、仓库 API 和 Worker Promise，无原生窗口操作。修改产品代码前，新增的 5 项集成测试失败，其中两个直接证明问题：

1. 初始焦点为 false 时，恢复已存活动项目后 `openRepository` 调用数为 0。原 startup effect 将必要初始化放在 `isForeground()` 后，初始未知/false 直接只标 pending。
2. 元数据 Promise 尚未完成时发生 blur，再返回有效快照，`readContentPair` 调用数仍为 0。原 blur 无区别替换 repository/content gate，必要初始化结果被丢弃。

另据当前调用链，`refreshActive` 原先先判断“未打开”并调用 `loadProject`，再检查 loading/busy；焦点事件可能重复发起尚未完成的恢复并替换 gate。已将必要请求的同步 pending 状态纳入互斥判断，并取消自动刷新对初次打开/失败恢复的隐式重启。

以上是可复现的控制流缺陷，能解释初始化不推进和恢复状态残留；未把它扩大为用户真实仓库所有 I/O 延迟的唯一原因。

## 修改

- `App.tsx`：活动项目/v1 旧记录的必要初始化立即启动，不依赖首次焦点查询，完整执行元数据、快照、首文件和 diff，直到可阅读、空仓状态或明确错误。不后台预读其他项目。
- `RequestGate`：区分必要请求与自动请求，记录是否在途。初始化、显式打开/切项目/切范围/切文件/手动刷新默认是必要请求；watcher、轮询、回焦核对为自动请求。
- blur 只取消在途自动请求，保留必要请求的 gate 和完成/失败收尾。自动请求晚到结果不发布；显式读取可以隔离此前自动刷新。
- 自动更新仍要求原生窗口聚焦且 document visible；失焦事件只标 dirty、停轮询，不触发新自动 Git 工作。回焦事件合并，未变化的 diff 不重建。
- 焦点状态改为 App 实例 ref；焦点查询失败按未聚焦处理，但不阻塞初始化。焦点查询带代次，晚到初始结果不能覆盖更近的事件。
- `App.initialization.test.tsx`：实际 App 的受控集成测试。仅替换外部桥、Worker 和编辑器展示，不模拟 Windows 验收。
- `package.json` / lock：添加测试用 jsdom，生产运行依赖没有新增。

## 验证

`npm test -- --run`：6 个测试文件、37 项通过，其中本轮 13 项：

1. 初始未聚焦，只恢复活动项目并读到首文件。
2. 元数据及内容读取期间失焦仍完成，未重复打开。
3. 未聚焦初始化失败显示错误并退出 loading。
4. 初始化完成后失焦，8 次 dirty 事件和 61 秒受控时钟不刷新；多次回焦只核对一轮，无变化保留展示实例。
5. 慢 A 初始化后显式切 B，A 晚到不覆盖 B，B 未聚焦也完成。
6. 初始焦点查询未返回、打开较慢时仍启动一次，不因轮询重复打开。
7. 内容读取失败退出 loading。
8. Worker 失败退出 loading。
9. 显式切范围的新内容读取穿过 blur 后完成。
10. 自动刷新在途时失焦，晚到结果不读新内容；再次聚焦合并核对。
11. v1 恢复及 React StrictMode 不等待焦点且只打开一次。
12. 原生焦点查询拒绝，初始化仍完成，后台不自动刷新。
13. 较晚的初始焦点查询不能覆盖更新的焦点事件。

本轮没有修改 Rust；此前 Rust 10 passed、2 个显式性能探针 ignored 的结果仍是历史结果，本轮不声称重跑。TypeScript/Vite 构建通过，保留原有大 chunk 提示。

## 构建与安全边界

用户现有 `src-tauri/target/release/oris.exe` 正在运行（只读确认 PID 40016）。没有结束、重启、激活或修改它。使用独立 `CARGO_TARGET_DIR=artifacts/task-02-feedback/initialization-build`，复制原 release 编译缓存时排除 `oris.exe`，然后执行 `npm run tauri -- build --no-bundle`。新产物位于该独立目录，不覆盖运行中的旧版。

本轮构建前端入口为 `dist/assets/index-BFcQllRQ.js`。源码快照于 2026-09-23 13:37:31 +08:00 记录：

- `App.tsx`：`9CE3554B127AE90D8262B92D1733C3D72BD3516C3F6FA84D091F3001BFF13E12`
- `workspace-model.ts`：`8DB43D2BAE82D5713D72AEC6753E23F38DB7AD521704528BB52C351FF5DDF95C`
- `DiffViewer.tsx`：`D073D722BDCA5BED91A81C62DC76D0FF73B3B77E50982677F414239CF3C037C2`
- `styles.css`：`A8CC616CE500C6CE376AB95C42B5E4AE50064DAE4B28FB1C6F17B9002365A68D`

未修改 DiffViewer 轨道或 CSS；总控已暂停另一会话写入，构建不包含后续单轨需求。

构建完成时间：2026-09-23 13:39:41 +08:00。新产物 `artifacts/task-02-feedback/initialization-build/release/oris.exe`（23,414,899 字节），SHA-256：`0E0D813D753ECB5F8B22C69F818945552A290CC74C61F02B688DD02C124841E3`。原 release 仍为 `41F43555E3F145DE047C9CA52DEC0980200463D828E6573B64BEBF6264A76CC6`，用户 PID 40016 仍在运行。完整文件哈希见 `artifacts/task-02-feedback/initialization-build-manifest.json`。

本轮先读取根 AGENTS.md，保留全部禁用 GUI 入口，未复用危险 helper；无窗口创建、激活、枚举首匹配、CDP 连接或其他应用操作。真实 Windows 焦点和用户实际仓库 GUI 验收未测；受控测试不能代替该项。README、AGENTS.md、其他 WIP 及任务验收状态保留，未 stage/commit/push。
