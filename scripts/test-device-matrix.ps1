[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$FlowPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$BundleId,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AbilityName,
    [Alias('ModuleName')][string]$Module,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string[]]$DeviceIds,
    [hashtable]$Env = @{},
    [Alias('ArtifactsRoot')][string]$Artifacts,
    [ValidateRange(1, 1000)][int]$Repeat = 1,
    [ValidateRange(1, 60)][int]$ProbeTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$originalEnvironment = [Environment]::GetEnvironmentVariables('Process')
$originalLocation = Get-Location
$utf8 = [Text.UTF8Encoding]::new($false)
$report = $null
$matrixDirectory = $null
$matrixExit = 1

function Get-MatrixTimestamp { return [DateTimeOffset]::UtcNow.ToString('o') }

function ConvertTo-MatrixArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.IndexOf([char]0) -ge 0) { throw 'Arguments cannot contain NUL.' }
    $quoted = [Text.StringBuilder]::new()
    $null = $quoted.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++ } else {
            $count = if ($character -eq '"') { $slashes * 2 + 1 } else { $slashes }
            if ($count -gt 0) { $null = $quoted.Append('\', $count) }
            $null = $quoted.Append($character)
            $slashes = 0
        }
    }
    if ($slashes -gt 0) { $null = $quoted.Append('\', $slashes * 2) }
    $null = $quoted.Append('"')
    return $quoted.ToString()
}

function Invoke-MatrixNative {
    param([string]$Executable, [string[]]$Arguments)
    $process = [Diagnostics.Process]::new()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $process.StartInfo.FileName = $Executable
        if ($null -ne $process.StartInfo.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
        } else {
            $process.StartInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-MatrixArgument $_ }) -join ' '
        }
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $process.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($ProbeTimeoutSeconds * 1000)) { throw 'Probe timed out.' }
        $remaining = [Math]::Max(0, $ProbeTimeoutSeconds * 1000 - [int]$timer.ElapsedMilliseconds)
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), $remaining)) { throw 'Probe timed out while reading output.' }
        $outputText = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        if ($outputText.Length -gt 4MB -or $errorText.Length -gt 4MB) { throw 'Probe output exceeded the 4 MiB character limit.' }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $outputText; Stderr = $errorText; Error = $null }
    } catch {
        return [pscustomobject]@{ ExitCode = $null; Stdout = ''; Stderr = ''; Error = $_.Exception.Message }
    } finally {
        try { if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(2000) } } catch { }
        try { $process.StandardOutput.Close() } catch { }
        try { $process.StandardError.Close() } catch { }
        $process.Dispose()
    }
}

function Get-MatrixTargets {
    $result = Invoke-MatrixNative $hdc @('list', 'targets')
    $report.discoveryProbes += [ordered]@{ at = Get-MatrixTimestamp; result = $result }
    if ($result.Error -or $result.ExitCode -ne 0 -or $result.Stderr.Trim()) { throw 'HDC device discovery failed; see the probe result.' }
    $lines = @($result.Stdout -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -eq 0 -or ($lines.Count -eq 1 -and $lines[0] -eq '[Empty]')) { return @() }
    foreach ($line in $lines) {
        if ($line -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$' -or $line -match '^(error|fail|failed|warning|usage|help|hdc)$') {
            throw 'Unexpected HDC device-list output; no device was selected.'
        }
    }
    return $lines
}

function Invoke-MatrixShell {
    param([string]$Target, [string[]]$Arguments)
    $marker = 'MATRIX_EXIT_' + [guid]::NewGuid().ToString('N') + '='
    $quoted = @($Arguments | ForEach-Object { "'" + $_.Replace("'", "'`"'`"'") + "'" })
    $command = ($quoted -join ' ') + '; matrix_status=$?; printf ''\n' + $marker + '%s\n'' "$matrix_status"; exit "$matrix_status"'
    $result = Invoke-MatrixNative $hdc @('-t', $Target, 'shell', $command)
    if ($result.Error -or $result.ExitCode -ne 0 -or $result.Stderr.Trim()) {
        return [pscustomobject]@{ status = 'unknown'; value = $null; reason = 'Host command failed or returned diagnostics.'; output = $result.Stdout; diagnostics = $result.Stderr; error = $result.Error }
    }
    $lines = @($result.Stdout.TrimEnd() -split '\r?\n')
    $match = [regex]::Match($lines[-1], '^' + [regex]::Escape($marker) + '([0-9]+)$')
    $output = if ($lines.Count -gt 1) { ($lines[0..($lines.Count - 2)] -join "`n").Trim() } else { '' }
    if (-not $match.Success -or $match.Groups[1].Value -ne '0' -or $output -match '(?im)^\s*(?:\[\s*(?:fail|error)\s*\]|error:|failed:)' -or -not $output) {
        return [pscustomobject]@{ status = 'unknown'; value = $null; reason = 'No confirmed successful device response.'; output = $output; diagnostics = $result.Stderr; error = $null }
    }
    return [pscustomobject]@{ status = 'observed'; value = $output; reason = $null; output = $output; diagnostics = ''; error = $null }
}

function Get-MatrixDeviceInfo {
    param([string]$Target)
    $model = Invoke-MatrixShell $Target @('param', 'get', 'const.product.model')
    $system = Invoke-MatrixShell $Target @('param', 'get', 'const.ohos.fullname')
    $api = Invoke-MatrixShell $Target @('param', 'get', 'const.ohos.apiversion')
    if ($api.status -eq 'observed' -and $api.value -notmatch '^[0-9]+$') { $api.status = 'unknown'; $api.reason = 'API response was not an integer.'; $api.value = $null }
    $uitest = Invoke-MatrixShell $Target @('which', 'uitest')
    $media = Invoke-MatrixShell $Target @('which', 'mediatool')
    $recorder = Invoke-MatrixShell $Target @('bm', 'dump', '-n', 'com.huawei.hmos.screenrecorder')
    $basicStatus = if ($uitest.status -eq 'observed' -and $uitest.value -match '^/[^\r\n]+/uitest$') { 'available-unverified' } else { 'unknown' }
    $recordingStatus = if ($media.status -eq 'observed' -and $media.value -match '^/[^\r\n]+/mediatool$' -and $recorder.status -eq 'observed' -and $recorder.value.Contains('com.huawei.hmos.screenrecorder.ServiceExtAbility')) { 'available-unverified' } else { 'unknown' }
    return [ordered]@{
        model = $model; system = $system; api = $api
        capabilities = [ordered]@{
            basic = [ordered]@{ status = $basicStatus; note = 'Tool presence only; actual operations are established by Flow results.'; uitest = $uitest }
            recording = [ordered]@{ status = $recordingStatus; note = 'Service/tool presence only. This probe never starts recording or verifies video decoding.'; mediaTool = $media; service = $recorder }
        }
    }
}

function Get-MatrixScreen {
    param([string]$Directory)
    # Read dimensions from an actual CLI artifact, without another device operation.
    foreach ($png in @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter '*.png' -ErrorAction SilentlyContinue | Sort-Object FullName)) {
        $stream = $null
        try {
            $stream = [IO.File]::OpenRead($png.FullName)
            $header = New-Object byte[] 24
            if ($stream.Read($header, 0, 24) -ne 24) { continue }
            if ([BitConverter]::ToString($header, 0, 8) -ne '89-50-4E-47-0D-0A-1A-0A' -or [Text.Encoding]::ASCII.GetString($header, 12, 4) -ne 'IHDR') { continue }
            [long]$width = $header[16] * 16777216L + $header[17] * 65536L + $header[18] * 256L + $header[19]
            [long]$height = $header[20] * 16777216L + $header[21] * 65536L + $header[22] * 256L + $header[23]
            if ($width -gt 0 -and $height -gt 0) { return [ordered]@{ status = 'observed'; width = $width; height = $height; source = $png.FullName; note = 'PNG artifact dimensions; no orientation or physical-display compatibility claim.' } }
        } catch { } finally { if ($null -ne $stream) { $stream.Dispose() } }
    }
    return [ordered]@{ status = 'unknown'; width = $null; height = $null; source = $null; note = 'No readable PNG artifact was produced.' }
}

function ConvertTo-MatrixMarkdown {
    param($Value)
    return ([string]$Value).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
}

function Read-MatrixAgentResult {
    param($Run)
    $document = Get-Content -LiteralPath $Run.runResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $data = $document.data
    if ($document.protocol -ne 'maestro.harmonyos.agent' -or $document.schemaVersion -ne 1 -or $document.kind -ne 'runResult' -or
        $data.runId -cne $Run.runId -or $data.attemptId -cne $Run.attemptId -or $data.attemptNo -ne $Run.round -or
        $data.deviceId -cne $Run.deviceId -or
        $data.status -notin @('passed', 'failed', 'blocked', 'cancelled', 'unknown') -or -not $data.endedAt) {
        throw 'The agent result does not confirm a terminal outcome for this attempt.'
    }
    if ($data.status -eq 'passed' -and ($null -ne $data.error -or $Run.cliExitCode -ne 0)) {
        throw 'Agent result and CLI exit disagree; inspect the retained artifacts.'
    }
    if ($data.status -ne 'passed' -and $null -eq $data.error) { throw 'The unsuccessful agent result has no typed error.' }
    $Run.agentStatus = $data.status
    $Run.agentError = $data.error
    $Run.cleanup = $data.cleanup
    $Run.effects = $data.effects
    $Run.evidenceIndexPath = $data.artifacts.evidenceIndexPath
    return $data
}

function Write-MatrixText {
    param([string]$Path, [string]$Text)
    $temporaryPath = $Path + '.tmp'
    [IO.File]::WriteAllText($temporaryPath, $Text, $utf8)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $previousPath = $Path + '.previous'
        [IO.File]::Replace($temporaryPath, $Path, $previousPath)
        [IO.File]::Delete($previousPath)
    } else { [IO.File]::Move($temporaryPath, $Path) }
}

function Write-MatrixReport {
    $report.summary = [ordered]@{
        planned = $report.runs.Count
        passed = @($report.runs | Where-Object { $_.status -eq 'passed' }).Count
        failed = @($report.runs | Where-Object { $_.status -eq 'failed' }).Count
        blocked = @($report.runs | Where-Object { $_.status -eq 'blocked' }).Count
        cancelled = @($report.runs | Where-Object { $_.status -eq 'cancelled' }).Count
        unknown = @($report.runs | Where-Object { $_.status -eq 'unknown' }).Count
        notRun = @($report.runs | Where-Object { $_.status -eq 'not-run' }).Count
        running = @($report.runs | Where-Object { $_.status -eq 'running' }).Count
        pending = @($report.runs | Where-Object { $_.status -eq 'pending' }).Count
    }
    $report.summary.passRate = if ($report.runs.Count) { $report.summary.passed / [double]$report.runs.Count } else { 0.0 }
    Write-MatrixText (Join-Path $matrixDirectory 'matrix.json') ($report | ConvertTo-Json -Depth 24)
    $markdown = [Collections.Generic.List[string]]::new()
    $markdown.Add('# HarmonyOS device matrix')
    $markdown.Add('')
    $markdown.Add('Status: ' + $report.status + '. Planned: ' + $report.summary.planned + '; passed: ' + $report.summary.passed + '; failed: ' + $report.summary.failed + '; blocked: ' + $report.summary.blocked + '; cancelled: ' + $report.summary.cancelled + '; unknown: ' + $report.summary.unknown + '; not run: ' + $report.summary.notRun + '.')
    $markdown.Add('')
    $markdown.Add('Every row is a planned invocation, not an automatic retry. Manual intervention is unknown until reviewed. Unsupported or unexecuted work is never counted as passed. A successful Flow does not establish support for commands it did not run.')
    $markdown.Add('')
    $markdown.Add('| Device | Round | Result | CLI exit | Started (UTC) | Finished (UTC) | Reason | Artifacts |')
    $markdown.Add('| --- | --- | --- | --- | --- | --- | --- | --- |')
    foreach ($run in $report.runs) {
        $fields = @($run.deviceKey, $run.round, $run.status, $run.cliExitCode, $run.startedAt, $run.finishedAt, $run.reason, $run.artifactDirectory) | ForEach-Object { ConvertTo-MatrixMarkdown $_ }
        $markdown.Add('| ' + ($fields -join ' | ') + ' |')
    }
    $markdown.Add('')
    $markdown.Add('Device identifiers, probe evidence, input hashes and tool/build information are in matrix.json. Review all artifacts before sharing them.')
    Write-MatrixText (Join-Path $matrixDirectory 'matrix.md') ($markdown -join "`n")
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This entry point currently supports Windows PowerShell only.' }
    $localConfig = Join-Path $projectRoot 'config.local.ps1'
    if (Test-Path -LiteralPath $localConfig -PathType Leaf) { . $localConfig }
    $flowItem = Get-Item -LiteralPath $FlowPath
    if ($flowItem.PSProvider.Name -ne 'FileSystem') { throw 'FlowPath must be a local file or directory.' }
    if ([string]::IsNullOrWhiteSpace($BundleId) -or [string]::IsNullOrWhiteSpace($AbilityName)) { throw 'BundleId and AbilityName must not be blank.' }
    if ($PSBoundParameters.ContainsKey('Module') -and [string]::IsNullOrWhiteSpace($Module)) { throw 'Module must not be blank when supplied.' }
    foreach ($key in $Env.Keys) {
        if ($key -isnot [string] -or $key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $key -ieq 'APP_ID' -or $null -eq $Env[$key]) { throw 'Env requires named values and must not override APP_ID; use BundleId.' }
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($target in $DeviceIds) {
        if ($target -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$' -or -not $seen.Add($target)) { throw 'DeviceIds must contain distinct HDC target identifiers.' }
    }
    if (-not $DeviceIds.Count) { throw 'Specify at least one device.' }
    $runner = Join-Path $projectRoot 'scripts/run-harmonyos.ps1'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'run-harmonyos.ps1 is missing.' }
    $hdc = if ($env:MAESTRO_HARMONYOS_HDC) { $env:MAESTRO_HARMONYOS_HDC } else { (Get-Command hdc -CommandType Application -ErrorAction Stop).Source }
    if (-not (Test-Path -LiteralPath $hdc -PathType Leaf) -or [IO.Path]::GetExtension($hdc) -ine '.exe') { throw 'HDC must point to a native .exe file.' }
    $artifactsRoot = if ($Artifacts) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Artifacts) } else { Join-Path $projectRoot 'artifacts/device-matrix' }
    $matrixDirectory = Join-Path $artifactsRoot ('matrix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    $agentDirectory = Join-Path $matrixDirectory 'agent'
    $null = [IO.Directory]::CreateDirectory($matrixDirectory)
    $flowFiles = if ($flowItem.PSIsContainer) { @(Get-ChildItem -LiteralPath $flowItem.FullName -Recurse -File | Where-Object { $_.Extension -in @('.yaml', '.yml', '.js') } | Sort-Object FullName) } else { @($flowItem) }
    $hashes = @($flowFiles | ForEach-Object { [ordered]@{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
    $upstreamFile = Join-Path $projectRoot 'upstream.lock.json'
    $upstreamCommit = if (Test-Path -LiteralPath $upstreamFile) { (Get-Content -LiteralPath $upstreamFile -Raw -Encoding UTF8 | ConvertFrom-Json).commit } else { $null }
    $patchFile = Join-Path $projectRoot 'patches/maestro/0001-harmonyos-host.patch'
    $patchHash = if (Test-Path -LiteralPath $patchFile) { (Get-FileHash -LiteralPath $patchFile -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
    $commit = if ($git) { Invoke-MatrixNative $git.Source @('-C', $projectRoot, 'rev-parse', 'HEAD') } else { $null }
    $dirty = if ($git) { Invoke-MatrixNative $git.Source @('-C', $projectRoot, 'status', '--porcelain') } else { $null }
    $java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/java.exe' } else { (Get-Command java -CommandType Application -ErrorAction SilentlyContinue).Source }
    $javaVersion = if ($java) { Invoke-MatrixNative $java @('-version') } else { $null }
    $cliLibraries = Join-Path $projectRoot '.upstream/maestro/maestro-cli/build/install/maestro/lib'
    $implementationJars = @(Get-ChildItem -LiteralPath $cliLibraries -Filter '*.jar' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^maestro-(?:cli|client|orchestra(?:-models)?)-.*\.jar$' } | Sort-Object Name | ForEach-Object { [ordered]@{ file = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
    $report = [ordered]@{
        schemaVersion = 1; status = 'running'; startedAt = Get-MatrixTimestamp; finishedAt = $null; error = $null
        host = [ordered]@{ os = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString(); javaVersion = $javaVersion; hdcVersion = (Invoke-MatrixNative $hdc @('-v')) }
        build = [ordered]@{ projectCommit = $commit; workingTree = $dirty; upstreamCommit = $upstreamCommit; patchSha256 = $patchHash; implementationJars = $implementationJars }
        input = [ordered]@{ flowPath = $flowItem.FullName; files = $hashes; bundleId = $BundleId; abilityName = $AbilityName; moduleName = $Module; environmentKeys = @($Env.Keys | Sort-Object); repeat = $Repeat; recordingBackend = $env:MAESTRO_HARMONYOS_RECORDING; manualIntervention = 'unknown' }
        devices = @(); runs = @(); summary = $null; discoveryProbes = @()
    }
    for ($deviceIndex = 0; $deviceIndex -lt $DeviceIds.Count; $deviceIndex++) {
        $key = 'device-' + ($deviceIndex + 1).ToString('00')
        $logicalRunId = [guid]::NewGuid().ToString()
        $report.devices += [ordered]@{ key = $key; id = $DeviceIds[$deviceIndex]; info = $null; runId = $logicalRunId }
        for ($round = 1; $round -le $Repeat; $round++) {
            $report.runs += [ordered]@{ deviceKey = $key; round = $round; status = 'pending'; startedAt = $null; finishedAt = $null; cliExitCode = $null; reason = $null; manualIntervention = 'unknown'; artifactDirectory = (Join-Path $matrixDirectory ($key + '/round-' + $round.ToString('000'))); log = $null; screen = $null
                runId = $logicalRunId; attemptId = [guid]::NewGuid().ToString(); deviceId = $DeviceIds[$deviceIndex]; agentStatus = $null; agentError = $null; runResultPath = $null; evidenceIndexPath = $null; cleanup = $null; effects = $null }
            $report.runs[-1].runResultPath = Join-Path $agentDirectory ('runs/' + $logicalRunId + '/' + $report.runs[-1].attemptId + '/result.json')
        }
    }
    Write-Output ('Matrix artifacts: ' + $matrixDirectory)
    Write-MatrixReport
    foreach ($device in $report.devices) {
        $deviceUnavailable = $null
        foreach ($run in @($report.runs | Where-Object { $_.deviceKey -eq $device.key })) {
            if (-not $deviceUnavailable) {
                try {
                    $targets = @(Get-MatrixTargets)
                    if ($targets -cnotcontains $device.id) { $deviceUnavailable = 'The selected device is not connected. Remaining rounds for this device were not run.' }
                } catch { $deviceUnavailable = $_.Exception.Message }
            }
            if ($deviceUnavailable) {
                $run.status = 'not-run'; $run.reason = $deviceUnavailable; $run.finishedAt = Get-MatrixTimestamp
                Write-MatrixReport
                continue
            }
            if ($null -eq $device.info) { $device.info = Get-MatrixDeviceInfo $device.id }
            $null = [IO.Directory]::CreateDirectory($run.artifactDirectory)
            $run.log = Join-Path $run.artifactDirectory 'runner.log'
            $run.status = 'running'; $run.startedAt = Get-MatrixTimestamp
            Write-MatrixReport
            $parameters = @{ FlowPath = $flowItem.FullName; BundleId = $BundleId; AbilityName = $AbilityName; DeviceId = $device.id; Env = $Env; Artifacts = $run.artifactDirectory; AgentRoot = $agentDirectory; RunId = $run.runId; AttemptId = $run.attemptId; AttemptNo = $run.round }
            if ($PSBoundParameters.ContainsKey('Module')) { $parameters.Module = $Module }
            try {
                $global:LASTEXITCODE = $null
                & $runner @parameters *> $run.log
                $run.cliExitCode = $LASTEXITCODE
                if ($null -eq $run.cliExitCode) { throw 'The runner did not report an exit code.' }
                $agentResult = Read-MatrixAgentResult $run
                $run.status = $agentResult.status
                if ($null -ne $agentResult.error) { $run.reason = $agentResult.error.kind + '/' + $agentResult.error.code + ': ' + $agentResult.error.message }
                if ($agentResult.cleanup.state -ne 'complete' -or $agentResult.status -eq 'unknown') {
                    $deviceUnavailable = 'The previous attempt did not confirm safe handoff. Remaining rounds require device/session inspection and were not run.'
                }
            } catch [OperationCanceledException] { throw } catch {
                $run.status = 'unknown'; $run.agentStatus = 'unknown'; $run.reason = $_.Exception.Message
                $deviceUnavailable = 'The previous invocation has no confirmed outcome and cleanup. Remaining rounds were not run.'
            } finally {
                $run.finishedAt = Get-MatrixTimestamp
                $screenDirectory = Split-Path -Parent $run.runResultPath
                $run.screen = Get-MatrixScreen $(if (Test-Path -LiteralPath $screenDirectory -PathType Container) { $screenDirectory } else { $run.artifactDirectory })
                Write-MatrixReport
            }
        }
    }
    $report.status = 'completed'
    $matrixExit = if (@($report.runs | Where-Object { $_.status -ne 'passed' }).Count -eq 0) { 0 } else { 1 }
} catch {
    if ($null -ne $report) { $report.error = $_.Exception.Message; $report.status = 'interrupted' }
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
} finally {
    if ($null -ne $report) {
        foreach ($run in $report.runs) {
            if ($run.status -eq 'running') {
                $run.status = 'unknown'; $run.agentStatus = 'unknown'; $run.reason = 'Matrix execution was interrupted while this round was running; its outcome is unknown.'; $run.finishedAt = Get-MatrixTimestamp
            } elseif ($run.status -eq 'pending') {
                $run.status = 'not-run'; $run.reason = 'Matrix execution was interrupted before this round started.'; $run.finishedAt = Get-MatrixTimestamp
            }
        }
        $report.finishedAt = Get-MatrixTimestamp
        try { Write-MatrixReport } catch { $matrixExit = 1; Write-Error -Message $_.Exception.Message -ErrorAction Continue }
    }
    $currentEnvironment = [Environment]::GetEnvironmentVariables('Process')
    foreach ($name in $currentEnvironment.Keys) {
        if (-not $originalEnvironment.Contains($name)) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    }
    foreach ($name in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, [string]$originalEnvironment[$name], 'Process') }
    Set-Location -LiteralPath $originalLocation.Path
}
exit $matrixExit
