import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectArtifacts } from '../ci/collect-artifacts.mjs';
import { maintenanceFixture } from './fixtures/maintenance.mjs';
import { verifyMaintenanceRelease } from '../recovery/verify-maintenance.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.join(repo, 'artifacts/ci-archive-tests');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const fileHash = async file => hash(await fs.readFile(file));
const document = (kind, data) => ({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, revision: 1, observedAt: new Date().toISOString(), data });

async function withMaintenance(t, producer = false) {
  const f = await fixture(t, 'failed', 'unknown', producer ? 'maintenance-producer-fixture' : undefined);
  let maintenance;
  if (producer) {
    const produced = spawnSync(process.env.MAESTRO_TEST_JAVA, ['--class-path', path.join(process.env.MAESTRO_TEST_CLI, 'lib', '*'),
      path.join(repo, 'scripts/tests/fixtures/MaintenanceProducer.java'), f.record.recoveryRoot, 'complete'],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(produced.status, 0, produced.stderr);
    maintenance = { input: JSON.parse(await fs.readFile(path.join(f.record.recoveryRoot, 'input.json'), 'utf8')) };
  } else maintenance = await maintenanceFixture(f.root, undefined, { deviceId: f.record.deviceId });
  const checked = await verifyMaintenanceRelease(maintenance.input);
  f.record.createdAt = maintenance.input.createdAt;
  f.result.data.cleanup.errors.push({ code: 'DEVICE_RECOVERY_REQUIRED', details: { recoverySessionId: checked.sessionId } });
  await f.persist();
  const recovered = { ...f.record, state: 'released', updatedAt: '2026-10-31T02:00:00.000Z',
    resolution: { mode: 'recovery', recoveryKind: 'ordered_restart_maintenance', releaseConfirmed: true, ...checked } };
  const recoveryStateRecord = path.join(f.root, 'recovered-state.json');
  await write(recoveryStateRecord, recovered);
  return { ...f, maintenance, recovered, recoveryStateRecord,
    options: { recoveryStateRecord, expectedLaunchId: f.record.launchId } };
}

test('JVM coordinator output passes Node release verification and the full CI archive collector', {
  skip: !process.env.MAESTRO_TEST_JAVA || !process.env.MAESTRO_TEST_CLI,
}, async t => {
  const f = await withMaintenance(t, true), before = await fileHash(f.resultPath);
  const report = await f.collect(f.options);
  assert.equal(report.status, 'complete', JSON.stringify(report.issues));
  assert.equal(report.recoveryEvidence, 'maintenance_receipt_and_chain');
  assert.equal(report.originals.ci.execution, 'failed');
  assert.equal(report.originals.result.cleanup.state, 'unknown');
  assert.equal(await fileHash(f.resultPath), before);
  assert.ok(report.files.filter(file => file.path.startsWith('recovery/maintenance/')).length > 25);
});

test('archives a completed maintenance chain beside the immutable failed CI result', async t => {
  const f = await withMaintenance(t), before = await fileHash(path.join(f.ci, 'ci-result.json'));
  // A newer owner, changed current journal and unrelated files must not influence historical collection.
  await write(f.maintenance.gatePath, { ownerSessionId: randomUUID() });
  await write(f.maintenance.journalPath, { newer: true });
  await write(path.join(f.maintenance.evidence, 'unreferenced-private.json'), { private: true });
  const report = await f.collect(f.options);
  assert.equal(report.status, 'complete', JSON.stringify(report.issues));
  assert.equal(report.recoveryEvidence, 'maintenance_receipt_and_chain');
  assert.equal(report.originals.ci.state, 'needs_inspection');
  assert.equal(report.originals.ci.execution, 'failed');
  assert.equal(report.originals.result.cleanup.state, 'unknown');
  assert.equal(report.originals.recoveryState.state, 'released');
  assert.equal(report.scope.deviceReleaseAssessment, 'not_performed');
  assert.equal(report.files.some(file => file.source === f.maintenance.gatePath || file.source === f.maintenance.journalPath || file.source.endsWith('unreferenced-private.json')), false);
  const archivedEvidence = report.files.filter(file => file.path.startsWith('recovery/maintenance/'));
  const originals = (await fs.readdir(f.maintenance.evidence)).filter(name => name !== 'unreferenced-private.json');
  assert.deepEqual(archivedEvidence.map(file => path.basename(file.source)).sort(), originals.sort());
  assert.equal(await fileHash(path.join(f.ci, 'ci-result.json')), before);
});

for (const mode of ['missing-head', 'missing-response', 'wrong-response-owner', 'changed-journal', 'foreign-state', 'changed-execution', 'missing-response-path', 'traversal', 'limited-budget']) {
  test(`maintenance archive preserves partials and reports incomplete for ${mode}`, async t => {
    const f = await withMaintenance(t), before = await fileHash(path.join(f.ci, 'ci-result.json'));
    if (mode === 'missing-head') await fs.unlink(path.join(f.maintenance.evidence, f.maintenance.response.head.path));
    if (mode === 'missing-response') await fs.unlink(f.maintenance.input.responsePath);
    if (mode === 'wrong-response-owner') {
      await write(f.maintenance.input.responsePath, { ...f.maintenance.response, ownerId: randomUUID() });
      f.recovered.resolution.recoveryResponseSha256 = await fileHash(f.maintenance.input.responsePath);
    }
    if (mode === 'changed-journal') {
      const name = (await fs.readdir(f.maintenance.evidence)).find(name => name.startsWith('original-journal-'));
      await write(path.join(f.maintenance.evidence, name), { changed: true });
    }
    if (mode === 'foreign-state') f.recovered.launchId = randomUUID();
    if (mode === 'changed-execution') f.recovered.execution = 'passed';
    if (mode === 'missing-response-path') delete f.recovered.resolution.recoveryResponsePath;
    if (mode === 'traversal') {
      f.maintenance.response.head.path = '../outside.json';
      await write(f.maintenance.input.responsePath, f.maintenance.response);
      f.recovered.resolution.recoveryResponseSha256 = await fileHash(f.maintenance.input.responsePath);
    }
    await write(f.recoveryStateRecord, f.recovered);
    const report = await f.collect({ ...f.options, ...(mode === 'limited-budget' ? { limits: { files: 25 } } : {}) });
    assert.equal(report.status, 'incomplete', mode);
    assert.notEqual(report.recoveryEvidence, 'maintenance_receipt_and_chain');
    assert.equal(report.originals.ci.execution, 'failed');
    assert.ok(report.files.some(file => file.path.endsWith('unfinished.partial') && file.status === 'copied'));
    assert.equal(await fileHash(path.join(f.ci, 'ci-result.json')), before);
    if (!['foreign-state', 'changed-execution', 'limited-budget'].includes(mode)) {
      assert.ok(report.files.some(file => file.source.includes('host-before-') && file.status === 'copied'));
    }
  });
}

test('supplemental recovery cannot override hard-stop input or omit the expected launch', async t => {
  const f = await withMaintenance(t);
  await assert.rejects(f.collect({ recoveryStateRecord: f.recoveryStateRecord }), /explicit launch/);
  await assert.rejects(f.collect({ ...f.options, stateRecord: f.recoveryStateRecord }), /explicit launch/);
});

test('public archive command accepts a separate recovery state without changing the CI result', async t => {
  const f = await withMaintenance(t);
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts/ci/collect-artifacts.mjs'),
    '--ci-directory', f.ci, '--output-directory', f.output, '--recovery-state-record', f.recoveryStateRecord,
    '--expected-launch-id', f.record.launchId], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(f.output, 'archive-manifest.json')));
  assert.equal(report.recoveryEvidence, 'maintenance_receipt_and_chain');
  assert.equal(report.originals.ci.state, 'needs_inspection');
});

async function fixture(t, status = 'passed', cleanup = 'complete', deviceId = 'fixture-device-not-a-real-serial') {
  const root = path.join(parent, randomUUID()), launchId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
  const ci = path.join(root, 'outputs', 'ci-' + launchId), persistent = path.join(root, 'persistent');
  const agentRoot = path.join(persistent, 'agent'), attempt = path.join(agentRoot, 'runs', runId, attemptId);
  const runner = path.join(ci, 'harmonyos-fixture'), controlPath = path.join(persistent, 'launches', launchId + '.json');
  const inputs = path.join(ci, 'ci-inputs.json'), quality = path.join(ci, 'ci-quality.json');
  const ref = async relative => ({ path: relative, sha256: await fileHash(path.join(attempt, relative)) });
  await write(inputs, { schemaVersion: 1, toolFiles: [{ path: path.join(root, 'tools/not-copied.jar'), sha256: 'a'.repeat(64) }] });
  await write(quality, { status: 'passed' });
  await write(path.join(ci, 'runner.log'), 'original runner output');
  await write(path.join(runner, 'stdout.log'), 'native stdout'); await write(path.join(runner, 'stderr.log'), 'native stderr');
  const resultPath = path.join(attempt, 'result.json');
  await write(path.join(runner, 'invocation.json'), { runId, attemptId, attemptNo: 1, runResultPath: resultPath, cliExitCode: status === 'passed' ? 0 : 1, agentStatus: status });
  await write(path.join(attempt, 'input.json'), { kind: 'flow', fixture: true });
  await write(path.join(attempt, 'state.json'), { state: status });
  await write(path.join(attempt, 'registration.json'), { attemptNo: 1 });
  await write(path.join(attempt, 'junit.xml'), '<testsuites><testsuite tests="1" failures="0"><testcase name="fixture"/></testsuite></testsuites>');
  await write(path.join(attempt, 'flows/a/maestro.log'), 'source log');
  await write(path.join(attempt, 'flows/a/sources/source.yaml'), 'appId: fixture\n---\n- assertTrue: true\n');
  const snapshotContent = 'appId: fixture\n---\n- assertTrue: true\n', sourceSnapshot = 'sources/' + hash(snapshotContent) + '.yaml';
  await write(path.join(attempt, sourceSnapshot), snapshotContent);
  await write(path.join(attempt, 'flows/a/unfinished.partial'), 'partial failure material');
  await write(path.join(attempt, 'flows/a/manifest.json'), { entries: [{ relativePath: 'maestro.log' }] });
  const error = status === 'failed' ? { code: 'ASSERTION_FAILED', kind: 'assertion', message: 'original failure', details: {} } : null;
  const result = document('runResult', { runId, attemptId, deviceId, status, error, failedStepId: null,
    cleanup: { state: cleanup, errors: cleanup === 'unknown' ? [{ code: 'CLOSE_UNCONFIRMED', message: 'still unknown' }] : [] },
    input: await ref('input.json'), flow: null, artifacts: { baseDir: attempt, evidenceIndexPath: 'evidence-index.json',
      junitPath: 'junit.xml', manifestPaths: ['agent-manifest.json', 'flows/a/manifest.json'] } });
  const index = document('evidenceIndex', { runId, attemptId, entries: [{ stepId: null, source: { flow: sourceSnapshot, commandIndex: 0, commandName: 'AssertTrueCommand' },
    evidence: [{ state: 'available', ...await ref('flows/a/maestro.log') }] }] });
  const control = { protocol: 'maestro.harmonyos.runner-control', schemaVersion: 1, launchId: randomUUID(), runId, attemptId, deviceId,
    phase: 'exited', artifactDirectory: runner, invocationPath: path.join(runner, 'invocation.json'),
    stdoutPath: path.join(runner, 'stdout.log'), stderrPath: path.join(runner, 'stderr.log'), runResultPath: resultPath,
    processExitObserved: true, processExitCode: status === 'passed' ? 0 : 1, wrapperExitCode: status === 'passed' ? 0 : 1,
    stdoutComplete: true, stderrComplete: true, agentStatus: status };
  const record = { protocol: 'maestro.harmonyos.ci-device', schemaVersion: 1, kind: 'single', launchId, runId, attemptId, deviceId,
    artifactDirectory: ci, agentRoot, recoveryRoot: path.join(root, 'recovery'), controlRecordPath: controlPath,
    state: cleanup === 'complete' ? 'released' : 'needs_inspection', execution: status, wrapperExitCode: control.wrapperExitCode,
    inputs: { path: inputs, sha256: await fileHash(inputs) }, quality: { path: quality, sha256: await fileHash(quality), status: 'passed' }, resolution: null };
  const context = { root, ci, attempt, agentRoot, control, controlPath, record, result, index, resultPath,
    output: path.join(root, 'archive'), ref,
    async persist() {
      await write(resultPath, result); await write(path.join(attempt, 'evidence-index.json'), index);
      const files = [];
      for (const relative of ['input.json', 'result.json', 'state.json', 'registration.json', 'junit.xml', 'evidence-index.json', 'flows/a/manifest.json']) files.push(await ref(relative));
      await write(path.join(attempt, 'agent-manifest.json'), { schemaVersion: 1, runId, attemptId, files });
      await write(controlPath, control); await write(path.join(ci, 'ci-result.json'), record);
    },
    collect(extra = {}) { return collectArtifacts({ ciDirectory: ci, outputDirectory: context.output, ...extra }); } };
  await context.persist();
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  return context;
}

test('collects the external exact attempt, source snapshots and partial files, preserving original bytes', async t => {
  const f = await fixture(t), before = await fileHash(f.resultPath);
  const unrelated = path.join(f.agentRoot, 'runs', randomUUID(), randomUUID(), 'foreign.txt'); await write(unrelated, 'must not be archived');
  const report = await f.collect();
  assert.equal(report.status, 'complete', JSON.stringify(report.issues));
  assert.equal(report.originals.ci.state, 'released'); assert.notEqual(report.originals.control.launchId, report.identity.launchId);
  assert.ok(report.files.some(file => file.path.endsWith('sources/source.yaml')));
  assert.ok(report.files.some(file => file.path.endsWith('unfinished.partial')));
  assert.equal(report.files.some(file => file.source === unrelated || file.source.endsWith('.jar')), false);
  for (const file of report.files) { assert.equal(file.status, 'copied'); assert.equal(file.copySha256, file.sourceSha256Before); assert.equal(file.copySha256, file.sourceSha256After); }
  assert.equal(await fileHash(f.resultPath), before);
});

test('complete collection preserves failed execution and unknown cleanup independently', async t => {
  const f = await fixture(t, 'failed', 'unknown'), report = await f.collect();
  assert.equal(report.status, 'complete', JSON.stringify(report.issues));
  assert.equal(report.originals.ci.execution, 'failed'); assert.equal(report.originals.result.cleanup.state, 'unknown');
  assert.equal(report.originals.result.error.message, 'original failure');
});

test('unknown recording owner without a bound receipt is explicitly incomplete', async t => {
  for (const mode of ['no-resolution', 'same-owner-without-receipt']) await t.test(mode, async t => {
    const f = await fixture(t, 'failed', 'unknown'), sessionId = randomUUID();
    f.result.data.cleanup.errors.push({ code: 'DEVICE_RECOVERY_REQUIRED', details: { recoverySessionId: sessionId } });
    if (mode === 'same-owner-without-receipt') f.record.resolution = { sessionId };
    await f.persist(); const report = await f.collect(); assert.equal(report.status, 'incomplete');
    assert.ok(report.issues.some(issue => issue.code === 'uncollected_recovery_owner'));
    assert.equal(report.recoveryEvidence, 'owner_referenced_not_collected');
  });
});

test('hard stop requires exact launch and preserves available partials without inventing a result', async t => {
  const f = await fixture(t), state = path.join(f.root, 'retained-state.json');
  f.control.processExitObserved = false; f.control.stderrComplete = false; await f.persist();
  await write(state, f.record); await fs.unlink(path.join(f.ci, 'ci-result.json')); await fs.unlink(f.resultPath);
  const report = await f.collect({ stateRecord: state, expectedLaunchId: f.record.launchId });
  assert.equal(report.status, 'incomplete'); assert.equal(report.originals.result, null);
  assert.ok(report.files.some(file => file.path.endsWith('unfinished.partial') && file.status === 'copied'));
  assert.ok(report.issues.some(issue => issue.code === 'unfinished_runner'));
});

test('blocked preflight can be collected without creating a device identity', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.ci, 'ci-result.json'));
  await write(path.join(f.ci, 'ci-preflight.json'), { status: 'blocked', dispatched: false, error: 'bad static input' });
  const report = await f.collect(); assert.equal(report.status, 'complete'); assert.equal(report.identity, null);
  assert.equal(report.files.some(file => file.path.startsWith('attempt/')), false);
});

test('retained state requires the selected expected launch and cannot replace an existing result', async t => {
  const f = await fixture(t), state = path.join(f.root, 'retained-state.json'); await write(state, f.record);
  await assert.rejects(f.collect({ stateRecord: state, expectedLaunchId: randomUUID() }), /Expected launch/);
  const existing = await f.collect({ stateRecord: state, expectedLaunchId: f.record.launchId });
  assert.equal(existing.status, 'incomplete'); assert.ok(existing.issues.some(issue => issue.message.includes('override')));
  await fs.unlink(path.join(f.ci, 'ci-result.json'));
  await assert.rejects(f.collect({ outputDirectory: path.join(f.root, 'no-expected'), stateRecord: state }), /expected launch UUID/);
});

test('bad launch and foreign control references cannot expand the selected scope', async t => {
  for (const mode of ['launch', 'control', 'invocation', 'result']) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === 'launch') f.record.launchId = randomUUID();
    if (mode === 'control') f.control.runResultPath = path.join(f.agentRoot, 'runs', randomUUID(), randomUUID(), 'result.json');
    if (mode === 'result') f.result.data.attemptId = randomUUID();
    await f.persist();
    if (mode === 'invocation') await write(f.control.invocationPath, { runId: randomUUID(), attemptId: f.record.attemptId, runResultPath: f.resultPath });
    assert.equal((await f.collect()).status, 'incomplete');
  });
});

test('missing hash, duplicate keys, traversal, absent evidence and tampering retain an incomplete archive', async t => {
  for (const mode of ['hash', 'inputs-hash', 'quality-hash', 'duplicate', 'traversal', 'missing', 'tamper', 'flow-manifest', 'junit', 'missing-source', 'changed-source']) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === 'hash') { delete f.index.data.entries[0].evidence[0].sha256; await f.persist(); }
    if (mode === 'inputs-hash' || mode === 'quality-hash') { delete f.record[mode.split('-')[0]].sha256; await f.persist(); }
    if (mode === 'duplicate') await fs.writeFile(path.join(f.ci, 'ci-result.json'), '{"protocol":"x","protocol":"y"}');
    if (mode === 'traversal') { f.index.data.entries[0].evidence[0].path = '../outside.txt'; await f.persist(); }
    if (mode === 'missing') await fs.unlink(path.join(f.attempt, 'flows/a/maestro.log'));
    if (mode === 'tamper') await fs.appendFile(path.join(f.attempt, 'input.json'), ' ');
    if (mode === 'flow-manifest') { await write(path.join(f.attempt, 'flows/a/manifest.json'), { entries: [{ relativePath: '../outside.txt' }] }); await f.persist(); }
    if (mode === 'junit') { f.result.data.artifacts.junitPath = null; await f.persist(); }
    if (mode === 'missing-source') await fs.unlink(path.join(f.attempt, f.index.data.entries[0].source.flow));
    if (mode === 'changed-source') await fs.appendFile(path.join(f.attempt, f.index.data.entries[0].source.flow), '# changed');
    const report = await f.collect(); assert.equal(report.status, 'incomplete');
    assert.ok(report.files.some(file => file.path === 'ci/runner.log' && file.status === 'copied'));
  });
});

test('linked input directory is rejected without collecting its foreign contents', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'foreign'); await write(path.join(outside, 'secret.txt'), 'not for this run');
  const link = path.join(f.attempt, 'linked'); await fs.symlink(outside, link, 'junction');
  const report = await f.collect(); assert.equal(report.status, 'incomplete');
  assert.equal(report.files.some(file => file.source.includes('secret.txt')), false);
  await fs.unlink(link);
});

test('existing output and output nested inside any source are rejected before mutation', async t => {
  const f = await fixture(t);
  for (const outputDirectory of [f.ci, path.join(f.ci, 'archive'), path.join(f.attempt, 'archive'), path.join(f.record.recoveryRoot, 'archive')])
    await assert.rejects(f.collect({ outputDirectory }), /overlap/);
  await fs.mkdir(f.output); await write(path.join(f.output, 'keep.txt'), 'original');
  await assert.rejects(f.collect(), /EEXIST/); assert.equal(await fs.readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'original');
});

test('file, total, count and elapsed budgets leave explicit incomplete manifests', async t => {
  for (const limits of [{ fileBytes: 20 }, { totalBytes: 20 }, { files: 2 }, { milliseconds: 1 }]) await t.test(JSON.stringify(limits), async t => {
    const f = await fixture(t), report = await f.collect({ limits }); assert.equal(report.status, 'incomplete');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'archive-manifest.json'), 'utf8')).status, 'incomplete');
  });
});

test('bound receipt collects only its exact snapshot and all owned original versions', async t => {
  for (const mode of ['normal', 'missing-first', 'tampered-first']) await t.test(mode, async t => {
  const f = await fixture(t), session = randomUUID(), recoveryId = randomUUID(), generation = randomUUID(), id = randomUUID();
  const owner = path.join(f.record.recoveryRoot, hash(f.record.deviceId), session), receiptPath = path.join(owner, 'recoveries', recoveryId + '.json');
  const archives = [];
  for (const value of ['original A', 'original B']) {
    const item = { name: id + '-' + randomUUID() + '.mp4', sha256: hash(value), size: Buffer.byteLength(value) };
    await write(path.join(owner, 'recording-originals', item.name), value); archives.push(item);
  }
  await write(path.join(owner, 'recording-originals', 'unregistered.mp4'), 'do not collect');
  const snapshotPath = path.join(owner, 'recoveries', recoveryId + '-recordings.json');
  await write(snapshotPath, { schemaVersion: 1, deviceId: f.record.deviceId, ownerId: session, generation,
    remoteRoot: '/data/local/tmp/maestro-session-' + generation, resources: [{ id, fileName: 'maestro-recording-' + id.replaceAll('-', '') + '.mp4', archives }] });
  await write(receiptPath, { schemaVersion: 2, deviceId: f.record.deviceId, sessionId: session, recoveryId,
    recordingResources: { path: snapshotPath, sha256: await fileHash(snapshotPath) } });
  f.record.resolution = { sessionId: session, reportPath: receiptPath, reportSha256: await fileHash(receiptPath) }; await f.persist();
  if (mode === 'missing-first') await fs.unlink(path.join(owner, 'recording-originals', archives[0].name));
  if (mode === 'tampered-first') await write(path.join(owner, 'recording-originals', archives[0].name), 'different original A');
  const report = await f.collect(); assert.equal(report.status, mode === 'normal' ? 'complete' : 'incomplete', JSON.stringify(report.issues));
  assert.equal(report.files.filter(file => file.path.startsWith('recovery/originals/')).length, 2);
  assert.equal(report.files.find(file => file.path.endsWith(archives[1].name)).status, 'copied');
  assert.equal(report.files.some(file => file.source.endsWith('unregistered.mp4')), false);
  });
});

test('copy write failure keeps earlier material and reports incomplete without changing original release', async t => {
  const f = await fixture(t), open = fs.open;
  t.mock.method(fs, 'open', async function(file, flags, ...args) {
    if (String(file).startsWith(f.output) && String(file).endsWith('runner.log') && flags === 'wx') throw new Error('fixture disk write failure');
    return open.call(this, file, flags, ...args);
  });
  const report = await f.collect(); assert.equal(report.status, 'incomplete');
  assert.ok(report.issues.some(issue => issue.message.includes('disk write failure')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.ci, 'ci-result.json'), 'utf8')).state, 'released');
});

test('source mutation after its first copy is caught by final closure verification', async t => {
  const f = await fixture(t), open = fs.open, source = path.join(f.ci, 'runner.log'); let changed = false;
  t.mock.method(fs, 'open', async function(file, flags, ...args) {
    if (!changed && String(file) === f.controlPath) { changed = true; await fs.appendFile(source, ' changed later'); }
    return open.call(this, file, flags, ...args);
  });
  const report = await f.collect(); assert.equal(report.status, 'incomplete');
  assert.ok(report.issues.some(issue => issue.code === 'final_hash_check_failed'));
});

test('public command reports a missing reference with a nonzero exit and retained manifest', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.attempt, 'flows/a/maestro.log'));
  const run = spawnSync(process.execPath, [path.join(repo, 'scripts/ci/collect-artifacts.mjs'), '--ci-directory', f.ci, '--output-directory', f.output], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 1, run.stderr); assert.equal(JSON.parse(run.stdout).status, 'incomplete');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'archive-manifest.json'), 'utf8')).originals.ci.execution, 'passed');
});

test('video archive follows exact reports and logs without collecting external tools or changing execution', async t => {
  for (const mode of ['passed', 'failed', 'report-missing', 'pointer-missing', 'pointer-changed', 'decode-log-missing',
    'decode-log-changed', 'process-log-missing', 'version-log-missing', 'foreign-report', 'unknown-external']) await t.test(mode, async t => {
    const f = await fixture(t), videoPath = 'flows/a/recording.mp4';
    await write(path.join(f.attempt, videoPath), 'owned video fixture');
    const videoHash = await fileHash(path.join(f.attempt, videoPath));
    f.index.data.entries[0].evidence.push({ kind: 'video', state: 'available', path: videoPath, sha256: videoHash });
    const qualityPath = path.join(f.ci, 'ci-quality.json'), inputPath = path.join(f.ci, 'ci-inputs.json');
    const directory = path.join(f.ci, 'video-verification', 'one');
    const decodedPath = path.join(directory, 'recording-' + randomUUID().replaceAll('-', ''), 'verification.json');
    const pointerPath = path.join(directory, 'report-pointer.json'), reportPath = path.join(f.ci, 'video-verification', 'ci-videos.json');
    const originals = [];
    for (const name of ['decode.stdout.log', 'decode.stderr.log', 'version.log']) {
      const file = path.join(path.dirname(decodedPath), name); await write(file, name);
      originals.push({ path: file, sha256: await fileHash(file) });
    }
    const tool = { path: path.join(f.root, 'external-decoder.exe'), sha256: 'a'.repeat(64) };
    const inputs = JSON.parse(await fs.readFile(inputPath, 'utf8')); inputs.toolFiles.push(tool); await write(inputPath, inputs);
    originals.push(tool);
    const process = {};
    for (const name of ['stdout', 'stderr']) {
      const file = path.join(directory, 'verifier.' + name + '.log'); await write(file, name);
      process[name] = { path: file, sha256: await fileHash(file) };
    }
    await write(decodedPath, { protocol: 'maestro.harmonyos.recording-verification', schemaVersion: 1,
      status: mode === 'failed' ? 'failed' : 'passed', inputPath: path.join(f.attempt, videoPath), inputSha256: videoHash,
      stdout: 'decode.stdout.log', stderr: 'decode.stderr.log' });
    await write(pointerPath, { protocol: 'maestro.harmonyos.recording-report-pointer', schemaVersion: 1,
      reportPath: decodedPath, reportSha256: await fileHash(decodedPath) });
    const video = { path: videoPath, sourcePath: path.join(f.attempt, videoPath), sha256: videoHash,
      status: mode === 'failed' ? 'failed' : 'passed', process,
      pointer: { path: pointerPath, sha256: await fileHash(pointerPath) }, verification: { path: decodedPath, sha256: await fileHash(decodedPath) } };
    const report = { protocol: 'maestro.harmonyos.ci-videos', schemaVersion: 1, runId: f.record.runId, attemptId: f.record.attemptId,
      status: video.status, videos: [video], originalFiles: originals };
    if (mode === 'unknown-external') originals.push({ path: path.join(f.root, 'unrelated-secret.txt'), sha256: 'b'.repeat(64) });
    if (mode === 'foreign-report') video.verification.path = path.join(f.root, 'foreign.json');
    await write(reportPath, report);
    await write(qualityPath, { status: report.status, video: { path: reportPath, sha256: await fileHash(reportPath), status: report.status } });
    f.record.inputs.sha256 = await fileHash(inputPath); f.record.quality.sha256 = await fileHash(qualityPath); f.record.quality.status = report.status;
    await f.persist();
    const before = await fileHash(path.join(f.ci, 'ci-result.json'));
    if (mode === 'report-missing') await fs.unlink(reportPath);
    if (mode === 'pointer-missing') await fs.unlink(pointerPath);
    if (mode === 'pointer-changed') await fs.appendFile(pointerPath, ' ');
    if (mode === 'decode-log-missing') await fs.unlink(originals[0].path);
    if (mode === 'decode-log-changed') await fs.appendFile(originals[0].path, ' changed');
    if (mode === 'version-log-missing') await fs.unlink(originals[2].path);
    if (mode === 'process-log-missing') await fs.unlink(process.stdout.path);
    const collected = await f.collect();
    assert.equal(collected.status, ['passed', 'failed'].includes(mode) ? 'complete' : 'incomplete', JSON.stringify(collected.issues));
    assert.equal(collected.files.some(file => file.source === tool.path), false);
    assert.equal(collected.originals.ci.execution, 'passed'); assert.equal(collected.originals.ci.state, 'released');
    assert.equal(await fileHash(path.join(f.ci, 'ci-result.json')), before);
  });
});
