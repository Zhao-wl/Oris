# Oris

面向 Windows 11 与 macOS Apple Silicon 的轻量 Git 可视化桌面应用。

核心目标：多项目快速切换、直观易读的 diff、高性能、清晰的提交与分支浏览。界面以已确认的 JetBrains 风格 V2 为基准。

技术栈：Tauri 2 + Rust + React + TypeScript；Git CLI 负责仓库读取；CodeMirror 6 为待验证的 diff 基础组件。

当前处于文档与任务规划阶段，尚未实现应用。文档和效果图不是性能或功能验收结果。

- [V1 文档入口](docs/README.md)
- [产品与功能规格](docs/specs/v1-product.md)
- [技术方案](docs/architecture/v1-architecture.md)
- [实施任务与依赖](docs/tasks/README.md)
- [验收与性能计划](docs/validation/v1-acceptance.md)
