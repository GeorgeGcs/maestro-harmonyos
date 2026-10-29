[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$FfmpegPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$resultDirectory = Join-Path $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory) ('recording-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($resultDirectory)
$reportPath = Join-Path $resultDirectory 'verification.json'
$report = [ordered]@{
    protocol = 'maestro.harmonyos.recording-verification'; schemaVersion = 1
    status = 'failed'; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); endedAt = $null
    inputPath = $null; inputSha256 = $null; inputSha256After = $null; bytes = $null
    decoderPath = $null; decoderSha256 = $null; decoderVersion = $null
    timeoutSeconds = $TimeoutSeconds; arguments = @(); exitCode = $null; timedOut = $false
    frames = 0; progressEnded = $false; error = $null
    stdout = 'decode.stdout.log'; stderr = 'decode.stderr.log'
}

function ConvertTo-DecoderArgument {
    param([string]$Value)
    if ($Value.IndexOf([char]0) -ge 0) { throw 'Arguments cannot contain NUL.' }
    $text = [Text.StringBuilder]::new(); $null = $text.Append('"'); $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        $count = if ($character -eq '"') { 2 * $slashes + 1 } else { $slashes }
        if ($count) { $null = $text.Append('\', $count) }
        $null = $text.Append($character); $slashes = 0
    }
    if ($slashes) { $null = $text.Append('\', 2 * $slashes) }
    $null = $text.Append('"'); return $text.ToString()
}

function Invoke-Decoder {
    param([string[]]$Arguments, [int]$BudgetSeconds)
    $process = [Diagnostics.Process]::new()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $outText = [Text.StringBuilder]::new(); $errText = [Text.StringBuilder]::new()
    $failure = $null; $timedOut = $false; $exitCode = $null
    try {
        $process.StartInfo.FileName = $report.decoderPath
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $process.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
        if ($null -ne $process.StartInfo.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $Arguments) { $process.StartInfo.ArgumentList.Add($argument) }
        } else { $process.StartInfo.Arguments = ($Arguments | ForEach-Object { ConvertTo-DecoderArgument $_ }) -join ' ' }
        $null = $process.Start()
        $outBuffer = New-Object char[] 4096; $errBuffer = New-Object char[] 4096
        $outRead = $process.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)
        $errRead = $process.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length)
        while ($true) {
            if ($timer.Elapsed.TotalSeconds -ge $BudgetSeconds) { $timedOut = $true; throw 'Decoder time budget exceeded.' }
            if ($null -ne $outRead -and $outRead.IsCompleted) {
                $count = $outRead.GetAwaiter().GetResult()
                if ($count -eq 0) { $outRead = $null } else {
                    if ($outText.Length + $count -gt 1MB) { throw 'Decoder stdout exceeded 1 MiB characters.' }
                    $null = $outText.Append($outBuffer, 0, $count)
                    $outRead = $process.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)
                }
            }
            if ($null -ne $errRead -and $errRead.IsCompleted) {
                $count = $errRead.GetAwaiter().GetResult()
                if ($count -eq 0) { $errRead = $null } else {
                    if ($errText.Length + $count -gt 1MB) { throw 'Decoder stderr exceeded 1 MiB characters.' }
                    $null = $errText.Append($errBuffer, 0, $count)
                    $errRead = $process.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length)
                }
            }
            if ($process.HasExited -and $null -eq $outRead -and $null -eq $errRead) { $exitCode = $process.ExitCode; break }
            Start-Sleep -Milliseconds 10
        }
    } catch { $failure = $_.Exception.Message } finally {
        try {
            if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(2000) }
            if ($process.HasExited) { $exitCode = $process.ExitCode }
        } catch { if (-not $failure) { $failure = $_.Exception.Message } }
        try { $process.StandardOutput.Close() } catch { }
        try { $process.StandardError.Close() } catch { }
        $process.Dispose()
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Stdout = $outText.ToString(); Stderr = $errText.ToString(); Error = $failure; TimedOut = $timedOut }
}

$verificationExit = 1
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This entry point currently supports Windows.' }
    $inputFile = Get-Item -LiteralPath $InputPath
    $decoder = Get-Item -LiteralPath $FfmpegPath
    if ($inputFile.PSIsContainer -or $inputFile.PSProvider.Name -ne 'FileSystem' -or $inputFile.Length -eq 0) { throw 'Input must be a nonempty local file.' }
    if ($decoder.PSIsContainer -or $decoder.PSProvider.Name -ne 'FileSystem' -or $decoder.Extension -ine '.exe') { throw 'FfmpegPath must identify a native executable.' }
    $report.inputPath = $inputFile.FullName; $report.bytes = $inputFile.Length
    $report.decoderPath = $decoder.FullName
    $report.inputSha256 = (Get-FileHash -LiteralPath $inputFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.decoderSha256 = (Get-FileHash -LiteralPath $decoder.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $version = Invoke-Decoder @('-version') 10
    [IO.File]::WriteAllText((Join-Path $resultDirectory 'version.log'), $version.Stdout + $version.Stderr, $utf8)
    if ($version.Error -or $version.ExitCode -ne 0 -or $version.Stdout -notmatch '^ffmpeg version ') { throw 'Could not confirm FFmpeg version; see version.log.' }
    $report.decoderVersion = ($version.Stdout -split '\r?\n')[0]
    $report.arguments = @('-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', $inputFile.FullName,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-enc_time_base', '-1', '-progress', 'pipe:1', '-nostats', '-f', 'null', 'NUL')
    $decoded = Invoke-Decoder $report.arguments $TimeoutSeconds
    [IO.File]::WriteAllText((Join-Path $resultDirectory $report.stdout), $decoded.Stdout, $utf8)
    [IO.File]::WriteAllText((Join-Path $resultDirectory $report.stderr), $decoded.Stderr, $utf8)
    $report.exitCode = $decoded.ExitCode; $report.timedOut = $decoded.TimedOut
    foreach ($match in [regex]::Matches($decoded.Stdout, '(?m)^frame=\s*([0-9]+)\s*$')) {
        $report.frames = [Math]::Max([long]$report.frames, [long]$match.Groups[1].Value)
    }
    $report.progressEnded = [regex]::IsMatch($decoded.Stdout, '(?m)^progress=end\s*$')
    $report.inputSha256After = (Get-FileHash -LiteralPath $inputFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($decoded.Error) { throw $decoded.Error }
    if ($decoded.ExitCode -ne 0 -or $decoded.Stderr.Trim()) { throw 'Full video decode failed; see decode.stderr.log.' }
    if (-not $report.progressEnded -or $report.frames -le 0) { throw 'Decoder did not confirm completed decoding of any video frames.' }
    if ($report.inputSha256 -cne $report.inputSha256After) { throw 'Input changed during verification.' }
    $report.status = 'passed'; $verificationExit = 0
} catch { $report.error = $_.Exception.Message } finally {
    $report.endedAt = [DateTimeOffset]::UtcNow.ToString('o')
    foreach ($name in @($report.stdout, $report.stderr)) {
        $logPath = Join-Path $resultDirectory $name
        if (-not (Test-Path -LiteralPath $logPath)) { [IO.File]::WriteAllText($logPath, '', $utf8) }
    }
    $temporary = Join-Path $resultDirectory 'verification.pending.json'
    [IO.File]::WriteAllText($temporary, ($report | ConvertTo-Json -Depth 8), $utf8)
    [IO.File]::Move($temporary, $reportPath)
    Write-Output ('Recording verification: ' + $report.status + '; report: ' + $reportPath)
}
exit $verificationExit
