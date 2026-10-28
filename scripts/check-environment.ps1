[CmdletBinding()]
param([string]$HdcPath)

$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()

function Read-ToolVersion {
    param([string]$Executable, [string]$VersionArgument)
    $versionProcess = [System.Diagnostics.Process]::new()
    $versionProcess.StartInfo.FileName = $Executable
    $versionProcess.StartInfo.Arguments = $VersionArgument
    $versionProcess.StartInfo.UseShellExecute = $false
    $versionProcess.StartInfo.CreateNoWindow = $true
    $versionProcess.StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $versionProcess.StartInfo.RedirectStandardOutput = $true
    $versionProcess.StartInfo.RedirectStandardError = $true
    try {
        $null = $versionProcess.Start()
        $outputTask = $versionProcess.StandardOutput.ReadToEndAsync()
        $errorTask = $versionProcess.StandardError.ReadToEndAsync()
        if (-not $versionProcess.WaitForExit(8000)) {
            try { $versionProcess.Kill() } catch { }
            return [pscustomobject]@{ Success = $false; Output = 'Version probe timed out after 8 seconds' }
        }
        if (-not $outputTask.Wait(1000) -or -not $errorTask.Wait(1000)) {
            return [pscustomobject]@{ Success = $false; Output = 'Version output did not close in time' }
        }
        $versionText = ($outputTask.Result + $errorTask.Result).Trim()
        return [pscustomobject]@{ Success = ($versionProcess.ExitCode -eq 0); Output = $versionText }
    } catch {
        return [pscustomobject]@{ Success = $false; Output = 'Could not execute the version probe' }
    } finally {
        $versionProcess.Dispose()
    }
}

foreach ($toolName in @('git', 'java', 'node')) {
    $toolCommand = Get-Command $toolName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $toolState = 'MISSING'
    $toolDetail = 'Not found in PATH'
    if ($toolCommand) {
        $toolState = 'OK'
        $toolDetail = $toolCommand.Source
        if ($toolName -eq 'java') {
            $versionResult = Read-ToolVersion -Executable $toolCommand.Source -VersionArgument '-version'
            $versionOutput = $versionResult.Output
            $versionMatch = [regex]::Match($versionOutput, '"(?:1\.)?(\d+)[.\-"]')
            if (-not $versionResult.Success -or -not $versionMatch.Success -or [int]$versionMatch.Groups[1].Value -lt 17) {
                $toolState = 'CHECK_JDK_17_PLUS'
            }
            $toolDetail = ($versionOutput -split '\r?\n')[0]
        } elseif ($toolName -eq 'node') {
            $versionResult = Read-ToolVersion -Executable $toolCommand.Source -VersionArgument '--version'
            if (-not $versionResult.Success) { $toolState = 'ERROR' }
            $toolDetail = $versionResult.Output
        }
    }
    $checks.Add([pscustomobject]@{ Tool = $toolName; Status = $toolState; Detail = $toolDetail })
}

if ($HdcPath) {
    $hdcAvailable = Test-Path -LiteralPath $HdcPath -PathType Leaf
    $hdcLocation = $HdcPath
} else {
    $hdcCommand = Get-Command hdc -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $hdcAvailable = $null -ne $hdcCommand
    $hdcLocation = if ($hdcCommand) { $hdcCommand.Source } else { 'Add SDK toolchains to PATH or pass -HdcPath' }
}
$checks.Add([pscustomobject]@{ Tool = 'hdc'; Status = $(if ($hdcAvailable) { 'OK' } else { 'MISSING' }); Detail = $hdcLocation })
$checks | Format-Table -AutoSize
Write-Output 'Tool discovery only. No device connection, build or test was performed.'
if ($checks | Where-Object { $_.Status -ne 'OK' }) { exit 1 }
exit 0
