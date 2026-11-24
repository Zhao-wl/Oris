# Oris

Oris 是面向 Windows 11 x64 和 macOS 14 及以上 Apple Silicon 的 Git 桌面应用。可在 GitHub Releases 下载 Windows 安装程序和 macOS DMG。安装后需要 Git 2.31 或更新版本，可在应用设置中指定 Git 路径。[下载安装包](https://github.com/Zhao-wl/Oris/releases/latest)

## 主要功能

- 在多个项目间切换，在同一工作区内浏览主仓库、子模块和 linked worktree。
- 浏览未暂存及已暂存改动，支持并排与统一 diff、图片对比和冲突版本查看。
- 浏览提交图、分支和文件历史，比较提交或分支。
- 按文件或差异块暂存、取消暂存和丢弃，支持提交、stash、分支、同步及合并操作。
- 按需配置 AI 连接，用于解释、审查改动和辅助撰写提交说明。

## 本地开发

桌面端使用 Tauri 2 和 Rust，前端使用 React、TypeScript、Vite 和 CodeMirror 6，仓库操作使用 Git CLI。

准备 Node.js 22、npm 和 Git。运行桌面端还需要 Rust stable 和平台构建工具。Windows 使用 MSVC C++ 工具链及 WebView2，macOS 使用 Xcode Command Line Tools。Windows 桌面构建请在 PowerShell 中执行。

```sh
npm ci
npm run tauri -- dev  # 启动桌面端，连接本地 Git 后端
npm run dev           # 单独启动 Vite 前端开发服务器
```

```sh
npm test -- --no-file-parallelism  # 运行前端回归
npm run build                    # TypeScript 检查和前端生产构建
npm run tauri -- build           # 构建当前平台的桌面应用和安装包
```

提交前运行 `node scripts/local-ci.mjs`。该命令执行 TypeScript 检查、前端构建和回归，以及主题、旧 GUI 入口安全回归和发布工具测试。任何一步失败都会返回非零退出码。

## 项目文档

- [文档入口](docs/README.md)
- [产品与功能规格](docs/specs/v1-product.md)
- [技术方案](docs/architecture/v1-architecture.md)
- [实施任务与依赖](docs/tasks/README.md)
- [验收与性能计划](docs/validation/v1-acceptance.md)
