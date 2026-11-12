#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$SuiteTemplate = $env:MAESTRO_CI_SUITE_TEMPLATE,
    [string]$DeviceId = $env:MAESTRO_CI_DEVICE_ID,
    [string]$DeviceStateDirectory = $env:MAESTRO_CI_DEVICE_STATE,
    [string]$RawArtifactsRoot = $env:MAESTRO_CI_RAW_ROOT,
    [string]$ReportDirectory = 'artifacts/ci-device-report',
    [ValidateRange(1, 604800)][int]$RunTimeoutSeconds = 900,
    [ValidateRange(1, 604800)][int]$JobTimeoutSeconds = 1200
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$reportDir = [IO.Path]::GetFullPath($ReportDirectory, $root)
$null = New-Item -ItemType Directory -Path $reportDir
$report = [ordered]@{ commit = $null; status = 'failed'; stage = 'preflight'; execution = 'unknown'; deviceRelease = 'unconfirmed'; quality = 'unknown' }
$jobExit = 1
try {
    if (!$IsWindows) { throw 'This device job requires a Windows runner.' }
    $report.commit = (& git -C $root rev-parse HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the source commit.' }
    if (!$SuiteTemplate -or !$DeviceId -or !$DeviceStateDirectory -or !$RawArtifactsRoot -or !$env:MAESTRO_HARMONYOS_HDC) {
        throw 'Configure the dedicated runner with suite, device, state, raw artifact and HDC settings.'
    }
    if (!(Test-Path -LiteralPath $env:MAESTRO_HARMONYOS_HDC -PathType Leaf)) { throw 'The configured HDC executable is missing.' }
    foreach ($directory in @($DeviceStateDirectory, $RawArtifactsRoot)) {
        if (![IO.Path]::IsPathFullyQualified($directory)) { throw 'Runner state and raw artifact paths must be absolute.' }
        $full = [IO.Path]::GetFullPath($directory).TrimEnd('\', '/')
        if ($full -eq $root -or $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Keep runner state and raw artifacts outside the checkout.'
        }
    }
    $rawRoot = [IO.Path]::GetFullPath($RawArtifactsRoot).TrimEnd('\', '/')
    $stateRoot = [IO.Path]::GetFullPath($DeviceStateDirectory).TrimEnd('\', '/')
    $separator = [IO.Path]::DirectorySeparatorChar
    if ($rawRoot -eq $stateRoot -or $rawRoot.StartsWith($stateRoot + $separator, [StringComparison]::OrdinalIgnoreCase) -or
        $stateRoot.StartsWith($rawRoot + $separator, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Keep the device state and raw artifact directories separate.'
    }
    $runKey = [guid]::NewGuid().ToString()
    $report.localRunKey = $runKey
    $privateRun = Join-Path $rawRoot $runKey
    $null = New-Item -ItemType Directory -Path $privateRun
    $template = [IO.Path]::GetFullPath($SuiteTemplate, $root)
    $templateDirectory = Split-Path -Parent $template
    $suite = Get-Content -LiteralPath $template -Raw | ConvertFrom-Json -AsHashtable
    if ($suite.schemaVersion -ne 2) { throw 'A v2 suite template is required.' }
    $suite.flowPath = [IO.Path]::GetFullPath($suite.flowPath, $templateDirectory)
    $suite.sourceRoot = [IO.Path]::GetFullPath($suite.sourceRoot, $templateDirectory)
    foreach ($flow in $suite.expectedFlows) { $flow.path = [IO.Path]::GetFullPath($flow.path, $templateDirectory) }
    if ($suite.applicationFile) { $suite.applicationFile.path = [IO.Path]::GetFullPath($suite.applicationFile.path, $templateDirectory) }
    if ($suite.videoPolicy) {
        $suite.videoPolicy.requiredFlows = @($suite.videoPolicy.requiredFlows | ForEach-Object { [IO.Path]::GetFullPath($_, $templateDirectory) })
        $suite.videoPolicy.ffmpeg.path = [IO.Path]::GetFullPath($suite.videoPolicy.ffmpeg.path, $templateDirectory)
    }
    $report.stage = 'snapshot'
    $snapshot = Join-Path $privateRun 'build-observed.json'
    & node (Join-Path $root 'scripts/ci/snapshot-build.mjs') $snapshot $root *> (Join-Path $privateRun 'snapshot.log')
    if ($LASTEXITCODE -ne 0) { throw 'Could not record the installed CLI. See the runner-local snapshot log.' }
    $suite.buildManifest = @{ path = $snapshot; sha256 = (Get-FileHash -LiteralPath $snapshot).Hash.ToLowerInvariant() }
    $manifest = Join-Path $privateRun 'suite.json'
    $suite | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM

    $report.stage = 'device-suite'
    $pwsh = (Get-Process -Id $PID).Path
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-device-suite.ps1') -SuiteManifest $manifest -DeviceId $DeviceId `
        -ArtifactsRoot $privateRun -DeviceStateDirectory $stateRoot -RunTimeoutSeconds $RunTimeoutSeconds `
        -JobTimeoutSeconds $JobTimeoutSeconds *> (Join-Path $privateRun 'device-suite.log')
    $jobExit = $LASTEXITCODE
    $report.exitCode = $jobExit
    $invocations = @(Get-ChildItem -LiteralPath $privateRun -Directory -Filter 'ci-*')
    if ($invocations.Count -eq 1) {
        $resultPath = Join-Path $invocations[0].FullName 'ci-result.json'
        if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
            $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
            $report.execution = $result.execution
            if ($result.state -eq 'released') { $report.deviceRelease = 'released' }
            if ($result.quality) { $report.quality = $result.quality.status }
            $qualityPath = Join-Path $invocations[0].FullName 'ci-quality.json'
            if (Test-Path -LiteralPath $qualityPath -PathType Leaf) {
                $quality = Get-Content -LiteralPath $qualityPath -Raw | ConvertFrom-Json
                if ($quality.junit) { $report.junit = @{ tests = [int]$quality.junit.tests; failures = [int]$quality.junit.failures } }
            }
        }
    }
    if ($jobExit -eq 0 -and $report.deviceRelease -eq 'released' -and $report.quality -eq 'passed') {
        $report.status = 'passed'
    } elseif ($jobExit -eq 0) { $jobExit = 1 }
} catch {
    Write-Host ('Device CI failed at stage: ' + $report.stage)
    $jobExit = 1
} finally {
    $report.exitCode = $jobExit
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDir 'device-job.json') -Encoding utf8NoBOM
    Write-Host ("Device CI: {0}; execution: {1}; release: {2}; local run: {3}" -f $report.status, $report.execution, $report.deviceRelease, $report.localRunKey)
}
exit $jobExit
