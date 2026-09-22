param(
    [string]$Parent = $env:TEMP,
    [int]$FileCount = 96
)

$ErrorActionPreference = 'Stop'
$fixtureName = 'oris-task01-large-tree-' + [guid]::NewGuid().ToString('N')
$fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $Parent $fixtureName))
$parentRoot = [System.IO.Path]::GetFullPath($Parent)
if (-not $fixtureRoot.StartsWith($parentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture path escaped its parent.'
}

New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
git -C $fixtureRoot init -q
git -C $fixtureRoot config user.email 'fixture@example.invalid'
git -C $fixtureRoot config user.name 'Oris Fixture'
git -C $fixtureRoot config core.hooksPath NUL
git -C $fixtureRoot config core.autocrlf false

$relativePaths = [System.Collections.Generic.List[string]]::new()
for ($index = 1; $index -le $FileCount; $index += 1) {
    $group = 'group-{0:D2}' -f [int][math]::Ceiling($index / 12)
    $depth = 'nested-{0:D2}' -f (($index - 1) % 6)
    $name = if ($index -eq 37) { '中文 空格 file-37.ts' } else { 'component-{0:D3}.ts' -f $index }
    $relative = "src/$group/$depth/$name"
    $absolute = Join-Path $fixtureRoot ($relative -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path -Parent $absolute) -Force | Out-Null
    [System.IO.File]::WriteAllText($absolute, "export const value = $index;`n", [System.Text.UTF8Encoding]::new($false))
    $relativePaths.Add($relative)
}

git -C $fixtureRoot add --all
git -C $fixtureRoot commit -qm 'large tree baseline'
foreach ($relative in $relativePaths) {
    $absolute = Join-Path $fixtureRoot ($relative -replace '/', '\')
    [System.IO.File]::AppendAllText($absolute, "export const changed = true;`n", [System.Text.UTF8Encoding]::new($false))
}

[pscustomobject]@{
    path = $fixtureRoot
    fileCount = $FileCount
    unicodePath = 'src/group-04/nested-00/中文 空格 file-37.ts'
} | ConvertTo-Json -Compress
