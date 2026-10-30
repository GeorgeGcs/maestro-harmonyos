[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testParent = Join-Path $projectRoot 'artifacts/validation-wrapper-tests'
$testRoot = Join-Path $testParent ([guid]::NewGuid().ToString('N').Substring(0, 8))
$fixture = Join-Path $testRoot 'checkout with spaces'
$utf8 = [Text.UTF8Encoding]::new($false)
$shell = (Get-Process -Id $PID).Path
$savedEnvironment = [Environment]::GetEnvironmentVariables('Process')
$passed = 0
function Assert-Test { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-Json { param([string]$File, $Value) [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 30), $utf8) }
function Invoke-Case {
    param([string]$Name, [string]$Mode, [switch]$Reuse)
    $caseRoot = Join-Path $testRoot $Name
    if (-not $Reuse) {
        $null = [IO.Directory]::CreateDirectory($caseRoot)
        $setup = Join-Path $caseRoot 'setup.json'
        Write-Json $setup @{ operation = 'source-plan'; root = $caseRoot; options = @{ repeat = 2; units = 2 } }
        $null = & node (Join-Path $fixture 'scripts/tests/validation-fixture.mjs') $setup
        if ($LASTEXITCODE -ne 0) { throw 'Could not create fixture inputs.' }
    }
    $env:VALIDATION_FIXTURE_ROOT = $caseRoot
    $env:VALIDATION_FIXTURE_MODE = $Mode
    $env:VALIDATION_FIXTURE_RECOVERY = Join-Path $caseRoot 'recovery'
    $arguments = @('-NoProfile', '-File', (Join-Path $fixture 'scripts/test-validation-plan.ps1'),
        '-PlanPath', (Join-Path $caseRoot 'source-plan.json'), '-ArtifactsRoot', (Join-Path $caseRoot 'output'),
        '-DeviceStateDirectory', (Join-Path $caseRoot 'state'), '-RecoveryRoot', $env:VALIDATION_FIXTURE_RECOVERY)
    $preference = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; $output = @(& $shell @arguments 2>&1); $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $preference }
    $summaries = @(Get-ChildItem -LiteralPath (Join-Path $caseRoot 'output') -Directory | ForEach-Object {
        Get-Item -LiteralPath (Join-Path $_.FullName 'validation-summary.json')
    } | Sort-Object LastWriteTimeUtc)
    $stateFiles = @(Get-ChildItem -LiteralPath (Join-Path $caseRoot 'state') -Filter '*.json' -File)
    $calls = if (Test-Path -LiteralPath (Join-Path $caseRoot 'calls.txt')) { @(Get-Content -LiteralPath (Join-Path $caseRoot 'calls.txt')).Count } else { 0 }
    return @{ code = $code; output = ($output | Out-String); calls = $calls;
        summary = if ($summaries.Count) { Get-Content -LiteralPath $summaries[-1].FullName -Raw | ConvertFrom-Json } else { $null };
        reservation = if ($stateFiles.Count) { Get-Content -LiteralPath $stateFiles[0].FullName -Raw | ConvertFrom-Json } else { $null } }
}
try {
    $localConfig = Join-Path $projectRoot 'config.local.ps1'
    if (Test-Path -LiteralPath $localConfig -PathType Leaf) { . $localConfig }
    foreach ($directory in @('scripts/validation', 'scripts/ci', 'scripts/tests', 'examples/agent-client')) {
        $null = [IO.Directory]::CreateDirectory((Join-Path $fixture $directory))
    }
    foreach ($relative in @('scripts/test-validation-plan.ps1', 'scripts/ci/device-reservation.ps1', 'scripts/ci/verify-state.mjs',
        'scripts/tests/validation-fixture.mjs', 'examples/agent-client/client.mjs', 'examples/agent-client/evidence.mjs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination (Join-Path $fixture $relative)
    }
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts/validation') -Filter '*.mjs' | Copy-Item -Destination (Join-Path $fixture 'scripts/validation')
    $fakeDistribution = Join-Path $fixture '.upstream/maestro/maestro-cli/build/install/maestro'
    $null = [IO.Directory]::CreateDirectory((Join-Path $fakeDistribution 'lib'))
    $null = [IO.Directory]::CreateDirectory((Join-Path $fakeDistribution 'bin'))
    [IO.File]::WriteAllText((Join-Path $fakeDistribution 'lib/fixture.jar'), 'Synthetic dependency; never executed.', $utf8)
    [IO.File]::WriteAllText((Join-Path $fakeDistribution 'bin/maestro.bat'), 'Synthetic launcher placeholder.', $utf8)
    $matrix = @'
param($FlowPath, $BundleId, $AbilityName, $Module, $DeviceIds, $Env, $Artifacts, $Repeat, $ReportPointerPath, $ControlRecordDirectory, $MatrixInvocationId, $RunTimeoutSeconds)
$ErrorActionPreference = 'Stop'
[IO.File]::AppendAllText((Join-Path $env:VALIDATION_FIXTURE_ROOT 'calls.txt'), "called`n")
if ($env:VALIDATION_FIXTURE_MODE -eq 'hard-stop') { [Environment]::Exit(87) }
$modes = switch ($env:VALIDATION_FIXTURE_MODE) { 'cancel' { @('cancel', 'not-run') } 'fail' { @('fail', 'pass') } 'unconfirmed' { @('unknown-cleanup', 'not-run') } default { @('pass', 'pass') } }
$request = Join-Path $Artifacts 'fixture-request.json'
$value = @{ artifacts=$Artifacts; flowPath=$FlowPath; repeat=[int]$Repeat; deviceId=$DeviceIds[0]; pointerPath=$ReportPointerPath;
    controlDirectory=$ControlRecordDirectory; invocationId=$MatrixInvocationId; recoveryRoot=$env:VALIDATION_FIXTURE_RECOVERY; modes=@($modes) }
[IO.File]::WriteAllText($request, ($value | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
& node (Join-Path $PSScriptRoot 'tests/validation-fixture.mjs') $request
exit $LASTEXITCODE
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts/test-device-matrix.ps1'), $matrix, $utf8)
    $result = Invoke-Case 'normal' 'pass'
    Assert-Test ($result.calls -eq 2) ('Both units should dispatch: ' + $result.output)
    Assert-Test ($result.summary.slots.Count -eq 4 -and @($result.summary.slots | Where-Object { $_.firstPassStatus -eq 'passed' }).Count -eq 4) 'All planned passes must be retained.'
    Assert-Test ($result.code -eq 1 -and -not $result.summary.qualified -and $result.reservation.state -eq 'released') 'Unreviewed successful execution must remain unqualified with a released device.'
    Assert-Test ($result.reservation.execution -eq 'passed') 'Confirmed clean success must retain passed execution.'
    $passed++; Write-Output 'PASS all units, persistent release, and explicit review'

    $result = Invoke-Case 'cancel' 'cancel'
    Assert-Test ($result.calls -eq 1 -and $result.summary.slots.Count -eq 4) ('Cancelled batch should stop the next unit: ' + $result.output)
    Assert-Test ($result.summary.groups[0].cancelled -eq 1 -and $result.summary.groups[1].notRun -eq 2) 'Cancelled and unexecuted slots must remain in the denominator.'
    Assert-Test ($result.reservation.execution -eq 'unknown') 'A stopped device must not become an ordinary failed execution merely because matrix returned exit 1.'
    $passed++; Write-Output 'PASS cancellation stops subsequent unit without reducing denominator'

    $result = Invoke-Case 'failure' 'fail'
    Assert-Test ($result.calls -eq 2 -and $result.reservation.state -eq 'released') ('Clean ordinary failure should permit subsequent units: ' + $result.output)
    Assert-Test ($result.code -eq 1 -and $result.summary.batches[0].matrixExitCode -eq 1) 'Original failure exit must remain visible.'
    Assert-Test ($result.reservation.execution -eq 'failed') 'Confirmed clean assertion failure must retain failed execution.'
    $passed++; Write-Output 'PASS clean failure continues and preserves original exit code'

    $result = Invoke-Case 'unconfirmed' 'unconfirmed'
    Assert-Test ($result.calls -eq 1 -and $result.code -eq 1 -and $result.summary.batches[0].status -eq 'completed') ('Unconfirmed cleanup should stop later dispatch after matrix returns: ' + $result.output)
    Assert-Test ($result.reservation.state -eq 'needs_inspection' -and $result.reservation.execution -eq 'unknown') 'A completed matrix cannot convert unconfirmed cleanup into a known failed execution.'
    Assert-Test ($result.summary.groups[1].notRun -eq 2 -and -not $result.summary.batches[0].releaseConfirmed) 'Unconfirmed cleanup must keep the next unit unexecuted and preserve its denominator.'
    $passed++; Write-Output 'PASS completed matrix with unconfirmed cleanup preserves unknown execution'

    $result = Invoke-Case 'killed' 'hard-stop'
    Assert-Test ($result.code -eq 87 -and $result.calls -eq 1 -and $result.reservation.state -eq 'running') ('Hard stop must retain blocking ownership: ' + $result.output)
    Assert-Test ($result.summary.slots.Count -eq 4) 'All denominator slots must exist before hard stop.'
    $passed++; Write-Output 'PASS hard stop retains persistent reservation and planned denominator'
    $result = Invoke-Case 'killed' 'pass' -Reuse
    Assert-Test ($result.calls -eq 1 -and $result.reservation.state -eq 'running') 'A later launch must not bypass retained ownership.'
    Assert-Test ($result.summary.groups[0].notRun -eq 2 -and $result.summary.groups[1].notRun -eq 2) 'Blocked plan must retain all unexecuted slots.'
    $passed++; Write-Output 'PASS later plan refuses unresolved previous launch'
    Write-Output ('Passed: ' + $passed + '; fixture artifacts: ' + $testRoot)
} finally {
    $current = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in @($current.Keys)) { if (-not $savedEnvironment.Contains($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') } }
    foreach ($name in @($savedEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, [string]$savedEnvironment[$name], 'Process') }
}
