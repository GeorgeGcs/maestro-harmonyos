# Persistent requests are checked only before dispatch, never inside a device action.
function Assert-TestStopPath {
    param([string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Stop metadata paths must be absolute.' }
    for ($item = [IO.Path]::GetFullPath($Path); $item; $item = [IO.Path]::GetDirectoryName($item)) {
        if ((Test-Path -LiteralPath $item) -and ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Stop metadata must not follow links.'
        }
    }
}

function Read-TestStopJson {
    param([string]$Path)
    Assert-TestStopPath $Path
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt 16384) { throw 'Stop metadata must be a bounded JSON file.' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $sha256 = ([BitConverter]::ToString($digest.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $digest.Dispose() }
    $value = $text | ConvertFrom-Json -ErrorAction Stop
    # ConvertFrom-Json can turn ISO strings into local DateTime values. Preserve
    # the exact timestamp text so archived copies match the hashed source bytes.
    foreach ($field in @('createdAt', 'requestedAt')) {
        if ($value.PSObject.Properties[$field]) {
            $timeMatches = [regex]::Matches($text, ('"' + $field + '"\s*:\s*"([^"\\]+)"'))
            if ($timeMatches.Count -ne 1) { throw 'Stop metadata has an invalid or duplicate timestamp.' }
            $value.$field = $timeMatches[0].Groups[1].Value
        }
    }
    return [pscustomobject]@{ path = [IO.Path]::GetFullPath($Path); sha256 = $sha256; value = $value }
}

function Get-TestStopControl {
    param([string]$Path)
    $document = Read-TestStopJson $Path
    $value = $document.value
    if ([IO.Path]::GetFileName($document.path) -cne 'stop-control.json' -or
        $value.protocol -cne 'maestro.harmonyos.stop-control' -or $value.schemaVersion -ne 1 -or
        $value.kind -cnotin @('matrix', 'validation') -or
        $value.invocationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        -not $value.createdAt -or ($value.kind -eq 'validation' -and
        (-not $value.planId -or $value.planSha256 -cnotmatch '^[0-9a-f]{64}$'))) { throw 'Invalid stop control identity.' }
    $null = [DateTimeOffset]::Parse($value.createdAt, [Globalization.CultureInfo]::InvariantCulture)
    return $document
}

function Write-TestStopJson {
    param([string]$Path, $Value)
    Assert-TestStopPath $Path
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.pending'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8))
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        # Never replace an earlier request or a control from another invocation.
        [IO.File]::Move($temporary, $Path)
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function New-TestStopControl {
    param([string]$Directory, [string]$Kind, [string]$InvocationId, [string]$PlanId, [string]$PlanSha256)
    $file = Join-Path ([IO.Path]::GetFullPath($Directory)) 'stop-control.json'
    Write-TestStopJson $file ([ordered]@{
        protocol = 'maestro.harmonyos.stop-control'; schemaVersion = 1; kind = $Kind
        invocationId = $InvocationId; createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        planId = $PlanId; planSha256 = $PlanSha256
    })
    return Get-TestStopControl $file
}

function Read-TestStopRequest {
    param($Control)
    $observed = Get-TestStopControl $Control.path
    if ($observed.sha256 -cne $Control.sha256) { throw 'Stop control changed after startup.' }
    $file = Join-Path ([IO.Path]::GetDirectoryName($Control.path)) 'stop-request.json'
    Assert-TestStopPath $file
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $request = Read-TestStopJson $file
    $value = $request.value
    if ($value.protocol -cne 'maestro.harmonyos.stop-request' -or $value.schemaVersion -ne 1 -or
        $value.invocationId -cne $Control.value.invocationId -or $value.controlSha256 -cne $Control.sha256 -or
        $value.kind -cne $Control.value.kind -or $value.boundary -cne 'after-current-round' -or
        $value.reason -isnot [string] -or [string]::IsNullOrWhiteSpace($value.reason) -or $value.reason.Length -gt 1000 -or
        -not $value.requestedAt) { throw 'Stop request does not match this invocation.' }
    if ([DateTimeOffset]::Parse($value.requestedAt, [Globalization.CultureInfo]::InvariantCulture) -lt
        [DateTimeOffset]::Parse($Control.value.createdAt, [Globalization.CultureInfo]::InvariantCulture)) { throw 'Stop request predates this invocation.' }
    return $request
}

function Request-TestStop {
    param([string]$ControlPath, [string]$Reason = 'Operator requested stopping after the current round.')
    if ([string]::IsNullOrWhiteSpace($Reason) -or $Reason.Length -gt 1000) { throw 'Provide a stop reason of 1 to 1000 characters.' }
    $control = Get-TestStopControl $ControlPath
    $existing = Read-TestStopRequest $control
    if ($existing) { return $existing }
    $file = Join-Path ([IO.Path]::GetDirectoryName($control.path)) 'stop-request.json'
    try {
        Write-TestStopJson $file ([ordered]@{
            protocol = 'maestro.harmonyos.stop-request'; schemaVersion = 1; kind = $control.value.kind
            invocationId = $control.value.invocationId; controlSha256 = $control.sha256
            boundary = 'after-current-round'; requestedAt = [DateTimeOffset]::UtcNow.ToString('o'); reason = $Reason
        })
    } catch { if (-not [IO.File]::Exists($file)) { throw } }
    return Read-TestStopRequest $control
}
