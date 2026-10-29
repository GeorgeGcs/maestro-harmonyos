[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$CacheDirectory)

$ErrorActionPreference = 'Stop'
$resourceLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'simulator-resources.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$upstreamLock = Get-Content -LiteralPath (Join-Path $repository 'upstream.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($resourceLock.schemaVersion -ne 1 -or $upstreamLock.commit -cne $resourceLock.upstreamCommit -or
    $resourceLock.simulatorVersion -cne '37010dc7') {
    throw 'The resource lock does not match the pinned upstream. Review the resource source before updating either lock.'
}
$cache = (Get-Item -LiteralPath $CacheDirectory -ErrorAction Stop).FullName
if (-not (Test-Path -LiteralPath $cache -PathType Container)) { throw 'CacheDirectory must be an existing directory.' }

function Assert-CachedFile {
    param($Reference)
    if ($Reference.name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Reference.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Invalid file reference in resource lock.'
    }
    $file = Get-Item -LiteralPath (Join-Path $cache $Reference.name) -ErrorAction Stop
    if ($file.PSIsContainer -or $file.Length -ne $Reference.bytes -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Reference.sha256) {
        throw ('Missing or invalid official resource: ' + $Reference.name)
    }
}

Assert-CachedFile $resourceLock.manifest
$expected = @{}
foreach ($archive in $resourceLock.archives) {
    if ($expected.ContainsKey($archive.name)) { throw 'Duplicate archive in resource lock.' }
    $expected[$archive.name] = $archive.sha256
}
$actual = @{}
foreach ($line in [IO.File]::ReadAllLines((Join-Path $cache $resourceLock.manifest.name), [Text.UTF8Encoding]::new($false, $true))) {
    if ($line -cnotmatch '^([0-9a-fA-F]{64})\s+\*?([A-Za-z0-9][A-Za-z0-9._-]*)$') { throw 'Invalid SHA256SUMS entry.' }
    $name = $Matches[2]
    if ($actual.ContainsKey($name)) { throw 'Duplicate SHA256SUMS entry.' }
    $actual[$name] = $Matches[1].ToLowerInvariant()
}
if ($actual.Count -ne $expected.Count) { throw 'SHA256SUMS has an unexpected archive set.' }
foreach ($archive in $resourceLock.archives) {
    if ($actual[$archive.name] -cne $archive.sha256) { throw 'SHA256SUMS does not match the resource lock.' }
    Assert-CachedFile $archive
    Write-Output ('Verified ' + $archive.name)
}
Write-Output 'PASS: official manifest and all three archives match their pinned size and SHA-256. No files were changed or extracted.'
