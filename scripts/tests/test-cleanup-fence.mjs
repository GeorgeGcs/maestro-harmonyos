import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { verifyCleanupFenceGate, verifyCleanupFenceReceipt } from '../recovery/verify-cleanup-fence.mjs';
import { verifyCleanupFenceReport } from '../../examples/agent-client/cleanup-fence.mjs';
import { verifyState, verifyDeviceRelease } from '../ci/verify-state.mjs';
import { hash } from '../recovery/cleanup-fence-scripts.mjs';

const execute = promisify(execFile);
const enabled = Boolean(process.env.MAESTRO_TEST_JAVA && process.env.MAESTRO_TEST_CLI && process.env.MAESTRO_TEST_BASH);
async function produce(t, mode = 'complete') {
  const parent = path.resolve(process.env.MAESTRO_TEST_TEMP ?? os.tmpdir());
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'fence-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const output = path.join(root, 'evidence');
  await execute(process.env.MAESTRO_TEST_JAVA, ['--class-path', path.join(process.env.MAESTRO_TEST_CLI, 'lib', '*'),
    path.resolve('scripts/tests/fixtures/CleanupFenceProducer.java'), output, process.env.MAESTRO_TEST_BASH, mode],
  { windowsHide: true, timeout: 90000 });
  const input = JSON.parse(await fs.readFile(path.join(output, 'input.json'), 'utf8'));
  const gatePath = path.join(output, hash(input.deviceId) + '.owner.json');
  const gate = JSON.parse(await fs.readFile(gatePath, 'utf8'));
  return { root, output, input, gate, gatePath };
}

for (const mode of ['complete', 'inventory', 'lost-claim', 'lost-clean', 'lost-gate-commit', 'normal-recover-refused']) {
  test(`production shell recovery ${mode} has independently verifiable evidence`, { skip: !enabled }, async t => {
    const f = await produce(t, mode);
    const checked = await verifyCleanupFenceGate(f.input);
    assert.equal(checked.release.originalResult, 'unknown');
    assert.equal(checked.retainedFenceCount, 1);
    assert.ok(checked.checkedFiles > 12);
    assert.equal((await verifyCleanupFenceReport(f.input)).releaseConfirmed, true);
    const resolution = await verifyState({ ...f.input, mode: 'recovery', recoveryReportPath: f.input.responsePath });
    assert.equal(resolution.recoveryKind, 'cleanup_fence');
    assert.equal(resolution.releaseConfirmed, true);
    await assert.rejects(verifyState({ ...f.input, mode: 'completion', runId: randomUUID(), attemptId: randomUUID() }), /cannot establish completion/);
    const original = JSON.parse(await fs.readFile(f.gate.journalPath, 'utf8'));
    assert.equal(original.operations.filter(op => !op.completed).length, 1);
    assert.equal(original.rootRemoved, false);
    if (mode === 'inventory') {
      assert.equal(original.operations.length, 8);
      assert.equal(original.temporaryFiles.length, 4);
    }
  });
}

for (const mode of ['before-marker', 'old-wins', 'unknown-child', 'cancel-after-claim']) {
  test(`production shell recovery refuses ${mode}`, { skip: !enabled }, async t => {
    const f = await produce(t, mode);
    assert.equal(f.gate.state, 'quarantined');
    await assert.rejects(verifyCleanupFenceGate(f.input));
    assert.equal((JSON.parse(await fs.readFile(path.join(f.output, 'producer.json'), 'utf8'))).blocked, true);
  });
}

test('new owner carries retained fences through normal close and independent release verification', { skip: !enabled }, async t => {
  const f = await produce(t, 'new-lease');
  assert.equal(f.gate.cleanupFence, null);
  assert.equal(f.gate.schemaVersion, 3);
  assert.equal((await verifyCleanupFenceGate(f.input)).retainedFenceCount, 1);
  const released = await verifyDeviceRelease(f.input);
  assert.equal(released.sessionId, f.gate.ownerSessionId);
  assert.equal(released.deviceGateVersion, 3);
  assert.equal(released.retainedFences.length, 1);
  await assert.rejects(verifyCleanupFenceReport(f.input), /current owner/);
});

test('missing remote barrier blocks a new production owner', { skip: !enabled }, async t => {
  const f = await produce(t, 'removed-fence');
  assert.equal(f.gate.ownerSessionId, f.gate.retainedFences[0].ownerId);
  assert.equal((JSON.parse(await fs.readFile(path.join(f.output, 'producer.json'), 'utf8'))).passed, true);
  // Node checks saved evidence only; the production begin path performed the fresh remote rejection.
  assert.equal((await verifyCleanupFenceGate(f.input)).release.originalResult, 'unknown');
});

test('original CLI reader refuses the new persistent gate version', {
  skip: !enabled || !process.env.MAESTRO_TEST_ORIGINAL_CLI,
}, async t => {
  const f = await produce(t);
  const result = await execute(process.env.MAESTRO_TEST_JAVA, ['--class-path', path.join(process.env.MAESTRO_TEST_ORIGINAL_CLI, 'lib', '*'),
    path.resolve('scripts/tests/fixtures/CleanupFenceLegacyReader.java'), f.output], { windowsHide: true, timeout: 30000 });
  assert.match(result.stdout, /refused retained-fence/);
});

test('fence evidence remains archivable after the current gate belongs to another owner', { skip: !enabled }, async t => {
  const f = await produce(t);
  await fs.writeFile(f.gatePath, JSON.stringify({ ownerSessionId: randomUUID() }));
  const result = await verifyCleanupFenceReceipt({ ...f.input, retained: f.gate.retainedFences[0] });
  assert.equal(result.receipt.originalResult, 'unknown');
  assert.ok(result.records.length > 12);
});

for (const [name, mutate] of [
  ['wrong response owner', async f => { const v = JSON.parse(await fs.readFile(f.input.responsePath)); v.sessionId = randomUUID(); await fs.writeFile(f.input.responsePath, JSON.stringify(v)); }],
  ['original journal rewrite', async f => { const v = JSON.parse(await fs.readFile(f.gate.journalPath)); v.operations[0].completed = true; await fs.writeFile(f.gate.journalPath, JSON.stringify(v)); }],
  ['dropped retained inventory', async f => { f.gate.retainedFences = []; await fs.writeFile(f.gatePath, JSON.stringify(f.gate)); }],
  ['foreign retained owner', async f => { f.gate.retainedFences[0].ownerId = randomUUID(); await fs.writeFile(f.gatePath, JSON.stringify(f.gate)); }],
  ['missing call journal', async f => { await fs.unlink(path.join(path.dirname(f.gate.reportPath), 'calls.json')); }],
]) {
  test(`fence verifier rejects ${name}`, { skip: !enabled }, async t => {
    const f = await produce(t); await mutate(f);
    await assert.rejects(verifyCleanupFenceGate(f.input));
  });
}

for (const [name, change] of [
  ['false handoff', v => { v.handoffReady = false; }],
  ['rewritten execution success', v => { v.originalResult = 'passed'; }],
  ['claimed root deletion', v => { v.retainedDirectories = []; }],
  ['unsupported disposition', v => { v.disposition = 'assumed_stopped'; }],
]) {
  test(`fence verifier rejects rehashed receipt with ${name}`, { skip: !enabled }, async t => {
    const f = await produce(t);
    const receipt = JSON.parse(await fs.readFile(f.gate.reportPath)); change(receipt);
    const bytes = Buffer.from(JSON.stringify(receipt)); await fs.writeFile(f.gate.reportPath, bytes);
    f.gate.retainedFences[0].receipt.sha256 = hash(bytes); f.gate.reportSha256 = hash(bytes);
    await fs.writeFile(f.gatePath, JSON.stringify(f.gate));
    await assert.rejects(verifyCleanupFenceGate(f.input), /receipt does not establish/);
  });
}

for (const invalid of [false, true]) test(`PowerShell fence reconciliation ${invalid ? 'retains invalid evidence' : 'releases isolated device'}`, {
  skip: !enabled || process.platform !== 'win32',
}, async t => {
  const f = await produce(t), stateRoot = path.join(f.root, 'ci-state'); await fs.mkdir(stateRoot);
  const runId = randomUUID(), attemptId = randomUUID(), dead = { pid: 2147483647, startTimeTicks: 1 };
  const controlPath = path.join(f.root, 'control.json');
  const control = { protocol: 'maestro.harmonyos.runner-control', schemaVersion: 1, deviceId: f.input.deviceId, runId, attemptId, process: dead };
  await fs.writeFile(controlPath, JSON.stringify(control));
  const statePath = path.join(stateRoot, hash(f.input.deviceId) + '.json');
  const state = { protocol: 'maestro.harmonyos.ci-device', schemaVersion: 1, deviceId: f.input.deviceId, state: 'needs_inspection', kind: 'single',
    launchId: randomUUID(), runId, attemptId, ownerProcess: dead, controlRecordPath: controlPath, recoveryRoot: f.input.recoveryRoot,
    createdAt: f.input.createdAt, updatedAt: f.input.createdAt, resolution: null, execution: 'unknown' };
  await fs.writeFile(statePath, JSON.stringify(state));
  if (invalid) {
    const response = JSON.parse(await fs.readFile(f.input.responsePath)); response.handoffReady = false;
    await fs.writeFile(f.input.responsePath, JSON.stringify(response));
  }
  const invocation = execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/ci/run-device-suite.ps1'),
    '-DeviceId', f.input.deviceId, '-DeviceStateDirectory', stateRoot, '-RecoveryRoot', f.input.recoveryRoot,
    '-ReconcileOnly', '-RecoveryReportPath', f.input.responsePath], { windowsHide: true, timeout: 45000,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH } });
  if (invalid) await assert.rejects(invocation, /Fence response differs/); else await invocation;
  const after = JSON.parse(await fs.readFile(statePath));
  assert.equal(after.state, invalid ? 'needs_inspection' : 'released');
  assert.equal(after.execution, 'unknown');
  assert.deepEqual(JSON.parse(await fs.readFile(controlPath)), control);
});
