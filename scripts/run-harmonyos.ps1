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
    [ValidateRange(1, 2147483647)][int]$AttemptNo = 1
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$originalLocation = Get-Location
$originalEnvironment = [Environment]::GetEnvironmentVariables('Process')
$runProcess = $null
$runExitCode = 1
$invocation = $null

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
    $stdoutTask = $runProcess.StandardOutput.ReadLineAsync()
    $stderrTask = $runProcess.StandardError.ReadLineAsync()
    while ($null -ne $stdoutTask -or $null -ne $stderrTask) {
        if ($null -ne $stdoutTask -and $stdoutTask.IsCompleted) {
            $line = $stdoutTask.GetAwaiter().GetResult()
            if ($null -eq $line) { $stdoutTask = $null } else {
                Write-Output $line
                $stdoutTask = $runProcess.StandardOutput.ReadLineAsync()
            }
        }
        if ($null -ne $stderrTask -and $stderrTask.IsCompleted) {
            $line = $stderrTask.GetAwaiter().GetResult()
            if ($null -eq $line) { $stderrTask = $null } else {
                [Console]::Error.WriteLine($line)
                $stderrTask = $runProcess.StandardError.ReadLineAsync()
            }
        }
        if ($null -ne $stdoutTask -or $null -ne $stderrTask) { Start-Sleep -Milliseconds 10 }
    }
    $runProcess.WaitForExit()
    $runExitCode = $runProcess.ExitCode
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
} finally {
    if ($null -ne $runProcess) {
        try {
            if (-not $runProcess.HasExited) { $runProcess.Kill(); $null = $runProcess.WaitForExit(5000) }
        } catch { }
        $runProcess.Dispose()
    }
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
