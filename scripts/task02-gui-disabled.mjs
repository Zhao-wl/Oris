// 旧共享桌面入口永久禁用。无 CDP 连接、进程搜索、窗口操作或夹具写入。
throw new Error('Legacy GUI validation is disabled. Run npm run test:branch-switch for foreground-independent acceptance; real Windows focus requires a separately reviewed isolated harness.');
