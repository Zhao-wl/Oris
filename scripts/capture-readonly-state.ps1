param(
    [Parameter(Mandatory = $true)] [string]$Repository
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath($Repository)
$gitDir = (git --no-optional-locks -c core.fsmonitor=false -C $repo rev-parse --path-format=absolute --absolute-git-dir).Trim()
$statusBytes = [System.Text.Encoding]::UTF8.GetBytes((git --no-optional-locks -c core.fsmonitor=false -C $repo status --porcelain=v2 --branch))
$refs = git --no-optional-locks -c core.fsmonitor=false -C $repo for-each-ref '--format=%(refname) %(objectname)'
$head = git --no-optional-locks -c core.fsmonitor=false -C $repo rev-parse HEAD
$tracked = git --no-optional-locks -c core.fsmonitor=false -C $repo ls-files -s
$gitMetadataPath = [System.IO.Path]::GetFullPath((Join-Path $repo '.git'))
$gitMetadataPrefix = $gitMetadataPath + [System.IO.Path]::DirectorySeparatorChar
$worktreeFiles = Get-ChildItem -LiteralPath $repo -File -Recurse -Force |
    Where-Object {
        -not $_.FullName.Equals($gitMetadataPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $_.FullName.StartsWith($gitMetadataPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    } |
    ForEach-Object {
        $relative = [System.IO.Path]::GetRelativePath($repo, $_.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$relative|$($_.Length)|$hash"
    } | Sort-Object
$worktreeManifest = [System.Text.Encoding]::UTF8.GetBytes(($worktreeFiles -join "`n"))

[pscustomobject]@{
    repository = $repo
    statusSha256 = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($statusBytes)).ToLowerInvariant()
    indexSha256 = (Get-FileHash -LiteralPath (Join-Path $gitDir 'index') -Algorithm SHA256).Hash.ToLowerInvariant()
    configSha256 = (Get-FileHash -LiteralPath (Join-Path $gitDir 'config') -Algorithm SHA256).Hash.ToLowerInvariant()
    refsSha256 = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes(($refs -join "`n")))).ToLowerInvariant()
    head = $head.Trim()
    trackedIndex = $tracked
    worktreeManifestSha256 = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($worktreeManifest)).ToLowerInvariant()
    worktreeFiles = $worktreeFiles
    externalHelperMarkerExists = Test-Path -LiteralPath (Join-Path $repo 'external-helper-ran.txt')
    fsmonitorHelperMarkerExists = Test-Path -LiteralPath (Join-Path $repo 'fsmonitor-helper-ran.txt')
    textconvHelperMarkerExists = Test-Path -LiteralPath (Join-Path $repo 'textconv-helper-ran.txt')
} | ConvertTo-Json -Depth 4
