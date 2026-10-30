import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { verifyVideos } from '../ci/verify-videos.mjs';
import { hash, hashFile } from '../validation/io.mjs';
import { traceFixture, json } from './validation-fixture.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.join(repo, 'artifacts/ci-video-tests');
const powershell = process.env.CI_TEST_POWERSHELL ?? execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const document = (kind, data) => ({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, revision: 1, observedAt: new Date().toISOString(), data });
const decoderFixture = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const [input, decoder, output, pointer, timeout] = process.argv.slice(2);
const project = path.dirname(path.dirname(process.argv[1]));
let mode = JSON.parse(await fs.readFile(path.join(project,'mode.json'),'utf8')).mode;
await fs.appendFile(path.join(project,'calls.log'), input+'\n');
if(mode==='failed-first') mode=path.basename(input).includes('-0.')?'failed':'passed';
const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
const directory=path.join(output,'recording-'+randomUUID().replaceAll('-','')); await fs.mkdir(directory);
const bytes=await fs.readFile(input), digest=sha(bytes), decoderHash=sha(await fs.readFile(decoder));
const reportPath=path.join(directory,'verification.json'), now=new Date().toISOString();
const value={protocol:'maestro.harmonyos.recording-verification',schemaVersion:1,status:'passed',startedAt:now,endedAt:now,
 inputPath:input,inputSha256:digest,inputSha256After:digest,bytes:bytes.length,decoderPath:decoder,decoderSha256:decoderHash,
 decoderVersion:'ffmpeg version fixture',timeoutSeconds:Number(timeout),arguments:['-nostdin','-hide_banner','-loglevel','error','-xerror','-err_detect','explode','-i',input,
 '-map','0:v:0','-an','-sn','-dn','-fps_mode','passthrough','-enc_time_base','-1','-progress','pipe:1','-nostats','-f','null','NUL'],
 exitCode:0,timedOut:false,frames:2,progressEnded:true,error:null,stdout:'decode.stdout.log',stderr:'decode.stderr.log'};
if(mode==='failed'){value.status='failed';value.exitCode=7;value.error='fixture decoder failure';}
if(mode==='zero-frames') value.frames=0;
if(mode==='unfinished') value.progressEnded=false;
if(mode==='timed-out') value.timedOut=true;
if(mode==='wrong-input') value.inputPath=path.join(project,'another.mp4');
if(mode==='wrong-decoder') value.decoderSha256='0'.repeat(64);
if(mode==='wrong-arguments') value.arguments=['-i',input,'-frames:v','1'];
if(mode==='missing-field') delete value.inputSha256After;
await fs.writeFile(path.join(directory,value.stdout), mode==='empty-progress'?'':'frame=2\nprogress=end\n');
await fs.writeFile(path.join(directory,value.stderr),mode==='stderr'?'decode warning\n':'');
if(mode==='version-log') await fs.writeFile(path.join(directory,'version.log'),'ffmpeg version fixture\n');
let reportText=JSON.stringify(value);
if(mode==='duplicate-report') reportText=reportText.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1');
await fs.writeFile(reportPath,reportText);
const reference={protocol:'maestro.harmonyos.recording-report-pointer',schemaVersion:1,reportPath,reportSha256:sha(Buffer.from(reportText))};
if(mode==='wrong-hash') reference.reportSha256='0'.repeat(64);
if(mode==='outside-pointer') reference.reportPath=path.join(project,'foreign.json');
if(mode==='source-mutation') await fs.appendFile(input,'changed after report');
if(mode==='decoder-mutation') await fs.appendFile(decoder,'changed after report');
if(mode!=='missing-pointer') {
 let text=JSON.stringify(reference);
 if(mode==='duplicate-pointer') text=text.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1');
 await fs.writeFile(pointer,text,{flag:'wx'});
}
console.log('Do not infer report paths from this stdout: '+reportPath);
if(mode==='failed'||mode==='nonzero-process') process.exitCode=7;
`;

async function setup(t, count = 1) {
  const root = path.join(parent, randomUUID()), project = path.join(root, 'project with spaces'), output = path.join(root, 'ci-output');
  await fs.mkdir(path.join(project, 'scripts'), { recursive: true }); await fs.mkdir(output);
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const helper = path.join(project, 'scripts/verify-recording.ps1');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await fs.writeFile(path.join(project, 'scripts/fixture-sleeper.ps1'), 'Start-Sleep -Seconds 60\n');
  const cleanup = path.join(project, 'scripts/cleanup-child.ps1');
  await fs.writeFile(cleanup, `param([string]$IdentityPath)
$ErrorActionPreference = 'Stop'
$identity = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
$process = $null
try {
  try { $process = [Diagnostics.Process]::GetProcessById([int]$identity.pid) } catch [ArgumentException] { '{"wasAlive":false,"exitConfirmed":true}'; exit 0 }
  if ([string]$process.StartTime.ToUniversalTime().Ticks -cne $identity.startTimeTicks -or
      -not [string]::Equals($process.MainModule.FileName, $identity.executable, [StringComparison]::OrdinalIgnoreCase)) { throw 'Owned child process identity changed; refusing to stop it.' }
  $process.Kill()
  if (-not $process.WaitForExit(5000)) { throw 'Owned child did not exit within the cleanup budget.' }
  '{"wasAlive":true,"exitConfirmed":true}'
} finally { if ($null -ne $process) { $process.Dispose() } }
`);
  await fs.writeFile(helper, `param($InputPath,$FfmpegPath,$OutputDirectory,$TimeoutSeconds,$ReportPointerPath)
$mode = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../mode.json') -Raw | ConvertFrom-Json).mode
if ($mode -eq 'hang') {
  $childScript = Join-Path $PSScriptRoot 'fixture-sleeper.ps1'
  $child = Start-Process -FilePath ${quote(powershell)} -ArgumentList @('-NoProfile','-File',('"' + $childScript + '"')) -WindowStyle Hidden -PassThru
  try {
    $identity = @{ pid=$child.Id; startTimeTicks=[string]$child.StartTime.ToUniversalTime().Ticks; executable=$child.MainModule.FileName }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot '../child-identity.json'),($identity | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  } finally { $child.Dispose() }
  Start-Sleep -Seconds 40; exit 7
}
& ${quote(process.execPath)} (Join-Path $PSScriptRoot 'fixture-decoder.mjs') $InputPath $FfmpegPath $OutputDirectory $ReportPointerPath $TimeoutSeconds
exit $LASTEXITCODE
`);
  await fs.writeFile(path.join(project, 'scripts/fixture-decoder.mjs'), decoderFixture); await json(path.join(project, 'mode.json'), { mode: 'passed' });
  const decoder = path.join(root, 'fake decoder.exe'); await fs.writeFile(decoder, 'inert decoder identity; fixture runner does not execute this file');
  const agentRoot = path.join(root, 'agent'), runId = randomUUID(), attemptId = randomUUID(), base = path.join(agentRoot, 'runs', runId, attemptId);
  const content = 'appId: org.example.fixture\n---\n- assertTrue: true\n', sourceHash = hash(Buffer.from(content));
  const flows = [], traces = [], links = [], sources = [];
  await fs.mkdir(path.join(base, 'media'), { recursive: true }); await fs.mkdir(path.join(base, 'sources'));
  await fs.writeFile(path.join(base, 'sources', sourceHash + '.yaml'), content);
  for (let i = 0; i < count; i++) {
    const source = path.join(project, 'flows', String.fromCharCode(65 + i) + '.yaml'); await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, content);
    sources.push({ path: source, sha256: sourceHash }); flows.push({ path: source, sha256: sourceHash, name: 'flow-' + i, requiredSteps: [] });
    const identity = { protocol: 'maestro.harmonyos.retry-trace', schemaVersion: 2, runId, attemptId, flowExecutionId: randomUUID(), flowPath: source, flowSha256: sourceHash };
    const trace = traceFixture(identity, { sha256: sourceHash });
    for (const event of trace.events) if (event.event === 'stepStarted' || event.event === 'stepFinished') event.sourceIdentity = source;
    traces.push(trace);
    const file = 'media/unrelated-layout-' + i + '.mp4'; await fs.writeFile(path.join(base, file), 'small synthetic video bytes ' + i);
    links.push({ flow: i, stepId: trace.entries[0].stepId, path: file });
  }
  const input = { kind: 'flow', deviceId: 'fixture-device', request: { sources: [{ path: flows[0].path,
    files: sources.map(file => ({ ...file, content, dependencies: [] })) }], configuration: { ability: 'EntryAbility', module: null, environment: { APP_ID: 'org.example.fixture' } } } };
  await json(path.join(base, 'input.json'), input); await json(path.join(base, 'state.json'), {}); await json(path.join(base, 'registration.json'), {});
  const result = document('runResult', { runId, attemptId, deviceId: 'fixture-device', status: 'passed', cleanup: { state: 'complete', errors: [] },
    error: null, failedStepId: null, input: { path: 'input.json', sha256: await hashFile(path.join(base, 'input.json')) }, flow: null,
    artifacts: { baseDir: base, evidenceIndexPath: 'evidence-index.json', manifestPaths: ['agent-manifest.json'], junitPath: null } });
  const index = document('evidenceIndex', { runId, attemptId, entries: [] });
  const snapshot = { projectRoot: project, powershellPath: powershell, units: [{ entry: flows[0].path, sources, requiredTopLevelFlows: flows }],
    profiles: { suite: { bundleId: 'org.example.fixture', abilityName: 'EntryAbility', moduleName: null, environmentHashes: {} } },
    toolFiles: [{ path: helper, sha256: await hashFile(helper) }, { path: powershell, sha256: await hashFile(powershell) }],
    videoPolicy: { requiredFlows: flows.map(flow => flow.path), ffmpeg: { path: decoder, sha256: await hashFile(decoder) }, timeoutSeconds: 1, maxVideos: count + 1, budgetSeconds: (count + 1) * 21 + 10 } };
  const context = { root, project, output, decoder, agentRoot, base, result, index, snapshot, traces, links, cleanup,
    mode: mode => json(path.join(project, 'mode.json'), { mode }),
    async refresh() {
      const logs = []; index.data.entries = traces.flatMap(trace => trace.entries.map(entry => ({ ...entry, evidence: [] })));
      for (const [i, trace] of traces.entries()) {
        const relative = 'traces/' + i, bytes = Buffer.from(trace.events.map(event => JSON.stringify(event)).join('\n') + '\n');
        trace.summary.traceSha256 = hash(bytes); await json(path.join(base, relative, 'retry-summary.json'), trace.summary);
        await fs.writeFile(path.join(base, relative, 'retry-trace.jsonl'), bytes);
        for (const name of ['retry-summary.json', 'retry-trace.jsonl']) logs.push({ kind: 'log', state: 'available', path: relative + '/' + name, sha256: await hashFile(path.join(base, relative, name)) });
      }
      index.data.entries.push({ stepId: null, source: null, status: 'passed', evidence: logs });
      for (const link of links) {
        const entry = index.data.entries.find(entry => entry.stepId === link.stepId);
        assert.ok(entry); entry.evidence.push({ kind: 'video', state: 'available', path: link.path, sha256: await hashFile(path.join(base, link.path)) });
      }
      await json(path.join(base, 'result.json'), result); await json(path.join(base, 'evidence-index.json'), index);
      const files = [];
      for (const name of ['input.json', 'result.json', 'state.json', 'registration.json', 'evidence-index.json']) files.push({ path: name, sha256: await hashFile(path.join(base, name)) });
      await json(path.join(base, 'agent-manifest.json'), { schemaVersion: 1, runId, attemptId, files });
    },
    run: () => verifyVideos({ snapshot, result, index, agentRoot, outputDirectory: output }) };
  await context.refresh(); return context;
}

test('trace step IDs bind same-content A/B Flows; every available video is independently decoded', async t => {
  const f = await setup(t, 2); f.snapshot.videoPolicy.requiredFlows = [f.snapshot.units[0].requiredTopLevelFlows[0].path];
  const before = await hashFile(path.join(f.base, 'result.json')), result = await f.run();
  assert.equal(result.status, 'passed', result.error); assert.equal(result.videos.length, 2);
  for (const [i, video] of result.videos.entries()) { assert.equal(video.status, 'passed'); assert.equal(video.flowPath, f.snapshot.units[0].requiredTopLevelFlows[i].path); assert.ok(video.pointer.sha256); assert.equal(video.process.descendantExitConfirmed, true); }
  assert.notEqual(path.dirname(result.videos[0].pointer.path), path.dirname(result.videos[1].pointer.path));
  assert.equal(await hashFile(path.join(f.base, 'result.json')), before); assert.equal(f.result.data.cleanup.state, 'complete');
});

test('B video cannot satisfy required A despite identical source content', async t => {
  const f = await setup(t, 2); f.links.splice(0, 1); await f.refresh();
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.match(result.error, /Required Flow/);
  assert.equal(result.videos[0].status, 'passed'); assert.equal(result.coverage[0].videos.length, 0);
});

test('shared paths, unattributed steps, wrong source identity and maxVideos are rejected before decoding', async t => {
  for (const mode of ['shared-path', 'null-step', 'wrong-identity', 'max-videos']) await t.test(mode, async t => {
    const f = await setup(t, 2);
    if (mode === 'shared-path') f.links[1].path = f.links[0].path;
    if (mode === 'null-step') f.links[0].stepId = null;
    if (mode === 'wrong-identity') for (const event of f.traces[0].events) if (event.sourceIdentity) event.sourceIdentity += '.unregistered';
    if (mode === 'max-videos') f.snapshot.videoPolicy.maxVideos = 1;
    await f.refresh(); assert.equal((await f.run()).status, 'failed'); await assert.rejects(fs.stat(path.join(f.project, 'calls.log')), { code: 'ENOENT' });
  });
});

test('invalid decoder reports and pointers cannot produce a passed video assessment', async t => {
  for (const mode of ['failed', 'zero-frames', 'unfinished', 'timed-out', 'wrong-input', 'wrong-decoder', 'missing-field', 'stderr',
    'wrong-hash', 'outside-pointer', 'duplicate-pointer', 'duplicate-report', 'missing-pointer', 'nonzero-process', 'source-mutation', 'decoder-mutation', 'empty-progress', 'wrong-arguments']) await t.test(mode, async t => {
    const f = await setup(t); await f.mode(mode); const result = await f.run(); assert.equal(result.status, 'failed', mode);
    assert.equal(result.videos[0].status, 'failed', mode); assert.ok(result.error);
    if (mode === 'missing-pointer') {
      assert.equal(result.videos[0].process.descendantExitConfirmed, null);
      for (const reference of [result.videos[0].process.stdout, result.videos[0].process.stderr]) assert.equal(await hashFile(reference.path), reference.sha256);
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'ci-videos.json'))).status, 'failed');
  });
});

test('a failed decode keeps its report and does not prevent decoding the other video', async t => {
  const f = await setup(t, 2); await f.mode('failed-first'); const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.videos[0].verification.report.exitCode, 7);
  assert.equal(result.videos[1].status, 'passed'); assert.equal((await fs.readFile(path.join(f.project, 'calls.log'), 'utf8')).trim().split('\n').length, 2);
});

test('an unavailable video fails quality even when another video satisfies the Flow', async t => {
  for (const state of ['missing', 'capture_failed']) await t.test(state, async t => {
    const f = await setup(t);
    f.index.data.entries[0].evidence.push({ kind: 'video', state, path: null, sha256: null });
    await json(path.join(f.base, 'evidence-index.json'), f.index);
    const manifestPath = path.join(f.base, 'agent-manifest.json'), manifest = JSON.parse(await fs.readFile(manifestPath));
    manifest.files.find(file => file.path === 'evidence-index.json').sha256 = await hashFile(path.join(f.base, 'evidence-index.json'));
    await json(manifestPath, manifest);
    const result = await f.run(); assert.equal(result.status, 'failed'); assert.match(result.error, /unavailable/);
    assert.equal(result.videos[0].status, 'passed');
  });
});

test('video quality success preserves a failed outer execution', async t => {
  const f = await setup(t); f.result.data.status = 'failed'; f.result.data.error = { kind: 'transport', code: 'OUTER', message: 'original' }; await f.refresh();
  assert.equal((await f.run()).status, 'passed'); assert.equal(f.result.data.status, 'failed'); assert.equal(f.result.data.error.code, 'OUTER');
});

test('insufficient remaining budget refuses a new decoder and existing output is never overwritten', async t => {
  const f = await setup(t); f.snapshot.videoPolicy.maxVideos = 1; f.snapshot.videoPolicy.budgetSeconds = 31;
  // Keep the valid frozen minimum; simulate 11 seconds already spent checking inputs.
  const realNow = performance.now.bind(performance), open = fs.open; let consumed = false;
  t.mock.method(performance, 'now', () => realNow() + (consumed ? 11000 : 0));
  t.mock.method(fs, 'open', (...args) => { if (args[0] === f.decoder) consumed = true; return open(...args); });
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.match(result.error, /budget/);
  await assert.rejects(fs.stat(path.join(f.project, 'calls.log')), { code: 'ENOENT' });
  await assert.rejects(f.run(), /already exists/);
});

test('output inside the original attempt is refused before writing any diagnostic file', async t => {
  const f = await setup(t);
  await assert.rejects(verifyVideos({ snapshot: f.snapshot, result: f.result, index: f.index, agentRoot: f.agentRoot, outputDirectory: f.base }), /overlaps/);
  await assert.rejects(fs.stat(path.join(f.base, 'ci-videos.json')), { code: 'ENOENT' });
});

test('a hung verifier is bounded and only its own process is stopped', async t => {
  const f = await setup(t); f.snapshot.videoPolicy.maxVideos = 1; f.snapshot.videoPolicy.budgetSeconds = 31;
  await f.mode('hang'); const start = performance.now(); let reclaimed;
  try {
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.videos[0].process.timedOut, true);
    assert.equal(result.videos[0].process.descendantExitConfirmed, null);
    assert.ok(performance.now() - start < 26000, 'Verifier exceeded its bounded termination margin.');
  } finally {
    reclaimed = JSON.parse(execFileSync(powershell, ['-NoProfile', '-File', f.cleanup, '-IdentityPath', path.join(f.project, 'child-identity.json')],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  }
  assert.equal(reclaimed.wasAlive, true, 'The fixture must exercise a child whose exit was not implied by the wrapper exit.');
  assert.equal(reclaimed.exitConfirmed, true);
});

test('existing decoder version output is fingerprinted without inventing absent version logs', async t => {
  const f = await setup(t); await f.mode('version-log'); const result = await f.run();
  assert.equal(result.status, 'passed', result.error);
  const versions = result.originalFiles.filter(file => path.basename(file.path) === 'version.log');
  assert.equal(versions.length, 1); assert.equal(await hashFile(versions[0].path), versions[0].sha256);
});

test('direct helper calls obey the frozen maximums and minimum total budget', async t => {
  for (const change of [{ maxVideos: 101 }, { budgetSeconds: 86401 }, { budgetSeconds: 30, maxVideos: 1 }]) await t.test(JSON.stringify(change), async t => {
    const f = await setup(t); Object.assign(f.snapshot.videoPolicy, change);
    assert.equal((await f.run()).status, 'failed'); await assert.rejects(fs.stat(path.join(f.project, 'calls.log')), { code: 'ENOENT' });
  });
});
