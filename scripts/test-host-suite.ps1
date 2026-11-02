#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('All', 'Jvm', 'Agent', 'Recovery', 'Scripts', 'Schemas', 'VSCode', 'ExtensionHost')]
    [string[]]$Group = @('All'),
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$NodePath = 'node',
    [string]$BashPath,
    [string]$CliDirectory,
    [string]$OriginalCliDirectory,
    [string]$GradleHome,
    [string]$GradleUserHome,
    [string]$SimulatorCache,
    [string]$TestTempDirectory,
    [string]$OutputDirectory,
    [string]$CodePath,
    [ValidateRange(1, 7200)][int]$StepTimeoutSeconds,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This host suite currently supports Windows only.' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command $NodePath -CommandType Application -ErrorAction Stop).Source
$shell = (Get-Process -Id $PID).Path
$arguments = @((Join-Path $PSScriptRoot 'host-suite/main.mjs'), '--project', $repository, '--powershell', $shell)
foreach ($name in $Group) { $arguments += @('--group', $name) }
$options = @{
    'java-home'=$JavaHome; bash=$BashPath; cli=$CliDirectory; 'original-cli'=$OriginalCliDirectory
    'gradle-home'=$GradleHome; 'gradle-user-home'=$GradleUserHome; 'simulator-cache'=$SimulatorCache
    'test-temp'=$TestTempDirectory; output=$OutputDirectory; code=$CodePath
}
foreach ($key in $options.Keys) { if ($options[$key]) { $arguments += @(('--' + $key), $options[$key]) } }
if ($CheckOnly) { $arguments += '--check-only' }
if ($StepTimeoutSeconds) { $arguments += @('--step-timeout-seconds', [string]$StepTimeoutSeconds) }
& $node @arguments
exit $LASTEXITCODE
