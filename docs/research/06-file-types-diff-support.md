# Git 文件类型与差异展示支持调研

日期：2026-09-23。状态：研究完成；用户已确认新 03 先仅纳入图片与冲突，随后已授权并完成正式计划同步；不是产品验收结果。

现行范围以[正式 03](../tasks/03-image-conflict-diff.md)为准；旧 03/04/05→04/05/06 映射见[任务总表](../tasks/README.md)。下文保留调查时的规划和待同步记录，广泛类型建议不构成实施授权。正式同步不解除平台/GUI 门禁，未实施或派发产品。

本轮仅新增本文及[任务提案](../tasks/proposals/03-file-diff-support-plan.md)。没有修改产品代码、依赖、现有规格、任务编号或状态；没有运行 GUI、窗口操作、产品测试或 Git 写操作。

## 1. 建议结论与现状

用户最新选择：“先仅纳入图片与冲突支持”。据此新 03 收窄为静态 PNG/JPEG/WebP 图片比较、Git stages/WT 冲突只读查看两个闭环，复用现有文本阅读器，只保留两项必要的逐侧状态、类型识别、预算和端点基础。上一版完整编码/普通文件与 LFS/submodule 等扩展建议不再纳入新 03。原 03/04/05 后移为 04/05/06 的规划保留，正式文档同步须等待任务 02 完成共享修改及总控授权；范围确认不解除平台门禁，也不授权产品实施。

以下广泛类型清单和第 3–8 节保留研究价值，属于候选方案，不能整体视为新 03 范围。当前纳入范围以[两闭环提案](../tasks/proposals/03-file-diff-support-plan.md)为准：原 04 仅图片责任迁入，文本/编码及其他特殊文件既有约定仍留在后移后的任务；超出既有约定的建议继续候选。

- 常见代码、配置、JSON/YAML/XML/CSV、Markdown、Unity 文本资产：原始文本 diff；语法高亮不等于语义 diff。
- PNG/JPEG/WebP：并排、滑动、缩放、透明背景、尺寸与失败状态，优先落地已有 R-IMAGE。
- 冲突：独立于文件格式；读取 stage 1/2/3 和工作区，用可选择的双端比较复用阅读器。没有编辑、合并、Accept、写 index 或“标记已解决”。
- 普通二进制、PDF/Office、音视频、字体、二进制 3D：大小、类型依据、对象标识及变化状态；首轮不解析专有内容。
- GIF 静态预览及 SVG 安全栅格化预览作为后续可选项；首轮 GIF 元信息，SVG 源码 diff。

依据调查时读取的[产品规格](../specs/v1-product.md)、[技术方案](../architecture/v1-architecture.md)、[任务总表](../tasks/README.md)、原 [03（现 04）](../tasks/04-history-branches.md)/[04（现 05）](../tasks/05-diff-experience.md)/[05（现 06）](../tasks/06-performance-release.md)与[验收计划](../validation/v1-acceptance.md)：图片本来属于原 04；冲突原要求仅为清晰提示；AST/语义 diff、Hex、Office/PDF 专用比较本来排除。任务 01/02 的 macOS 门禁未因本提案解除。上述为初始调查快照；后续正式同步已新增冲突只读需求及更新任务编号。

源码只读观察：`src-tauri/src/git.rs` 的 `read_content_pair_for_scope` 对 Conflicted 直接返回不可用双端和提示；`text_side` 仅接受不含 NUL 的 UTF-8，预算为 5 MiB / 100,000 行 / 单行 100,000 字符。`src/types.ts` 把内容描述为 TextSide，编码状态只有 utf-8 / binary-or-unsupported / missing。`src/diff-presentation.ts` 已区分新增删除单栏与空文件。这解释当前缺口，但不是全量审核，也未重跑测试。并行会话仍可能更新这些文件，实施前应重新核对。

## 2. 官方证据与适用边界

下表均于本轮联网读取。D = 官方文档；S = 上游源码/声明。未做 JetBrains、VS Code 或 Oris 实机操作。源码 main 链接是浮动参考，不声称固定发行版本已具备所有行为。

| 证据 | 已证实内容 | 对 Oris 的启发与不能推导的结论 |
| --- | --- | --- |
| D：[Git ls-files，OUTPUT](https://git-scm.com/docs/git-ls-files#_output) | unmerged index 最多三组 mode/object/stage；`-z` 保留路径分隔 | 从 index 取版本，不从标记猜三方；不能假定三个 stage 总存在 |
| D：[Git status](https://git-scm.com/docs/git-status) | 冲突 XY 有 DD/AU/UD/UA/DU/AA/UU；子模块还有提交/脏内容状态 | 状态与内容类型分层，冲突不是扩展名 |
| D：[Git checkout，ours/theirs](https://git-scm.com/docs/git-checkout#Documentation/git-checkout.txt---ours) | stage 2/3 对应 ours/theirs；rebase 中用户直觉上的双方可能反转 | 主标签固定 stage 编号，避免武断标“我的/远端”；只引用语义，Oris 不执行 checkout |
| D：[gitattributes](https://git-scm.com/docs/gitattributes) | 文本/EOL/working-tree-encoding 与 diff/filter 属性影响 Git；外部 driver 定义在 config | 属性作为提示，不授权命令执行；不能只依扩展名判文本 |
| D：[Git diff](https://git-scm.com/docs/git-diff) | 可禁 external diff / textconv；rename 是检测结果 | 保持受控只读命令；阅读统计与 Git 来源统计分开 |
| D：[Git cat-file](https://git-scm.com/docs/git-cat-file) | 可读对象类型/大小/原始内容；filters/textconv 是另外的转换选项 | 先取大小、再按预算读 blob；不选 filters/textconv，不把对象指针当实体 |
| S：[Git LFS 指针规范](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md) | 指针包含版本、OID、size，规范限制小于 1024 字节并允许扩展字段 | 解析完整有效指针，保留未知扩展，不只搜一行；OID/size 是实体描述 |
| D：[JetBrains Diff Viewer](https://www.jetbrains.com/help/idea/differences-viewer.html) | 文本并排阅读、空白/高亮/滚动设置；文档称可比较 binary/jar | 借鉴阅读一致性；“可比较”不能推成每类二进制均有结构化语义或像素分析 |
| D：[JetBrains 冲突处理](https://www.jetbrains.com/help/idea/resolve-conflicts.html) | 左右版本与中间可编辑结果、Base 比较入口 | Oris 借鉴版本身份清楚；可编辑结果和应用修改不适用 |
| D：[VS Code 冲突](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts) | 三方 merge editor 展示 Current/Incoming/Result，并有解决流程 | 证明冲突需要专门入口；Oris 不复制写入流程 |
| D：[VS Code 历史](https://code.visualstudio.com/docs/sourcecontrol/history)；S：[media-preview 声明](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/media-preview/package.json) | 文档提及 image diff/custom editor；内置声明包括常见图片及音视频的查看器，SVG 可切源码/预览 | 预览路由与文本可分开；声明不证明动画逐帧 diff、滑动或像素比较实现，亦不证明 Tauri 两平台解码能力 |
| D：[Unity 文本序列化格式](https://docs.unity.com/en-us/engine/6000.6/manual/working-with-scenes/text-scene-format/format-description) | 场景文本使用自定义 YAML 子集 | 原始文本是可靠第一层；通用 YAML 解析不能直接冒充 Unity 对象语义 |

未采纳第三方插件宣传作为竞品原生能力证据。两次尝试的 VS Code imagePreview 源码路径返回 404，未据此得出功能结论；有效依据是上表的官方文档及 package 声明。

## 3. 检测与展示的统一规则（Oris 推荐）

先确定 Git 对象/端点身份，再检测每侧内容；最后决定阅读器。旧路径与新路径、对象 mode、内容可用性、文件格式、冲突状态彼此独立。

1. 从快照定位路径、端点、mode/OID。mode 为 gitlink 或符号链接时先走对象阅读器，不按扩展名读取目标。
2. 不存在端点、已有零字节文件、读取失败、对象缺失、超预算、解码失败必须是不同状态。零字节文件显示“空文件”，不能伪装为不存在。
3. 在有界头部读取中识别 LFS 指针及支持的文件签名；后缀用于提示、高亮与歧义消解，不覆盖签名/解码结果。已知 PDF/ZIP/可执行等即使头部可读也不当代码。
4. 文本按 BOM、严格 UTF-8、明确允许的编码解码；先识别 UTF-16 BOM 再判断 NUL，避免把合法 UTF-16 当普通二进制。所有判断记录来源；未知编码不以替换字符悄悄继续。
5. 两侧独立路由：文本→二进制、好图→坏图等仍保留可读侧和对侧原因；不出现“0 差异”。不能运行差异算法时差异计数显示不可用，而非零。
6. 新增/未跟踪/删除采用存在侧单栏；已有两端均存在但一侧内容为空，仍是双端比较。冲突缺某个 stage 不能借用普通新增删除状态猜整份文件的身份。
7. HEAD→Index、Index→Working Tree、HEAD→Working Tree 三范围保持实际端点；后续历史 Commit(OID) 复用同一读取与展示模型。每次响应携带 repo/request/revision/端点内容身份，外部改变时丢弃过期结果并提示刷新。

建议以内容状态联合类型替代“空字符串代表失败”，保留现有 TextSide 的文本数据接口作为内部适配即可；不为这一改动建设通用插件系统。

## 4. 文件类型矩阵与优先级

下表 P0/P1/P2 保留最初广泛研究的优先级：P0 为当时优先推荐，P1 为后续可选，P2 为不做专用查看；**不再表示新 03 的纳入或验收范围**。用户现已仅选择图片与冲突。表中“元信息”包括已知类型及依据、各侧字节数/OID（可得时）、路径与端点、变化或不可用原因；未知数值不填 0。通用元信息闭环不属于新 03；它的既有产品约定留在后移任务。

| 类型/样例 | 检测方法 | 默认查看与交互 | 语义 diff 取舍、限制 | 优先级 |
| --- | --- | --- | --- | --- |
| 代码/脚本：cs/ts/js/c/cpp/h/rs/py/sh/ps1/sql/shader | 严格文本解码；扩展名/shebang 只选高亮 | 既有只读文本并排/统一、导航搜索复制 | 无 LSP、编译、运行或 AST；高亮缺失退纯文本 | P0 |
| 配置与清单：ini/toml/env/gitignore/lock/log/txt | BOM/编码与有限内容识别 | 原文 diff，保留键顺序与注释 | 不展开 env、不执行脚本；长锁文件按预算 | P0 |
| JSON/YAML/XML/CSV/TSV | 已解码文本 + 后缀；不依完整解析才能显示 | 文本 diff 与可用语法高亮 | 不格式化/排序键/推断 CSV 主键，不解析 XML 外部实体；结构树/表格语义后置 | P0 文本；P1 另研语义 |
| Markdown/HTML | 文本解码 | 源码 diff | 不渲染 HTML/Markdown 链接与远程图片；渲染稿对比非首轮 | P0 |
| Unity meta/prefab/unity/asset/mat/controller 等 | 实际字节可解码且符合文本；YAML 标记只辅助 | 原始文本保留 GUID/fileID、对象顺序 | 扩展名不保证文本；二进制 asset 降级。不启动 Unity/Smart Merge、不作对象匹配 | P0 |
| PNG/JPEG/WebP（含透明图） | 签名 + 有界头信息 + 受控解码；坏签名标明 | 并排/滑动、缩放、适应、原始尺寸、棋盘格/浅深底 | 不像素热图、不相似度；动画 WebP/APNG 首轮明确降级，不能无提示自动播放 | P0 静态 |
| GIF | 签名、可得画布大小，动画情况未解析则标未知 | 首轮元信息 | 单帧/首帧静态预览可另做，必须标“仅首帧”；不逐帧比较 | P1 预览 |
| SVG | 扩展名与文本识别，XML 源码 | 源码 diff | 不 innerHTML/object/iframe 执行；含脚本/外链照原文显示。未来隔离栅格化需另审实现和预算 | P0 源码；P1 预览 |
| BMP/ICO/TIFF/PSD/EXR/AVIF/HEIC 等 | 支持识别的签名，否则后缀“推测” | 元信息 | 不因系统能打开就承诺跨平台；多页/多层/HDR/色彩专业比较不做 | P1 或 P2 专用 |
| 普通二进制、ZIP/7z/gz/tar、exe/dll/so/dylib、数据库 | 签名/已知后缀 + 非文本判断 | 元信息；内容大小相同也不能称相同 | 不执行、不 Hex、不解压/列包内容，因此无压缩炸弹解压路径 | P0 元信息，P2 专用 |
| PDF、doc/docx/xls/xlsx/ppt/pptx/odt 等 | 签名及后缀提示；ZIP 容器不解包确诊 Office | 元信息 | 不嵌 PDF、不调用 Office/textconv、不宏、不抽取文档文本 | P2 专用 |
| 音视频：wav/mp3/ogg/mp4/webm/mov | 有界签名及后缀 | 元信息 | 不自动播放、转码、波形、时间轴 diff | P2 专用 |
| 字体：ttf/otf/woff/woff2 | 签名/后缀 | 元信息 | 不向应用加载字体，不字形比较 | P2 专用 |
| 3D：obj/mtl/gltf/usd 文本、glb/fbx/blend 等 | 实际文本/二进制；后缀辅助 | 文本形式走原文 diff，二进制元信息 | 不解析场景/加载纹理/渲染；glTF 外部引用不读取 | P0 原文/元信息，P2 3D |

结构化语义 diff 的收益（减少格式与顺序噪声）需要格式特定的身份和忽略规则；JSON 重复键、YAML tag/anchor、CSV 多行引号与无主键、Unity fileID 等都不适合通用自动归一化。本轮保留原文字节身份和阅读结果，未来按真实频率选单独闭环，不机械一格式一票。

## 5. 编码、换行与文字显示

后续编码候选建议自动支持 UTF-8（含 BOM）、带 BOM 的 UTF-16 LE/BE，严格校验代理项；本节不纳入新 03，冲突文本继续复用现有编码能力。旧式编码不猜测 GBK/Shift-JIS/Windows-1252；如用户确有仓库需求，再单独确认手动编码选择的小型白名单。无 BOM UTF-16 不依 NUL 分布自动猜测。原规格中编码/EOL 的既有约定仍归后移后的阅读任务。

两侧分别显示编码/BOM、LF/CRLF/混合/CR、末尾换行；存储字节与解码后文本身份分开。仅 BOM/编码/EOL 改变时，即使可见字符相同也显示元信息变化；忽略空白选项不能消灭这些提示。读取 Git blob 不运行 clean/smudge；working-tree-encoding 仅作解释依据，不能把声明当成功解码的证明。Git 索引规范化与工作区原始换行不同，应明确“原始内容阅读”，不伪称与 Git 过滤后 patch 完全一致。

一侧失败时另一侧仍可搜索/复制，但跨侧差异导航和计数不可用；不把失败侧当空文件制造全量新增。现有文本词/行高亮、对齐/独立滚动、单栏语义应复用，不另造图片能力时重写全部文本体验。

## 6. 图片阅读方案与资源约束

默认并排，共用缩放倍率和画布坐标；首屏适应整个比较画布。两图尺寸不同则以左上角原点放置、保留各自比例与有效边界，空白区不伪装为透明像素。滑动模式在同一画布裁切两个原图，不分别 fit 后叠加；可切回并排。显示每侧原始宽高、字节数及解码失败原因。透明图棋盘格默认，可切浅/深底；背景不参与“变化”统计。单侧只有一张图时只显示该图，关闭无意义滑杆。

JPEG EXIF 方向须明确采用同一解码策略，标出存储尺寸和定向后展示尺寸的差别；两平台实际行为需样例验证。颜色管理可能因 WebView/系统不同，不承诺专业校色或精确像素差异。图片不能套用文本“增删 N 行”；不显示伪造差异数量。

下面是**实施前待固定的工程建议，不是已测能力**。沿用现有预算的部分不放宽；新增图片约束在双平台测量前登记，失败不得事后放宽门槛冒充通过。

| 环节 | 建议预算与超限结果 |
| --- | --- |
| 类型探测 | 每侧初始头部最多 64 KiB；元信息读取不加载整份二进制。必要格式头扫描仍受总字节预算约束 |
| 文本 | 每侧原始及解码后 UTF-8 表示均 ≤5 MiB，≤100,000 行、单行 ≤100,000 Unicode 标量；任一超限只保留元信息/明确原因，无静默截断 |
| 图片输入 | 每侧压缩字节 ≤20 MiB；先查尺寸，拒绝异常/溢出/超过 16,384 边长或 40 MP 单图；两侧总像素 ≤40 MP |
| 图片内存 | RGBA 基础占用按两侧像素总数×4 估算；额外渲染副本须测量。单比较图片受控分配建议 ≤256 MiB，不能声称浏览器底层内存严格等于此数；超预算退元信息 |
| 调度 | 当前文件一组内容请求、一项图像解码工作；旧请求取消/结果丢弃；切图释放 object URL/位图，不缓存跨项目完整解码图 |
| 时限 | 建议内容请求 5 s 超时后停止并显示原因；取消/切换入口始终可用。既有 S 性能目标仍独立适用，5 s 不是新的合格响应目标 |

若平台原生解码不能在分配前执行尺寸校验，不能直接把恶意头部送到 WebView 再等失败；应在实现中选择可验证的有界检查路径。没有可靠停止解码能力则仅证明丢弃过期结果，不写成 CPU 工作已取消。本轮不选库、不安装依赖。

## 7. Git 状态与对象类型：独立于文件格式

### 7.1 冲突只读入口

列表仍标“未合并”，进入后显示可得的 Base（stage 1）、Stage 2（ours）、Stage 3（theirs）、Working Tree 四个版本身份，含 OID/存在性。主视图默认 stage 2→3；端点选择器允许 Base→2、Base→3、2→WT、3→WT、Base→WT，缺失端点明确显示原因/存在侧，不假造内容。工作区是用户/外部工具当前内容，绝不命名为“已合并结果”。不必常驻四个文本模型。

用 `ls-files --unmerged -z` 的 mode/OID/stage 权威记录取 blob；状态列表可继续受控现有命令，或 porcelain v2 `u` 记录。读取路径使用原始标识，读取 blob 使用已校验 OID。若 2 或 3 不存在，默认端点仍显示删除侧身份与存在侧内容；无可读文本时显示元信息。读取期间 index/工作区变动需刷新，不能混合不同 revision。

| 冲突情形 | 典型 stage 存在性 | 默认阅读和断言 |
| --- | --- | --- |
| modify/modify（UU） | 1、2、3 | 2↔3 文本 diff，可回看 Base 与 WT；标记数量不等于冲突块数量 |
| add/add（AA） | 2、3；无 1 | 双端新增内容比较；Base 显示“无共同文件版本”，不是空白文件 |
| modify/delete（UD） | 1、2；无 3 | stage 3 删除，显示 stage 2；Base→2 可查看修改 |
| delete/modify（DU） | 1、3；无 2 | 对称处理；不能把工作区存在推成 stage 2 存在 |
| DD/AU/UA | 通常分别仅 1 / 2 / 3 | 逐项按实际 index 记录显示，不要求三版本齐备才可进入 |
| 二进制/图片冲突 | stage 组合与格式无关 | 已支持静态图走图片比较；其他二进制显示双方元信息/OID，无文本冲突标记也是冲突 |
| rename/delete、rename/rename、目录/文件冲突 | 可能跨多个路径，组合依 Git 实际输出 | 每路径原样展示 stages/状态，已知旧新路径保留；不推断跨路径三方映射，不建冲突组图 |
| rebase/cherry-pick 等 | 用实际 stage 记录 | 固定 stage 2/3 标签，操作身份未可靠识别则不加分支别名 |

上述组合是常见形态，实际记录优先。即使外部工具已经删掉标记，index 未解冲突仍显示冲突；普通文本包含 `<<<<<<<` 不自动判冲突。后续历史的 merge commit 比较父节点，属于原 03 迁移后的历史任务，不用当前 index stages 冒充历史合并冲突。

三种本地范围中冲突均保持独立提示与同一冲突入口；“已暂存”范围里的 unmerged 条目不能标为普通已暂存版本，顶栏清楚说明普通范围比较对该路径被冲突版本查看替代。

### 7.2 rename、LFS、子模块与符号链接

| 状态/对象 | 推荐处理 | 边界 |
| --- | --- | --- |
| rename / mode change | 展示 Git 检出的旧新路径；内容路由独立。纯 rename 或 100644↔100755 内容相同时说明元信息变化 | 不用扩展名变化自行判 rename；不扫描全仓重建身份 |
| LFS pointer | 完整解析 pointer，展示实体 SHA-256 OID/声明 size、指针本身字节数；两侧 pointer 可比字段/源码 | 不运行 filter/smudge、LFS fetch/pull；实体 hash 不与 Git blob OID 混淆 |
| LFS 工作区实体 | 指针来自所选 Git 端点，WT 已是实体且预算内时可走实际格式预览；清楚说明一侧是 pointer、一侧是 WT 实体 | 只有实际核验 OID/size 后才称“匹配此指针”；超预算未 hash 则显示未验证匹配，不能冒充历史实体 |
| LFS 本地缓存 | 首轮不解析自定义 storage/扩展、不遍历缓存；状态写“本轮未读取 LFS 本地缓存” | 不把未查称为缺失；历史两侧只有 pointer 时停在 pointer 视图。显式本地实体解析可作为独立后续 P1 |
| submodule，mode 160000 | 比较 gitlink commit OID；已知的工作区脏/未初始化状态分开显示 | 不当普通文件读、不自动初始化/递归抓取，不承诺子模块内部 diff |
| symlink，mode 120000 | 展示链接目标文本与 mode 改变，标“符号链接” | 不跟随链接读取目标；Windows Git 配置下物化为文本文件也保留 index 身份 |
| 缺失对象/shallow/权限失败 | 报哪个端点不可用，保留另一侧 | 不自动拉取、修复或解锁 safe.directory |

### 7.3 读取属性不等于执行属性

仅提取明确需要的 text/eol/working-tree-encoding/diff/filter 等属性值用于解释，标出取值来自工作区或 index；不暗示与历史提交属性相同。系统 Git 最低 2.31.0 约束保留，不为了历史属性使用新版 `check-attr --source` 等未验证选项。

所有 diff 调用继续显式禁 `--ext-diff`/textconv；原始对象读取不用 `cat-file --filters`。既有 fsmonitor/可选锁与无网络边界保留。外部 diff/textconv/filter 名字只显示为“未执行的仓库配置”，不能启动命令改善 PDF/图像展示。特殊路径、换行路径用 NUL 分隔/原始 ID，参数数组不经 shell。实施验收需无害标记脚本证明这些命令未被执行，并核对工作区/index/refs/config 未写入。

## 8. 验证样例矩阵（待实施后执行）

本轮以下各项均**未运行**。夹具由隔离临时仓库真实生成，记录生成操作、入口、blob/stage OID、实际返回内容、UI 状态和前后哈希；不靠预填 JSON 证明 Git 适配。GUI 验证遵守 AGENTS，不抢用户前台，不操作其他应用；真实焦点测试不属于本能力必要闭环。

| ID | 样例 | 必须可观察的结果 |
| --- | --- | --- |
| F01 | 同文件 HEAD=A、Index=B、WT=C；含图片/文本各一份 | 三范围分别 A→B/B→C/A→C，文件切换/取消无串内容 |
| F02 | 新增/未跟踪/删除文本和图片，空文件/两侧一侧零字节 | 真缺失单栏；已有空文件不误判；方向标签与状态一致 |
| F03 | UTF-8/BOM、UTF-16 LE/BE BOM、中文/emoji、无 BOM UTF-16/GBK/坏序列 | 支持者原文可读；不支持者原因明确；单侧失败不吞另一侧 |
| F04 | LF/CRLF/混合/CR、仅 EOL/BOM 改变、无末尾换行 | 元信息差异仍可见；不是无差异；字符内容不被持久化转换 |
| F05 | JSON 重排/坏 JSON、XML 实体、CSV 多行、Unity YAML tags、Markdown HTML/SVG 脚本 | 原文 diff；无格式化、实体展开、脚本或远程资源执行 |
| F06 | PNG/JPEG/WebP 的透明、尺寸不同、EXIF 方向、同像素不同压缩字节 | 比例/边界/元信息正确；滑杆共用坐标；不宣称像素等同于字节一致 |
| F07 | 坏图、截断图、签名/扩展名冲突、APNG/动画 WebP/GIF | 逐侧失败/动画降级明确，静态图对侧可用，无无提示播放 |
| F08 | 文本字节/行/长行各预算临界±1，图片字节/像素/总像素/边长临界±1 | 有界读取和分配；超限 UI 能离开；内存和取消证据单独记录 |
| F09 | UU、AA、UD、DU、二进制冲突、工作区无标记但 index 未解 | stage 内容与 Git 输出一致；缺 stage 不伪造；全程无解决能力 |
| F10 | DD/AU/UA、rename/delete、rename/rename、rebase、外部解冲突后刷新 | 多路径不误关联，身份标签不反转，过期结果不落屏 |
| F11 | LFS 有效/无效 pointer、不同实体 OID、WT pointer/实体、实体超预算 | pointer 与实体状态区分；未检查缓存不写“缺失”；不联网、不执行 LFS |
| F12 | gitlink 改 OID/未初始化/脏、symlink 指仓库外、纯 rename/执行位变化 | 指针/目标文字/元信息可读，无递归初始化或跟随外部文件 |
| F13 | PDF/Office/ZIP/EXE/字体/媒体/二进制 3D、同大小异内容 | 元信息完整、专用不支持明确；不解析/解包/播放/执行；无伪零差异 |
| F14 | 外部 diff/textconv/filter/fsmonitor 标记脚本、特殊路径、缺对象、权限失败 | 标记未产生，错误不清空变化；读前后工作区/index/refs/config 一致 |
| F15 | 两平台 release，连续选图/文本/冲突和项目切换 30 次 | 记录 P50/P95/峰值/稳态全进程树内存；实际 WebView2/WKWebView 验证，未运行平台不算通过 |

F09/F10 的复杂冲突先由实际 Git 操作产生；某种 Git 版本难稳定生成的 index 形态可用额外受控底层夹具覆盖解析，但要单独标识，不能冒充完整真实 merge 操作的证据。历史 commit 双端、根提交、merge 父节点及 rename 历史由后移后的历史任务补测，不能在新 03 仅用本地范围通过就宣布历史入口完成。

## 9. 用户选择记录与正式迁移边界

已确认范围：“先仅纳入图片与冲突支持”。新 03 仅包括：（A）静态 PNG/JPEG/WebP 并排、滑动、缩放、透明背景、尺寸与单侧失败；（B）stage 1/2/3 与 WT 的只读版本选择和比较，复用现有文本与 A 图片阅读器。逐侧缺失/失败、必要识别、预算和端点仅为这两个闭环服务，不引入完整编码或通用特殊对象支持。

上一版普通文件/编码和特殊对象两闭环撤出本次提案；研究中的 UTF-16、GIF/SVG 图像预览、本地 LFS 缓存、更多专用格式保留后续候选。原 04 已有文本、编码/EOL、二进制/SVG/LFS/submodule 最低展示约定继续由后移任务承担，不因收窄而删除。新 03 不以 F03–F05/F11–F13 广泛格式矩阵作为前置或验收门槛，仅取图片/冲突所需用例及只读/资源回归子集。

正式迁移规划仍为原 03/04/05→04/05/06，原 04 图片责任迁入新 03，其余既有责任保留。详细迁移待应用清单见提案。本轮仅改两份独占文档；任务 02 完成共享文档的项目 tab 条款修改后，等待总控授权正式同步，再核对最新内容。未改总表、旧票据、共享规格和门禁；未实施、未派发，不重复索取已确认的范围许可。
