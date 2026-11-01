import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { verifyMaintenanceRelease, parseMaintenanceJson } from '../recovery/verify-maintenance.mjs';
import { verifyState, verifyDeviceRelease } from '../ci/verify-state.mjs';
import { maintenanceFixture, sha } from './fixtures/maintenance.mjs';
import { verifyMaintenanceReport } from '../../examples/agent-client/maintenance.mjs';

const execute = promisify(execFile);
test('JVM unconfirmed observation remains gated and cannot be accepted by Node', {
  skip: !process.env.MAESTRO_TEST_JAVA || !process.env.MAESTRO_TEST_CLI,
}, async t => {
  const parent = process.env.MAESTRO_TEST_TEMP ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'maestro-producer-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(parent)); await fs.rm(root, { recursive: true, force: true }); });
  const output = path.join(root, 'unconfirmed');
  await execute(process.env.MAESTRO_TEST_JAVA, ['--class-path', path.join(process.env.MAESTRO_TEST_CLI, 'lib', '*'),
    path.resolve('scripts/tests/fixtures/MaintenanceProducer.java'), output, 'unconfirmed'], { windowsHide: true, timeout: 60000 });
  const input = JSON.parse(await fs.readFile(path.join(output, 'input.json'), 'utf8'));
  const before = await fs.readFile(path.join(output, 'prepared.json'));
  await assert.rejects(verifyMaintenanceRelease(input));
  assert.deepEqual(await fs.readFile(path.join(output, 'prepared.json')), before);
  const producer = JSON.parse(await fs.readFile(path.join(output, 'producer.json'), 'utf8'));
  assert.equal(producer.deviceCalls, 0); assert.equal(producer.transportCalls, 1);
});
async function fixture(t, transform, options) {
  const parent = process.env.MAESTRO_TEST_TEMP ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'maestro-maintenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, ...await maintenanceFixture(root, transform, options) };
}

test('JVM retained-image maintenance evidence passes the Node and client verifiers', {
  skip: !process.env.MAESTRO_TEST_JAVA || !process.env.MAESTRO_TEST_CLI,
}, async t => {
  const parent = path.resolve(process.env.MAESTRO_TEST_TEMP ?? os.tmpdir());
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'maestro-retained-images-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const output = path.join(root, 'evidence');
  await execute(process.env.MAESTRO_TEST_JAVA, ['--class-path', path.join(process.env.MAESTRO_TEST_CLI, 'lib', '*'),
    path.resolve('scripts/tests/fixtures/MaintenanceProducer.java'), output, 'retained-images'], { windowsHide: true, timeout: 60000 });
  const input = JSON.parse(await fs.readFile(path.join(output, 'input.json'), 'utf8'));
  const result = await verifyMaintenanceRelease(input);
  assert.equal(result.originalExecutionResult, 'unknown');
  assert.ok(result.originalPendingOperations > 1);
  assert.equal((await verifyMaintenanceReport(input)).releaseConfirmed, true);
});
test('migrated host evidence permits different PowerShell versions only across the approved restart', async t => {
  const f = await fixture(t, undefined, { migrate: true });
  const result = await verifyMaintenanceRelease(f.input);
  assert.equal(result.originalExecutionResult, 'unknown');
  assert.equal(result.originalPendingOperations, 1);
});
for (const [label, kind, mutate] of [
  ['approval mismatch', 'tool-approval', v => { v.checkpointSha256 = 'e'.repeat(64); }],
  ['changed migration reason', 'host-tool-transition', v => { v.reason = 'force'; }],
  ['changed Java', 'checkpoint', v => { if (v.schemaVersion === 2) v.tools.java.sha256 = 'e'.repeat(64); }],
  ['changed dependency', 'checkpoint', v => { if (v.schemaVersion === 2) v.tools['classpath:0:fixture.jar'].sha256 = 'e'.repeat(64); }],
  ['foreign prior owner', 'previous-gate', v => { v.ownerSessionId = randomUUID(); }],
  ['prior gate released', 'previous-gate', v => { v.state = 'clean'; }],
  ['changed original scope', 'checkpoint', v => { if (v.schemaVersion === 2) v.generation = randomUUID(); }],
  ['foreign migration host', 'host-migrated', v => { v.machineIdSha256 = 'e'.repeat(64); }],
  ['no migration reboot', 'host-migrated', v => { v.lastBootUpTime = '2026-10-20T00:00:00.000Z'; }],
  ['second boot after migration', 'host-migrated', v => { v.lastBootUpTime = '2026-10-30T23:57:00.000Z'; }],
  ['version changes after migration', 'host-resume', v => { v.tools.powershell.version = '5.1.1.3'; }],
]) test(`migration rejects ${label}`, async t => {
  const f = await fixture(t, (k, value) => { if (k === kind) mutate(value); return value; }, { migrate: true });
  await assert.rejects(verifyMaintenanceRelease(f.input));
});
test('completed chain confirms release without rewriting the old unknown result or files', async t => {
  const f = await fixture(t), before = await fs.readFile(f.journalPath);
  const result = await verifyMaintenanceRelease(f.input);
  assert.equal(result.originalExecutionResult, 'unknown'); assert.equal(result.originalPendingOperations, 1);
  assert.ok(result.maintenanceCheckedFiles > 20);
  assert.deepEqual(await fs.readFile(f.journalPath), before);
  const ci = await verifyState({ ...f.input, mode: 'recovery', recoveryReportPath: f.input.responsePath });
  assert.equal(ci.releaseConfirmed, true); assert.equal(ci.recoveryKind, 'ordered_restart_maintenance');
  assert.equal((await verifyDeviceRelease(f.input)).maintenanceId, result.maintenanceId);
  assert.equal((await verifyMaintenanceReport(f.input)).releaseConfirmed, true);
  await assert.rejects(verifyMaintenanceReport({ ...f.input, responsePath: null }), /saved complete/);
  await assert.rejects(verifyState({ ...f.input, mode: 'completion', runId: randomUUID(), attemptId: randomUUID() }), /original execution/);
});
test('registered layout and screenshot paths require complete cleanup evidence and preserve original unknown results', async t => {
  const temporaryNames = [`layout-${randomUUID()}.json`, `screen-${randomUUID()}.png`];
  const f = await fixture(t, undefined, { temporaryNames });
  const before = await fs.readFile(f.journalPath);
  const result = await verifyMaintenanceRelease(f.input);
  assert.equal(result.originalExecutionResult, 'unknown');
  assert.equal(result.originalPendingOperations, 1);
  assert.equal((await verifyMaintenanceReport(f.input)).releaseConfirmed, true);
  assert.deepEqual(await fs.readFile(f.journalPath), before);
  const incomplete = await fixture(t, (kind, value) => {
    if (kind === 'cleanup-batch') value.paths.shift();
    return value;
  }, { temporaryNames });
  await assert.rejects(verifyMaintenanceRelease(incomplete.input), /precisely the owned paths/);
});

for (const [name, temporaryNames] of [
  ['recording file', [`recording-${randomUUID()}.mp4`]],
  ['wrong extension', [`layout-${randomUUID()}.mp4`]],
  ['traversal', [`../layout-${randomUUID()}.json`]],
  ['duplicate path', Array(2).fill(`layout-${randomUUID()}.json`)],
]) test(`maintenance rejects ${name} even with a consistent evidence chain`, async t => {
  const f = await fixture(t, undefined, { temporaryNames });
  await assert.rejects(verifyMaintenanceRelease(f.input), /outside maintenance scope/);
});

test('lossless parsing rejects duplicates and retains process identity integer differences', () => {
  assert.throws(() => parseMaintenanceJson('{"state":1,"st\\u0061te":2}'), /Duplicate/);
  assert.notDeepEqual(parseMaintenanceJson('{"ticks":9007199254740992}'), parseMaintenanceJson('{"ticks":9007199254740993}'));
  assert.throws(() => parseMaintenanceJson('['.repeat(66) + '0' + ']'.repeat(66)), /deeply/);
});
const mutations = [
  ['host uptime not decreased', 'host-resume', v => { v.uptimeMilliseconds = '864000001'; }],
  ['different host', 'host-resume', v => { v.machineIdSha256 = 'd'.repeat(64); }],
  ['second host restart', 'host-complete', v => { v.lastBootUpTime = '2026-10-31T00:09:00.000Z'; }],
  ['phone raw differs', 'phone-after', v => { v.raw = v.raw.replace('1 min', '2 min'); }],
  ['phone did not restart', 'phone-after', v => { v.raw = v.raw.replace('1 min', '50 min'); v.minutes = '50'; v.lowerBoundMilliseconds = '3000000'; v.upperBoundMillisecondsExclusive = '3060000'; }],
  ['phone belongs to another owner', 'phone-after', v => { v.ownerId = randomUUID(); }],
  ['missing original operation termination', 'termination', v => { v.operationIds = []; }],
  ['cleanup omits owned path', 'cleanup-batch', v => { v.paths.pop(); }],
  ['cleanup adds unowned path', 'cleanup-batch', v => { v.paths.push('/data/local/tmp/unowned'); }],
  ['cleanup belongs to another call', 'cleanup-batch', v => { v.hostCallId = randomUUID(); }],
  ['changed original pending result', 'ended-journal', v => { v.operations[0].completed = true; }],
  ['changed large original process ticks', 'ended-journal', v => { v.hostCalls[0].startTimeTicks = 9007199254740992n; }],
  ['unfinished host invocation', 'ended-journal', v => { v.hostCalls.at(-1).stopped = false; }],
  ['receipt claims original success', 'receipt', v => { v.originalExecutionResult = 'passed'; }],
  ['receipt omits pending count', 'receipt', v => { delete v.originalPendingOperations; }],
  ['wrong checkpoint generation', 'checkpoint', v => { v.generation = randomUUID(); }],
  ['chain loses previous step', 'step', v => { if (v.phase === 'complete') v.previous = null; }],
  ['chain skips pre-dispatch call evidence', 'step', v => { if (v.phase === 'cleaning' && v.calls.at(-1)?.outcome === null) v.calls = []; }],
];
for (const [label, kind, mutate] of mutations) test(`rejects ${label} even with matching file hashes`, async t => {
  const f = await fixture(t, (k, value) => { if (k === kind) mutate(value); return value; });
  await assert.rejects(verifyMaintenanceRelease(f.input));
});
for (const variant of ['prepared', 'missing-file', 'wrong-hash', 'response-owner', 'response-head', 'stale', 'recording', 'traversal', 'duplicate-json']) {
  test(`rejects ${variant}`, async t => {
    const f = await fixture(t);
    if (variant === 'prepared') { f.gate.state = 'quarantined'; f.gate.requiresRecovery = true; await f.write(f.gatePath, f.gate); }
    if (variant === 'missing-file') await fs.unlink(path.join(f.evidence, f.gate.maintenance.checkpoint.path));
    if (variant === 'wrong-hash') { f.gate.reportSha256 = '0'.repeat(64); await f.write(f.gatePath, f.gate); }
    if (variant === 'response-owner') { f.response.ownerId = randomUUID(); await f.write(f.input.responsePath, f.response); }
    if (variant === 'response-head') { f.response.head = f.response.checkpoint; await f.write(f.input.responsePath, f.response); }
    if (variant === 'stale') f.input.createdAt = '2026-11-01T00:00:00.000Z';
    if (variant === 'recording') await fs.writeFile(path.join(f.owner, 'recording-resources.json'), '{}');
    if (variant === 'traversal') { f.gate.maintenance.head.path = '../outside.json'; await f.write(f.gatePath, f.gate); }
    if (variant === 'duplicate-json') await fs.writeFile(f.gatePath, (await fs.readFile(f.gatePath, 'utf8')).replace('"schemaVersion":2', '"schemaVersion":1,"schemaVersion":2'));
    await assert.rejects(verifyMaintenanceRelease(f.input));
  });
}

// Exercise the real PowerShell reconciliation entry, with synthetic persistent state and no device.
for (const invalid of [false, true]) test(`PowerShell reconciliation ${invalid ? 'retains unknown for invalid' : 'releases valid'} maintenance evidence`, { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), stateRoot = path.join(f.root, 'ci-state'); await fs.mkdir(stateRoot);
  const runId = randomUUID(), attemptId = randomUUID(), controlPath = path.join(f.root, 'control.json');
  const dead = { pid: 2147483647, startTimeTicks: 1 };
  await f.write(controlPath, { protocol: 'maestro.harmonyos.runner-control', schemaVersion: 1, deviceId: f.input.deviceId, runId, attemptId, process: dead });
  const statePath = path.join(stateRoot, sha(Buffer.from(f.input.deviceId)) + '.json');
  const state = { protocol: 'maestro.harmonyos.ci-device', schemaVersion: 1, deviceId: f.input.deviceId, state: 'needs_inspection', kind: 'single',
    launchId: randomUUID(), runId, attemptId, ownerProcess: dead, controlRecordPath: controlPath, recoveryRoot: f.input.recoveryRoot,
    createdAt: f.input.createdAt, updatedAt: f.input.createdAt, resolution: null, execution: 'unknown' };
  await f.write(statePath, state);
  if (invalid) { f.response.ownerId = randomUUID(); await f.write(f.input.responsePath, f.response); }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/ci/run-device-suite.ps1'), '-DeviceId', f.input.deviceId,
    '-DeviceStateDirectory', stateRoot, '-RecoveryRoot', f.input.recoveryRoot, '-ReconcileOnly', '-RecoveryReportPath', f.input.responsePath];
  const run = execute('powershell.exe', args, { windowsHide: true, timeout: 45000,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH } });
  if (invalid) await assert.rejects(run, /Maintenance response differs/); else await run;
  const after = JSON.parse(await fs.readFile(statePath));
  assert.equal(after.state, invalid ? 'needs_inspection' : 'released'); assert.equal(after.execution, 'unknown');
  assert.deepEqual(JSON.parse(await fs.readFile(controlPath)), { protocol: 'maestro.harmonyos.runner-control', schemaVersion: 1, deviceId: f.input.deviceId, runId, attemptId, process: dead });
});
