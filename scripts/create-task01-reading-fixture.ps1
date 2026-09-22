param([string]$Target)

$ErrorActionPreference = 'Stop'
if (-not $Target) {
  $Target = Join-Path ([IO.Path]::GetTempPath()) ("oris-task01-reading-" + [guid]::NewGuid().ToString('N'))
}
[IO.Directory]::CreateDirectory($Target) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $Target 'src')) | Out-Null
git -C $Target init | Out-Null
git -C $Target config user.email 'oris@example.invalid'
git -C $Target config user.name 'Oris Fixture'

$baseline = [Collections.Generic.List[string]]::new()
for ($line = 1; $line -le 220; $line++) {
  $baseline.Add(('export const baseline{0:D3} = {0};' -f $line))
}
$baseline[19] = 'export const wins = "wins"; // 选中 wins 后检查其它匹配'
$baseline[20] = 'export const Wins = "Wins";'
$baseline[21] = 'export const winsome = "winsome";'
$baseline[39] = 'export const literalMath = "a+b";'
$baseline[40] = 'export const regexMath = "aaab";'
$baseline[79] = 'export const removedWins = "wins"; // 将被删除'
$baseline[119] = 'export const modifiedWins = "old wins"; // 修改蓝色块'
$baselinePath = Join-Path $Target 'src/reading.ts'
[IO.File]::WriteAllLines($baselinePath, $baseline, [Text.UTF8Encoding]::new($false))
git -C $Target add -- 'src/reading.ts'
git -C $Target commit -m baseline | Out-Null

$working = [Collections.Generic.List[string]]::new()
foreach ($line in $baseline) { $working.Add($line) }
$working.RemoveAt(79)
$working[118] = 'export const modifiedWins = "new wins"; // 修改蓝色块'
$working.Insert(159, 'export const insertedWins = "wins"; // 新增绿色块')
$working.Insert(160, 'export const chineseWins = "胜利 wins"; // 中文与语法 token')
[IO.File]::WriteAllLines($baselinePath, $working, [Text.UTF8Encoding]::new($false))

$Target
