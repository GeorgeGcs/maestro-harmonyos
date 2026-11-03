# Requires PowerShell 7 (Test-Json). No device calls or file mutations.
[CmdletBinding()]
param([string]$SessionRoot, [string]$VerificationRoot)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run this schema check with PowerShell 7.' }
$repository = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$schemaRoot = Join-Path $repository 'docs/protocol'
$checks = 0
function Check-Shape {
    param([object]$Document, [string]$Schema, [bool]$Expected, [string]$Name)
    $json = if ($Document -is [string]) { $Document } else { $Document | ConvertTo-Json -Depth 50 }
    $actual = Test-Json -Json $json -SchemaFile (Join-Path $schemaRoot $Schema) -ErrorAction SilentlyContinue
    if ($actual -ne $Expected) { throw ('Schema expectation failed: ' + $Name) }
    $script:checks++
}
function Copy-Document($Value) { return ($Value | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable) }

$owner = '11111111-1111-4111-8111-111111111111'
$generation = '22222222-2222-4222-8222-222222222222'
$resourceId = '33333333-3333-4333-8333-333333333333'
$recoveryId = '44444444-4444-4444-8444-444444444444'
$archive = "$resourceId-$recoveryId.mp4"
$media = 'maestro-recording-33333333333343338333333333333333.mp4'
$digest = 'a' * 64
$resource = @{
    id = $resourceId; fileName = $media; remotePath = "/data/local/tmp/maestro-session-$generation/files/recording-$resourceId.mp4"
    startRequested = $true; startAcknowledged = $true; ownerPid = 123; stopRequested = $false; captureEnded = $true
    uri = "file://media/Photo/1/VID_1/$media"; archiveName = $archive; archiveSize = 64; archiveSha256 = $digest
    mediaRemoved = $true; clean = $true; failureFingerprint = $null; archives = @(@{ name = $archive; size = 64; sha256 = $digest })
}
$snapshot = @{ schemaVersion = 1; deviceId = 'schema-fixture-device'; ownerId = $owner; generation = $generation
    remoteRoot = "/data/local/tmp/maestro-session-$generation"; resources = @($resource) }
$resourceSchema = 'recording-resources-v1.schema.json'
Check-Shape $snapshot $resourceSchema $true 'ended capture without an explicit stop'
$registered = Copy-Document $snapshot
$r = $registered.resources[0]
foreach ($key in @('startRequested', 'startAcknowledged', 'captureEnded', 'mediaRemoved', 'clean')) { $r[$key] = $false }
foreach ($key in @('ownerPid', 'uri', 'archiveName', 'archiveSize', 'archiveSha256')) { $r[$key] = $null }
$r.archives = @()
Check-Shape $registered $resourceSchema $true 'registered before dispatch'
$rejected = Copy-Document $registered
$rejected.schemaVersion = 2
$rejected.resources[0].startRequested = $true
$rejected.resources[0].clean = $true
$rejected.resources[0].failureFingerprint = $digest
$rejected.resources[0].rejectedStart = @{ errorCode = 10106102; failureFingerprint = $digest
    firstObservedAt = '2026-11-03T01:00:00Z'; secondObservedAt = '2026-11-03T01:00:02Z' }
Check-Shape $rejected 'recording-resources-v2.schema.json' $true 'rejected start with no capture or media'
$badRejected = Copy-Document $rejected
$badRejected.resources[0].captureEnded = $true
Check-Shape $badRejected 'recording-resources-v2.schema.json' $false 'rejected start cannot claim capture ended'
foreach ($mutation in @(
    { param($d) $d.resources[0].startAcknowledged = $false },
    { param($d) $d.resources[0].ownerPid = $null },
    { param($d) $d.resources[0].archiveSize = $null },
    { param($d) $d.resources[0].archives[0].name = '../outside.mp4' },
    { param($d) $d.resources[0].archives[0].size = 1073741825 },
    { param($d) $d.resources[0].mediaRemoved = $false },
    { param($d) $d.resources[0].extra = $true }
)) { $changed = Copy-Document $snapshot; & $mutation $changed; Check-Shape $changed $resourceSchema $false 'invalid resource' }

$receipt = @{ schemaVersion = 2; recoveryId = $recoveryId; deviceId = 'schema-fixture-device'; sessionId = $owner
    observedAt = '2026-01-01T00:00:00Z'; reason = 'recovery'; previousState = 'quarantined'
    previousReportPath = $null; previousReportSha256 = $null; requiresRecovery = $true; uncertainReason = 'previous interruption'
    unresolvedRecording = $false; closeFailure = $null; state = 'complete'; operations = 2; pendingOperations = 0; temporaryFiles = 0
    issues = @(); recordingResources = @{ path = "C:/fixture/recoveries/$recoveryId-recordings.json"; sha256 = $digest } }
$receiptSchema = 'recovery-receipt.schema.json'
Check-Shape $receipt $receiptSchema $true 'v2 complete retains prior requiresRecovery'
$old = Copy-Document $receipt; $old.schemaVersion = 1; $old.Remove('recordingResources')
Check-Shape $old $receiptSchema $true 'v1 without recording extension'
$unknown = Copy-Document $receipt; $unknown.state = 'unknown'; $unknown.pendingOperations = 1
$unknown.unresolvedRecording = $true; $unknown.issues = @(@{ code = 'PENDING'; message = 'Command is unconfirmed.' })
Check-Shape $unknown $receiptSchema $true 'unknown receipt'
foreach ($mutation in @(
    { param($d) $d.Remove('recordingResources') },
    { param($d) $d.schemaVersion = 1 },
    { param($d) $d.pendingOperations = 1 },
    { param($d) $d.unresolvedRecording = $true },
    { param($d) $d.closeFailure = @{kind = 'environment'; code = 'CLOSE'; message = 'unconfirmed'} },
    { param($d) $d.previousReportSha256 = 'b' * 64 }
)) { $changed = Copy-Document $receipt; $null = & $mutation $changed; Check-Shape $changed $receiptSchema $false 'invalid receipt' }

$video = @{ protocol = 'maestro.harmonyos.recording-verification'; schemaVersion = 1; status = 'passed'
    startedAt = '2026-01-01T00:00:00Z'; endedAt = '2026-01-01T00:00:01Z'; inputPath = 'C:/fixture/video.mp4'
    inputSha256 = $digest; inputSha256After = $digest; bytes = 64; decoderPath = 'C:/fixture/ffmpeg.exe'
    decoderSha256 = $digest; decoderVersion = 'ffmpeg version fixture'; timeoutSeconds = 60; arguments = @('-version')
    exitCode = 0; timedOut = $false; frames = 1; progressEnded = $true; error = $null; stdout = 'decode.stdout.log'; stderr = 'decode.stderr.log' }
$videoSchema = 'recording-verification-v1.schema.json'
Check-Shape $video $videoSchema $true 'passed decode shape'
$failed = Copy-Document $video; $failed.status = 'failed'; $failed.exitCode = $null; $failed.error = 'launch failed'
$failed.frames = 0; $failed.progressEnded = $false; $failed.decoderVersion = $null
Check-Shape $failed $videoSchema $true 'failed decode with no process exit'
foreach ($mutation in @(
    { param($d) $d.exitCode = $null }, { param($d) $d.frames = 0 }, { param($d) $d.timedOut = $true },
    { param($d) $d.progressEnded = $false }, { param($d) $d.error = 'decode failed' }
)) { $changed = Copy-Document $video; & $mutation $changed; Check-Shape $changed $videoSchema $false 'contradictory passed decode' }

# Optional checks read only the caller-selected artifact trees. They do not publish their contents.
if ($SessionRoot) {
    foreach ($file in Get-ChildItem -LiteralPath $SessionRoot -File -Recurse -Filter '*.json') {
        if ($file.Name -eq 'recording-resources.json' -or $file.Name -like '*-recordings.json') {
            $stored = Get-Content -LiteralPath $file.FullName -Raw
            $version = ($stored | ConvertFrom-Json).schemaVersion
            $storedSchema = if ($version -eq 2) { 'recording-resources-v2.schema.json' } else { $resourceSchema }
            Check-Shape $stored $storedSchema $true 'stored recording resource'
        } elseif ($file.Directory.Name -eq 'recoveries' -and $file.BaseName -match '^[0-9a-f-]{36}$') {
            Check-Shape (Get-Content -LiteralPath $file.FullName -Raw) $receiptSchema $true 'stored cleanup receipt'
        }
    }
}
if ($VerificationRoot) {
    foreach ($file in Get-ChildItem -LiteralPath $VerificationRoot -File -Recurse -Filter 'verification.json') {
        Check-Shape (Get-Content -LiteralPath $file.FullName -Raw) $videoSchema $true 'stored video verification'
    }
}
Write-Output ("Recording schema checks passed: $checks")
exit 0
