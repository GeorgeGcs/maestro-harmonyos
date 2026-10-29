#Requires -Version 7.0
[CmdletBinding()]
param([string]$ValidationArtifactRoot, [string]$RetryArtifactRoot)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$schemas = Join-Path $project 'docs/protocol'
$script:checks = 0
$script:realDocuments = 0
function Copy-Value($Value) { return $Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable }
function Assert-Schema($Name, $Value, [bool]$Expected, $Label) {
    $actual = Test-Json -Json ($Value | ConvertTo-Json -Depth 100 -Compress) -SchemaFile (Join-Path $schemas ($Name + '-v1.schema.json')) -ErrorAction SilentlyContinue
    if ($actual -ne $Expected) { throw ('Schema expectation failed: ' + $Label) }
    $script:checks++
}
$id = '11111111-1111-4111-8111-111111111111'
$sha = 'a' * 64
$stamp = '2026-01-01T00:00:00.000Z'
$identity = @{ protocol='maestro.harmonyos.retry-trace'; schemaVersion=1; runId=$id; attemptId=$id; flowExecutionId=$id; flowPath='C:\fixture\flow.yaml'; flowSha256=$sha }
$engine = @{ sequence=0; elapsedNanos=0; flowExecutionId=$id }
$step = $engine + @{ stepId=$id; executionSequence=0; parentExecutionSequence=$null; sourcePath=$null; sourceSha256=$null;
    commandIndex=0; commandName='DefineVariablesCommand'; sourceOffset=$null; sourceOrigin='generated'; commandOptional=$false;
    selectorOptional=$false; retryContext=@(); flowScopeOwner=$null; phase='setup'; optionalAncestorSequences=@() }
$retry = $engine + @{ retryInvocationId=$id; retryCommandStepId=$id; executionSequence=0; parentRetryInvocationId=$null;
    parentTryNo=$null; retryContext=@(); maxRetries=1; optional=$false }
$events = @(
    ($identity + @{ event='traceStarted' }),
    ($step + @{ event='stepStarted' }),
    ($step + @{ event='stepFinished'; outcome='Completed'; error=$null }),
    ($step + @{ event='stepInterrupted'; outcome=$null; error=@{ class='CancellationException'; message=$null } }),
    ($retry + @{ event='retryBlockStarted'; tryNo=$null; outcome=$null; error=$null }),
    ($retry + @{ event='retryTryStarted'; tryNo=1; outcome=$null; error=$null }),
    ($retry + @{ event='retryTryFinished'; tryNo=1; outcome='failed'; error=@{ class='AssertionFailure'; message='fixture' } }),
    ($retry + @{ event='retryScheduled'; tryNo=2; outcome=$null; error=$null }),
    ($retry + @{ event='retryBlockFinished'; tryNo=$null; outcome='interrupted'; error=@{ class='CancellationException'; message=$null } }),
    ($engine + @{ event='flowFinished'; success=$null; error=$null; expectedEventCount=2; lastExecutionSequence=-1 }),
    ($engine + @{ event='traceCompleted'; expectedEventCount=2 })
)
foreach ($event in $events) { Assert-Schema 'retry-trace' $event $true ('synthetic ' + $event.event) }
$nested = Copy-Value $events[1]
$nested.retryContext = @(@{ retryInvocationId=$id; retryCommandStepId=$id; tryNo=2 }, @{ retryInvocationId='22222222-2222-4222-8222-222222222222'; retryCommandStepId='33333333-3333-4333-8333-333333333333'; tryNo=1 })
$nested.phase = 'onFlowComplete'; $nested.optionalAncestorSequences = @(0)
Assert-Schema 'retry-trace' $nested $true 'nested hook context shape'
$bad = Copy-Value $events[3]; $bad.outcome = 'Failed'; Assert-Schema 'retry-trace' $bad $false 'interrupted outcome must be null'
$bad = Copy-Value $events[1]; $bad.stepId = 'not-a-uuid'; Assert-Schema 'retry-trace' $bad $false 'step UUID'
$bad = Copy-Value $events[1]; $bad.unversionedField = $true; Assert-Schema 'retry-trace' $bad $false 'unknown event field'
$bad = Copy-Value $events[0]; $bad.event = 'unknownEvent'; Assert-Schema 'retry-trace' $bad $false 'unknown event kind'

$retrySummary = $identity + @{ state='complete'; traceCompleted=$true; tracePath='retry-trace.jsonl'; traceSha256=$sha;
    eventCount=2; expectedEventCount=2; stepCount=0; retryUsed=$false; optionalRetryUsed=$false; firstPassStatus='passed';
    outcomeCounts=@{}; coverageIndex=@{}; error=$null }
Assert-Schema 'retry-summary' $retrySummary $true 'complete summary shape'
$incomplete = Copy-Value $retrySummary
$incomplete.state='incomplete'; $incomplete.traceCompleted=$false; $incomplete.traceSha256=$null; $incomplete.expectedEventCount=$null
$incomplete.retryUsed=$null; $incomplete.optionalRetryUsed=$null; $incomplete.firstPassStatus='unknown'
Assert-Schema 'retry-summary' $incomplete $true 'initial incomplete summary'
$bad=Copy-Value $incomplete; $bad.firstPassStatus='passed'; Assert-Schema 'retry-summary' $bad $false 'incomplete cannot claim first pass'
$bad=Copy-Value $retrySummary; $bad.traceSha256=$null; Assert-Schema 'retry-summary' $bad $false 'complete requires trace hash'
$bad=Copy-Value $retrySummary; $bad.outcomeCounts.Fallback=1; Assert-Schema 'retry-summary' $bad $false 'unknown raw outcome'

$unit = @{ unitId='login'; profile='demo'; entry='flows/login.yaml'; sourceRoot='flows'; requiredTopLevelFlows=@(@{
    path='flows/login.yaml'; name='login'; requiredSteps=@(@{path='flows/login.yaml';commandIndex=1;role='assertion'}) }) }
$plan = @{ schemaVersion=1; planId='fixture'; status='frozen'; purpose='development'; measurementMode='per-flow'; repeat=2;
    runTimeoutSeconds=10; thresholdPolicy=@{metric='firstPass';minimumRate='1'}; preparationProcedure='Reset fixture.'; retryPolicy='Explicit YAML retry only.';
    manualInterventionPolicy='review-required'; evidencePolicy=@{requireVideo=$false}; devices=@(@{deviceId='fixture-device'});
    profiles=@{demo=@{bundleId='org.example.fixture';abilityName='EntryAbility';moduleName='entry';environmentNames=@()}};
    units=@($unit); buildFingerprint=@{files=@()}; applicationFingerprint=@{files=@()} }
Assert-Schema 'validation-plan-input' $plan $true 'development input'
foreach ($rate in @('0', '0.95', '1')) {
    $decimal=Copy-Value $plan; $decimal.thresholdPolicy.minimumRate=$rate
    Assert-Schema 'validation-plan-input' $decimal $true ('decimal threshold ' + $rate)
}
$bad=Copy-Value $plan; $bad.thresholdPolicy.minimumRate=0.95; Assert-Schema 'validation-plan-input' $bad $false 'threshold must retain decimal string'
$bad=Copy-Value $plan; $bad.repeat=0; Assert-Schema 'validation-plan-input' $bad $false 'zero denominator'
$bad=Copy-Value $plan; $bad.purpose='formal'; Assert-Schema 'validation-plan-input' $bad $false 'formal scope and fingerprints missing'
$formal=Copy-Value $plan; $formal.purpose='formal'; $formal.confirmation=@{status='confirmed';path='scope.txt';sha256=$sha}
$formal.buildFingerprint.files=@(@{path='implementation.jar';sha256=$sha}); $formal.applicationFingerprint.files=@(@{path='application.hap';sha256=$sha})
Assert-Schema 'validation-plan-input' $formal $true 'formal structure only'
$bad=Copy-Value $plan; $bad.units[0].requiredTopLevelFlows[0].requiredSteps[0].role='action'
Assert-Schema 'validation-plan-input' $bad $false 'required assertion absent'

$frozen = Copy-Value $plan
$null=$frozen.Remove('buildFingerprint'); $null=$frozen.Remove('applicationFingerprint')
$frozen.protocol='maestro.harmonyos.validation-plan'; $frozen.frozenAt=$stamp; $frozen.sourcePlan=@{path='C:\fixture\input.json';sha256=$sha}
$frozen.projectRoot='C:\fixture'; $frozen.confirmation=$null; $frozen.buildFiles=@(); $frozen.applicationFiles=@(); $frozen.toolFiles=@(); $frozen.environmentFingerprint=$null
$frozen.profiles.demo.environmentHashes=@{}; $frozen.batches=@(@{batchId=$id;unitId='login';deviceId='fixture-device'})
$frozen.units[0].entry='C:\fixture\flows\login.yaml'; $frozen.units[0].sourceRoot='C:\fixture\flows'
$frozen.units[0].sources=@(@{path='C:\fixture\flows\login.yaml';sha256=$sha})
$frozen.units[0].requiredTopLevelFlows[0].path='C:\fixture\flows\login.yaml'; $frozen.units[0].requiredTopLevelFlows[0].sha256=$sha
$frozen.units[0].requiredTopLevelFlows[0].requiredSteps=@(@{sourcePath='C:\fixture\flows\login.yaml';sourceSha256=$sha;commandIndex=1;role='assertion'})
Assert-Schema 'validation-plan' $frozen $true 'frozen output'
foreach ($rate in @('0', '0.95', '1')) {
    $decimal=Copy-Value $frozen; $decimal.thresholdPolicy.minimumRate=$rate
    Assert-Schema 'validation-plan' $decimal $true ('frozen decimal threshold ' + $rate)
}
$bad=Copy-Value $frozen; $null=$bad.Remove('batches'); Assert-Schema 'validation-plan' $bad $false 'missing frozen batches'
$bad=Copy-Value $frozen; $bad.units[0].entry='relative.yaml'; Assert-Schema 'validation-plan' $bad $false 'frozen entry must be absolute'

$batch = @{batchId=$id;unitId='login';deviceId='fixture-device';status='pending';matrixExitCode=$null;stopDevice=$false;releaseConfirmed=$false}
$slot = @{batchId=$id;unitId='login';deviceId='fixture-device';slotId=($id+':1');round=1;status='pending';firstPassStatus='not_run';finalPass=$false;
    manualIntervention='unknown';cleanup=$null;evidenceComplete=$false;coverageComplete=$false;retryComplete=$false;videoComplete=$false;runId=$null;attemptId=$null;reason=$null}
$group = @{unitId='login';deviceId='fixture-device';planned=1;firstPassCount=0;finalPassCount=0;firstPassRate=0;finalPassRate=0;minimumPassCount=1;
    thresholdMet=$false;unattendedPassCount=0;complete=$false;qualified=$false;failed=0;cancelled=0;blocked=0;unknown=0;notRun=1}
$summary = @{protocol='maestro.harmonyos.validation-summary';schemaVersion=1;planId='fixture';planPath='C:\fixture\plan.json';planSha256=$sha;
    status='running';createdAt=$stamp;updatedAt=$stamp;batches=@($batch);slots=@($slot);groups=@($group);qualified=$false}
Assert-Schema 'validation-summary' $summary $true 'pending summary'
$bad=Copy-Value $summary; $bad.slots[0].firstPassStatus='success'; Assert-Schema 'validation-summary' $bad $false 'unknown first pass status'
$bad=Copy-Value $summary; $bad.qualified='true'; Assert-Schema 'validation-summary' $bad $false 'qualification is boolean'
$review = @{schemaVersion=1;planId='fixture';planSha256=$sha;observedAt=$stamp;slots=@(@{slotId=($id+':1');manualIntervention='none';notes='Synthetic review.'})}
Assert-Schema 'validation-review' $review $true 'human review'
$bad=Copy-Value $review; $bad.slots[0].manualIntervention='unknown'; Assert-Schema 'validation-review' $bad $false 'review needs explicit intervention decision'

if (-not $ValidationArtifactRoot) { $ValidationArtifactRoot=Join-Path $project 'artifacts/validation-device-smoke' }
if (-not $RetryArtifactRoot) { $RetryArtifactRoot=Join-Path $project 'artifacts/retry-trace-device' }
foreach ($root in @($ValidationArtifactRoot, $RetryArtifactRoot)) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { Write-Output 'SKIP optional local device artifacts: directory absent.'; continue }
    foreach ($file in Get-ChildItem -LiteralPath $root -File -Recurse) {
        $schemaName = switch ($file.Name) { 'plan.json' {'validation-plan'} 'validation-summary.json' {'validation-summary'} 'retry-summary.json' {'retry-summary'} default {$null} }
        if ($schemaName) {
            $value=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -AsHashtable
            Assert-Schema $schemaName $value $true ('local ' + $file.Name); $script:realDocuments++
            if ($schemaName -eq 'validation-plan' -and (Test-Path -LiteralPath $value.sourcePlan.path -PathType Leaf)) {
                $source=Get-Content -LiteralPath $value.sourcePlan.path -Raw | ConvertFrom-Json -AsHashtable
                Assert-Schema 'validation-plan-input' $source $true 'local source plan'; $script:realDocuments++
            }
        } elseif ($file.Name -eq 'retry-trace.jsonl') {
            foreach ($line in Get-Content -LiteralPath $file.FullName) {
                Assert-Schema 'retry-trace' ($line | ConvertFrom-Json -AsHashtable) $true 'local trace record'; $script:realDocuments++
            }
        }
    }
}
Write-Output ('Schema checks passed: ' + $script:checks + '; local documents/records checked: ' + $script:realDocuments + '. No device commands or artifact writes performed.')
