# Shape tests plus optional production-coordinator output. PowerShell 7; no device calls.
[CmdletBinding()]
param([string]$ProducerDirectory)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
$schemaRoot = Join-Path $PSScriptRoot '../../docs/protocol'
$checks = 0
function Check($Value, [string]$Schema, [bool]$Expected, [string]$Name) {
    $json = $Value | ConvertTo-Json -Depth 50
    $actual = Test-Json -Json $json -SchemaFile (Join-Path $schemaRoot $Schema) -ErrorAction SilentlyContinue
    if ($actual -ne $Expected) { throw "Schema expectation failed: $Name" }
    $script:checks++
}
function Copy-Shape($Value) { return ($Value | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable) }
$id = '11111111-1111-4111-8111-111111111111'
$ref = @{ path = "step-$id.json"; sha256 = 'a' * 64 }
$receipt = @{ schemaVersion = 3; recoveryId = $id; maintenanceId = $id; sessionId = $id
    deviceId = 'maintenance-schema-fixture'; observedAt = '2026-10-30T01:00:00.000Z'
    reason = 'ordered_restart_maintenance'; state = 'complete'; originalExecutionResult = 'unknown'
    operations = 1; originalPendingOperations = 1; pendingOperations = 0; temporaryFiles = 0; issues = @()
    checkpoint = $ref; evidenceHead = $ref; termination = $ref; originalJournal = $ref; finalJournal = $ref
    originalReceipt = $ref; cleanupBatches = @($ref) }
$receiptSchema = 'maintenance-receipt-v3.schema.json'
Check $receipt $receiptSchema $true 'v3 shape (not evidence verification)'
foreach ($mutation in @(
    { param($v) $v.originalExecutionResult = 'passed' },
    { param($v) $v.pendingOperations = 1 },
    { param($v) $v.originalPendingOperations = -1 },
    { param($v) $v.issues = @('unconfirmed') },
    { param($v) $v.cleanupBatches = @() },
    { param($v) $v.checkpoint.path = '../outside.json' },
    { param($v) $v.finalJournal.sha256 = 'not-a-hash' },
    { param($v) $v.Remove('originalReceipt') },
    { param($v) $v.schemaVersion = 2 },
    { param($v) $v.state = 'unknown' },
    { param($v) $v.extra = $true }
)) { $changed = Copy-Shape $receipt; $null = & $mutation $changed; Check $changed $receiptSchema $false 'invalid receipt' }
Check $receipt 'recovery-receipt.schema.json' $false 'v3 cannot silently downgrade to v1/v2'
$response = @{ protocol = 'harmonyos.reboot-recovery'; schemaVersion = 1; maintenanceId = $id; ownerId = $id
    deviceId = 'maintenance-schema-fixture'; state = 'complete'; cleanup = @{ state = 'complete' }; phase = 'complete'
    handoffReady = $true; checkpoint = $ref; head = $ref; evidenceDirectory = 'C:/fixture/maintenance'
    receipt = @{ path = "C:/fixture/recoveries/$id.json"; sha256 = 'b' * 64; schemaVersion = 3 } }
$responseSchema = 'maintenance-response-v1.schema.json'
Check $response $responseSchema $true 'complete response'
foreach ($phase in @('prepared', 'phone_prepared', 'receipt_written')) {
    $pending = Copy-Shape $response; $pending.phase = $phase; $pending.state = 'unknown'; $pending.cleanup.state = 'unknown'
    $pending.handoffReady = $false; $pending.receipt = $null
    Check $pending $responseSchema $true 'incomplete response'
    $pending.handoffReady = $true; Check $pending $responseSchema $false 'premature handoff'
}
foreach ($mutation in @(
    { param($v) $v.receipt = $null }, { param($v) $v.cleanup.state = 'unknown' },
    { param($v) $v.handoffReady = $false }, { param($v) $v.receipt.schemaVersion = 2 },
    { param($v) $v.head.path = 'C:/foreign.json' }
)) { $changed = Copy-Shape $response; $null = & $mutation $changed; Check $changed $responseSchema $false 'inconsistent response' }
if ($ProducerDirectory) {
    foreach ($name in @('prepared.json', 'resumed.json', 'response.json')) {
        $actualResponse = Get-Content -LiteralPath (Join-Path $ProducerDirectory $name) -Raw | ConvertFrom-Json -AsHashtable
        Check $actualResponse $responseSchema $true "JVM $name"
    }
    $actualReceipt = Get-Content -LiteralPath $actualResponse.receipt.path -Raw | ConvertFrom-Json -AsHashtable
    Check $actualReceipt $receiptSchema $true 'JVM receipt'
}
Write-Output "Maintenance schema checks passed: $checks"
