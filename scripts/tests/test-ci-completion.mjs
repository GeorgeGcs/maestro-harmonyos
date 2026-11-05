import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyState } from '../ci/verify-state.mjs';
import { writeGate, json } from './validation-fixture.mjs';
import { hash, hashFile, readJson } from '../validation/io.mjs';

const document = (kind, data) => ({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1,
  kind, revision: 1, observedAt: new Date().toISOString(), data });

async function fixture(t) {
  const parent = path.resolve('artifacts/ci-completion-tests');
  const root = path.join(parent, randomUUID());
  t.after(async () => {
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const runId = randomUUID(), attemptId = randomUUID(), deviceId = 'completion-fixture-no-device';
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const agentRoot = path.join(root, 'agent'), recoveryRoot = path.join(root, 'recovery');
  const base = path.join(agentRoot, 'runs', runId, attemptId), resultPath = path.join(base, 'result.json');
  const controlRecordPath = path.join(root, 'control.json');
  await json(path.join(base, 'input.json'), { kind: 'flow', fixture: true });
  await json(path.join(base, 'state.json'), { status: 'unknown' });
  await json(path.join(base, 'registration.json'), { runId, attemptId });
  await fs.writeFile(path.join(base, 'diagnostics.log'), 'The action outcome is unknown; session cleanup completed.');
  const result = document('runResult', { runId, attemptId, attemptNo: 1, sessionId: null, deviceId, flow: null,
    status: 'unknown', startedAt: createdAt, endedAt: new Date().toISOString(), effects: 'unknown',
    error: { kind: 'transport', code: 'HDC_TIMEOUT', message: 'The action outcome was not confirmed.' },
    cleanup: { state: 'complete', errors: [] }, failedStepId: null,
    input: { kind: 'flow', path: 'input.json', sha256: await hashFile(path.join(base, 'input.json')) },
    artifacts: { baseDir: base, manifestPaths: ['agent-manifest.json'], junitPath: null,
      evidenceIndexPath: 'evidence-index.json' } });
  await json(resultPath, result);
  await json(path.join(base, 'evidence-index.json'), document('evidenceIndex', { runId, attemptId, entries: [
    { stepId: null, source: null, status: 'unknown', error: result.data.error, evidence: [
      { kind: 'log', state: 'available', path: 'diagnostics.log', sha256: await hashFile(path.join(base, 'diagnostics.log')),
        capturedAt: result.observedAt, phase: 'failure', error: null } ] } ] }));
  async function seal() {
    await json(path.join(base, 'agent-manifest.json'), { schemaVersion: 1, runId, attemptId,
      files: await Promise.all(['input.json', 'result.json', 'state.json', 'registration.json', 'evidence-index.json']
        .map(async relative => ({ path: relative, sha256: await hashFile(path.join(base, relative)) }))) });
  }
  await seal();
  const control = { protocol: 'maestro.harmonyos.runner-control', schemaVersion: 1, runId, attemptId, deviceId,
    phase: 'exited', process: { pid: 2147483000, startTimeTicks: 1, executable: 'fixture-java' },
    processExitObserved: true, processExitCode: 7, wrapperExitCode: 7, agentStatus: 'unknown',
    terminationRequested: false, stopReason: null, error: null, stdoutComplete: true, stderrComplete: true,
    runResultPath: resultPath };
  await json(controlRecordPath, control);
  await writeGate(recoveryRoot, deviceId);
  const gatePath = path.join(recoveryRoot, hash(Buffer.from(deviceId)) + '.owner.json');
  const gate = (await readJson(gatePath)).value;
  return { root, base, resultPath, result, control, gate, gatePath, seal,
    input: { mode: 'completion', deviceId, runId, attemptId, createdAt, agentRoot, recoveryRoot, controlRecordPath } };
}

test('unknown execution with confirmed normal cleanup releases resources without changing the failure', async t => {
  const f = await fixture(t), before = await hashFile(f.resultPath);
  const verified = await verifyState(f.input);
  assert.equal(verified.releaseConfirmed, true);
  assert.equal(verified.status, 'unknown');
  assert.equal(verified.processExitCode, 7);
  assert.equal(verified.reportSha256, f.gate.reportSha256);
  assert.equal(verified.evidence.unavailable, 0);
  assert.equal(await hashFile(f.resultPath), before);
  assert.equal((await readJson(f.resultPath)).value.data.error.code, 'HDC_TIMEOUT');
});

for (const [name, mutate] of [
  ['zero exit', f => { f.control.processExitCode = 0; f.control.wrapperExitCode = 0; }],
  ['unobserved process exit', f => { f.control.processExitObserved = false; }],
  ['uncollected stderr', f => { f.control.stderrComplete = false; }],
  ['forced termination', f => { f.control.terminationRequested = true; }],
  ['status mismatch', f => { f.control.agentStatus = 'failed'; }],
  ['exit mismatch', f => { f.control.wrapperExitCode = 1; }],
]) test(`unknown completion rejects ${name}`, async t => {
  const f = await fixture(t); mutate(f); await json(f.input.controlRecordPath, f.control);
  await assert.rejects(verifyState(f.input), /unconfirmed|matching/);
});

test('a clean device gate cannot override an unknown attempt cleanup result', async t => {
  const f = await fixture(t); f.result.data.cleanup.state = 'unknown';
  await json(f.resultPath, f.result); await f.seal();
  await assert.rejects(verifyState(f.input), /cleaned terminal/);
});

for (const [name, mutate] of [
  ['quarantined gate', f => { f.gate.state = 'quarantined'; }],
  ['unresolved recording', f => { f.gate.unresolvedRecording = true; }],
  ['receipt digest mismatch', f => { f.gate.reportSha256 = '0'.repeat(64); }],
  ['wrong session owner', f => { f.gate.ownerSessionId = randomUUID(); }],
]) test(`unknown completion rejects ${name}`, async t => {
  const f = await fixture(t); mutate(f); await json(f.gatePath, f.gate);
  await assert.rejects(verifyState(f.input), /clean release|trusted cleanup/);
});

test('unknown completion rejects stale receipts even with a matching gate digest', async t => {
  const f = await fixture(t), receipt = (await readJson(f.gate.reportPath)).value;
  receipt.observedAt = new Date(Date.parse(f.input.createdAt) - 1000).toISOString();
  await json(f.gate.reportPath, receipt); f.gate.reportSha256 = await hashFile(f.gate.reportPath);
  await json(f.gatePath, f.gate);
  await assert.rejects(verifyState(f.input), /stale/);
});

test('unknown completion rejects modified result and recording evidence', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.resultPath, ' ');
  await assert.rejects(verifyState(f.input), /Artifact hash differs/);
  await f.seal();
  const receipt = (await readJson(f.gate.reportPath)).value;
  await fs.appendFile(receipt.recordingResources.path, ' ');
  await assert.rejects(verifyState(f.input), /recording|Recording|snapshot|hash/i);
});
