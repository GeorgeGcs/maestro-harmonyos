[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [Parameter(Mandatory = $true)][string]$ArtifactsRoot,
    [Parameter(Mandatory = $true)][string]$DeviceStateDirectory,
    [string]$RecoveryRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.maestro/harmonyos-sessions'),
    [ValidateRange(1, 600)][int]$VerificationTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$utf8 = [Text.UTF8Encoding]::new($false)
$originalEnvironment = [Environment]::GetEnvironmentVariables('Process')
$summaryPath = $null
$outputDirectory = $null
$interrupted = $true
$exitCode = 1
. (Join-Path $PSScriptRoot 'ci/device-reservation.ps1')

function ConvertTo-ValidationArgument {
    param([string]$Value)
    if ($Value.IndexOf([char]0) -ge 0) { throw 'Arguments cannot contain NUL.' }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-ValidationHelper {
    param([Parameter(Mandatory = $true)]$InputValue)
    $requestPath = Join-Path $outputDirectory ('request-' + [guid]::NewGuid().ToString('N') + '.json')
    $bytes = $utf8.GetBytes(($InputValue | ConvertTo-Json -Depth 24))
    $stream = [IO.File]::Open($requestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $node.Source
        $process.StartInfo.Arguments = ((@((Join-Path $PSScriptRoot 'validation/main.mjs'), $requestPath) | ForEach-Object { ConvertTo-ValidationArgument $_ }) -join ' ')
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = $utf8
        $process.StartInfo.StandardErrorEncoding = $utf8
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($VerificationTimeoutSeconds * 1000)) { throw 'Validation metadata verification exceeded its budget.' }
        if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) { throw 'Validation helper output did not close.' }
        if ($process.ExitCode -ne 0) { throw ('Validation failed: ' + $stderr.GetAwaiter().GetResult().Trim()) }
        return $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
    } finally {
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(1000) } } catch { }
        $process.Dispose()
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This validation runner currently supports Windows only.' }
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $configuration = Join-Path $projectRoot 'config.local.ps1'
    if (Test-Path -LiteralPath $configuration -PathType Leaf) { . $configuration }
    $planFile = (Get-Item -LiteralPath $PlanPath -ErrorAction Stop).FullName
    $artifacts = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactsRoot))
    Assert-DeviceReservationPath $artifacts
    $trustedRecoveryRoot = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RecoveryRoot))
    Assert-DeviceReservationPath $trustedRecoveryRoot
    $outputDirectory = Join-Path $artifacts ('validation-' + [guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($outputDirectory)
    $frozen = Invoke-ValidationHelper @{ operation = 'freeze'; planPath = $planFile; outputDirectory = $outputDirectory; projectRoot = $projectRoot }
    $summaryPath = $frozen.summaryPath
    Write-Output ('Validation plan: ' + $summaryPath)
    $stoppedDevices = @{}
    foreach ($batch in @($frozen.batches)) {
        if ($stoppedDevices.ContainsKey($batch.deviceId)) {
            $null = Invoke-ValidationHelper @{ operation = 'skip'; summaryPath = $summaryPath; batchId = $batch.batchId; started = $false; reason = $stoppedDevices[$batch.deviceId] }
            continue
        }
        $reservation = $null
        $ownedLaunch = $false
        $matrixWasCalled = $false
        $batchState = $null
        try {
            $reservation = Open-DeviceReservation -DeviceId $batch.deviceId -DeviceStateDirectory $DeviceStateDirectory -ProjectRoot $projectRoot -ArtifactsRoot $artifacts
            if ($null -ne $reservation.State -and $reservation.State.state -ne 'released') {
                throw 'A previous CI or validation launch still needs inspection. Use the existing recovery and reconciliation procedure.'
            }
            $batchDirectory = Join-Path $outputDirectory $batch.batchId
            $null = [IO.Directory]::CreateDirectory($batchDirectory)
            $pointerPath = Join-Path $batchDirectory 'matrix-pointer.json'
            $controlDirectory = Join-Path $reservation.Directory ('validation/' + $batch.batchId)
            $controlIndexPath = Join-Path $controlDirectory 'control-index.json'
            $prepared = Invoke-ValidationHelper @{ operation = 'start'; summaryPath = $summaryPath; batchId = $batch.batchId;
                outputDirectory = $batchDirectory; pointerPath = $pointerPath; controlIndexPath = $controlIndexPath }
            $self = [Diagnostics.Process]::GetCurrentProcess()
            try { $owner = @{ pid = $self.Id; startTimeTicks = $self.StartTime.ToUniversalTime().Ticks; executable = $self.MainModule.FileName } }
            finally { $self.Dispose() }
            $batchState = [ordered]@{
                protocol = 'maestro.harmonyos.ci-device'; schemaVersion = 1; kind = 'validation'; deviceId = $batch.deviceId
                launchId = $batch.batchId; unitInvocationId = $batch.batchId; controlIndexPath = $controlIndexPath
                runId = $null; attemptId = $null; controlRecordPath = $null
                createdAt = [DateTime]::UtcNow.ToString('o'); updatedAt = $null; state = 'launching'; ownerProcess = $owner
                artifactDirectory = $batchDirectory; agentRoot = $null; recoveryRoot = $trustedRecoveryRoot
                execution = 'unknown'; wrapperExitCode = $null; resolution = $null; error = $null
            }
            Write-DeviceReservationState $reservation $batchState
            $ownedLaunch = $true
            $variables = @{}
            foreach ($name in @($prepared.profile.environmentNames)) { $variables[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
            $parameters = @{ FlowPath = $prepared.unit.entry; BundleId = $prepared.profile.bundleId; AbilityName = $prepared.profile.abilityName;
                DeviceIds = @($batch.deviceId); Env = $variables; Artifacts = $batchDirectory; Repeat = [int]$prepared.repeat;
                ReportPointerPath = $pointerPath; ControlRecordDirectory = $controlDirectory; MatrixInvocationId = $batch.batchId;
                RunTimeoutSeconds = [int]$prepared.runTimeoutSeconds }
            if ($null -ne $prepared.profile.moduleName) { $parameters.Module = $prepared.profile.moduleName }
            $batchState.state = 'running'; $batchState.updatedAt = [DateTime]::UtcNow.ToString('o')
            Write-DeviceReservationState $reservation $batchState
            $global:LASTEXITCODE = $null
            $matrixWasCalled = $true
            & (Join-Path $PSScriptRoot 'test-device-matrix.ps1') @parameters *> (Join-Path $batchDirectory 'matrix-runner.log')
            $matrixCode = $LASTEXITCODE
            if ($null -eq $matrixCode) { throw 'Matrix invocation did not report an exit code.' }
            $result = Invoke-ValidationHelper @{ operation = 'import'; summaryPath = $summaryPath; batchId = $batch.batchId;
                matrixExitCode = [int]$matrixCode; recoveryRoot = $trustedRecoveryRoot }
            $batchState.wrapperExitCode = [int]$matrixCode
            $batchState.agentRoot = $result.agentRoot
            $batchState.execution = if ($result.status -eq 'completed' -and $result.releaseConfirmed -eq $true -and $result.stopDevice -eq $false) {
                if ($matrixCode -eq 0) { 'passed' } else { 'failed' }
            } else { 'unknown' }
            $batchState.state = if ($result.releaseConfirmed) { 'released' } else { 'needs_inspection' }
            $batchState.resolution = $result.release
            $batchState.error = $result.error
            $batchState.updatedAt = [DateTime]::UtcNow.ToString('o')
            Write-DeviceReservationState $reservation $batchState
            if ($result.stopDevice) { $stoppedDevices[$batch.deviceId] = 'An earlier batch was cancelled, unknown, unexecuted, or did not confirm clean handoff.' }
        } catch {
            $caughtError = $_.Exception
            $reason = $caughtError.Message
            $stoppedDevices[$batch.deviceId] = $reason
            if ($ownedLaunch) {
                $batchState.state = 'needs_inspection'; $batchState.error = $reason; $batchState.updatedAt = [DateTime]::UtcNow.ToString('o')
                try { Write-DeviceReservationState $reservation $batchState } catch { Write-Warning 'The retained reservation could not be updated; it remains blocking.' }
            }
            try { $null = Invoke-ValidationHelper @{ operation = 'skip'; summaryPath = $summaryPath; batchId = $batch.batchId; started = $matrixWasCalled; reason = $reason } } catch { }
            if ($caughtError -is [OperationCanceledException] -or $caughtError -is [Management.Automation.PipelineStoppedException]) { throw $caughtError }
        } finally { if ($reservation) { Close-DeviceReservation $reservation } }
    }
    $interrupted = $false
} catch { Write-Error -Message $_.Exception.Message -ErrorAction Continue }
finally {
    if ($summaryPath) {
        try {
            $final = Invoke-ValidationHelper @{ operation = 'finish'; summaryPath = $summaryPath; interrupted = $interrupted }
            if ($final.originalExecutionSucceeded -and $final.qualified) { $exitCode = 0 }
            Write-Output ('Validation summary: ' + $summaryPath + '; qualified=' + $final.qualified + '. Manual and video evidence review remain explicit.')
        } catch { Write-Error -Message $_.Exception.Message -ErrorAction Continue }
    }
    $current = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in @($current.Keys)) { if (-not $originalEnvironment.Contains($name)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') } }
    foreach ($name in @($originalEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, [string]$originalEnvironment[$name], 'Process') }
}
exit $exitCode
