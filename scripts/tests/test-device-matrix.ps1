[CmdletBinding()]
param([string]$TestArtifactsRoot)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$source = Join-Path $projectRoot 'scripts/test-device-matrix.ps1'
# Keep UUID attempt bundles below Windows PowerShell 5.1's file API path limit.
# Script and Flow inputs still exercise Unicode and spaces in the separate fixture tree.
$testParent = if ($TestArtifactsRoot) { [IO.Path]::GetFullPath($TestArtifactsRoot) } else { Join-Path ([IO.Path]::GetTempPath()) 'mh-matrix' }
$testRoot = Join-Path $testParent ([guid]::NewGuid().ToString('N').Substring(0, 12))
$utf8 = [Text.UTF8Encoding]::new($false)
$savedEnvironment = [Environment]::GetEnvironmentVariables('Process')
$passed = 0
$completed = $false

function Assert-Test { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Write-TestFile { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, $utf8) }

function Invoke-Fixture {
    param([string]$Scenario, [string[]]$Targets = @('fixture-a', 'fixture-b'), [int]$Rounds = 1, [hashtable]$Extra = @{})
    Write-TestFile $stateFile (@{ scenario = $Scenario; discoveries = 0; calls = @() } | ConvertTo-Json -Depth 8)
    $env:MATRIX_FIXTURE_STATE = $stateFile
    $arguments = @{
        FlowPath = $flowFile; BundleId = 'org.example.matrix'; AbilityName = 'EntryAbility'; Module = 'entry'
        DeviceIds = $Targets; Repeat = $Rounds; Artifacts = $outputDirectory
        Env = @{ INPUT_TEXT = $inputText; EMPTY = '' }
    }
    foreach ($key in $Extra.Keys) { $arguments[$key] = $Extra[$key] }
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $matrixScript @arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    $directoryLine = @($output | ForEach-Object { $_.ToString() } | Where-Object { $_.StartsWith('Matrix artifacts: ') })
    $directory = if ($directoryLine.Count -eq 1) { $directoryLine[0].Substring('Matrix artifacts: '.Length) } else { $null }
    $result = if ($directory) { Get-Content -LiteralPath (Join-Path $directory 'matrix.json') -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ ExitCode = $code; Report = $result; Output = $output; Directory = $directory; State = (Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json) }
}

try {
    $unicodeText = -join ([char[]]@(0x718A, 0x732B, 0x6D4B, 0x8BD5))
    $fixture = Join-Path $testRoot ('fixture space ' + $unicodeText)
    $fixtureScripts = Join-Path $fixture 'scripts'
    $libraryDirectory = Join-Path $fixture '.upstream/maestro/maestro-cli/build/install/maestro/lib'
    foreach ($directory in @($fixtureScripts, $libraryDirectory)) { $null = [IO.Directory]::CreateDirectory($directory) }
    $matrixScript = Join-Path $fixtureScripts 'test-device-matrix.ps1'
    Copy-Item -LiteralPath $source -Destination $matrixScript
    $flowFile = Join-Path $fixture 'input flow.yaml'
    $stateFile = Join-Path $fixture 'state.json'
    $outputDirectory = Join-Path $testRoot 'output space'
    $inputText = $unicodeText + ' O''Reilly "quoted" C:\path with spaces\'
    Write-TestFile $flowFile "appId: org.example.matrix`n---`n- launchApp`n"
    Write-TestFile (Join-Path $fixture 'fakehdc.exe') 'Not executed; native commands are mocked by the fixture config.'
    Write-TestFile (Join-Path $libraryDirectory 'maestro-cli-fixture.jar') 'Build identity fixture.'
    Write-TestFile (Join-Path $libraryDirectory 'maestro-client-fixture.jar') 'Driver identity fixture.'
    Write-TestFile (Join-Path $libraryDirectory 'maestro-orchestra-fixture.jar') 'Execution identity fixture.'
    Write-TestFile (Join-Path $libraryDirectory 'maestro-orchestra-models-fixture.jar') 'Execution model identity fixture.'
    Write-TestFile (Join-Path $libraryDirectory 'third-party-fixture.jar') 'Not part of implementation identity.'
    Write-TestFile (Join-Path $fixture 'upstream.lock.json') '{"commit":"1111111111111111111111111111111111111111"}'
    $configuration = @'
$env:MAESTRO_HARMONYOS_HDC = Join-Path $PSScriptRoot 'fakehdc.exe'
$env:MATRIX_CONFIG_MARKER = 'loaded'
function Invoke-MatrixNative {
    param([string]$Executable, [string[]]$Arguments)
    $state = Get-Content -LiteralPath $env:MATRIX_FIXTURE_STATE -Raw -Encoding UTF8 | ConvertFrom-Json
    $result = [pscustomobject]@{ ExitCode = 0; Stdout = ''; Stderr = ''; Error = $null }
    if ($Arguments[0] -eq 'list') {
        $state.discoveries++
        [IO.File]::WriteAllText($env:MATRIX_FIXTURE_STATE, ($state | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $result.Stdout = "fixture-a`nfixture-b`n"
        if ($state.scenario -eq 'empty') { $result.Stdout = "[Empty]`n" }
        if ($state.scenario -eq 'disconnect' -and $state.discoveries -ge 2) { $result.Stdout = "fixture-b`n" }
        if ($state.scenario -eq 'discovery-error') { $result.ExitCode = 9; $result.Stderr = 'fixture discovery failed' }
        if ($state.scenario -eq 'malformed-list') { $result.Stdout = "[FAIL] server disconnected`n" }
    } elseif ($Arguments[0] -eq '-t') {
        $command = $Arguments[3]
        $marker = [regex]::Match($command, 'MATRIX_EXIT_[a-f0-9]{32}=').Value
        if (-not $marker) { throw 'Missing remote exit marker in probe.' }
        $response = 'fixture-model'
        if ($command.Contains('const.ohos.fullname')) { $response = 'OpenHarmony-fixture' }
        if ($command.Contains('const.ohos.apiversion')) { $response = '26' }
        if ($command.Contains("'which' 'uitest'")) { $response = '/system/bin/uitest' }
        if ($command.Contains("'which' 'mediatool'")) { $response = '/system/bin/mediatool' }
        if ($command.Contains("'bm' 'dump'")) { $response = '{"abilities":["com.huawei.hmos.screenrecorder.ServiceExtAbility"]}' }
        $result.Stdout = $response + "`n" + $marker + "0`n"
        if ($state.scenario -eq 'unknown-probes') {
            $result.Stdout = "[FAIL] not available`n" + $marker + "0`n"
        }
        if ($state.scenario -eq 'remote-error') { $result.Stdout = $response + "`n" + $marker + "7`n" }
        if ($state.scenario -eq 'missing-marker') { $result.Stdout = $response }
    } elseif ($Arguments[0] -eq '-v') { $result.Stdout = 'HDC fixture version' }
    elseif ($Arguments -contains 'HEAD') { $result.Stdout = '2222222222222222222222222222222222222222' }
    elseif ($Arguments[0] -eq '-version') { $result.Stderr = 'java version fixture' }
    return $result
}
'@
    Write-TestFile (Join-Path $fixture 'config.local.ps1') $configuration
    $runnerFixture = @'
param([string]$FlowPath, [string]$BundleId, [string]$AbilityName, [string]$Module, [string]$DeviceId, [hashtable]$Env, [string]$Artifacts, [string]$AgentRoot, [string]$RunId, [string]$AttemptId, [int]$AttemptNo, [int]$RunTimeoutSeconds, [string]$ControlRecordPath)
$state = Get-Content -LiteralPath $env:MATRIX_FIXTURE_STATE -Raw -Encoding UTF8 | ConvertFrom-Json
$state.calls = @($state.calls) + @([ordered]@{ device = $DeviceId; flow = $FlowPath; bundle = $BundleId; ability = $AbilityName; module = $Module; env = $Env; artifacts = $Artifacts; runTimeoutSeconds = $RunTimeoutSeconds })
if ($ControlRecordPath) {
    $index = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $ControlRecordPath) 'control-index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry = @($index.entries | Where-Object { $_.attemptId -ceq $AttemptId })
    if ($entry.Count -ne 1 -or $entry[0].dispatchState -ne 'launching' -or $entry[0].controlRecordPath -cne $ControlRecordPath) { throw 'Runner started without a matching durable launch intent.' }
    $state.calls[-1].Add('controlRecordPath', $ControlRecordPath)
}
[IO.File]::WriteAllText($env:MATRIX_FIXTURE_STATE, ($state | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
if ($state.scenario -eq 'cancel') { throw [OperationCanceledException]::new('fixture cancelled') }
$resultDirectory = Join-Path $AgentRoot ('runs/' + $RunId + '/' + $AttemptId)
$captureDirectory = Join-Path $resultDirectory 'takeScreenshot'
$null = [IO.Directory]::CreateDirectory($captureDirectory)
[IO.File]::WriteAllBytes((Join-Path $captureDirectory 'screen.png'), [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII='))
Write-Output ('Artifacts: ' + $captureDirectory)
$status = 'passed'; $error = $null; $exitCode = 0
if ($state.scenario -eq 'failure' -and $state.calls.Count -eq 2) { $status = 'failed'; $error = @{ kind = 'assertion'; code = 'ASSERTION_FAILED'; message = 'fixture assertion' }; $exitCode = 37 }
if ($state.scenario -eq 'unsupported') { $status = 'failed'; $error = @{ kind = 'unsupported'; code = 'UNSUPPORTED_COMMAND'; message = 'fixture unsupported' }; $exitCode = 2 }
if ($state.scenario -in @('blocked', 'cancelled', 'unknown')) { $status = $state.scenario; $error = @{ kind = 'environment'; code = 'PRECONDITION_UNKNOWN'; message = 'fixture terminal state' }; $exitCode = 9 }
$null = [IO.Directory]::CreateDirectory($resultDirectory)
$document = @{ protocol = 'maestro.harmonyos.agent'; schemaVersion = 1; kind = 'runResult'; observedAt = [DateTime]::UtcNow.ToString('o'); revision = 1
    data = @{ runId = $RunId; attemptId = $AttemptId; attemptNo = $AttemptNo; deviceId = $DeviceId; status = $status; error = $error; endedAt = [DateTime]::UtcNow.ToString('o'); cleanup = @{ state = 'complete'; errors = @() }; effects = 'none'; artifacts = @{ evidenceIndexPath = 'evidence-index.json' } } }
if ($state.scenario -eq 'cleanup-unknown') { $document.data.cleanup.state = 'unknown' }
if ($state.scenario -eq 'cleanup-failed') { $document.data.cleanup.state = 'failed'; $document.data.cleanup.errors = @(@{ kind = 'internal'; code = 'CLEANUP_FAILED'; message = 'fixture cleanup' }) }
if ($state.scenario -ne 'missing-result') { [IO.File]::WriteAllText((Join-Path $resultDirectory 'result.json'), ($document | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false)) }
if ($state.scenario -eq 'failure' -and $state.calls.Count -eq 2) { Write-Output 'fixture failed'; exit 37 }
if ($state.scenario -eq 'unsupported') { Write-Output 'operation not supported'; exit 2 }
exit $exitCode
'@
    Write-TestFile (Join-Path $fixtureScripts 'run-harmonyos.ps1') $runnerFixture

    $result = Invoke-Fixture 'pass' -Rounds 2
    Assert-Test ($result.ExitCode -eq 0) ('The successful matrix did not exit zero: ' + ($result.Output -join ' ') + '; ' + ($result.Report | ConvertTo-Json -Depth 12 -Compress))
    Assert-Test ($result.Report.summary.planned -eq 4 -and $result.Report.summary.passed -eq 4) 'Planned invocations were not counted correctly.'
    Assert-Test (($result.State.calls.device -join ',') -ceq 'fixture-a,fixture-a,fixture-b,fixture-b') 'Devices and rounds did not run sequentially in the requested order.'
    Assert-Test (@($result.State.calls.artifacts | Select-Object -Unique).Count -eq 4) 'Invocations shared an artifact directory.'
    foreach ($call in $result.State.calls) {
        Assert-Test ($call.env.INPUT_TEXT -ceq $inputText -and $call.env.EMPTY -ceq '') 'Flow parameters changed.'
        Assert-Test ($call.module -eq 'entry' -and $call.bundle -eq 'org.example.matrix' -and $call.flow -ceq $flowFile) 'Runner parameters were not preserved.'
    }
    Assert-Test ($result.Report.devices[0].info.capabilities.basic.status -eq 'available-unverified') 'Tool presence was not recorded.'
    Assert-Test ($result.Report.devices[0].info.capabilities.recording.status -eq 'available-unverified') 'Recorder presence was incorrectly treated as a recording test.'
    Assert-Test ($result.Report.runs[0].screen.width -eq 1 -and $result.Report.runs[0].screen.height -eq 1) 'PNG artifact dimensions were not captured.'
    Assert-Test (@($result.Report.runs | Where-Object { $_.manualIntervention -ne 'unknown' }).Count -eq 0) 'Manual intervention was guessed.'
    Assert-Test ((Get-Content -LiteralPath (Join-Path $result.Directory 'matrix.json') -Raw -Encoding UTF8) -notmatch [regex]::Escape($inputText)) 'The report copied environment parameter values.'
    Assert-Test ($result.Report.input.files[0].sha256 -eq (Get-FileHash -LiteralPath $flowFile -Algorithm SHA256).Hash.ToLowerInvariant()) 'Flow identity is missing.'
    Assert-Test ($result.Report.build.implementationJars.Count -eq 4) 'Built CLI, driver or execution identity is missing.'
    Assert-Test (@($result.Report.build.implementationJars | Where-Object { $_.file -like 'third-party*' }).Count -eq 0) 'Third-party files were unnecessarily included in implementation identity.'
    Assert-Test (Test-Path -LiteralPath (Join-Path $result.Directory 'matrix.md')) 'The Markdown summary is missing.'
    Assert-Test (@(Get-ChildItem -LiteralPath $result.Directory -File -Filter '*.tmp').Count -eq 0) 'A completed report retained temporary output.'
    $passed++

    $result = Invoke-Fixture 'failure' -Rounds 2
    Assert-Test ($result.ExitCode -eq 1 -and $result.Report.summary.passed -eq 3 -and $result.Report.summary.failed -eq 1) 'A failed invocation was hidden.'
    Assert-Test ($result.Report.runs[1].cliExitCode -eq 37 -and $result.Report.summary.passRate -eq 0.75) 'Original exit code or full-denominator pass rate changed.'
    Assert-Test ($result.State.calls.Count -eq 4) 'The wrapper retried or skipped a planned invocation.'
    Assert-Test ((Get-Content -LiteralPath $result.Report.runs[1].log -Raw -Encoding UTF8) -match 'fixture failed') 'The original failed output was lost.'
    $passed++

    $result = Invoke-Fixture 'unsupported' -Targets @('fixture-a')
    Assert-Test ($result.ExitCode -eq 1 -and $result.Report.summary.failed -eq 1 -and $result.Report.summary.passed -eq 0) 'Unsupported commands were counted as passed.'
    Assert-Test ($result.Report.runs[0].cliExitCode -eq 2) 'Unsupported exit code was lost.'
    $passed++

    $result = Invoke-Fixture 'empty' -Rounds 2
    Assert-Test ($result.ExitCode -eq 1 -and $result.Report.summary.notRun -eq 4 -and $result.State.calls.Count -eq 0) 'No-device execution did not remain unexecuted.'
    Assert-Test ($result.Report.summary.passRate -eq 0) 'Missing devices inflated the pass rate.'
    $passed++

    $result = Invoke-Fixture 'disconnect' -Targets @('fixture-a') -Rounds 3
    Assert-Test ($result.ExitCode -eq 1 -and $result.Report.summary.passed -eq 1 -and $result.Report.summary.notRun -eq 2) 'A disconnected device resumed from an unknown state.'
    Assert-Test ($result.State.calls.Count -eq 1 -and $result.State.discoveries -eq 2) 'The disconnected device was retried.'
    $passed++

    foreach ($scenario in @('unknown-probes', 'remote-error', 'missing-marker')) {
        $result = Invoke-Fixture $scenario -Targets @('fixture-a')
        Assert-Test ($result.ExitCode -eq 0 -and $result.Report.summary.passed -eq 1) 'A metadata-only failure was confused with the Flow outcome.'
        Assert-Test ($result.Report.devices[0].info.api.status -eq 'unknown') 'Unconfirmed metadata was accepted.'
        Assert-Test ($result.Report.devices[0].info.capabilities.recording.status -eq 'unknown') 'Unconfirmed recorder capability was accepted.'
    }
    $passed++

    foreach ($scenario in @('discovery-error', 'malformed-list')) {
        $result = Invoke-Fixture $scenario -Targets @('fixture-a')
        Assert-Test ($result.ExitCode -eq 1 -and $result.Report.summary.notRun -eq 1 -and $result.State.calls.Count -eq 0) 'Failed discovery still ran a Flow.'
        Assert-Test ($result.Report.discoveryProbes.Count -eq 1) 'Discovery failure evidence is missing.'
    }
    $passed++

    $result = Invoke-Fixture 'cancel' -Rounds 2
    Assert-Test ($result.ExitCode -eq 1 -and $result.Report.status -eq 'interrupted') 'Cancellation did not interrupt the matrix.'
    Assert-Test ($result.Report.summary.unknown -eq 1 -and $result.Report.summary.failed -eq 0 -and $result.Report.summary.notRun -eq 3 -and $result.State.calls.Count -eq 1) 'Cancellation lost the current round or claimed a confirmed failure.'
    $passed++

    foreach ($scenario in @('blocked', 'cancelled', 'unknown', 'missing-result')) {
        $result = Invoke-Fixture $scenario -Targets @('fixture-a')
        $expected = if ($scenario -eq 'missing-result') { 'unknown' } else { $scenario }
        Assert-Test ($result.ExitCode -eq 1 -and $result.Report.runs[0].status -eq $expected) 'Structured outcome was not preserved.'
        Assert-Test ($result.Report.summary.failed -eq 0 -and $result.Report.summary.passed -eq 0) 'Unconfirmed execution was counted as a test failure or pass.'
        Assert-Test ($result.Report.runs[0].cliExitCode -eq $(if ($scenario -eq 'missing-result') { 0 } else { 9 })) 'Original CLI exit was changed.'
    }
    $passed++

    foreach ($scenario in @('cleanup-unknown', 'cleanup-failed', 'unknown', 'missing-result', 'cancelled')) {
        $result = Invoke-Fixture $scenario -Targets @('fixture-a') -Rounds 3
        Assert-Test ($result.ExitCode -eq 1 -and $result.State.calls.Count -eq 1 -and $result.Report.summary.notRun -eq 2) 'A device was reused before safe handoff was confirmed.'
        Assert-Test ($result.Report.runs[1].reason -match 'not run') 'The handoff block was not explained.'
    }
    $passed++

    $pointerFile = Join-Path $testRoot 'pointers/selected.json'
    $result = Invoke-Fixture 'pass' -Targets @('fixture-a') -Extra @{ ReportPointerPath = $pointerFile; RunTimeoutSeconds = 17 }
    $pointer = Get-Content -LiteralPath $pointerFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($result.ExitCode -eq 0 -and $pointer.protocol -eq 'maestro.harmonyos.matrix-pointer' -and $pointer.schemaVersion -eq 1) 'Machine-readable report pointer was not published.'
    Assert-Test ($pointer.reportPath -ceq (Join-Path $result.Directory 'matrix.json') -and $pointer.matrixDirectory -ceq $result.Directory) 'Pointer selected another invocation.'
    Assert-Test ($result.State.calls[0].runTimeoutSeconds -eq 17) 'The explicit invocation timeout was not forwarded.'
    $pointerHash = (Get-FileHash -LiteralPath $pointerFile -Algorithm SHA256).Hash
    $reused = Invoke-Fixture 'pass' -Targets @('fixture-a') -Extra @{ ReportPointerPath = $pointerFile }
    Assert-Test ($reused.ExitCode -ne 0 -and $reused.State.calls.Count -eq 0 -and $reused.State.discoveries -eq 0) 'Reusing a pointer reached device operations.'
    Assert-Test ((Get-FileHash -LiteralPath $pointerFile -Algorithm SHA256).Hash -ceq $pointerHash) 'An earlier invocation pointer was overwritten.'
    $passed++

    $controls = Join-Path $testRoot 'controls'
    $invocationId = [guid]::NewGuid().ToString()
    $result = Invoke-Fixture 'cleanup-unknown' -Targets @('fixture-a') -Rounds 3 -Extra @{ ControlRecordDirectory = $controls; MatrixInvocationId = $invocationId }
    $indexPath = Join-Path $controls 'control-index.json'
    $index = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($index.protocol -eq 'maestro.harmonyos.control-index' -and $index.schemaVersion -eq 1 -and $index.invocationId -ceq $invocationId -and $index.matrixRoot -ceq $result.Directory) 'Control index identity differs.'
    Assert-Test ($index.entries.Count -eq 3 -and $index.entries[0].dispatchState -eq 'returned' -and $index.entries[1].dispatchState -eq 'planned' -and $index.entries[2].dispatchState -eq 'planned') 'Control index lost an unstarted slot or launch state.'
    Assert-Test ($result.State.calls.Count -eq 1 -and $index.entries[0].controlRecordPath -ceq $result.State.calls[0].controlRecordPath -and $index.entries[0].attemptId -ceq $result.Report.runs[0].attemptId) 'Runner control identity was not forwarded.'
    $indexHash = (Get-FileHash -LiteralPath $indexPath).Hash
    $reused = Invoke-Fixture 'pass' -Targets @('fixture-a') -Extra @{ ControlRecordDirectory = $controls }
    Assert-Test ($reused.ExitCode -ne 0 -and $reused.State.calls.Count -eq 0 -and $reused.State.discoveries -eq 0 -and (Get-FileHash -LiteralPath $indexPath).Hash -ceq $indexHash) 'Reusing a control directory reached device operations or changed its index.'
    $interruptedControls = Join-Path $testRoot 'interrupted-controls'
    $result = Invoke-Fixture 'cancel' -Targets @('fixture-a') -Rounds 2 -Extra @{ ControlRecordDirectory = $interruptedControls }
    $index = Get-Content -LiteralPath (Join-Path $interruptedControls 'control-index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Test ($result.ExitCode -ne 0 -and $index.entries[0].dispatchState -eq 'launching' -and $index.entries[1].dispatchState -eq 'planned') 'An interrupted dispatch was falsely marked returned.'
    $passed++

    $result = Invoke-Fixture 'pass' -Targets @('fixture-a', 'fixture-a')
    Assert-Test ($result.ExitCode -eq 1 -and $null -eq $result.Report -and $result.State.calls.Count -eq 0) 'Duplicate device IDs were accepted.'
    Assert-Test ($null -eq [Environment]::GetEnvironmentVariable('MATRIX_CONFIG_MARKER', 'Process')) 'Configuration leaked into the caller environment.'
    $passed++

    # Exercise the real bounded process runner separately; no HDC or network is used.
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$parseErrors)
    Assert-Test ($parseErrors.Count -eq 0) 'Matrix script has syntax errors.'
    foreach ($functionName in @('ConvertTo-MatrixArgument', 'Invoke-MatrixNative')) {
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    $ProbeTimeoutSeconds = 10
    $nativePowerShell = (Get-Process -Id $PID).Path
    $native = Invoke-MatrixNative $nativePowerShell @('-NoProfile', '-Command', '[Console]::Out.Write("matrix stdout"); [Console]::Error.Write("matrix stderr"); exit 7')
    Assert-Test ($native.ExitCode -eq 7 -and $native.Stdout -eq 'matrix stdout' -and $native.Stderr -eq 'matrix stderr') 'Native output or exit status changed.'
    $ProbeTimeoutSeconds = 1
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $native = Invoke-MatrixNative $nativePowerShell @('-NoProfile', '-Command', 'Start-Sleep -Seconds 20')
    $clock.Stop()
    Assert-Test ($native.Error -match 'timed out' -and $clock.Elapsed.TotalSeconds -lt 8) 'A probe was not bounded by its timeout.'
    $passed++

    $testParseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$null, [ref]$testParseErrors) | Out-Null
    Assert-Test ($testParseErrors.Count -eq 0) 'Matrix test script has syntax errors.'
    Write-Output ('PASS: ' + $passed + ' matrix checks and 2 syntax checks. No device, Gradle or network operations.')
    $completed = $true
} finally {
    $currentEnvironment = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in $currentEnvironment.Keys) {
        if (-not $savedEnvironment.Contains($name)) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    }
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, [string]$savedEnvironment[$name], 'Process') }
    if ($completed -and (Test-Path -LiteralPath $testRoot)) {
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
        $allowedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedTestRoot.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside matrix-tests.' }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    } elseif (Test-Path -LiteralPath $testRoot) {
        Write-Output ('Failure evidence retained at ' + $testRoot)
    }
}
exit 0
