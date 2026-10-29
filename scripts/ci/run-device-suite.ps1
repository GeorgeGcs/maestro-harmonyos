[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')][string]$SuiteManifest,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')][string]$DeviceId,
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')][string]$ArtifactsRoot,
    [Parameter(Mandatory = $true)][string]$DeviceStateDirectory,
    [string]$RecoveryRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.maestro/harmonyos-sessions'),
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')][ValidateRange(1, 604800)][int]$RunTimeoutSeconds,
    [ValidateRange(1, 300)][int]$TerminationWaitSeconds = 5,
    [ValidateRange(1, 300)][int]$OutputDrainSeconds = 5,
    [ValidateRange(1, 300)][int]$VerificationTimeoutSeconds = 30,
    [ValidateRange(0, 604800)][int]$JobTimeoutSeconds = 0,
    [Parameter(Mandatory = $true, ParameterSetName = 'Reconcile')][switch]$ReconcileOnly,
    [Parameter(Mandatory = $true, ParameterSetName = 'Reconcile')][string]$RecoveryReportPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$utf8 = [Text.UTF8Encoding]::new($false)
$reservation = $null
$state = $null
$statePath = $null
$ownedLaunch = $false
$exitCode = 1
. (Join-Path $PSScriptRoot 'device-reservation.ps1')

function Assert-NoLinks {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'CI state and verification paths must not follow directory links.'
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Write-AtomicJson {
    param([string]$Path, $Value)
    Assert-NoLinks $Path
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.' + [guid]::NewGuid().ToString('N') + '.pending')
    $bytes = $utf8.GetBytes(($Value | ConvertTo-Json -Depth 24))
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try {
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function ConvertTo-NativeArgument {
    param([string]$Value)
    if ($Value.IndexOf([char]0) -ge 0) { throw 'Arguments cannot contain NUL.' }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-StateVerification {
    param($InputValue, [string]$Directory)
    $inputPath = Join-Path $Directory ('verification-' + [guid]::NewGuid().ToString('N') + '.json')
    Write-AtomicJson $inputPath $InputValue
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $node.Source
        $process.StartInfo.Arguments = ((@((Join-Path $PSScriptRoot 'verify-state.mjs'), $inputPath) | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
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
        if (-not $process.WaitForExit($VerificationTimeoutSeconds * 1000)) { throw 'Local verification exceeded its budget.' }
        if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) { throw 'Verification output did not close.' }
        $message = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw ('Release verification failed: ' + $message.Trim()) }
        $value = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($value.releaseConfirmed -ne $true) { throw 'Verification did not confirm release.' }
        return $value
    } finally {
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(1000) } } catch { }
        $process.Dispose()
    }
}

function Assert-RecordedProcessEnded {
    param($Identity)
    if ($null -eq $Identity -or $Identity.pid -le 0 -or $Identity.startTimeTicks -le 0) {
        throw 'The old launch has no usable process identity; automatic reconciliation is unavailable.'
    }
    try { $observed = [Diagnostics.Process]::GetProcessById([int]$Identity.pid) }
    catch [ArgumentException] { return }
    try {
        if ($observed.StartTime.ToUniversalTime().Ticks -eq [long]$Identity.startTimeTicks) {
            throw 'The old recorded process is still alive; reconciliation will not stop or take it over.'
        }
    } finally { $observed.Dispose() }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This CI entry point currently supports Windows only.' }
    $artifactRoot = if ($ArtifactsRoot) { [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArtifactsRoot)) } else { $null }
    if ($artifactRoot) { Assert-NoLinks $artifactRoot }
    $reservation = Open-DeviceReservation -DeviceId $DeviceId -DeviceStateDirectory $DeviceStateDirectory -ProjectRoot $projectRoot -ArtifactsRoot $artifactRoot
    $stateDirectory = $reservation.Directory
    $statePath = $reservation.StatePath
    $state = $reservation.State
    $trustedRecoveryRoot = [IO.Path]::GetFullPath($RecoveryRoot)
    Assert-NoLinks $trustedRecoveryRoot
    if ($ReconcileOnly) {
        if ($null -eq $state -or $state.state -eq 'released') { throw 'There is no blocked CI launch to reconcile.' }
        if (-not [string]::Equals($trustedRecoveryRoot, [IO.Path]::GetFullPath($state.recoveryRoot), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Reconciliation must use the same trusted recovery root as the retained launch.'
        }
        Assert-RecordedProcessEnded $state.ownerProcess
        if ($state.kind -eq 'validation') {
            Assert-NoLinks $state.controlIndexPath
            $indexFile = Get-Item -LiteralPath $state.controlIndexPath
            if ($indexFile.PSIsContainer -or $indexFile.Length -gt 4MB) { throw 'The validation control index is not a bounded file.' }
            $index = Get-Content -LiteralPath $state.controlIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($index.protocol -ne 'maestro.harmonyos.control-index' -or $index.schemaVersion -ne 1 -or
                $index.invocationId -cne $state.unitInvocationId -or $index.entries -isnot [array] -or @($index.entries).Count -eq 0) {
                throw 'The validation control index does not belong to the retained invocation.'
            }
            $seen = @{}
            $uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            foreach ($entry in @($index.entries)) {
                if ($entry.deviceId -cne $DeviceId -or $entry.runId -notmatch $uuidPattern -or $entry.attemptId -notmatch $uuidPattern -or
                    $entry.dispatchState -notin @('planned', 'launching', 'returned') -or $seen.ContainsKey($entry.attemptId)) {
                    throw 'The validation control index has invalid or duplicate attempt identities.'
                }
                $seen[$entry.attemptId] = $true
                $expectedControl = Join-Path ([IO.Path]::GetDirectoryName($state.controlIndexPath)) ($entry.attemptId + '.json')
                if (-not [string]::Equals([IO.Path]::GetFullPath($entry.controlRecordPath), $expectedControl, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'The validation control index references an unexpected control path.'
                }
                Assert-NoLinks $expectedControl
                if ($entry.dispatchState -eq 'planned') {
                    if (Test-Path -LiteralPath $expectedControl) { throw 'A planned-only attempt unexpectedly has a runner record.' }
                    continue
                }
                $oldControl = Get-Content -LiteralPath $expectedControl -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($oldControl.protocol -ne 'maestro.harmonyos.runner-control' -or $oldControl.schemaVersion -ne 1 -or
                    $oldControl.runId -cne $entry.runId -or $oldControl.attemptId -cne $entry.attemptId -or $oldControl.deviceId -cne $DeviceId) {
                    throw 'The runner record does not belong to the indexed validation attempt.'
                }
                Assert-RecordedProcessEnded $oldControl.process
            }
        } else {
            Assert-NoLinks $state.controlRecordPath
            $oldControl = Get-Content -LiteralPath $state.controlRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($oldControl.protocol -ne 'maestro.harmonyos.runner-control' -or $oldControl.schemaVersion -ne 1 -or
                $oldControl.runId -cne $state.runId -or $oldControl.attemptId -cne $state.attemptId -or $oldControl.deviceId -cne $DeviceId) {
                throw 'The retained runner record does not belong to this CI launch.'
            }
            Assert-RecordedProcessEnded $oldControl.process
        }
        $verification = Invoke-StateVerification @{
            mode = 'recovery'; deviceId = $DeviceId; runId = $state.runId; attemptId = $state.attemptId
            recoveryRoot = $trustedRecoveryRoot; createdAt = $state.createdAt
            recoveryReportPath = [IO.Path]::GetFullPath($RecoveryReportPath)
        } $stateDirectory
        $state.resolution = $verification
        $state.state = 'released'
        $state.updatedAt = [DateTime]::UtcNow.ToString('o')
        Write-DeviceReservationState $reservation $state
        Write-Output 'The retained launch is released using the checked v2 recovery report. Its original execution result is unchanged.'
        $exitCode = 0
    } else {
        if ($null -ne $state -and $state.state -ne 'released') {
            throw ('Device use is blocked by a retained CI launch (' + $state.launchId + '). Inspect it and reconcile with a trusted v2 recovery report; a timeout does not release it.')
        }
        if ($JobTimeoutSeconds -gt 0 -and $RunTimeoutSeconds + $TerminationWaitSeconds + $OutputDrainSeconds + $VerificationTimeoutSeconds + 60 -ge $JobTimeoutSeconds) {
            throw 'The job budget must leave more than 60 seconds beyond execution, termination, output drain and verification for startup and archival.'
        }
        $manifestPath = (Get-Item -LiteralPath $SuiteManifest -ErrorAction Stop).FullName
        $null = Get-Command node -CommandType Application -ErrorAction Stop
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($manifest.suiteId) -or
            [string]::IsNullOrWhiteSpace($manifest.flowPath) -or [string]::IsNullOrWhiteSpace($manifest.bundleId) -or
            [string]::IsNullOrWhiteSpace($manifest.abilityName)) { throw 'Suite manifest requires schemaVersion=1, suiteId, flowPath, bundleId and abilityName.' }
        $flow = if ([IO.Path]::IsPathRooted($manifest.flowPath)) { $manifest.flowPath } else { Join-Path ([IO.Path]::GetDirectoryName($manifestPath)) $manifest.flowPath }
        $flow = (Get-Item -LiteralPath $flow -ErrorAction Stop).FullName
        $variables = @{}
        foreach ($name in @($manifest.environmentNames)) {
            if ($null -eq $name) { continue }
            if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $name -ieq 'APP_ID') { throw 'Invalid environment variable name in suite manifest.' }
            $value = [Environment]::GetEnvironmentVariable($name, 'Process')
            if ($null -eq $value) { throw ('A required suite environment variable is missing: ' + $name) }
            $variables[$name] = $value
        }
        $launchId = [guid]::NewGuid().ToString()
        $directory = Join-Path $artifactRoot ('ci-' + $launchId)
        $null = [IO.Directory]::CreateDirectory($directory)
        $controlDirectory = Join-Path $stateDirectory 'launches'
        $null = [IO.Directory]::CreateDirectory($controlDirectory)
        $process = [Diagnostics.Process]::GetCurrentProcess()
        try { $owner = @{ pid = $process.Id; startTimeTicks = $process.StartTime.ToUniversalTime().Ticks; executable = $process.MainModule.FileName } }
        finally { $process.Dispose() }
        $state = [ordered]@{
            protocol = 'maestro.harmonyos.ci-device'; schemaVersion = 1; kind = 'single'; deviceId = $DeviceId
            launchId = $launchId; runId = [guid]::NewGuid().ToString(); attemptId = [guid]::NewGuid().ToString()
            suiteId = $manifest.suiteId; manifestPath = $manifestPath; manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
            createdAt = [DateTime]::UtcNow.ToString('o'); updatedAt = $null; state = 'launching'; ownerProcess = $owner
            controlRecordPath = (Join-Path $controlDirectory ($launchId + '.json'))
            artifactDirectory = $directory; agentRoot = (Join-Path $stateDirectory 'agent'); recoveryRoot = $trustedRecoveryRoot
            execution = 'unknown'; wrapperExitCode = $null; resolution = $null; error = $null
        }
        $state.updatedAt = $state.createdAt
        # The durable intent precedes Java launch. A platform hard stop can skip every finally below.
        Write-DeviceReservationState $reservation $state
        $ownedLaunch = $true
        $arguments = @{
            FlowPath = $flow; BundleId = $manifest.bundleId; AbilityName = $manifest.abilityName; DeviceId = $DeviceId; Env = $variables
            Artifacts = $directory; AgentRoot = $state.agentRoot; RunId = $state.runId; AttemptId = $state.attemptId
            RunTimeoutSeconds = $RunTimeoutSeconds; TerminationWaitSeconds = $TerminationWaitSeconds; OutputDrainSeconds = $OutputDrainSeconds
            ControlRecordPath = $state.controlRecordPath
        }
        if ($manifest.moduleName) { $arguments.Module = $manifest.moduleName }
        $state.state = 'running'
        Write-DeviceReservationState $reservation $state
        Write-Output ('CI artifacts: ' + $directory)
        $log = [IO.StreamWriter]::new((Join-Path $directory 'runner.log'), $false, $utf8)
        try {
            & (Join-Path $projectRoot 'scripts/run-harmonyos.ps1') @arguments 2>&1 | ForEach-Object {
                $log.WriteLine($_.ToString()); $log.Flush(); Write-Output $_
            }
            $state.wrapperExitCode = $LASTEXITCODE
        } finally { $log.Dispose() }
        $verification = Invoke-StateVerification @{
            mode = 'completion'; deviceId = $DeviceId; runId = $state.runId; attemptId = $state.attemptId
            agentRoot = $state.agentRoot; recoveryRoot = $trustedRecoveryRoot; createdAt = $state.createdAt
            controlRecordPath = $state.controlRecordPath
        } $directory
        $state.execution = $verification.status
        $state.resolution = $verification
        $state.state = 'released'
        $state.updatedAt = [DateTime]::UtcNow.ToString('o')
        Write-AtomicJson (Join-Path $directory 'ci-result.json') $state
        Write-DeviceReservationState $reservation $state
        $exitCode = if ($state.wrapperExitCode -eq 0 -and $verification.processExitCode -eq 0 -and $verification.status -eq 'passed' -and $verification.evidence.unavailable -eq 0) { 0 } else { 1 }
    }
} catch {
    if ($ownedLaunch) {
        $state.state = 'needs_inspection'; $state.error = $_.Exception.Message; $state.updatedAt = [DateTime]::UtcNow.ToString('o')
        try { Write-DeviceReservationState $reservation $state; Write-AtomicJson (Join-Path $state.artifactDirectory 'ci-result.json') $state } catch { }
    }
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
} finally {
    if ($null -ne $reservation) { Close-DeviceReservation $reservation }
}
exit $exitCode
