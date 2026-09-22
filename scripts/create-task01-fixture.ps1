param(
    [string]$Parent = $env:TEMP
)

$ErrorActionPreference = 'Stop'
$fixtureName = 'oris-task01-' + [guid]::NewGuid().ToString('N')
$fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $Parent $fixtureName))
$parentRoot = [System.IO.Path]::GetFullPath($Parent)
if (-not $fixtureRoot.StartsWith($parentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture path escaped its parent.'
}
New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'src') -Force | Out-Null

git -C $fixtureRoot init -q
git -C $fixtureRoot config user.email 'fixture@example.invalid'
git -C $fixtureRoot config user.name 'Oris Fixture'

$base = [System.Collections.Generic.List[string]]::new()
1..70 | ForEach-Object {
    if ($_ -eq 10) { $base.Add('export const policy = "old-policy";') }
    elseif ($_ -eq 24) { $base.Add('export const removeA = true;') }
    elseif ($_ -eq 25) { $base.Add('export const removeB = true;') }
    elseif ($_ -eq 35) { $base.Add('export const deleteOnly = "baseline";') }
    elseif ($_ -eq 48) { $base.Add('export const spacing = 1;') }
    else { $base.Add(('export const context{0:D2} = {0};' -f $_)) }
}
$filePath = Join-Path $fixtureRoot 'src\中文 diff.ts'
[System.IO.File]::WriteAllText($filePath, ($base -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $fixtureRoot '.gitattributes'), "*.ts diff=oris-testconv`n", [System.Text.UTF8Encoding]::new($false))
git -C $fixtureRoot add -- 'src/中文 diff.ts' '.gitattributes'
git -C $fixtureRoot commit -qm 'fixture baseline'

$changed = [System.Collections.Generic.List[string]]::new()
foreach ($line in $base) {
    if ($line -eq 'export const policy = "old-policy";') {
        $changed.Add('export const policy = "new-policy";')
    } elseif ($line -eq 'export const removeA = true;') {
        $changed.Add('export const addedA = "alpha";')
        $changed.Add('export const addedB = "beta";')
        $changed.Add('export const addedC = "gamma";')
    } elseif ($line -eq 'export const removeB = true;') {
        continue
    } elseif ($line -eq 'export const deleteOnly = "baseline";') {
        continue
    } elseif ($line -eq 'export const spacing = 1;') {
        $changed.Add('export const spacing  =  1;')
    } else {
        $changed.Add($line)
        if ($line -eq 'export const context55 = 55;') {
            $changed.Add('export const insertOnlyA = "working";')
            $changed.Add('export const insertOnlyB = "working";')
        }
    }
}
[System.IO.File]::WriteAllText($filePath, ($changed -join "`n"), [System.Text.UTF8Encoding]::new($false))

$externalMarker = Join-Path $fixtureRoot 'external-helper-ran.txt'
$externalHelper = Join-Path $fixtureRoot 'external-helper.cmd'
$fsmonitorMarker = Join-Path $fixtureRoot 'fsmonitor-helper-ran.txt'
$fsmonitorHelper = Join-Path $fixtureRoot 'fsmonitor-helper.cmd'
$textconvMarker = Join-Path $fixtureRoot 'textconv-helper-ran.txt'
$textconvHelper = Join-Path $fixtureRoot 'textconv-helper.cmd'
[System.IO.File]::WriteAllText($externalHelper, "@echo invoked>`"$externalMarker`"`r`n", [System.Text.ASCIIEncoding]::new())
[System.IO.File]::WriteAllText($fsmonitorHelper, "@echo invoked>`"$fsmonitorMarker`"`r`n", [System.Text.ASCIIEncoding]::new())
[System.IO.File]::WriteAllText($textconvHelper, "@echo invoked>`"$textconvMarker`"`r`n", [System.Text.ASCIIEncoding]::new())
git -C $fixtureRoot config diff.external $externalHelper
git -C $fixtureRoot config core.fsmonitor $fsmonitorHelper
git -C $fixtureRoot config diff.oris-testconv.textconv $textconvHelper

[pscustomobject]@{
    path = $fixtureRoot
    changedFile = 'src/中文 diff.ts'
    externalMarker = $externalMarker
    fsmonitorMarker = $fsmonitorMarker
    textconvMarker = $textconvMarker
} | ConvertTo-Json -Compress
