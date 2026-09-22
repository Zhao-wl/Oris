param([string]$Parent = $env:TEMP)

$ErrorActionPreference = 'Stop'
$fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $Parent ('oris-task01-scroll-' + [guid]::NewGuid().ToString('N'))))
$parentRoot = [System.IO.Path]::GetFullPath($Parent)
if (-not $fixtureRoot.StartsWith($parentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture path escaped its parent.'
}
New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'src') -Force | Out-Null
git -C $fixtureRoot init -q
git -C $fixtureRoot config user.email 'fixture@example.invalid'
git -C $fixtureRoot config user.name 'Oris Fixture'
git -C $fixtureRoot config core.hooksPath NUL
git -C $fixtureRoot config core.autocrlf false

$mixed = [System.Collections.Generic.List[string]]::new()
1..260 | ForEach-Object { $mixed.Add(('export const baseline{0:D3} = {0};' -f $_)) }
$insertOnly = ''
$deleteOnly = ((1..180 | ForEach-Object { 'export const deleted{0:D3} = {0};' -f $_ }) -join "`n") + "`n"
[System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\mixed.ts'), ($mixed -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\insert-only.ts'), $insertOnly, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\delete-only.ts'), $deleteOnly, [System.Text.UTF8Encoding]::new($false))
git -C $fixtureRoot add -- 'src/mixed.ts' 'src/insert-only.ts' 'src/delete-only.ts'
git -C $fixtureRoot commit -qm 'fixture baseline'

$changed = [System.Collections.Generic.List[string]]::new()
for ($index = 1; $index -le 260; $index += 1) {
    if ($index -eq 35) {
        1..24 | ForEach-Object { $changed.Add(('export const inserted{0:D2} = "new";' -f $_)) }
    }
    if ($index -ge 90 -and $index -le 101) { continue }
    if ($index -eq 145) {
        $changed.Add('export const replacementA = "short";')
        $changed.Add('export const replacementB = "this is a deliberately much longer replacement line that wraps at narrow pane widths";')
        $index += 5
        continue
    }
    if ($index -eq 220) { $changed.Add('export const baseline220 = "changed without final newline";'); continue }
    $changed.Add(('export const baseline{0:D3} = {0};' -f $index))
}
[System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\mixed.ts'), ($changed -join "`n"), [System.Text.UTF8Encoding]::new($false))
$added = ((1..210 | ForEach-Object { 'export const added{0:D3} = {0};' -f $_ }) -join "`n")
[System.IO.File]::WriteAllText((Join-Path $fixtureRoot 'src\insert-only.ts'), $added, [System.Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath (Join-Path $fixtureRoot 'src\delete-only.ts')

[pscustomobject]@{
    path = $fixtureRoot
    mixed = 'src/mixed.ts'
    insertOnly = 'src/insert-only.ts'
    deleteOnly = 'src/delete-only.ts'
} | ConvertTo-Json -Compress
