[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$applyScript = Join-Path $projectRoot 'scripts/apply-upstream-patches.ps1'
$testParent = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts/script-tests'))
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N'))
$expectedRepository = 'https://github.com/mobile-dev-inc/Maestro.git'
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0

function Write-TestFile {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text.Replace("`r`n", "`n"), $utf8)
}

function Invoke-FixtureGit {
    param([string]$Directory, [string[]]$Arguments)
    $result = & git -C $Directory @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Fixture Git failed: ' + ($Arguments -join ' ')) }
    return $result
}

function New-Fixture {
    param([string]$Name)
    $fixtureRoot = Join-Path $testRoot $Name
    $checkout = Join-Path $fixtureRoot '.upstream/maestro'
    New-Item -ItemType Directory -Path $checkout -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'patches/maestro') -Force | Out-Null
    Copy-Item -LiteralPath $applyScript -Destination (Join-Path $fixtureRoot 'scripts/apply-upstream-patches.ps1')
    Invoke-FixtureGit -Directory $checkout -Arguments @('init', '-q') | Out-Null
    Invoke-FixtureGit -Directory $checkout -Arguments @('config', 'core.autocrlf', 'false') | Out-Null
    Invoke-FixtureGit -Directory $checkout -Arguments @('remote', 'add', 'origin', $expectedRepository) | Out-Null
    Write-TestFile -Path (Join-Path $checkout 'sample.txt') -Text "one`nold`nthree`n"
    Invoke-FixtureGit -Directory $checkout -Arguments @('-c', 'core.autocrlf=false', 'add', 'sample.txt') | Out-Null
    Invoke-FixtureGit -Directory $checkout -Arguments @('-c', 'user.name=Patch tests', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture baseline') | Out-Null
    $commit = (Invoke-FixtureGit -Directory $checkout -Arguments @('rev-parse', 'HEAD')).Trim()
    $lock = [ordered]@{ repository = $expectedRepository; commit = $commit; checkoutPath = '.upstream/maestro' }
    Write-TestFile -Path (Join-Path $fixtureRoot 'upstream.lock.json') -Text ($lock | ConvertTo-Json)
    $patch = @'
diff --git a/sample.txt b/sample.txt
--- a/sample.txt
+++ b/sample.txt
@@ -1,3 +1,3 @@
 one
-old
+new
 three
diff --git a/added.txt b/added.txt
new file mode 100644
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+host adapter
'@
    Write-TestFile -Path (Join-Path $fixtureRoot 'patches/maestro/0001-harmonyos-host.patch') -Text ($patch + "`n")
    return [pscustomobject]@{ Root = $fixtureRoot; Checkout = $checkout; Script = (Join-Path $fixtureRoot 'scripts/apply-upstream-patches.ps1'); Lock = $lock }
}

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Expect-Failure {
    param([string]$Script, [string]$MessagePattern)
    $failure = $null
    try { & $Script | Out-Null } catch { $failure = $_.Exception.Message }
    Assert-Test -Condition ($null -ne $failure) -Message 'Expected the patch script to fail.'
    Assert-Test -Condition ($failure -match $MessagePattern) -Message ('Unexpected failure: ' + $failure)
}

try {
    $fixture = New-Fixture -Name 'apply-repeat'
    & $fixture.Script | Out-Null
    Assert-Test -Condition (([IO.File]::ReadAllText((Join-Path $fixture.Checkout 'sample.txt'))) -eq "one`nnew`nthree`n") -Message 'Modified file was not patched.'
    Assert-Test -Condition (([IO.File]::ReadAllText((Join-Path $fixture.Checkout 'added.txt'))) -eq "host adapter`n") -Message 'New file was not patched.'
    $passed++

    Write-TestFile -Path (Join-Path $fixture.Checkout 'user-notes.txt') -Text "keep my work`n"
    & $fixture.Script | Out-Null
    Assert-Test -Condition (([IO.File]::ReadAllText((Join-Path $fixture.Checkout 'user-notes.txt'))) -eq "keep my work`n") -Message 'Repeated application changed extra local work.'
    $passed++

    $fixture = New-Fixture -Name 'wrong-sha'
    $fixture.Lock.commit = '0000000000000000000000000000000000000000'
    Write-TestFile -Path (Join-Path $fixture.Root 'upstream.lock.json') -Text ($fixture.Lock | ConvertTo-Json)
    Expect-Failure -Script $fixture.Script -MessagePattern 'HEAD does not match'
    Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.Checkout 'added.txt'))) -Message 'Wrong SHA applied a patch.'
    $passed++

    $fixture = New-Fixture -Name 'wrong-origin'
    Invoke-FixtureGit -Directory $fixture.Checkout -Arguments @('remote', 'set-url', 'origin', 'https://example.invalid/other.git') | Out-Null
    Expect-Failure -Script $fixture.Script -MessagePattern 'origin does not match'
    $passed++

    $fixture = New-Fixture -Name 'dirty-conflict'
    Write-TestFile -Path (Join-Path $fixture.Checkout 'sample.txt') -Text "one`nmy unfinished change`nthree`n"
    Expect-Failure -Script $fixture.Script -MessagePattern 'local changes'
    Assert-Test -Condition (([IO.File]::ReadAllText((Join-Path $fixture.Checkout 'sample.txt'))) -eq "one`nmy unfinished change`nthree`n") -Message 'Conflicting local change was overwritten.'
    $passed++

    $fixture = New-Fixture -Name 'partial-patch'
    Write-TestFile -Path (Join-Path $fixture.Checkout 'sample.txt') -Text "one`nnew`nthree`n"
    Expect-Failure -Script $fixture.Script -MessagePattern 'local changes'
    Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.Checkout 'added.txt'))) -Message 'Partial patch was changed.'
    $passed++

    $fixture = New-Fixture -Name 'clean-conflict'
    $patchPath = Join-Path $fixture.Root 'patches/maestro/0001-harmonyos-host.patch'
    Write-TestFile -Path $patchPath -Text (([IO.File]::ReadAllText($patchPath)).Replace('-old', '-missing'))
    Expect-Failure -Script $fixture.Script -MessagePattern 'pre-check failed'
    Assert-Test -Condition (-not (Test-Path -LiteralPath (Join-Path $fixture.Checkout 'added.txt'))) -Message 'A failed pre-check applied part of the patch.'
    $passed++

    $fixture = New-Fixture -Name 'escaped-checkout'
    $fixture.Lock.checkoutPath = '../other'
    Write-TestFile -Path (Join-Path $fixture.Root 'upstream.lock.json') -Text ($fixture.Lock | ConvertTo-Json)
    Expect-Failure -Script $fixture.Script -MessagePattern 'must remain inside'
    $passed++

    foreach ($scriptPath in @($applyScript, (Join-Path $projectRoot 'scripts/test-host.ps1'), $PSCommandPath)) {
        $parseErrors = $null
        [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$parseErrors) | Out-Null
        Assert-Test -Condition ($parseErrors.Count -eq 0) -Message ('PowerShell syntax errors in ' + $scriptPath)
    }
    Write-Output ('PASS: ' + $passed + ' patch behavior checks and 3 PowerShell syntax checks. No network, Gradle or device operations were run.')
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
        $allowedPrefix = $testParent.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedTestRoot.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the script-test directory.' }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
