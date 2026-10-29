[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$FlowPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BundleId,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AbilityName,
    [Alias('ModuleName')][string]$Module,
    [string]$DeviceId,
    [hashtable]$Env = @{},
    [Alias('ArtifactsRoot')][string]$Artifacts,
    [string]$AgentRoot,
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$RunId = [guid]::NewGuid().ToString(),
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$AttemptId = [guid]::NewGuid().ToString(),
    [ValidateRange(1, 2147483647)][int]$AttemptNo = 1,
    [ValidateRange(0, 604800)][int]$RunTimeoutSeconds = 0,
    [ValidateRange(1, 300)][int]$TerminationWaitSeconds = 5,
    [ValidateRange(1, 300)][int]$OutputDrainSeconds = 5,
    [string]$ControlRecordPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$originalLocation = Get-Location
$originalEnvironment = [Environment]::GetEnvironmentVariables('Process')
$runProcess = $null
$runExitCode = 1
$invocation = $null
$control = $null
$controlPath = $null
$controlCreated = $false
$processIdentity = $null
$processExitCode = $null
$stdoutTask = $null
$stderrTask = $null
$stdoutLog = $null
$stderrLog = $null

function Write-RunnerControl {
    param([switch]$Create)
    $control.updatedAt = [DateTime]::UtcNow.ToString('o')
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($controlPath)) ('.' + [guid]::NewGuid().ToString('N') + '.pending')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($control | ConvertTo-Json -Depth 12))
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try {
        if ($Create) { [IO.File]::Move($temporary, $controlPath) }
        else { [IO.File]::Replace($temporary, $controlPath, [NullString]::Value) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Assert-RunnerControlPath {
    param([string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if ((Test-Path -LiteralPath $current) -and (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'Runner control records must not follow file or directory links.'
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Stop-RunnerProcess {
    param([string]$Reason)
    if ($null -eq $runProcess -or $runProcess.HasExited) { return }
    if ($null -eq $processIdentity -or $runProcess.Id -ne $processIdentity.pid -or
        $runProcess.StartTime.ToUniversalTime().Ticks -ne $processIdentity.startTimeTicks -or
        -not [string]::Equals($runProcess.MainModule.FileName, $processIdentity.executable, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('The owned Java process identity could not be confirmed; no termination was sent. PID match=' + ($runProcess.Id -eq $processIdentity.pid) + ', start match=' + ($runProcess.StartTime.ToUniversalTime().Ticks -eq $processIdentity.startTimeTicks) + ', executable match=' + [string]::Equals($runProcess.MainModule.FileName, $processIdentity.executable, [StringComparison]::OrdinalIgnoreCase))
    }
    $control.stopReason = $Reason
    $control.terminationRequested = $true
    $control.terminationRequestedAt = [DateTime]::UtcNow.ToString('o')
    $control.phase = 'stopping'
    # Persist intent before Kill. A lost host never implies the device operation stopped.
    try { Write-RunnerControl } catch { $control.error = 'Could not persist termination intent: ' + $_.Exception.Message }
    $runProcess.Kill()
    $control.processExitObserved = $runProcess.WaitForExit($TerminationWaitSeconds * 1000)
    if ($control.processExitObserved) { $control.processExitCode = $runProcess.ExitCode }
    $control.phase = 'unknown'
    Write-RunnerControl
}

function ConvertTo-WindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.IndexOf([char]0) -ge 0) { throw 'Arguments cannot contain NUL.' }
    # ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1.
    # Quote for the Windows CRT argv parser, without involving cmd.exe.
    $quoted = [Text.StringBuilder]::new()
    $null = $quoted.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
        } else {
            $count = if ($character -eq '"') { $backslashes * 2 + 1 } else { $backslashes }
            if ($count -gt 0) { $null = $quoted.Append('\', $count) }
            $null = $quoted.Append($character)
            $backslashes = 0
        }
    }
    if ($backslashes -gt 0) { $null = $quoted.Append('\', $backslashes * 2) }
    $null = $quoted.Append('"')
    return $quoted.ToString()
}

function Get-JavaLauncherEncoding {
    param([string]$Executable)
    $probe = [Diagnostics.Process]::new()
    try {
        $probe.StartInfo.FileName = $Executable
        $probe.StartInfo.Arguments = '-XshowSettings:properties -version'
        $probe.StartInfo.UseShellExecute = $false
        $probe.StartInfo.CreateNoWindow = $true
        $probe.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $probe.StartInfo.RedirectStandardOutput = $true
        $probe.StartInfo.RedirectStandardError = $true
        $null = $probe.Start()
        $outputTask = $probe.StandardOutput.ReadToEndAsync()
        $errorTask = $probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(10000)) { throw 'Java version probe timed out.' }
        if (-not $outputTask.Wait(1000) -or -not $errorTask.Wait(1000)) { throw 'Java version probe output did not close.' }
        $details = $outputTask.GetAwaiter().GetResult() + $errorTask.GetAwaiter().GetResult()
        $version = [regex]::Match($details, '(?m)^\s*java\.specification\.version\s*=\s*(\d+)\s*$')
        $encoding = [regex]::Match($details, '(?m)^\s*sun\.jnu\.encoding\s*=\s*(\S+)\s*$')
        if ($probe.ExitCode -ne 0 -or -not $version.Success -or [int]$version.Groups[1].Value -lt 17) {
            throw 'Java 17 or later is required to run the built CLI.'
        }
        if (-not $encoding.Success) { throw 'Could not determine the Java launcher encoding.' }
        return [Text.Encoding]::GetEncoding($encoding.Groups[1].Value,
            [Text.EncoderExceptionFallback]::new(), [Text.DecoderExceptionFallback]::new())
    } finally {
        try { if (-not $probe.HasExited) { $probe.Kill(); $null = $probe.WaitForExit(5000) } } catch { }
        $probe.Dispose()
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This entry point currently supports Windows PowerShell only.'
    }
    $flowItem = Get-Item -LiteralPath $FlowPath -ErrorAction Stop
    if ($flowItem.PSProvider.Name -ne 'FileSystem') { throw 'FlowPath must be a local file or directory.' }
    $resolvedFlow = $flowItem.FullName
    $artifactsRoot = if ([string]::IsNullOrWhiteSpace($Artifacts)) {
        Join-Path $projectRoot 'artifacts'
    } else {
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Artifacts)
    }
    $localConfig = Join-Path $projectRoot 'config.local.ps1'
    if (Test-Path -LiteralPath $localConfig -PathType Leaf) { . $localConfig }

    if ([string]::IsNullOrWhiteSpace($BundleId) -or [string]::IsNullOrWhiteSpace($AbilityName)) {
        throw 'BundleId and AbilityName must not be blank.'
    }
    if ($PSBoundParameters.ContainsKey('Module') -and [string]::IsNullOrWhiteSpace($Module)) {
        throw 'Module must not be blank when supplied.'
    }
    if ($PSBoundParameters.ContainsKey('DeviceId') -and [string]::IsNullOrWhiteSpace($DeviceId)) {
        throw 'DeviceId must not be blank when supplied.'
    }
    foreach ($key in $Env.Keys) {
        if ($key -isnot [string] -or $key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw 'Env keys must be valid variable names.'
        }
        if ($key -ieq 'APP_ID') { throw 'Use BundleId to set APP_ID; Env must not override it.' }
        if ($null -eq $Env[$key]) { throw ('Env value is missing: ' + $key) }
    }

    $distribution = Join-Path $projectRoot '.upstream/maestro/maestro-cli/build/install/maestro'
    $libraryDirectory = Join-Path $distribution 'lib'
    if (-not (Test-Path -LiteralPath (Join-Path $distribution 'bin/maestro.bat') -PathType Leaf) -or
        -not (Test-Path -LiteralPath $libraryDirectory -PathType Container) -or
        @(Get-ChildItem -LiteralPath $libraryDirectory -Filter '*.jar' -File).Count -eq 0) {
        throw 'The built Maestro CLI is missing. Build :maestro-cli:installDist first; this script does not build or download it.'
    }
    if ($env:JAVA_HOME) {
        $javaExecutable = Join-Path $env:JAVA_HOME 'bin/java.exe'
        if (-not (Test-Path -LiteralPath $javaExecutable -PathType Leaf)) { throw 'JAVA_HOME does not contain bin/java.exe.' }
    } else {
        $javaCommand = Get-Command java -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $javaCommand) { throw 'Java 17 is required. Set JAVA_HOME or add java to PATH.' }
        $javaExecutable = $javaCommand.Source
    }

    $env:MAESTRO_HARMONYOS_ABILITY = $AbilityName
    $env:MAESTRO_CLI_NO_ANALYTICS = '1'
    $env:MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED = 'true'
    if ($PSBoundParameters.ContainsKey('Module')) { $env:MAESTRO_HARMONYOS_MODULE = $Module }
    $runName = 'harmonyos-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
    $artifactDirectory = Join-Path $artifactsRoot $runName
    $artifactDirectory = [IO.Path]::GetFullPath($artifactDirectory)
    $agentDirectory = if ($AgentRoot) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AgentRoot) } else { Join-Path $artifactsRoot 'agent' }
    $agentDirectory = [IO.Path]::GetFullPath($agentDirectory)
    # Keep the installed launcher's classpath, main class and default JVM option.
    # Start Java directly so cmd.exe and .bat do not re-parse Flow parameters.
    $arguments = [System.Collections.Generic.List[string]]::new()
    foreach ($value in @('--enable-native-access=ALL-UNNAMED', '-Dfile.encoding=UTF-8', '-classpath',
        (Join-Path $libraryDirectory '*'), 'maestro.cli.AppKt', '--platform', 'harmonyos')) {
        $arguments.Add($value)
    }
    if ($DeviceId) { $arguments.Add('--device'); $arguments.Add($DeviceId) }
    $arguments.Add('test')
    $arguments.Add('--test-output-dir')
    $arguments.Add($artifactDirectory)
    $arguments.Add('-e')
    $arguments.Add('APP_ID=' + $BundleId)
    foreach ($key in @($Env.Keys | Sort-Object)) {
        $arguments.Add('-e')
        $arguments.Add($key + '=' + [string]$Env[$key])
    }
    foreach ($value in @('--harmonyos-agent-output', $agentDirectory, '--harmonyos-run-id', $RunId,
        '--harmonyos-attempt-id', $AttemptId, '--harmonyos-attempt-no', [string]$AttemptNo)) { $arguments.Add($value) }
    $arguments.Add($resolvedFlow)

    # Windows JDK 17 can replace characters outside its native code page with '?'
    # before main(String[]) receives them. Reject that loss before starting Maestro.
    $launcherEncoding = Get-JavaLauncherEncoding $javaExecutable
    foreach ($value in $arguments) {
        if ($value.IndexOf([char]0) -ge 0) { throw 'Arguments cannot contain NUL.' }
        $preserved = $false
        try { $preserved = $launcherEncoding.GetString($launcherEncoding.GetBytes($value)) -ceq $value } catch [Text.EncoderFallbackException] { }
        if (-not $preserved) {
            throw ('Java launcher encoding ' + $launcherEncoding.WebName + ' cannot preserve a command-line value. Put this text directly in a UTF-8 YAML Flow instead of -Env. No device command was run.')
        }
    }
    $null = [IO.Directory]::CreateDirectory($artifactDirectory)
    $invocation = [ordered]@{
        runId = $RunId; attemptId = $AttemptId; attemptNo = $AttemptNo; cliExitCode = $null
        runResultPath = (Join-Path $agentDirectory ('runs/' + $RunId + '/' + $AttemptId + '/result.json'))
        agentStatus = 'pending'; reason = $null
    }
    [IO.File]::WriteAllText((Join-Path $artifactDirectory 'invocation.json'), ($invocation | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $controlPath = if ($ControlRecordPath) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ControlRecordPath) } else { Join-Path $artifactDirectory 'execution-control.json' }
    $controlPath = [IO.Path]::GetFullPath($controlPath)
    Assert-RunnerControlPath $controlPath
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($controlPath))
    if ([IO.File]::Exists($controlPath)) { throw 'ControlRecordPath already exists; each launch must use a new record.' }
    $argumentHasher = [Security.Cryptography.SHA256]::Create()
    try { $argumentHash = ([BitConverter]::ToString($argumentHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($arguments | ConvertTo-Json -Compress))))).Replace('-', '').ToLowerInvariant() } finally { $argumentHasher.Dispose() }
    $control = [ordered]@{
        protocol = 'maestro.harmonyos.runner-control'; schemaVersion = 1
        launchId = [guid]::NewGuid().ToString(); runId = $RunId; attemptId = $AttemptId; attemptNo = $AttemptNo
        deviceId = $DeviceId; createdAt = [DateTime]::UtcNow.ToString('o'); updatedAt = $null; phase = 'launching'
        artifactDirectory = $artifactDirectory; invocationPath = (Join-Path $artifactDirectory 'invocation.json'); runResultPath = $invocation.runResultPath
        executable = [IO.Path]::GetFullPath($javaExecutable); argumentsSha256 = $argumentHash
        process = $null; processExitObserved = $false; processExitCode = $null; wrapperExitCode = $null
        runTimeoutSeconds = $RunTimeoutSeconds; terminationWaitSeconds = $TerminationWaitSeconds; outputDrainSeconds = $OutputDrainSeconds
        terminationRequested = $false; terminationRequestedAt = $null; stopReason = $null
        stdoutComplete = $false; stderrComplete = $false; agentStatus = 'pending'; error = $null
        stdoutPath = (Join-Path $artifactDirectory 'stdout.log'); stderrPath = (Join-Path $artifactDirectory 'stderr.log')
    }
    Write-RunnerControl -Create
    $controlCreated = $true
    $stdoutLog = [IO.StreamWriter]::new($control.stdoutPath, $false, [Text.UTF8Encoding]::new($false))
    $stderrLog = [IO.StreamWriter]::new($control.stderrPath, $false, [Text.UTF8Encoding]::new($false))
    $stdoutLog.AutoFlush = $true
    $stderrLog.AutoFlush = $true
    Write-Output ('Artifacts: ' + $artifactDirectory)
    $runProcess = [Diagnostics.Process]::new()
    $runProcess.StartInfo.FileName = $javaExecutable
    if ($null -ne $runProcess.StartInfo.PSObject.Properties['ArgumentList']) {
        foreach ($value in $arguments) { $runProcess.StartInfo.ArgumentList.Add($value) }
    } else {
        $runProcess.StartInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    }
    $runProcess.StartInfo.WorkingDirectory = $projectRoot
    $runProcess.StartInfo.UseShellExecute = $false
    $runProcess.StartInfo.RedirectStandardOutput = $true
    $runProcess.StartInfo.RedirectStandardError = $true
    $runProcess.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $runProcess.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    $runProcess.StartInfo.CreateNoWindow = $true
    $runProcess.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $null = $runProcess.Start()
    # MainModule can still be null immediately after Start. Check it against this launch target when terminating.
    $processIdentity = [ordered]@{ pid = $runProcess.Id; startTimeTicks = $runProcess.StartTime.ToUniversalTime().Ticks; executable = $control.executable }
    $control.process = $processIdentity
    $control.phase = 'running'
    Write-RunnerControl
    $runClock = [Diagnostics.Stopwatch]::StartNew()
    $exitClock = $null
    $stdoutTask = $runProcess.StandardOutput.ReadLineAsync()
    $stderrTask = $runProcess.StandardError.ReadLineAsync()
    while ($true) {
        $outputWasReady = $false
        if ($null -ne $stdoutTask -and $stdoutTask.IsCompleted) {
            $outputWasReady = $true
            $line = $stdoutTask.GetAwaiter().GetResult()
            if ($null -eq $line) { $stdoutTask = $null; $control.stdoutComplete = $true } else {
                $stdoutLog.WriteLine($line)
                Write-Output $line
                $stdoutTask = $runProcess.StandardOutput.ReadLineAsync()
            }
        }
        if ($null -ne $stderrTask -and $stderrTask.IsCompleted) {
            $outputWasReady = $true
            $line = $stderrTask.GetAwaiter().GetResult()
            if ($null -eq $line) { $stderrTask = $null; $control.stderrComplete = $true } else {
                $stderrLog.WriteLine($line)
                [Console]::Error.WriteLine($line)
                $stderrTask = $runProcess.StandardError.ReadLineAsync()
            }
        }
        if ($runProcess.HasExited) {
            if ($null -eq $exitClock) {
                $exitClock = [Diagnostics.Stopwatch]::StartNew()
                $processExitCode = $runProcess.ExitCode
                $control.processExitObserved = $true
                $control.processExitCode = $processExitCode
            }
            if ($null -eq $stdoutTask -and $null -eq $stderrTask) { break }
            if ($exitClock.Elapsed.TotalSeconds -ge $OutputDrainSeconds) {
                if (-not $control.stopReason) { $control.stopReason = 'output_drain_timeout' }
                break
            }
        } elseif ($RunTimeoutSeconds -gt 0 -and $runClock.Elapsed.TotalSeconds -ge $RunTimeoutSeconds) {
            Stop-RunnerProcess 'run_timeout'
            if (-not $runProcess.HasExited) { break }
        }
        if (-not $outputWasReady) { Start-Sleep -Milliseconds 10 }
    }
    if ($null -ne $processExitCode) { $runExitCode = $processExitCode }
    if ($control.stopReason -or -not $control.processExitObserved) { $runExitCode = 1 }
} catch {
    if ($null -ne $control) { $control.error = $_.Exception.Message }
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
} finally {
    if ($null -ne $runProcess) {
        try {
            if (-not $runProcess.HasExited -and -not $control.terminationRequested) { Stop-RunnerProcess 'runner_error' }
            if ($runProcess.HasExited -and $null -ne $control) {
                $processExitCode = $runProcess.ExitCode
                $control.processExitObserved = $true
                $control.processExitCode = $processExitCode
            }
        } catch { if ($null -ne $control) { $control.error = $_.Exception.Message; $control.phase = 'unknown' } }
        $runProcess.Dispose()
    }
    if ($null -ne $stdoutLog) { $stdoutLog.Dispose() }
    if ($null -ne $stderrLog) { $stderrLog.Dispose() }
    if ($null -ne $invocation) {
        $invocation.cliExitCode = $runExitCode
        try {
            $summary = Get-Content -LiteralPath $invocation.runResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($summary.protocol -ne 'maestro.harmonyos.agent' -or $summary.schemaVersion -ne 1 -or $summary.kind -ne 'runResult' -or
                $summary.data.runId -cne $RunId -or $summary.data.attemptId -cne $AttemptId -or
                $summary.data.status -notin @('passed', 'failed', 'blocked', 'cancelled', 'unknown')) { throw 'No matching terminal agent result.' }
            if ($summary.data.status -eq 'passed' -and $runExitCode -ne 0) { throw 'CLI exit does not confirm the stored result for this invocation.' }
            $invocation.agentStatus = $summary.data.status
        } catch {
            $invocation.agentStatus = 'unknown'
            $invocation.reason = 'The CLI did not produce a matching terminal agent result. Inspect the retained artifacts; the exit code is preserved.'
        }
        [IO.File]::WriteAllText((Join-Path $artifactDirectory 'invocation.json'), ($invocation | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Write-Output ('Agent result: ' + $invocation.runResultPath + ' (' + $invocation.agentStatus + ')')
    }
    if ($controlCreated) {
        $control.wrapperExitCode = $runExitCode
        $control.agentStatus = $invocation.agentStatus
        $control.phase = if ($control.processExitObserved -and -not $control.stopReason -and -not $control.error) { 'exited' } else { 'unknown' }
        try { Write-RunnerControl } catch { Write-Error -Message ('Could not persist runner control: ' + $_.Exception.Message) -ErrorAction Continue; $runExitCode = 1 }
    }
    $currentEnvironment = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in $currentEnvironment.Keys) {
        if (-not $originalEnvironment.Contains($name)) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    }
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, [string]$originalEnvironment[$name], 'Process')
    }
    Set-Location -LiteralPath $originalLocation.Path
}
exit $runExitCode
