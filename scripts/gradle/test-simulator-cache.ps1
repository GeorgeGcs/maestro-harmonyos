[CmdletBinding()]
param([string]$VerifiedCacheDirectory)

$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testRoot = Join-Path $repository ('artifacts/simulator-cache-tests/' + [guid]::NewGuid().ToString('N'))
$fixtureScriptDirectory = Join-Path $testRoot 'scripts/gradle'
$fixtureCache = Join-Path $testRoot 'cache'
$utf8 = [Text.UTF8Encoding]::new($false)
$passed = 0
function Assert-Rejected {
    param([string]$Expected)
    try { & (Join-Path $fixtureScriptDirectory 'verify-simulator-cache.ps1') -CacheDirectory $fixtureCache | Out-Null }
    catch {
        if (($_.Exception.Message + ' ' + $_.FullyQualifiedErrorId) -notmatch $Expected) { throw }
        return
    }
    throw ('Expected rejection: ' + $Expected)
}
try {
    $null = [IO.Directory]::CreateDirectory($fixtureScriptDirectory)
    $null = [IO.Directory]::CreateDirectory($fixtureCache)
    foreach ($name in @('verify-simulator-cache.ps1', 'simulator-resources.lock.json')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $fixtureScriptDirectory $name)
    }
    Copy-Item -LiteralPath (Join-Path $repository 'upstream.lock.json') -Destination (Join-Path $testRoot 'upstream.lock.json')
    $lock = Get-Content -LiteralPath (Join-Path $fixtureScriptDirectory 'simulator-resources.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest = Join-Path $fixtureCache 'SHA256SUMS'
    [IO.File]::WriteAllText($manifest, 'changed manifest', $utf8)
    Assert-Rejected 'Missing or invalid official resource: SHA256SUMS'
    $passed++

    $lines = @($lock.archives | ForEach-Object { $_.sha256 + '  ' + $_.name })
    [IO.File]::WriteAllText($manifest, (($lines -join "`n") + "`n"), $utf8)
    Assert-Rejected 'PathNotFound|ItemNotFound'
    $passed++

    [IO.File]::WriteAllText((Join-Path $fixtureCache $lock.archives[0].name), 'incomplete archive', $utf8)
    Assert-Rejected 'Missing or invalid official resource'
    $passed++

    $upstream = Get-Content -LiteralPath (Join-Path $testRoot 'upstream.lock.json') -Raw | ConvertFrom-Json
    $upstream.commit = '0000000000000000000000000000000000000000'
    [IO.File]::WriteAllText((Join-Path $testRoot 'upstream.lock.json'), ($upstream | ConvertTo-Json), $utf8)
    Assert-Rejected 'resource lock does not match'
    $passed++

    if ($VerifiedCacheDirectory) {
        & (Join-Path $PSScriptRoot 'verify-simulator-cache.ps1') -CacheDirectory $VerifiedCacheDirectory
        $passed++
    }
    Write-Output ('PASS: ' + $passed + ' cache checks. No network, archive extraction or Gradle build was performed.')
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = (Resolve-Path -LiteralPath $testRoot).Path
        $prefix = [IO.Path]::GetFullPath((Join-Path $repository 'artifacts/simulator-cache-tests')).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the cache test directory.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
