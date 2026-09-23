# Task 03：大仓持续过期与刷新调度修复

## 现场与范围

2026-09-23，只读核对用户运行实例 PID 45712，路径为 `artifacts/task-03-json-fix/target/release/oris.exe`，SHA256 为 `D2889D9C8BDFE3779543A6B5E2CAD5FE22A9A57A541CA8D7EA9C87CE32177A49`。当前基线 HEAD 为 `c0df05bd1b91040ac639981a39b8ec5b638a9994`，共享工作区包含前轮与其他任务 WIP。本轮未提交、暂存、重置、删除构建目录或添加忽略规则，未修改“阅读位置已调整”通知逻辑。

## 证据与修复

- 已复现机制：旧读取在前后两次校验全仓文件元数据，未变化 JSON 会因其他文件写入而得到 staleRequest。上一轮 JSON 报告记录了真实 Git 复现，本轮更改该回归以要求无关写入期间仍可读，并另测选中文件自身变化必须拒绝。
- 快照对全部未跟踪文件读取最多 5 MiB 来统计行数，在构建目录中造成无必要的大量 I/O。本轮保留完整文件列表，行数作为可选元数据限定最多 64 文件、合计 1 MiB，先按尺寸筛选，再执行有界读取。
- 新 `read_guard.rs` 按路径保存 index 各 stage 的 OID/mode、所需 HEAD 条目、工作树类型/尺寸/修改时间。Git 条目批量获取，单文件读取只查询相关路径。读取前后验证 guard，读取后复核实际源字节（20 MiB 上限；LFS 核对指针原文）。最近三份快照保留在后端，以免无关自动扫描仅因替换列表版本就淘汰在读请求；历史外请求、未知路径、相关变化仍拒绝，不自动无限重试。
- `check-ignore` 不能继承 `GIT_LITERAL_PATHSPECS=1`。本轮开始写入前已检测到共享源码中存在定向 `env_remove` 修正，保留该修正，不归为本轮独立新增。另修复大量路径时 stdin/stdout 双管道可能相互阻塞的问题；保留命令失败按相关变化处理的语义。
- watcher 继续忽略读取事件，并过滤 AccessTime 元数据变化；overflow/rescan 仍标脏。事件附带相对路径与 Git 状态变化标记，无关路径不清除或拒绝当前冲突内容。初次读取期间也用在读路径判定，不依赖已显示结果。
- 自动刷新串行执行并保留 1.5 秒冷却间隔；手动刷新在自动扫描期间可排队一次，完成或报错后恢复按钮。失焦只标脏，不自动扫描；初始化及明确手动操作仍允许完成。

## 自动化证据（非 GUI）

日志、构建配置、源码清单与产物均在 `D:/Projects/Research/Oris-builds/task03-stale-fix`。

- 前端：82 passed / 11 files；TypeScript 检查通过。包括自动扫描期间手动排队、持续事件期间无并发重入、失焦门控、无关路径保持冲突结果、无关事件不拒绝进行中的冲突读取。原先连续事件测试窗口随 1.5 秒冷却由 1.2 秒改为 2 秒，仍要求触发更新。
- 5001 文件真实 Git 夹具：快照 2562 ms；五次读取共 853 ms；旁路写入 81 次，五次读取均成功。选中路径发生变化时拒绝旧读取；停止写入、刷新后恢复。阶段样本：列表 760 ms、全仓列表版本 784 ms、端点记录 941 ms。此为后端夹具耗时，不是原生界面首次可读时间。
- 真实当前仓库只读探针：5611 个变化，截图选中文件 `artifacts/task-03/build/.rustc_info.json` 为 1383 字节，SHA256 `dd8a39ec504bcf33da987bbbd6f08560b3a7b9b7adb6725c7687693bd2c3a4db`；左侧 missing、右侧 utf-8，成功。列表 1725 ms、版本 713 ms、端点记录 1130 ms；测试体 4.63 秒，进程探针总计 5376 ms。与前轮 68.73 秒探针文件/仓库状态不同，不能作为严格同条件性能比值。
- Windows 原生文件系统 notify（无窗口）：20 次 metadata/read 产生 0 个事件、0 个失效；写入产生 1 个失效。读取自激在本机未复现，不作为已证实根因。Access/AccessTime 与 rescan 的分类另有单元断言。
- 桌面特性 test EXE 编译后遇到 `0xc0000139` 动态库入口加载失败，测试体未执行。增加 notify 测试依赖，使用 no-default-features 测试程序执行同一生产事件分类函数与真实 Windows watcher；不把该结果称为 WebView2 验证。
- 完整 Rust 最终结果与交付散列见下方补记。

## 安全与未验证范围

没有启动或激活任何 GUI、没有调用 ShowWindow/SetForegroundWindow/AppActivate，没有结束用户 Oris，也没有操作 Codex 或其他应用窗口。旧 `focus-task02-window.ps1` 与 task02-feedback 自动化未调用，本轮没有修改其危险调用。所有夹具由 tempfile 创建并在测试结束释放；watcher 在退出前 drop。构建输出和日志位于仓外，不覆盖正在运行的 EXE。

真实 Windows 前后台切换、WebView2 内实际可读时间、WKWebView、30 次 GUI 切换与进程树资源尚未验证。jsdom 控制焦点与文件系统 watcher 测试不等于原生窗口焦点测试。任务 03 整体验收状态不变，不解锁后续任务。

## 构建与复现补记

本轮再次直接运行旧 JSON 修复版的已存在测试二进制（未重编译旧源码），定向夹具输出 `REPRO_UNCHANGED_JSON_SIBLING_MUTATED {"kind":"staleRequest","message":"仓库已发生变化，请刷新"}`；1 passed，1.29 秒。此处 passed 表示成功复现旧行为，并非修复通过，见 `baseline.log`。未重建同条件 5001 文件旧版性能基准。

最终回归的大仓样本受并发 release 构建负载影响：5001 文件快照 2964 ms，五次读取 1993 ms，旁路写入 123 次，5/5 成功；选中变化拒绝与停写恢复通过。最终阶段样本列表 781 ms、版本 853 ms、端点记录 1135 ms；前述首轮数字保留为独立样本，不择优替换。5000 条忽略路径的过滤与混合一条真实变化测试通过。

Release 构建通过，产物 `D:/Projects/Research/Oris-builds/task03-stale-fix/target/release/oris.exe`，29,009,039 字节，SHA256 `EC343D1363F10FEDDEFA8BF8454C723774C2C417BFB915719BCF8D183B7302FA`。未启动该 GUI 程序。

冻结 45 个源码/依赖/配置文件。Tauri 构建自动将 `Cargo.toml` 从 CRLF 转为 LF，逐字节换行归一后与冻结文件散列匹配；没有语义变化。初始清单 `source-manifest.json` 与构建清单 `source-manifest-build.json` 均保留，后者 SHA256 `BCFC372BE762ED5B359E2EBE2764A43F570D131285339D5C1A4050895AD988C3`，构建结束后 45 个文件无漂移。旧运行 EXE 的 SHA256 仍为 `D2889D9C8BDFE3779543A6B5E2CAD5FE22A9A57A541CA8D7EA9C87CE32177A49`。

中间验证失败如实保留：第一次缺少 dlltool；桌面测试入口加载失败；新 5000 路径过滤测试第一次因夹具短路径未规范化而失败；该测试程序仍在运行时一次重链接被 Windows 拒绝。后续使用正确工具链、规范化测试路径并等待原测试结束。均未通过结束用户进程或改写测试断言规避。

## 最终回归结论

`cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib -- --nocapture`：**30 passed / 0 failed / 5 ignored**，209.83 秒，见 `rust-verified.log`。原完整 conflict 合并、rebase、stage 缺失形态、图片、LFS、本轮大仓、过滤突发、读取变化以及实际 notify 测试均通过。5 项 ignored 是既有显式性能/现场探针；截图文件探针另行显式执行通过。前端 82 passed / 11 files、`npx tsc --noEmit` 通过、release 构建通过。最终再次核对 45 文件构建清单，无源码漂移。

已向总控报告交付，本轮仅完成此定向修复，不宣称任务 03 全平台验收完成。

## 总控定向基础覆盖检查

2026-09-23，内部 `task03_coverage` 定向基础覆盖检查通过：实际核对 EXE SHA256 `EC343D1363F10FEDDEFA8BF8454C723774C2C417BFB915719BCF8D183B7302FA` 与构建清单 SHA256 `BCFC372BE762ED5B359E2EBE2764A43F570D131285339D5C1A4050895AD988C3`。路径 guard 与源字节复核、行数统计预算及可选值、手动刷新单次排队、自动冷却、失焦门控、ignored 过滤回归均有覆盖，无需补齐。

本次内部检查只读、未重跑测试，不是技术深审。真实 GUI、WKWebView、原生焦点切换与进程树尚未验证；desktop-feature 测试的动态库入口加载失败不能由 notify 测试通过替代。5.376 秒是非 GUI 探针耗时，且不是严格同条件的旧新性能比较。已复现的失效机制不能证明截图当时唯一的事件来源，该来源仍未确定。

本次仅追加本报告，未修改代码、构建产物、散列清单或总体门禁，未重测、暂存、提交或推送。
