[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputPath)

# Read-only host observation. This does not restart anything or release a device.
# The caller owns the process timeout; a CIM call has no hard in-process deadline.
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$invariant = [Globalization.CultureInfo]::InvariantCulture

function Assert-RegularPath {
    param([string]$Path, [switch]$AllowMissingLeaf)
    $leaf = $true
    for ($current = $Path; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if ($leaf -and $AllowMissingLeaf -and -not (Test-Path -LiteralPath $current)) {
            $leaf = $false
            continue
        }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Observation paths must not follow reparse points.'
        }
        if ($leaf -and $item.PSIsContainer) { throw 'Expected a regular file.' }
        $leaf = $false
    }
}

function Get-Fingerprint {
    param([string]$Path)
    Assert-RegularPath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $length = $stream.Length
        $digest = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        if ($stream.Length -ne $length) { throw 'Fingerprint input changed.' }
        return [ordered]@{ path = $Path; sha256 = $digest; bytes = $length }
    } finally { $hasher.Dispose(); $stream.Dispose() }
}

function Get-MachineBinding {
    $base = $null
    $key = $null
    $hasher = $null
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
        $key = $base.OpenSubKey('SOFTWARE\Microsoft\Cryptography', $false)
        if ($null -eq $key) { throw 'Machine binding is unavailable.' }
        $raw = $key.GetValue('MachineGuid', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $guid = [Guid]::Empty
        if ($raw -isnot [string] -or -not [Guid]::TryParse($raw.Trim(), [ref]$guid) -or $guid -eq [Guid]::Empty) {
            throw 'Machine binding must be a nonempty GUID.'
        }
        $hasher = [Security.Cryptography.SHA256]::Create()
        $bytes = $utf8.GetBytes($guid.ToString('D').ToLowerInvariant())
        return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $hasher) { $hasher.Dispose() }
        if ($null -ne $key) { $key.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
    }
}

function Get-BootTime {
    $items = @(Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 10)
    if ($items.Count -ne 1 -or $items[0].LastBootUpTime -isnot [DateTime]) {
        throw 'LastBootUpTime is unavailable.'
    }
    return $items[0].LastBootUpTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
}

function Assert-SameFingerprint {
    param($Before, $After)
    if ($Before.path -cne $After.path -or $Before.sha256 -cne $After.sha256 -or $Before.bytes -ne $After.bytes) {
        throw 'Observation tool changed during collection.'
    }
}

$staging = $null
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
    $destination = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath))
    Assert-RegularPath $destination -AllowMissingLeaf
    if (Test-Path -LiteralPath $destination) { throw 'OutputPath must be a new file.' }
    $scriptFile = [IO.Path]::GetFullPath($PSCommandPath)
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try { $powershellFile = [IO.Path]::GetFullPath($process.MainModule.FileName) }
    finally { $process.Dispose() }
    $psBefore = Get-Fingerprint $powershellFile
    $scriptBefore = Get-Fingerprint $scriptFile
    $machineBefore = Get-MachineBinding

    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace MaestroHarmonyOS {
    public static class WindowsBootClock {
        [DllImport("kernel32.dll", ExactSpelling = true)]
        public static extern ulong GetTickCount64();
    }
}
'@
    $tickBefore = [MaestroHarmonyOS.WindowsBootClock]::GetTickCount64()
    $bootBefore = Get-BootTime
    $observedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $invariant)
    $tick = [MaestroHarmonyOS.WindowsBootClock]::GetTickCount64()
    $bootAfter = Get-BootTime
    $tickAfter = [MaestroHarmonyOS.WindowsBootClock]::GetTickCount64()
    if ($bootBefore -cne $bootAfter -or $tick -lt $tickBefore -or $tickAfter -lt $tick) {
        throw 'Host boot observation was not stable.'
    }
    if ((Get-MachineBinding) -cne $machineBefore) { throw 'Machine binding changed during collection.' }
    Assert-SameFingerprint $psBefore (Get-Fingerprint $powershellFile)
    Assert-SameFingerprint $scriptBefore (Get-Fingerprint $scriptFile)
    $psBefore['version'] = $PSVersionTable.PSVersion.ToString()
    $observation = [ordered]@{
        protocol = 'maestro.harmonyos.host-boot-observation'
        schemaVersion = 1
        provider = [ordered]@{ name = 'windows-gettickcount64-cim'; version = 1 }
        observedAt = $observedAt
        uptimeMilliseconds = $tick.ToString($invariant)
        lastBootUpTime = $bootBefore
        machineIdSha256 = $machineBefore
        tools = [ordered]@{ powershell = $psBefore; script = $scriptBefore }
    }
    $encoded = $utf8.GetBytes(($observation | ConvertTo-Json -Depth 6) + "`n")
    # Keep staging in the same directory without extending an already long destination.
    $staging = Join-Path ([IO.Path]::GetDirectoryName($destination)) ('.boot-' + [Guid]::NewGuid().ToString('N') + '.pending')
    $output = [IO.File]::Open($staging, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $output.Write($encoded, 0, $encoded.Length); $output.Flush($true) }
    finally { $output.Dispose() }
    Assert-RegularPath $destination -AllowMissingLeaf
    [IO.File]::Move($staging, $destination)
    $staging = $null
    exit 0
} catch {
    # Errors never include the raw registry value, and never publish a success observation.
    [Console]::Error.WriteLine('Windows boot observation failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $staging -and [IO.File]::Exists($staging)) {
        try { [IO.File]::Delete($staging) } catch { }
    }
}
