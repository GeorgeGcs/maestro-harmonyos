[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ControlPath,
    [ValidateLength(1, 1000)][string]$Reason = 'Operator requested stopping after the current round.'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'test-stop-control.ps1')
$request = Request-TestStop -ControlPath ([IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ControlPath))) -Reason $Reason
Write-Output ('Stop requested: ' + $request.path)
Write-Output 'The current round will finish normally. Later rounds will remain unexecuted; check the final report for cleanup and release.'
