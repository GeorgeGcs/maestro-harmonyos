[CmdletBinding()]
param(
    [switch]$Offline,
    [switch]$FullUpstream
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
    if ($Offline) { $gradleArguments += '--offline' }
    Push-Location -LiteralPath $checkoutPath
    try {
        & $wrapper @gradleArguments
        if ($LASTEXITCODE -ne 0) { throw ('HarmonyOS host tests failed (Gradle exit code ' + $LASTEXITCODE + ').') }
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
