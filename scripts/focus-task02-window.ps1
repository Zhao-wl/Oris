# 永久禁用旧的共享桌面激活入口；兼容旧参数只用于明确拒绝，绝不查找或操作窗口。
param([int]$TargetProcessId, [string]$WindowTitle)
throw 'Native window activation is disabled. No window APIs are called. Run npm run test:branch-switch for foreground-independent acceptance; real Windows focus requires a separately reviewed isolated harness.'
