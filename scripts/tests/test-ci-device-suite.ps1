[CmdletBinding()]
param([string]$TestArtifactsRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testParent = if ($TestArtifactsRoot) { [IO.Path]::GetFullPath($TestArtifactsRoot) } else { Join-Path $projectRoot 'artifacts/ci-tests' }
$testRoot = Join-Path $testParent ([guid]::NewGuid().ToString('N').Substring(0, 8))
$fixture = Join-Path $testRoot 'checkout with spaces'
$stateRoot = Join-Path $testRoot 'persistent'
$recoveryRoot = Join-Path $testRoot 'recovery'
$utf8 = [Text.UTF8Encoding]::new($false)
$savedEnvironment = [Environment]::GetEnvironmentVariables('Process')
$passed = 0
$skipped = 0
$completed = $false
function Assert-Test { param([bool]$Value, [string]$Message) if (-not $Value) { throw $Message } }
function Write-TestFile { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, $utf8) }
function Read-State {
    param([string]$Device)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($Device)))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
    $file = Join-Path $stateRoot ($key + '.json')
    if (Test-Path -LiteralPath $file) { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json }
    return $null
}
function Invoke-Fixture {
    param([string]$Mode, [string]$Device = 'fixture-a', [switch]$Recover, [string[]]$Extra = @(), [string]$ArtifactOverride)
    $env:CI_FIXTURE_MODE = $Mode
    $arguments = @('-NoProfile', '-File', (Join-Path $fixture 'scripts/ci/run-device-suite.ps1'), '-DeviceId', $Device,
        '-DeviceStateDirectory', $stateRoot, '-RecoveryRoot', $recoveryRoot)
    if ($Recover) { $arguments += @('-ReconcileOnly', '-RecoveryReportPath', (Join-Path $testRoot ($Device + '.response.json'))) }
    else {
        $outputRoot = if ($ArtifactOverride) { $ArtifactOverride } else { Join-Path $testRoot 'outputs' }
        $arguments += @('-SuiteManifest', (Join-Path $fixture 'suite.json'), '-ArtifactsRoot', $outputRoot, '-RunTimeoutSeconds', '5')
    }
    $arguments += $Extra
    $savedPreference = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; $output = @(& $shell @arguments 2>&1); $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $savedPreference }
    return [pscustomobject]@{ ExitCode = $code; Output = ($output | Out-String); State = (Read-State $Device) }
}
try {
    foreach ($directory in @($testRoot, (Join-Path $fixture 'scripts/ci'), (Join-Path $fixture 'examples/agent-client'))) {
        $null = [IO.Directory]::CreateDirectory($directory)
    }
    $shell = (Get-Process -Id $PID).Path
    foreach ($file in @('scripts/ci/run-device-suite.ps1', 'scripts/ci/verify-state.mjs', 'scripts/ci/device-reservation.ps1', 'examples/agent-client/evidence.mjs', 'examples/agent-client/client.mjs')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $fixture $file)
    }
    Write-TestFile (Join-Path $fixture 'flow.yaml') "appId: org.example.fixture`n---`n- launchApp`n"
    Write-TestFile (Join-Path $fixture 'suite.json') '{"schemaVersion":1,"suiteId":"fixture","flowPath":"flow.yaml","bundleId":"org.example.fixture","abilityName":"EntryAbility"}'
    $env:CI_FIXTURE_ROOT = $testRoot
    $env:CI_FIXTURE_RECOVERY = $recoveryRoot
    $fakeRunner = @'
param($FlowPath, $BundleId, $AbilityName, $DeviceId, $Env, $Artifacts, $AgentRoot, $RunId, $AttemptId, $RunTimeoutSeconds, $TerminationWaitSeconds, $OutputDrainSeconds, $ControlRecordPath, $Module)
$ErrorActionPreference = 'Stop'
if ($env:CI_FIXTURE_MODE -eq 'before-control') { [Environment]::Exit(87) }
$inputFile = Join-Path $env:CI_FIXTURE_ROOT ($DeviceId + '.input.json')
$value = @{ deviceId=$DeviceId; artifacts=$Artifacts; agentRoot=$AgentRoot; runId=$RunId; attemptId=$AttemptId; controlPath=$ControlRecordPath; mode=$env:CI_FIXTURE_MODE }
[IO.File]::WriteAllText($inputFile, ($value | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
& node (Join-Path $env:CI_FIXTURE_ROOT 'fixture.mjs') $inputFile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($env:CI_FIXTURE_MODE -eq 'hard-stop') { [Environment]::Exit(86) }
if ($env:CI_FIXTURE_MODE -eq 'failed') { exit 7 }
exit 0
'@
    Write-TestFile (Join-Path $fixture 'scripts/run-harmonyos.ps1') $fakeRunner
    $nodeFixture = @'
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const root = process.env.CI_FIXTURE_ROOT;
const recoveryRoot = process.env.CI_FIXTURE_RECOVERY;
const hash = text => createHash('sha256').update(text).digest('hex');
const key = hash(input.deviceId);
const write = async (file, value) => { await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, JSON.stringify(value, null, 2)); };
const document = (kind, data, version=1) => ({protocol:'maestro.harmonyos.agent',schemaVersion:version,kind,revision:1,observedAt:new Date().toISOString(),data});
const gatePath = path.join(recoveryRoot, `${key}.owner.json`);
async function release(owner, state='complete') {
  const recoveryId=randomUUID();
  const reportPath=path.join(recoveryRoot,key,owner,'recoveries',`${recoveryId}.json`);
  const audit={schemaVersion:1,recoveryId,deviceId:input.deviceId,sessionId:owner,observedAt:new Date().toISOString(),reason:'recovery',
    previousState:'quarantined',previousReportPath:null,previousReportSha256:null,requiresRecovery:false,uncertainReason:null,
    unresolvedRecording:false,closeFailure:null,state,operations:1,pendingOperations:state==='complete'?0:1,temporaryFiles:0,issues:state==='complete'?[]:[{code:'UNCONFIRMED'}]};
  if(input.mode.startsWith('recording-')) {
    const generation=randomUUID(), id=randomUUID();
    const ownerDirectory=path.join(recoveryRoot,key,owner);
    const raw=Buffer.from('original fixture video bytes; no decoding claim');
    const archive={name:`${id}-${randomUUID()}.mp4`,size:raw.length,sha256:hash(raw)};
    const original=path.join(ownerDirectory,'recording-originals',archive.name);
    await fs.mkdir(path.dirname(original),{recursive:true}); await fs.writeFile(original,raw);
    const fileName=`maestro-recording-${id.replaceAll('-','')}.mp4`;
    const remoteRoot=`/data/local/tmp/maestro-session-${generation}`;
    const snapshot={schemaVersion:1,deviceId:input.deviceId,ownerId:owner,generation,remoteRoot,resources:[{
      id,fileName,remotePath:`${remoteRoot}/files/recording-${randomUUID()}.mp4`,startRequested:true,startAcknowledged:true,ownerPid:51,
      stopRequested:true,captureEnded:true,uri:`file://media/Photo/123/VID_123/${fileName}`,archiveName:archive.name,archiveSize:archive.size,
      archiveSha256:archive.sha256,mediaRemoved:true,clean:input.mode!=='recording-unclean',failureFingerprint:null,archives:[archive]}]};
    const snapshotPath=path.join(path.dirname(reportPath),`${recoveryId}-recordings.json`);
    await write(snapshotPath,snapshot);
    audit.schemaVersion=2;
    audit.recordingResources={path:snapshotPath,sha256:hash(await fs.readFile(snapshotPath))};
    if(input.mode==='recording-bad-snapshot') await fs.appendFile(snapshotPath,' ');
    if(input.mode==='recording-bad-original') await fs.writeFile(original,Buffer.alloc(raw.length,88));
  }
  await write(reportPath,audit);
  const reportSha256=hash(await fs.readFile(reportPath));
  const gate={schemaVersion:1,deviceId:input.deviceId,ownerSessionId:owner,state:state==='complete'?'clean':'quarantined',
    journalPath:path.join(recoveryRoot,key,owner,'recovery-journal.json'),updatedAt:new Date().toISOString(),closeFailure:null,
    reportPath,reportSha256,requiresRecovery:false,uncertainReason:null,unresolvedRecording:false};
  await write(gatePath,gate);
  await write(path.join(root,`${input.deviceId}.response.json`),document('recoveryReport',{
    deviceId:input.deviceId,sessionId:owner,state,cleanup:{state:state==='complete'?'complete':'unknown',errors:[]},handoffReady:state==='complete',
    operations:audit.operations,pendingOperations:audit.pendingOperations,temporaryFiles:0,reportPath,reportSha256},2));
}
if (process.argv[3]==='recover') {
  const gate=JSON.parse(await fs.readFile(gatePath,'utf8')); await release(gate.ownerSessionId); process.exit(0);
}
await fs.appendFile(path.join(root,'calls.log'),input.deviceId+'\n');
const owner=randomUUID();
await release(owner,input.mode==='hard-stop'?'unknown':'complete');
const base=path.join(input.agentRoot,'runs',input.runId,input.attemptId);
await fs.mkdir(base,{recursive:true});
await fs.writeFile(path.join(base,'input.json'),JSON.stringify({flow:'appId: fixture\n---\n- launchApp\n'}));
await fs.writeFile(path.join(base,'junit.xml'),'<testsuites><testsuite tests="1" failures="0"/></testsuites>');
await fs.mkdir(path.join(base,'maestro'),{recursive:true});
await fs.writeFile(path.join(base,'maestro','manifest.json'),JSON.stringify({commands:[]}));
await fs.writeFile(path.join(base,'fixture.log'),'retained evidence');
const status=input.mode==='failed'?'failed':'passed';
const stepId=randomUUID();
const result=document('runResult',{runId:input.runId,attemptId:input.attemptId,attemptNo:1,sessionId:null,deviceId:input.deviceId,flow:null,
  status,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),effects:'observed',error:status==='passed'?null:{kind:'assertion',code:'ASSERTION_FAILED',message:'fixture'},
  cleanup:{state:'complete',errors:[]},failedStepId:status==='failed'?stepId:null,input:{kind:'flow',path:'input.json',sha256:hash(await fs.readFile(path.join(base,'input.json')))},
  artifacts:{baseDir:base,manifestPaths:['agent-manifest.json','maestro/manifest.json'],junitPath:'junit.xml',evidenceIndexPath:'evidence-index.json'}});
await write(path.join(base,'result.json'),result);
const evidence=document('evidenceIndex',{runId:input.runId,attemptId:input.attemptId,entries:[{stepId,source:null,status,error:null,evidence:[{
  kind:'log',state:'available',path:'fixture.log',sha256:hash(await fs.readFile(path.join(base,'fixture.log'))),capturedAt:new Date().toISOString(),phase:'after',error:null}]}]});
await write(path.join(base,'evidence-index.json'),evidence);
await write(path.join(base,'state.json'),{result,evidence});
await write(path.join(base,'registration.json'),{sha256:result.data.input.sha256,attemptNo:1,data:result.data});
const metadata={schemaVersion:1,runId:input.runId,attemptId:input.attemptId,files:[]};
for(const relative of ['input.json','result.json','evidence-index.json','state.json','registration.json','maestro/manifest.json','junit.xml']) {
  metadata.files.push({path:relative,sha256:hash(await fs.readFile(path.join(base,...relative.split('/'))))});
}
await write(path.join(base,'agent-manifest.json'),metadata);
if(input.mode==='tampered') await fs.writeFile(path.join(base,'input.json'),'changed');
if(input.mode==='tampered-index') { evidence.data.entries=[]; await write(path.join(base,'evidence-index.json'),evidence); }
if(input.mode==='tampered-native') await fs.writeFile(path.join(base,'maestro','manifest.json'),'changed');
if(input.mode==='tampered-junit') await fs.writeFile(path.join(base,'junit.xml'),'<testsuites/>');
if(input.mode==='omitted-metadata') { metadata.files=metadata.files.filter(item=>item.path!=='evidence-index.json'); await write(path.join(base,'agent-manifest.json'),metadata); }
await write(input.controlPath,{protocol:'maestro.harmonyos.runner-control',schemaVersion:1,runId:input.runId,attemptId:input.attemptId,deviceId:input.deviceId,
  phase:input.mode==='hard-stop'?'running':'exited',process:{pid:2147483000,startTimeTicks:1,executable:'fixture'},processExitObserved:input.mode!=='hard-stop',
  processExitCode:status==='passed'?0:7,wrapperExitCode:status==='passed'?0:7,agentStatus:input.mode==='unknown-control'?'unknown':status,
  terminationRequested:false,stopReason:null,error:null,stdoutComplete:true,stderrComplete:true,runResultPath:path.join(base,'result.json')});
'@
    Write-TestFile (Join-Path $testRoot 'fixture.mjs') $nodeFixture

    $success = Invoke-Fixture 'passed'
    Assert-Test ($success.ExitCode -eq 0 -and $success.State.state -eq 'released' -and $success.State.execution -eq 'passed') ('Normal completion failed: ' + $success.Output)
    Assert-Test ($success.State.resolution.reportSha256 -match '^[0-9a-f]{64}$') 'Release lacks a checked inner receipt.'
    $passed++
    $failure = Invoke-Fixture 'failed'
    Assert-Test ($failure.ExitCode -ne 0 -and $failure.State.state -eq 'released' -and $failure.State.execution -eq 'failed' -and $failure.State.wrapperExitCode -eq 7) 'An assertion failure was converted to success or lost its exit.'
    $passed++
    $recording = Invoke-Fixture 'recording-v2' 'fixture-recording'
    Assert-Test ($recording.ExitCode -eq 0 -and $recording.State.resolution.recordingCheckedFiles -eq 2) ('A clean v2 recording receipt was rejected: ' + $recording.Output)
    foreach ($mode in @('recording-bad-snapshot','recording-unclean','recording-bad-original')) {
        $badRecording = Invoke-Fixture $mode ('fixture-' + $mode)
        Assert-Test ($badRecording.ExitCode -ne 0 -and $badRecording.State.state -eq 'needs_inspection') ('Invalid recording receipt accepted: ' + $mode)
    }
    $passed++

    $tampered = Invoke-Fixture 'tampered' 'fixture-tampered'
    Assert-Test ($tampered.ExitCode -ne 0 -and $tampered.State.state -eq 'needs_inspection') 'Tampered evidence released the device.'
    $count = @(Get-Content -LiteralPath (Join-Path $testRoot 'calls.log')).Count
    $blocked = Invoke-Fixture 'passed' 'fixture-tampered'
    Assert-Test ($blocked.ExitCode -ne 0 -and @(Get-Content -LiteralPath (Join-Path $testRoot 'calls.log')).Count -eq $count) 'A blocked launch started another executor.'
    $passed++

    foreach ($mode in @('tampered-index','tampered-native','tampered-junit','omitted-metadata','unknown-control')) {
        $changed = Invoke-Fixture $mode ('fixture-' + $mode)
        Assert-Test ($changed.ExitCode -ne 0 -and $changed.State.state -eq 'needs_inspection') ('Metadata chain accepted ' + $mode)
        $passed++
    }

    $crash = Invoke-Fixture 'hard-stop' 'fixture-crash'
    Assert-Test ($crash.ExitCode -eq 86 -and $crash.State.state -eq 'running') 'Hard stop unexpectedly ran the outer finally/catch.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $crash.State.artifactDirectory 'ci-result.json'))) 'The hard-stop fixture wrote a final report.'
    $blocked = Invoke-Fixture 'passed' 'fixture-crash'
    Assert-Test ($blocked.ExitCode -ne 0 -and $blocked.State.launchId -eq $crash.State.launchId) 'The durable launch intent did not survive process termination.'
    $passed++
    $unknown = Invoke-Fixture 'unused' 'fixture-crash' -Recover
    Assert-Test ($unknown.ExitCode -ne 0 -and $unknown.State.state -eq 'running') 'Unknown recovery released the outer gate.'
    $passed++

    $gap = Invoke-Fixture 'before-control' 'fixture-gap'
    Assert-Test ($gap.ExitCode -eq 87 -and $gap.State.state -eq 'running' -and -not (Test-Path -LiteralPath $gap.State.controlRecordPath)) 'The pre-control crash fixture did not leave an incomplete launch.'
    $gapRetry = Invoke-Fixture 'passed' 'fixture-gap'
    Assert-Test ($gapRetry.ExitCode -ne 0 -and $gapRetry.State.launchId -eq $gap.State.launchId) 'A missing PID or runner record allowed automatic takeover.'
    $passed++

    $oldResult = Join-Path $crash.State.agentRoot ('runs/' + $crash.State.runId + '/' + $crash.State.attemptId + '/result.json')
    $oldHash = (Get-FileHash -LiteralPath $oldResult -Algorithm SHA256).Hash
    & node (Join-Path $testRoot 'fixture.mjs') (Join-Path $testRoot 'fixture-crash.input.json') recover
    Assert-Test ($LASTEXITCODE -eq 0) 'Could not prepare the local recovery fixture.'
    $responsePath = Join-Path $testRoot 'fixture-crash.response.json'
    $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json
    $validResponse = Get-Content -LiteralPath $responsePath -Raw
    $response.data.reportSha256 = '0' * 64
    Write-TestFile $responsePath ($response | ConvertTo-Json -Depth 12)
    $wrongHash = Invoke-Fixture 'unused' 'fixture-crash' -Recover
    Assert-Test ($wrongHash.ExitCode -ne 0 -and $wrongHash.State.state -eq 'running') 'A wrong recovery hash was accepted.'
    Write-TestFile $responsePath $validResponse
    $response.data.reportSha256 = ($validResponse | ConvertFrom-Json).data.reportSha256
    $response.data.sessionId = [guid]::NewGuid().ToString()
    Write-TestFile $responsePath ($response | ConvertTo-Json -Depth 12)
    $wrongOwner = Invoke-Fixture 'unused' 'fixture-crash' -Recover
    Assert-Test ($wrongOwner.ExitCode -ne 0 -and $wrongOwner.State.state -eq 'running') 'A recovery response for another session was accepted.'
    Write-TestFile $responsePath $validResponse
    $controlText = Get-Content -LiteralPath $crash.State.controlRecordPath -Raw
    $controlValue = $controlText | ConvertFrom-Json
    $live = [Diagnostics.Process]::GetCurrentProcess()
    try { $controlValue.process.pid = $live.Id; $controlValue.process.startTimeTicks = $live.StartTime.ToUniversalTime().Ticks } finally { $live.Dispose() }
    Write-TestFile $crash.State.controlRecordPath ($controlValue | ConvertTo-Json -Depth 12)
    $liveOwner = Invoke-Fixture 'unused' 'fixture-crash' -Recover
    Assert-Test ($liveOwner.ExitCode -ne 0 -and $liveOwner.State.state -eq 'running' -and $liveOwner.Output -match 'still alive') 'Recovery took over a live recorded process.'
    Write-TestFile $crash.State.controlRecordPath $controlText
    $passed++
    $recovered = Invoke-Fixture 'unused' 'fixture-crash' -Recover
    Assert-Test ($recovered.ExitCode -eq 0 -and $recovered.State.state -eq 'released' -and $recovered.State.execution -eq 'unknown') ('Trusted recovery failed or rewrote execution: ' + $recovered.Output)
    Assert-Test ((Get-FileHash -LiteralPath $oldResult -Algorithm SHA256).Hash -eq $oldHash) 'Recovery changed the old execution result.'
    $next = Invoke-Fixture 'passed' 'fixture-crash'
    Assert-Test ($next.ExitCode -eq 0 -and $next.State.launchId -ne $crash.State.launchId) 'A checked recovery did not allow a new launch.'
    $passed++

    $validation = Invoke-Fixture 'hard-stop' 'fixture-validation'
    $value = $validation.State
    $originalControl = Get-Content -LiteralPath $value.controlRecordPath -Raw
    $control = $originalControl | ConvertFrom-Json
    $indexDirectory = Join-Path $stateRoot ('validation-' + $value.launchId)
    $null = [IO.Directory]::CreateDirectory($indexDirectory)
    $recordPath = Join-Path $indexDirectory ($control.attemptId + '.json')
    Write-TestFile $recordPath $originalControl
    $plannedId = [guid]::NewGuid().ToString()
    $index = @{ protocol='maestro.harmonyos.control-index'; schemaVersion=1; invocationId=$value.launchId; matrixRoot=$value.artifactDirectory; entries=@(
        @{ deviceId='fixture-validation'; runId=$control.runId; attemptId=$control.attemptId; attemptNo=1; controlRecordPath=$recordPath; dispatchState='launching' },
        @{ deviceId='fixture-validation'; runId=$control.runId; attemptId=$plannedId; attemptNo=2; controlRecordPath=(Join-Path $indexDirectory ($plannedId + '.json')); dispatchState='planned' }
    ) }
    $value.kind = 'validation'
    $value | Add-Member NoteProperty unitInvocationId $value.launchId
    $value | Add-Member NoteProperty controlIndexPath (Join-Path $indexDirectory 'control-index.json')
    $value.runId = $null; $value.attemptId = $null; $value.controlRecordPath = $null
    Write-TestFile $value.controlIndexPath ($index | ConvertTo-Json -Depth 16)
    $stateFile = Get-ChildItem -LiteralPath $stateRoot -Filter '*.json' | Where-Object { $_.BaseName -match '^[0-9a-f]{64}$' -and (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).deviceId -eq 'fixture-validation' } | Select-Object -First 1
    Write-TestFile $stateFile.FullName ($value | ConvertTo-Json -Depth 20)
    $inputPath = Join-Path $testRoot 'fixture-validation.input.json'
    $recoveryInput = Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json
    $recoveryInput.mode = 'recording-v2'
    Write-TestFile $inputPath ($recoveryInput | ConvertTo-Json)
    & node (Join-Path $testRoot 'fixture.mjs') $inputPath recover
    Assert-Test ($LASTEXITCODE -eq 0) 'Could not prepare the validation recording recovery fixture.'
    Remove-Item -LiteralPath $recordPath
    $missingControl = Invoke-Fixture 'unused' 'fixture-validation' -Recover
    Assert-Test ($missingControl.ExitCode -ne 0 -and $missingControl.State.state -eq 'running') 'An indexed dispatched attempt with no process record was released.'
    Write-TestFile $recordPath $originalControl
    $index.invocationId = [guid]::NewGuid().ToString()
    Write-TestFile $value.controlIndexPath ($index | ConvertTo-Json -Depth 16)
    $wrongInvocation = Invoke-Fixture 'unused' 'fixture-validation' -Recover
    Assert-Test ($wrongInvocation.ExitCode -ne 0 -and $wrongInvocation.State.state -eq 'running') 'A different validation invocation index was accepted.'
    $index.invocationId = $value.launchId
    Write-TestFile $value.controlIndexPath ($index | ConvertTo-Json -Depth 16)
    $reconciled = Invoke-Fixture 'unused' 'fixture-validation' -Recover
    Assert-Test ($reconciled.ExitCode -eq 0 -and $reconciled.State.state -eq 'released' -and $reconciled.State.execution -eq 'unknown' -and $reconciled.State.resolution.recordingCheckedFiles -eq 2) ('Valid multi-attempt recording recovery failed: ' + $reconciled.Output)
    $passed++

    $budget = Invoke-Fixture 'passed' 'fixture-budget' -Extra @('-JobTimeoutSeconds','30')
    Assert-Test ($budget.ExitCode -ne 0 -and $null -eq $budget.State) 'An insufficient platform budget still wrote a launch intent.'
    $passed++
    $alias = Join-Path $testRoot 'artifact-alias'
    $junctionCreated = $false
    try { $null = New-Item -ItemType Junction -Path $alias -Target $testRoot; $junctionCreated = $true }
    catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [UnauthorizedAccessException] -or ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 5) -or $_.CategoryInfo.Category -eq 'PermissionDenied') {
            $skipped++; Write-Output 'SKIP: this host does not permit creating the artifact-junction fixture.'
        } else { throw }
    }
    if ($junctionCreated) {
        try {
            $linked = Invoke-Fixture 'passed' 'fixture-link' -ArtifactOverride $alias
            Assert-Test ($linked.ExitCode -ne 0 -and $null -eq $linked.State) 'An artifact junction pointing at persistent state was accepted.'
        } finally { [IO.Directory]::Delete($alias) }
        $passed++
    }
    $completed = $true
    Write-Output ('PASS: ' + $passed + ' CI behavior checks; skipped=' + $skipped + '. Local fake executors only; no HDC, network, device or CI provider calls.')
} finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if (-not $savedEnvironment.Contains($name)) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    }
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, [string]$savedEnvironment[$name], 'Process') }
    if ($completed -and (Test-Path -LiteralPath $testRoot)) {
        $resolved = (Resolve-Path -LiteralPath $testRoot).Path
        $prefix = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the CI test directory.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    } elseif (Test-Path -LiteralPath $testRoot) { Write-Output ('Retained failed CI fixture: ' + $testRoot) }
}
