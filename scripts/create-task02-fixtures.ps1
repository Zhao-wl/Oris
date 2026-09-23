param(
    [string]$Parent = $env:TEMP,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$fixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $Parent ('oris-task02-' + [guid]::NewGuid().ToString('N'))))
$parentRoot = [System.IO.Path]::GetFullPath($Parent)
if (-not $fixtureRoot.StartsWith($parentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture path escaped its parent.'
}
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

function Invoke-Git([string]$Repository, [string[]]$Arguments) {
    & git -C $Repository @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git failed in $Repository`: $($Arguments -join ' ')" }
}

function Initialize-Repository([string]$Repository, [int]$Index, [int]$ChangeCount = 20) {
    New-Item -ItemType Directory -Path $Repository -Force | Out-Null
    Invoke-Git $Repository @('init', '-q')
    Invoke-Git $Repository @('config', 'user.email', 'fixture@example.invalid')
    Invoke-Git $Repository @('config', 'user.name', 'Oris Task02')
    0..39 | ForEach-Object {
        $name = 'files/file-{0:D3}.txt' -f $_
        $full = Join-Path $Repository $name
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        [System.IO.File]::WriteAllText($full, "project $Index baseline $_`n", [System.Text.UTF8Encoding]::new($false))
    }
    [System.IO.File]::WriteAllText((Join-Path $Repository 'dual.txt'), "base`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Repository 'rename-old.txt'), "rename base`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Repository 'delete-me.txt'), "delete base`n", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Repository 'conflict.txt'), "conflict base`n", [System.Text.UTF8Encoding]::new($false))
    Invoke-Git $Repository @('add', '--all')
    Invoke-Git $Repository @('commit', '-qm', "project-$Index baseline")
    0..($ChangeCount - 1) | ForEach-Object {
        $full = Join-Path $Repository ('files/file-{0:D3}.txt' -f $_)
        [System.IO.File]::WriteAllText($full, "project $Index changed $_`nline two`n", [System.Text.UTF8Encoding]::new($false))
    }
}

$projects = @()
0..4 | ForEach-Object {
    $repository = Join-Path $fixtureRoot ("group-$_\same-name")
    Initialize-Repository $repository $_ ($(if ($_ -eq 0) { 40 } else { 12 }))
    $projects += $repository
}

$primary = $projects[0]
[System.IO.File]::WriteAllText((Join-Path $primary 'dual.txt'), "staged`n", [System.Text.UTF8Encoding]::new($false))
Invoke-Git $primary @('add', '--', 'dual.txt')
[System.IO.File]::WriteAllText((Join-Path $primary 'dual.txt'), "unstaged`n", [System.Text.UTF8Encoding]::new($false))
Invoke-Git $primary @('mv', 'rename-old.txt', 'renamed 中文 #.txt')
Remove-Item -LiteralPath (Join-Path $primary 'delete-me.txt')
[System.IO.File]::WriteAllText((Join-Path $primary '未跟踪 [x].txt'), "untracked`n", [System.Text.UTF8Encoding]::new($false))

$empty = $projects[3]
Remove-Item -LiteralPath $empty -Recurse -Force
New-Item -ItemType Directory -Path $empty -Force | Out-Null
Invoke-Git $empty @('init', '-q')
Invoke-Git $empty @('config', 'user.email', 'fixture@example.invalid')
Invoke-Git $empty @('config', 'user.name', 'Oris Empty')
[System.IO.File]::WriteAllText((Join-Path $empty 'first commit.txt'), "first`n", [System.Text.UTF8Encoding]::new($false))
Invoke-Git $empty @('add', '--', 'first commit.txt')

$conflict = $projects[4]
$mainBranch = (& git -C $conflict branch --show-current).Trim()
Invoke-Git $conflict @('checkout', '-qb', 'side')
[System.IO.File]::WriteAllText((Join-Path $conflict 'conflict.txt'), "side`n", [System.Text.UTF8Encoding]::new($false))
Invoke-Git $conflict @('commit', '-am', 'side conflict')
Invoke-Git $conflict @('checkout', '-q', $mainBranch)
[System.IO.File]::WriteAllText((Join-Path $conflict 'conflict.txt'), "main`n", [System.Text.UTF8Encoding]::new($false))
Invoke-Git $conflict @('commit', '-am', 'main conflict')
& git -C $conflict merge side 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw 'Expected a merge conflict fixture.' }

$result = [pscustomobject]@{
    root = $fixtureRoot
    projects = $projects
    primary = $primary
    empty = $empty
    conflict = $conflict
} | ConvertTo-Json -Depth 4 -Compress
if ($OutputPath) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
    New-Item -ItemType Directory -Path (Split-Path $resolvedOutput -Parent) -Force | Out-Null
    [System.IO.File]::WriteAllText($resolvedOutput, $result, [System.Text.UTF8Encoding]::new($false))
}
$result
