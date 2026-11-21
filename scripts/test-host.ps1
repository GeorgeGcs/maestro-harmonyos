[CmdletBinding()]
param(
    [switch]$Offline,
    [switch]$FullUpstream,
    [switch]$Orchestration
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This entry point currently supports Windows PowerShell only.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localConfig = Join-Path $projectRoot 'config.local.ps1'
if (Test-Path -LiteralPath $localConfig -PathType Leaf) { . $localConfig }

& (Join-Path $PSScriptRoot 'apply-upstream-patches.ps1')
$upstreamSpec = Get-Content -LiteralPath (Join-Path $projectRoot 'upstream.lock.json') -Raw | ConvertFrom-Json
$checkoutPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $upstreamSpec.checkoutPath))
$wrapper = Join-Path $checkoutPath 'gradlew.bat'
if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw 'The pinned upstream Gradle wrapper is missing.' }

if ($Orchestration -and -not $FullUpstream) { throw 'Orchestration tests require -FullUpstream.' }

$buildRoot = Join-Path $projectRoot 'host-tests'
$testTask = 'test'
if ($FullUpstream) {
    $buildRoot = $checkoutPath
    $testTask = ':maestro-client:test'
}
if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'build.gradle.kts') -PathType Leaf)) { throw 'The requested Gradle build is missing.' }

$savedGradleUserHome = $env:GRADLE_USER_HOME
try {
    $env:GRADLE_USER_HOME = Join-Path $projectRoot '.gradle-user-home'
    $gradleArguments = @('-p', $buildRoot, $testTask, '--tests', 'maestro.harmonyos.*', '--no-daemon', '--console=plain')
    if ($Orchestration) {
        $gradleArguments += @(':maestro-orchestra:test', '--tests', 'maestro.orchestra.debug.OrchestraListenerDispatchTest',
            '--tests', 'maestro.orchestra.debug.ScreenRecordingOutputTest', '--tests', 'maestro.orchestra.debug.ArtifactsGeneratorTest')
    }
    if ($Offline) { $gradleArguments += '--offline' }
    Push-Location -LiteralPath $checkoutPath
    try {
        & $wrapper @gradleArguments
        if ($LASTEXITCODE -ne 0) {
            $code = $LASTEXITCODE
            $details = foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $buildRoot 'build/test-results/test') -Filter 'TEST-*.xml' -File -ErrorAction SilentlyContinue)) {
                try {
                    [xml]$xml = Get-Content -LiteralPath $file.FullName -Raw
                    foreach ($failure in $xml.SelectNodes('//testcase/failure')) { [string]$failure.message }
                } catch { Write-Warning ('Cannot read test failure: ' + $file.Name) }
            }
            throw ('HarmonyOS host tests failed (Gradle exit code ' + $code + '). ' + (($details | Select-Object -First 4) -join ' | '))
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $savedGradleUserHome) {
        Remove-Item -LiteralPath Env:GRADLE_USER_HOME -ErrorAction SilentlyContinue
    } else {
        $env:GRADLE_USER_HOME = $savedGradleUserHome
    }
}
