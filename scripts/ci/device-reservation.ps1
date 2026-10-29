# Shared local reservation only. Release and recovery decisions belong to the caller's verifier.
function Assert-DeviceReservationPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if ((Test-Path -LiteralPath $current) -and
            (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'Device reservation paths must not follow links.'
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Assert-DeviceReservationState {
    param($State, [string]$DeviceId)
    $uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    if ($null -eq $State -or $State.protocol -ne 'maestro.harmonyos.ci-device' -or $State.schemaVersion -ne 1 -or
        $State.deviceId -cne $DeviceId -or $State.state -notin @('launching', 'running', 'needs_inspection', 'released') -or
        $State.launchId -notmatch $uuid) { throw 'Existing device reservation state is invalid; it was retained.' }
    $kind = if ($State.kind) { [string]$State.kind } else { 'single' }
    if ($kind -eq 'single') {
        if ($State.runId -notmatch $uuid -or $State.attemptId -notmatch $uuid -or
            -not [IO.Path]::IsPathRooted([string]$State.controlRecordPath)) { throw 'Single-run reservation identity is invalid.' }
    } elseif ($kind -eq 'validation') {
        if ($State.unitInvocationId -notmatch $uuid -or $State.unitInvocationId -cne $State.launchId -or
            -not [IO.Path]::IsPathRooted([string]$State.controlIndexPath) -or
            $null -ne $State.runId -or $null -ne $State.attemptId -or $null -ne $State.controlRecordPath) {
            throw 'Validation reservation identity is invalid.'
        }
    } else { throw 'Unsupported device reservation kind.' }
}

function Read-DeviceReservationState {
    param([Parameter(Mandatory = $true)]$Reservation)
    Assert-DeviceReservationPath $Reservation.StatePath
    if (-not (Test-Path -LiteralPath $Reservation.StatePath)) { return $null }
    $item = Get-Item -LiteralPath $Reservation.StatePath
    if ($item.PSIsContainer -or $item.Length -gt 4MB) { throw 'Device reservation state is not a bounded file.' }
    $value = Get-Content -LiteralPath $Reservation.StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-DeviceReservationState $value $Reservation.DeviceId
    return $value
}

function Write-DeviceReservationState {
    param([Parameter(Mandatory = $true)]$Reservation, [Parameter(Mandatory = $true)]$State)
    Assert-DeviceReservationState $State $Reservation.DeviceId
    Assert-DeviceReservationPath $Reservation.StatePath
    $temporary = Join-Path $Reservation.Directory ('.' + [guid]::NewGuid().ToString('N') + '.pending')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($State | ConvertTo-Json -Depth 32))
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($Reservation.StatePath)) { [IO.File]::Replace($temporary, $Reservation.StatePath, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Reservation.StatePath) }
        $Reservation.State = $State
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Open-DeviceReservation {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')][string]$DeviceId,
        [Parameter(Mandatory = $true)][string]$DeviceStateDirectory,
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [string]$ArtifactsRoot
    )
    $directory = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DeviceStateDirectory))
    foreach ($forbidden in @($ProjectRoot, $ArtifactsRoot)) {
        if ([string]::IsNullOrWhiteSpace($forbidden)) { continue }
        $root = [IO.Path]::GetFullPath($forbidden).TrimEnd('\', '/')
        Assert-DeviceReservationPath $root
        if ($directory -ieq $root -or $directory.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'DeviceStateDirectory must be outside the checkout and disposable artifacts.'
        }
    }
    Assert-DeviceReservationPath $directory
    $null = [IO.Directory]::CreateDirectory($directory)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($DeviceId)))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $lockPath = Join-Path $directory ($key + '.ci.lock')
    Assert-DeviceReservationPath $lockPath
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $reservation = [pscustomobject]@{ DeviceId = $DeviceId; Directory = $directory; StatePath = (Join-Path $directory ($key + '.json')); Lock = $lock; State = $null }
    try { $reservation.State = Read-DeviceReservationState $reservation; return $reservation }
    catch { $lock.Dispose(); throw }
}

function Close-DeviceReservation {
    param([Parameter(Mandatory = $true)]$Reservation)
    if ($null -ne $Reservation.Lock) { $Reservation.Lock.Dispose(); $Reservation.Lock = $null }
}
