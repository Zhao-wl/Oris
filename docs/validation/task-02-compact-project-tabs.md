# 项目 tab 精简与启动恢复补充回归

日期：2026-09-23。执行会话：`01a0cbe2-4ed0-7731-a1e4-3b29ad66e4ca`。本轮保持既有 WIP，不更新任务验收状态，不提交、暂存或推送。

## 实施范围

- 新 `ProjectTab.tsx` 承载项目标签交互。名称双击或 F2 进入原位输入；Enter/失焦保存 trim 后别名，Esc 取消，空白回退原仓库名。中文 IME 组合输入中的 Enter 不提前确认。
- 移除独立重命名按钮、固定/取消固定入口和星标。旧 `pinned` 字段保留兼容，不参与展示、访问顺序或拖动排序。
- × 是独立按钮，只删除应用记录；不会先选择项目或启动拖动。hover、active、focus-within 时显示，默认 `visibility:hidden` 且 `pointer-events:none`，避免透明但可点击的控件。键盘先进入标签后可到达显示的 ×。
- 固定标签宽度 164px（原最小 310px），18px 拖动柄、可收缩名称/路径列、20px 关闭入口；名称/路径采用省略号，完整路径保留 title。状态另占窄行，避免挤掉名称。宽度是 CSS 契约，未执行实际桌面视觉验收。
- 独立拖动柄、别名存储和用户数组顺序保持；编辑时禁用拖动柄并拒绝 drop。重启恢复不按 pinned/访问时间重排。

`App.tsx` 仅替换项目标签渲染、移除旧编辑/固定 UI 状态，并将无快照时的侧栏状态区分为正在读取/读取失败/未知。没有修改范围切换、notice 提示、初始化门禁、缓存或 01 的 presentation/单轨/单栏实现。

## 启动缺陷复核

本轮没有将用户运行旧 exe 视为新代码缺陷。新增实际 App 挂载回归：先选择并持久化第二个项目的 staged 范围，再卸载并用 StrictMode 重新挂载，分别返回可读快照、空快照和错误；另覆盖无效 activeId 回退。

现有初始化修复在这些条件下均会主动打开保存项目一次，无需点击或聚焦，不预读其他仓库；未复现新的“已选中却未调用打开”控制流缺陷。因此没有另行改写启动逻辑。

额外状态断言复现了一个确定缺口：读取失败时主错误和 tab 失败状态已存在，但侧栏 footer 仍显示“未知项目状态”。先观测到测试失败（expected 项目读取失败 / received 未知项目状态），再只修正该显示分支。空快照明确显示“当前比较范围没有变化”，不显示未知；失败显示明确错误并退出 loading。

用户另问的“阅读位置已调整”保持只读诊断：未修复 scope 旧 selectedPathId 传递，也未清理 notice 或改变提示语义。

## 自动验证

- `npm test -- --run`：8 个文件、59 项通过。保留 01 的单轨/纯新增删除单栏测试。
- `App.initialization.test.tsx` 共 18 项：保留原 13 项；新增 v2 非首 active/staged 三种重挂载结果、无效 activeId 回退，以及别名/拖动顺序持久化和关闭非活动项目不切换的集成验证。
- `ProjectTab.test.tsx` 7 项：旧 pinned 无星标/固定按钮、完整路径 tooltip、双击 Enter、blur/空名回退、F2/Esc、IME、× 事件隔离、编辑/拖动隔离（部分断言在同一测试中）。
- TypeScript/Vite 与独立 release 构建通过；保留 Vite 原有大 chunk 提示。`git diff --check` 通过。
- 未修改 Rust，本轮不声称重跑 Rust 测试。没有启动 Oris、执行 CDP、原生焦点或桌面视觉测试；受控事件测试不是原生鼠标拖拽验收。macOS 门禁保持未验证。

## 文档与交付边界

现行 R-PROJECT、批准 UI 的项目条款和任务 02 范围已改为双击别名、× 移除和持久拖动顺序；历史方向及旧 Windows 证据增加“固定功能已取消”的说明，不篡改过去的实测记录，也不宣称继续保留固定验收。未改任务状态/勾选、任务 03+ 编号、README 或 AGENTS.md。

按总控已确认结论，初始化说明回写“静态与受控测试基础覆盖通过，真实 GUI 未验收”；01 单轨说明只追加内部基础覆盖结论，保留技术记录不变。

整合构建使用独立 `CARGO_TARGET_DIR=artifacts/task-02-feedback/tab-ui-build`，不覆盖主 release 或此前独立 exe，也没有终止用户进程。保留 01 的 `DiffViewer.tsx`（SHA-256 `14379AF3968274BBF858C158C62EE1EDF9225752CE57C4D1F720614723310DDB`）及 `diff-presentation.ts`（`DA81AF529FDB400125517B769653FBAAFB0788840286B4D1C8143C4B657B9180`）。源码快照和产物信息见 `artifacts/task-02-feedback/tab-ui-build-manifest.json`。

最终 exe：`artifacts/task-02-feedback/tab-ui-build/release/oris.exe`，23,415,193 字节；SHA-256：`52D45F82673713AE98A8364037540BE6EBA2A13A4CB3CF4409C377A5D9E93203`。源码快照时间 2026-09-23 14:22:36 +08:00，完成时间 14:23:17 +08:00，构建后逐文件哈希与快照一致。前端 `index-DGSMtZZw.js` / `index-Depp53rO.css`。此前独立 01 整合产物仍为 `C51DB7419FE98EFA1A1A0B2A43A5A4E8B8F24F99B344206C07BFF3A5FB6E0360`，本轮没有覆盖它。

## 最终基础覆盖结论

总控收到 `task02_coverage` 通过报告：本轮紧凑项目 tab 与启动专项的静态实现、受控测试基础覆盖通过，无基础需求覆盖缺口。本次覆盖检查未重跑测试，不属于深度代码审查；本次回写仅记录该结论。

真实 GUI、hover/鼠标拖动、Windows 原生焦点和 macOS 仍未验收，不因本结论改为通过。源码、release 和 manifest 源码快照未变；release SHA-256 保持 `52D45F82673713AE98A8364037540BE6EBA2A13A4CB3CF4409C377A5D9E93203`。
