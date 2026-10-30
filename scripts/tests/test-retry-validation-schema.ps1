#Requires -Version 7.0
[CmdletBinding()]
param([string]$ValidationArtifactRoot, [string]$RetryArtifactRoot)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$schemas = Join-Path $project 'docs/protocol'
$script:checks = 0
$script:realDocuments = 0
function Copy-Value($Value) { return $Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable }
function Assert-Schema($Name, $Value, [bool]$Expected, $Label, [int]$Version = 1) {
    if (-not $PSBoundParameters.ContainsKey('Version')) {
        if ($Name -in @('retry-summary', 'validation-plan-input', 'validation-plan', 'validation-summary', 'validation-review') -and $Value.schemaVersion -eq 2) { $Version = 2 }
        elseif ($Name -in @('validation-plan', 'validation-summary') -and $Value.schemaVersion -eq 3) { $Version = 3 }
    }
    $actual = Test-Json -Json ($Value | ConvertTo-Json -Depth 100 -Compress) -SchemaFile (Join-Path $schemas ($Name + '-v' + $Version + '.schema.json')) -ErrorAction SilentlyContinue
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

foreach ($event in $events) {
    $v2 = Copy-Value $event
    if ($v2.event -eq 'traceStarted') { $v2.schemaVersion = 2 }
    if ($v2.event -in @('stepStarted','stepFinished','stepInterrupted')) { $v2.sourceIdentity = $null }
    Assert-Schema 'retry-trace' $v2 $true ('v2 synthetic ' + $v2.event) 2
}
$v2Summary = Copy-Value $retrySummary; $v2Summary.schemaVersion = 2
Assert-Schema 'retry-summary' $v2Summary $true 'v2 summary'
$v2Step = Copy-Value $events[1]; $v2Step.sourceIdentity=$null
$bad=Copy-Value $v2Step; $bad.Remove('sourceIdentity'); Assert-Schema 'retry-trace' $bad $false 'v2 identity cannot be omitted' 2
$bad=Copy-Value $v2Step; $bad.sourceIdentity='C:\fixture\flow.yaml'; Assert-Schema 'retry-trace' $bad $false 'generated step has no original source' 2
$v2Step.sourceOrigin='yaml'; $v2Step.sourcePath=('sources/'+$sha+'.yaml'); $v2Step.sourceSha256=$sha
$v2Step.sourceOffset=0; $v2Step.sourceIdentity='C:\fixture\flow.yaml'
Assert-Schema 'retry-trace' $v2Step $true 'v2 YAML source identity' 2
$bad=Copy-Value $v2Step; $bad.sourceIdentity=$null; Assert-Schema 'retry-trace' $bad $false 'v2 YAML identity is required' 2
$bad=Copy-Value $v2Step; $bad.sourceIdentity=@(); Assert-Schema 'retry-trace' $bad $false 'v2 identity must be a string' 2
Assert-Schema 'retry-trace' $v2Step $false 'v2 step must not be accepted by the original v1 schema' 1

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

# Version 2 adds runtime and preparation observations without changing the v1 fixtures above.
$plan2=Copy-Value $plan; $plan2.schemaVersion=2
Assert-Schema 'validation-plan-input' $plan2 $true 'v2 development input may omit preparation declarations'
$formal2=Copy-Value $formal; $formal2.schemaVersion=2
Assert-Schema 'validation-plan-input' $formal2 $false 'v2 formal input needs preparation references and application versions'
$formal2.preparations=@(@{path='preparation.json';sha256=$sha})
Assert-Schema 'validation-plan-input' $formal2 $false 'v2 formal profile still needs application version'
$formal2.profiles.demo.applicationVersion=@{versionCode='1';versionName='1.0.0'}
Assert-Schema 'validation-plan-input' $formal2 $true 'v2 formal input structure'
$bad=Copy-Value $formal2; $bad.profiles.demo.applicationVersion.versionCode=1
Assert-Schema 'validation-plan-input' $bad $false 'application version code is a decimal string'
$bad=Copy-Value $formal2; $bad.profiles.demo.applicationVersion.versionCode='01'
Assert-Schema 'validation-plan-input' $bad $false 'application version code has canonical decimal syntax'
$bad=Copy-Value $formal2; $bad.profiles.demo.applicationVersion.versionName=''
Assert-Schema 'validation-plan-input' $bad $false 'application version name cannot be empty'
$bad=Copy-Value $formal2; $bad.preparations=@()
Assert-Schema 'validation-plan-input' $bad $false 'formal preparation references cannot be empty'
$bad=Copy-Value $plan; $bad.preparations=@()
Assert-Schema 'validation-plan-input' $bad $false 'v1 input does not silently accept v2 fields'

$runtimeFile=@{path='C:\fixture\bin\java.exe';sha256=$sha;bytes=100}
$runtime=@{schemaVersion=1;projectRoot='C:\fixture';cliHome='C:\fixture\cli';classpathArgument='C:\fixture\cli\lib\*';
    java=(Copy-Value $runtimeFile);node=@{path='C:\fixture\bin\node.exe';sha256=$sha;bytes=100};
    powershell=@{path='C:\fixture\bin\pwsh.exe';sha256=$sha;bytes=100};
    classpath=@(@{path='C:\fixture\cli\lib\maestro-cli.jar';sha256=$sha;bytes=100});
    configuration=@{path='C:\fixture\config.local.ps1';present=$false;sha256=$null;bytes=$null}}
$unknownPreparation=@{planId='fixture';profileId='demo';deviceId='fixture-device';preparationId=$null;state='unknown';
    reference=$null;application=$null;installation=$null;packageObservation=$null;preparation=$null;files=@()}
$hap=@{path='C:\fixture\app.hap';sha256=$sha}
$install=@{path='C:\fixture\install.txt';sha256=$sha}
$package=@{path='C:\fixture\package.txt';sha256=$sha}
$prepare=@{path='C:\fixture\prepare.txt';sha256=$sha}
$readyPreparation=@{planId='fixture';profileId='demo';deviceId='fixture-device';preparationId=$id;state='ready';
    reference=@{path='C:\fixture\preparation.json';sha256=$sha};
    application=@{bundleId='org.example.fixture';moduleName='entry';abilityName='EntryAbility';versionCode='1';versionName='1.0.0';hap=$hap};
    installation=@{basis='operator_attested';installedAt=$stamp;record=$install};
    packageObservation=@{basis='operator_attested';observedAt=$stamp;bundleId='org.example.fixture';versionCode='1';versionName='1.0.0';record=$package};
    preparation=@{basis='operator_attested';completedAt=$stamp;procedureSha256=$sha;record=$prepare};files=@($hap,$install,$package,$prepare)}
$frozen2=Copy-Value $frozen; $frozen2.schemaVersion=2; $frozen2.runtime=Copy-Value $runtime; $frozen2.preparations=@((Copy-Value $unknownPreparation))
Assert-Schema 'validation-plan' $frozen2 $true 'v2 development freeze retains explicit unknown preparation'
$bad=Copy-Value $frozen2; $null=$bad.Remove('runtime')
Assert-Schema 'validation-plan' $bad $false 'v2 frozen runtime cannot be omitted'
$bad=Copy-Value $frozen2; $null=$bad.Remove('preparations')
Assert-Schema 'validation-plan' $bad $false 'v2 frozen preparation list cannot be omitted'
$bad=Copy-Value $frozen2; $bad.runtime.configuration.sha256=$sha
Assert-Schema 'validation-plan' $bad $false 'absent configuration cannot claim a file hash'
$bad=Copy-Value $frozen2; $bad.runtime.configuration.present=$true
Assert-Schema 'validation-plan' $bad $false 'present configuration requires bytes and hash'
$configured=Copy-Value $frozen2; $configured.runtime.configuration=@{path='C:\fixture\config.local.ps1';present=$true;sha256=$sha;bytes=0}
Assert-Schema 'validation-plan' $configured $true 'present empty configuration is fingerprinted'
$bad=Copy-Value $frozen2; $bad.runtime.classpath=@()
Assert-Schema 'validation-plan' $bad $false 'runtime classpath cannot be empty'
$bad=Copy-Value $frozen2; $bad.runtime.classpathArgument='lib/*'
Assert-Schema 'validation-plan' $bad $false 'runtime classpath argument must be absolute'
$bad=Copy-Value $frozen2; $bad.preparations=@()
Assert-Schema 'validation-plan' $bad $false 'frozen development plans retain unknown entries rather than an empty list'
$bad=Copy-Value $frozen2; $bad.runtime.java.path='relative.exe'
Assert-Schema 'validation-plan' $bad $false 'runtime tool path must be absolute'
$bad=Copy-Value $frozen2; $bad.runtime.java.bytes=-1
Assert-Schema 'validation-plan' $bad $false 'runtime byte count cannot be negative'
$bad=Copy-Value $frozen2; $bad.preparations[0].preparationId=$id
Assert-Schema 'validation-plan' $bad $false 'unknown preparation does not claim a registered identity'
$prepared2=Copy-Value $frozen2; $prepared2.preparations=@((Copy-Value $readyPreparation)); $prepared2.profiles.demo.applicationVersion=@{versionCode='1';versionName='1.0.0'}
Assert-Schema 'validation-plan' $prepared2 $true 'v2 retained operator preparation structure'
$bad=Copy-Value $prepared2; $bad.preparations[0].installation.basis='device_observed'
Assert-Schema 'validation-plan' $bad $false 'operator evidence cannot be relabelled as a device observation'
$bad=Copy-Value $prepared2; $bad.preparations[0].preparationId=$null
Assert-Schema 'validation-plan' $bad $false 'ready preparation requires identity'
$bad=Copy-Value $prepared2; $bad.preparations[0].files=@($hap)
Assert-Schema 'validation-plan' $bad $false 'ready preparation retains HAP and all three evidence records'
$formalFrozen2=Copy-Value $prepared2; $formalFrozen2.purpose='formal'; $formalFrozen2.confirmation=@{path='C:\fixture\scope.txt';sha256=$sha}
$formalFrozen2.buildFiles=@(@{path='C:\fixture\implementation.jar';sha256=$sha}); $formalFrozen2.applicationFiles=@($hap)
Assert-Schema 'validation-plan' $formalFrozen2 $true 'v2 formal freeze structure'
$bad=Copy-Value $formalFrozen2; $bad.preparations=@((Copy-Value $unknownPreparation))
Assert-Schema 'validation-plan' $bad $false 'formal freeze cannot rely on unknown preparation'

$unknownCheck=@{state='unknown';preparationId=$null;preparationSha256=$null;reviewedAt=$null;basis=$null;
    installationUnchanged=$null;preparationUnchanged=$null;reason='preparation_missing'}
$summary2=Copy-Value $summary; $summary2.schemaVersion=2; $summary2.formalEligible=$false; $summary2.formalQualified=$false
$summary2.slots[0].runtimeVerification=@{state='unknown';reason=$null}; $summary2.slots[0].preparationVerification=Copy-Value $unknownCheck
foreach ($field in @('runtimeComplete','preparationComplete','formalEligible','formalQualified')) { $summary2.groups[0][$field]=$false }
Assert-Schema 'validation-summary' $summary2 $true 'v2 pending summary records unknown checks'
$bad=Copy-Value $summary2; $null=$bad.slots[0].Remove('runtimeVerification')
Assert-Schema 'validation-summary' $bad $false 'v2 cannot omit runtime verification'
$bad=Copy-Value $summary2; $null=$bad.slots[0].Remove('preparationVerification')
Assert-Schema 'validation-summary' $bad $false 'v2 cannot omit preparation verification'
$bad=Copy-Value $summary2; $bad.slots[0].runtimeVerification.state='passed'
Assert-Schema 'validation-summary' $bad $false 'runtime verification has explicit distinct states'
$bad=Copy-Value $summary2; $bad.formalQualified=$true
Assert-Schema 'validation-summary' $bad $false 'formal qualification needs statistical qualification and eligibility'
$bad=Copy-Value $summary2; $bad.groups[0].formalEligible=$true
Assert-Schema 'validation-summary' $bad $false 'formal group eligibility needs runtime and preparation completeness'
$bad=Copy-Value $summary2; $bad.slots[0].preparationVerification.state='confirmed'
Assert-Schema 'validation-summary' $bad $false 'confirmed preparation cannot retain missing evidence fields'
$confirmed2=Copy-Value $summary2
$confirmed2.slots[0].runtimeVerification=@{state='verified';reason=$null}
$confirmed2.slots[0].preparationVerification=@{state='confirmed';preparationId=$id;preparationSha256=$sha;reviewedAt=$stamp;
    basis='operator_attested';installationUnchanged=$true;preparationUnchanged=$true;reason=$null}
Assert-Schema 'validation-summary' $confirmed2 $true 'confirmed per-slot preparation does not by itself claim overall success'
$bad=Copy-Value $confirmed2; $bad.slots[0].preparationVerification.installationUnchanged=$false
Assert-Schema 'validation-summary' $bad $false 'changed installation cannot remain confirmed'
$bad=Copy-Value $summary; $bad.formalQualified=$false
Assert-Schema 'validation-summary' $bad $false 'legacy summary format is not silently extended'

# Version 3 adds retained static inspection to each frozen unit; input and review remain v2.
$staticInspection=@{javaPath='C:\fixture\bin\java.exe';libraryDirectory='C:\fixture\cli\lib';
    classpath=@('C:\fixture\cli\lib\maestro-cli.jar');
    implementationFiles=@(@{path='C:\fixture\bin\java.exe';sha256=$sha},
        @{path='C:\fixture\scripts\ci\InspectFlows.java';sha256=$sha},
        @{path='C:\fixture\cli\lib\maestro-cli.jar';sha256=$sha});
    evidenceFiles=@(@{path='C:\fixture\static\login\static-request.json';sha256=$sha},
        @{path='C:\fixture\static\login\static-flows.json';sha256=$sha},
        @{path='C:\fixture\static\login\static-parser.stdout.log';sha256=$sha},
        @{path='C:\fixture\static\login\static-parser.stderr.log';sha256=$sha});
    dependencies=@(@{path='C:\fixture\flows\login.yaml';sha256=$sha;kind='yaml'});scriptsExecuted=$false}
$frozen3=Copy-Value $frozen2; $frozen3.schemaVersion=3; $frozen3.units[0].staticInspection=Copy-Value $staticInspection
Assert-Schema 'validation-plan' $frozen3 $true 'v3 development freeze requires retained static inspection'
$formalFrozen3=Copy-Value $formalFrozen2; $formalFrozen3.schemaVersion=3; $formalFrozen3.units[0].staticInspection=Copy-Value $staticInspection
Assert-Schema 'validation-plan' $formalFrozen3 $true 'v3 formal freeze retains runtime and preparation requirements'
$scriptFrozen3=Copy-Value $frozen3
$scriptFrozen3.units[0].sources+=@{path='C:\fixture\flows\helper.js';sha256=$sha}
$scriptFrozen3.units[0].staticInspection.dependencies+=@{path='C:\fixture\flows\helper.js';sha256=$sha;kind='script'}
Assert-Schema 'validation-plan' $scriptFrozen3 $true 'static script dependencies are explicit without claiming execution'
$bad=Copy-Value $frozen3; $null=$bad.units[0].Remove('staticInspection')
Assert-Schema 'validation-plan' $bad $false 'v3 cannot omit unit static inspection'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.scriptsExecuted=$true
Assert-Schema 'validation-plan' $bad $false 'static inspection cannot claim script execution'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.dependencies[0].kind='asset'
Assert-Schema 'validation-plan' $bad $false 'unknown static dependency kind is rejected'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.dependencies[0].sha256='invalid'
Assert-Schema 'validation-plan' $bad $false 'static dependency hash is required'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.dependencies[0].path='outside.js'
Assert-Schema 'validation-plan' $bad $false 'frozen dependency identity must be absolute'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.dependencies=@()
Assert-Schema 'validation-plan' $bad $false 'static dependency list cannot be empty'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.classpath=@()
Assert-Schema 'validation-plan' $bad $false 'static parser classpath cannot be empty'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.evidenceFiles=@($staticInspection.evidenceFiles[0])
Assert-Schema 'validation-plan' $bad $false 'static request response and both logs must be retained'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.implementationFiles=@($staticInspection.implementationFiles[0])
Assert-Schema 'validation-plan' $bad $false 'static parser implementation retains Java helper and classpath'
$bad=Copy-Value $frozen3; $bad.units[0].staticInspection.runtimeSandbox=$true
Assert-Schema 'validation-plan' $bad $false 'static inspection rejects an undeclared runtime sandbox claim'
Assert-Schema 'validation-plan' $frozen3 $false 'v3 is not accepted by the original v2 schema' 2
$bad=Copy-Value $frozen2; $bad.units[0].staticInspection=Copy-Value $staticInspection
Assert-Schema 'validation-plan' $bad $false 'legacy v2 does not acquire v3 inspection fields'
$bad=Copy-Value $plan2; $bad.schemaVersion=3
Assert-Schema 'validation-plan-input' $bad $false 'v3 output does not introduce a v3 input protocol' 2

$summary3=Copy-Value $summary2; $summary3.schemaVersion=3; $summary3.staticInspectionComplete=$false; $summary3.staticInspectionError=$null
$summary3.groups[0].staticInspectionComplete=$false
Assert-Schema 'validation-summary' $summary3 $true 'v3 summary records unverified static inspection explicitly'
$bad=Copy-Value $summary3; $null=$bad.Remove('staticInspectionComplete')
Assert-Schema 'validation-summary' $bad $false 'v3 summary requires the overall static result'
$bad=Copy-Value $summary3; $null=$bad.Remove('staticInspectionError')
Assert-Schema 'validation-summary' $bad $false 'v3 summary retains an explicit nullable static failure reason'
$bad=Copy-Value $summary3; $bad.staticInspectionError=$false
Assert-Schema 'validation-summary' $bad $false 'static failure reason must be text or null'
$failedStatic3=Copy-Value $summary3; $failedStatic3.staticInspectionError='Retained static parser evidence changed.'
Assert-Schema 'validation-summary' $failedStatic3 $true 'static verification failure retains its reason without qualification'
$bad=Copy-Value $summary3; $null=$bad.groups[0].Remove('staticInspectionComplete')
Assert-Schema 'validation-summary' $bad $false 'v3 summary requires each group static result'
$bad=Copy-Value $summary3; $bad.staticInspectionComplete='true'
Assert-Schema 'validation-summary' $bad $false 'static inspection completion must be a boolean'
$bad=Copy-Value $summary3; $bad.formalEligible=$true
Assert-Schema 'validation-summary' $bad $false 'formal eligibility requires verified static inspection'
$bad=Copy-Value $summary3; $bad.qualified=$true
Assert-Schema 'validation-summary' $bad $false 'v3 qualification requires verified static inspection'
$bad=Copy-Value $summary3; $bad.groups[0].complete=$true
Assert-Schema 'validation-summary' $bad $false 'v3 group completeness requires verified static inspection'
$bad=Copy-Value $summary3; $bad.groups[0].qualified=$true
Assert-Schema 'validation-summary' $bad $false 'v3 group qualification requires verified static inspection'
$bad=Copy-Value $summary3; $bad.groups[0].formalEligible=$true
$bad.groups[0].runtimeComplete=$true; $bad.groups[0].preparationComplete=$true
Assert-Schema 'validation-summary' $bad $false 'group formal eligibility also requires static inspection'
$staticSummary3=Copy-Value $summary3; $staticSummary3.staticInspectionComplete=$true; $staticSummary3.groups[0].staticInspectionComplete=$true
Assert-Schema 'validation-summary' $staticSummary3 $true 'static inspection alone does not assert execution or qualification'
Assert-Schema 'validation-summary' $summary3 $false 'v3 summary is not accepted by the original v2 schema' 2
$bad=Copy-Value $summary2; $bad.staticInspectionComplete=$true
Assert-Schema 'validation-summary' $bad $false 'legacy v2 summary is not silently upgraded'

$review2=Copy-Value $review; $review2.schemaVersion=2
Assert-Schema 'validation-review' $review2 $true 'v2 review can leave preparation unknown'
$review2.slots[0].preparation=@{preparationSha256=$sha;installationUnchanged=$true;preparationUnchanged=$true}
Assert-Schema 'validation-review' $review2 $true 'v2 preparation review is tied to a frozen reference'
$bad=Copy-Value $review2; $bad.slots[0].preparation.installationUnchanged='true'
Assert-Schema 'validation-review' $bad $false 'preparation review confirmations must be booleans'
$bad=Copy-Value $review2; $null=$bad.slots[0].preparation.Remove('preparationUnchanged')
Assert-Schema 'validation-review' $bad $false 'both preparation review decisions are explicit'
$bad=Copy-Value $review2; $bad.slots[0].preparation.extra='ignored'
Assert-Schema 'validation-review' $bad $false 'preparation review rejects unknown fields'
$unknownReview2=Copy-Value $review2; $unknownReview2.slots[0].preparation=$null
Assert-Schema 'validation-review' $unknownReview2 $true 'null preparation review remains unknown'
$bad=Copy-Value $review2; $bad.schemaVersion=1
Assert-Schema 'validation-review' $bad $false 'v1 review cannot acquire v2 preparation semantics'

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
            $traceVersion = $null
            foreach ($line in Get-Content -LiteralPath $file.FullName) {
                $event = $line | ConvertFrom-Json -AsHashtable
                if ($null -eq $traceVersion) {
                    if ($event.event -ne 'traceStarted' -or $event.schemaVersion -notin @(1,2)) { throw 'Trace must start with a supported version header.' }
                    $traceVersion = $event.schemaVersion
                }
                Assert-Schema 'retry-trace' $event $true 'local trace record' $traceVersion; $script:realDocuments++
            }
        }
    }
}
Write-Output ('Schema checks passed: ' + $script:checks + '; local documents/records checked: ' + $script:realDocuments + '. No device commands or artifact writes performed.')
