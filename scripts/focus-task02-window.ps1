# Disabled after unsafe shared-desktop window activation. Accept old arguments only to fail closed.
param([int]$TargetProcessId, [string]$WindowTitle)
throw 'Native window activation is disabled. No window APIs are called. Use a separately reviewed isolated test harness.'
