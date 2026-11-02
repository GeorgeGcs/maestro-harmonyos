# Shape tests and explicit producer evidence only. Never invokes CLI, HDC or a device.
[CmdletBinding()]
param(
    [string]$ProducerDirectory,
    [string]$BlockedResponsePath,
    [switch]$RequireProductionEvidence
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
if ($RequireProductionEvidence -and (-not $ProducerDirectory -or -not $BlockedResponsePath)) {
    throw 'Both -ProducerDirectory and -BlockedResponsePath are required for production schema checks.'
}
$schemaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../docs/protocol'))
$receiptSchema = 'cleanup-fence-receipt-v4.schema.json'
$responseSchema = 'cleanup-fence-response-v1.schema.json'
$checks = 0
$productionChecks = 0
function Check($Value, [string]$Schema, [bool]$Expected, [string]$Name, [switch]$Production) {
    $actual = Test-Json -Json ($Value | ConvertTo-Json -Depth 50) -SchemaFile (Join-Path $schemaRoot $Schema) -ErrorAction SilentlyContinue
    if ($actual -ne $Expected) { throw "Schema expectation failed: $Name" }
    $script:checks++
    if ($Production) { $script:productionChecks++ }
}
function Copy-Shape($Value) { return ($Value | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable) }
function Read-Shape([string]$File) { return (Get-Content -LiteralPath $File -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable) }

$receipt = Read-Shape (Join-Path $schemaRoot 'examples/cleanup-fence-receipt.json')
$response = Read-Shape (Join-Path $schemaRoot 'examples/cleanup-fence-response-isolated.json')
$blocked = Read-Shape (Join-Path $schemaRoot 'examples/cleanup-fence-response-blocked.json')
Check $receipt $receiptSchema $true 'published v4 receipt shape'
Check $response $responseSchema $true 'published isolated response shape'
Check $blocked $responseSchema $true 'published blocked response shape'

foreach ($mutation in @(
    { param($v) $v.schemaVersion = 3 },
    { param($v) $v.recoveryId = 'not-a-uuid' },
    { param($v) $v.sessionId = '' },
    { param($v) $v.deviceId = 'device/foreign' },
    { param($v) $v.observedAt = 'not-a-time' },
    { param($v) $v.state = 'complete' },
    { param($v) $v.handoffReady = $false },
    { param($v) $v.disposition = 'terminated' },
    { param($v) $v.originalResult = 'passed' },
    { param($v) $v.pendingOperations = 0 },
    { param($v) $v.pendingOperations = 2 },
    { param($v) $v.temporaryFiles = 1 },
    { param($v) $v.checkpoint.path = '../checkpoint.json' },
    { param($v) $v.checkpoint.path = 'C:/checkpoint.json' },
    { param($v) $v.checkpoint.sha256 = 'bad-hash' },
    { param($v) $v.verifiedHead.extra = $true },
    { param($v) $v.verifiedHead = $null },
    { param($v) $v.retainedDirectories = @() },
    { param($v) $v.retainedDirectories = @($v.retainedDirectories[0], $v.retainedDirectories[0]) },
    { param($v) $v.retainedDirectories[0] += '/files' },
    { param($v) $v.retainedDirectories[0] = '/data/local/tmp/maestro-session-not-a-uuid' },
    { param($v) $v.rootRemoved = $true }
)) { $changed = Copy-Shape $receipt; $null = & $mutation $changed; Check $changed $receiptSchema $false 'invalid receipt' }
foreach ($field in @($receipt.Keys)) {
    $changed = Copy-Shape $receipt; $null = $changed.Remove($field)
    Check $changed $receiptSchema $false "missing receipt field $field"
}
foreach ($mutation in @(
    { param($v) $v.protocol = 'maestro.harmonyos.agent' },
    { param($v) $v.schemaVersion = 2 },
    { param($v) $v.deviceId = 'bad device' },
    { param($v) $v.sessionId = 'not-an-owner' },
    { param($v) $v.recoveryId = 'not-a-recovery' },
    { param($v) $v.state = 'complete' },
    { param($v) $v.handoffReady = $false },
    { param($v) $v.originalResult = 'passed' },
    { param($v) $v.disposition = 'terminated' },
    { param($v) $v.retainedDirectories = @() },
    { param($v) $v.retainedDirectories[0] = '../other' },
    { param($v) $v.receipt.schemaVersion = 3 },
    { param($v) $v.receipt.sha256 = 'A' * 64 },
    { param($v) $v.receipt.path = '' },
    { param($v) $v.receipt.extra = $true },
    { param($v) $v.receipt = $null },
    { param($v) $v.error = 'CLEANUP_FENCE_BLOCKED' }
)) { $changed = Copy-Shape $response; $null = & $mutation $changed; Check $changed $responseSchema $false 'invalid isolated response' }
foreach ($field in @($response.Keys)) {
    $changed = Copy-Shape $response; $null = $changed.Remove($field)
    Check $changed $responseSchema $false "missing isolated response field $field"
}
foreach ($mutation in @(
    { param($v) $v.protocol = 'harmonyos.reboot-recovery' },
    { param($v) $v.schemaVersion = 2 },
    { param($v) $v.state = 'isolated' },
    { param($v) $v.handoffReady = $true },
    { param($v) $v.error = 'INTERNAL_ERROR' },
    { param($v) $v.receipt = $null },
    { param($v) $v.sessionId = '11111111-1111-4111-8111-111111111111' }
)) { $changed = Copy-Shape $blocked; $null = & $mutation $changed; Check $changed $responseSchema $false 'invalid blocked response' }
foreach ($field in @($blocked.Keys)) {
    $changed = Copy-Shape $blocked; $null = $changed.Remove($field)
    Check $changed $responseSchema $false "missing blocked response field $field"
}
Check $receipt 'recovery-receipt.schema.json' $false 'v4 cannot downgrade to ordinary recovery v1/v2'
Check $receipt 'maintenance-receipt-v3.schema.json' $false 'v4 cannot downgrade to reboot maintenance v3'
Check $response 'maintenance-response-v1.schema.json' $false 'fence response is not reboot maintenance'
Check $response 'agent-v2.schema.json' $false 'fence response is not an agent v2 message'
Check $blocked 'maintenance-response-v1.schema.json' $false 'blocked response is not reboot maintenance'

if ($ProducerDirectory) {
    $producerRoot = [IO.Path]::GetFullPath($ProducerDirectory)
    $producer = Read-Shape (Join-Path $producerRoot 'producer.json')
    if ($producer.passed -ne $true -or $producer.device -ne $false -or $producer.blocked -ne $false -or
        $producer.originalJournalUnchanged -ne $true -or $producer.originalReceiptUnchanged -ne $true) {
        throw 'Expected a completed host-only CleanupFenceProducer fixture with unchanged originals.'
    }
    $actualResponse = Read-Shape (Join-Path $producerRoot 'response.json')
    Check $actualResponse $responseSchema $true 'production isolated response' -Production
    $actualReceiptPath = [IO.Path]::GetFullPath($actualResponse.receipt.path)
    if (-not $actualReceiptPath.StartsWith($producerRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Producer receipt is outside the selected fixture root.'
    }
    if ((Get-FileHash -LiteralPath $actualReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $actualResponse.receipt.sha256) {
        throw 'Producer receipt bytes differ from its response.'
    }
    $actualReceipt = Read-Shape $actualReceiptPath
    Check $actualReceipt $receiptSchema $true 'production isolated receipt' -Production
    foreach ($field in @('deviceId', 'sessionId', 'recoveryId', 'state', 'handoffReady', 'disposition', 'originalResult')) {
        if ($actualReceipt[$field] -cne $actualResponse[$field]) { throw "Producer response and receipt disagree: $field" }
    }
    if (($actualReceipt.retainedDirectories | ConvertTo-Json -Compress) -cne ($actualResponse.retainedDirectories | ConvertTo-Json -Compress)) {
        throw 'Producer response and receipt identify different retained directories.'
    }
}
if ($BlockedResponsePath) {
    $actualBlocked = Read-Shape $BlockedResponsePath
    Check $actualBlocked $responseSchema $true 'production blocked CLI response' -Production
    if ($actualBlocked.state -ne 'unknown' -or $actualBlocked.error -ne 'CLEANUP_FENCE_BLOCKED') {
        throw 'Expected the CLI blocked branch, not an isolated response.'
    }
}
[ordered]@{
    protocol = 'maestro.harmonyos.schema-test'; schemaVersion = 1; suite = 'cleanup-fence'
    checks = $checks; productionChecks = $productionChecks
    productionEvidenceRequired = [bool]$RequireProductionEvidence
    productionEvidenceComplete = ($productionChecks -eq 3); deviceCommands = 0; status = 'passed'
} | ConvertTo-Json -Compress
