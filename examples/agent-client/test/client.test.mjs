import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AgentClient, RequestTimeoutError } from '../client.mjs';
import { confinedFile } from '../evidence.mjs';
import { runWorkflow } from '../workflow.mjs';

const fixtureScript = fileURLToPath(new URL('./fake-bridge.mjs', import.meta.url));
const testArtifacts = fileURLToPath(new URL('../../../artifacts/agent-client-tests/', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, scenario, options = {}) {
  await fs.mkdir(testArtifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(testArtifacts, 'case-'));
  const client = AgentClient.spawn(process.execPath, [fixtureScript], { env: { ...process.env, AGENT_EXAMPLE_FIXTURE: root, AGENT_EXAMPLE_SCENARIO: scenario }, ...options });
  t.after(async () => { await client.close(1000); }); // Keep original fixture outputs for diagnosing failed checks.
  const until = Date.now() + 5000;
  while (true) {
    try { await fs.access(path.join(root, 'ready')); break; } catch { if (Date.now() > until) throw new Error('Fixture did not start.'); await pause(10); }
  }
  const requests = async () => (await fs.readFile(path.join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, client, requests };
}
const configuration = (fixture, overrides = {}) => ({ client: fixture.client, deviceId: 'fixture-device', appId: 'org.example.fixture',
  abilityName: 'EntryAbility', artifactsRoot: path.join(fixture.root, 'artifacts'), recoveryRoot: path.join(fixture.root, 'recovery'),
  assertText: 'Ready', timeoutMs: 3000, pollMs: 10, ...overrides });

test('JSONL matches concurrent replies by id and handles split UTF-8', async t => {
  for (const scenario of ['transport-reorder', 'transport-utf8']) {
    const f = await fixture(t, scenario);
    await f.client.request('agent.describe', { schemaVersion: 2 });
    const slow = f.client.request('agent.preflight', { tag: '慢 熊猫', delayMs: 50 });
    const fast = f.client.request('agent.preflight', { tag: '快 熊猫', delayMs: 0 });
    assert.equal((await fast).data.tag, '快 熊猫');
    assert.equal((await slow).data.tag, '慢 熊猫');
  }
});

test('describe without a version preserves the negotiated version on repeated queries', async t => {
  const f = await fixture(t, 'pass');
  assert.equal((await f.client.request('agent.describe', { schemaVersion: 2 })).schemaVersion, 2);
  assert.equal((await f.client.request('agent.describe')).schemaVersion, 2);
  assert.equal(f.client.failure, null);
});

test('timeout leaves execution uncertain, ignores its late reply, and never resends', async t => {
  const f = await fixture(t, 'transport-reorder');
  await assert.rejects(f.client.request('agent.describe', { delayMs: 150 }, { timeoutMs: 30 }), RequestTimeoutError);
  assert.equal((await f.client.request('agent.preflight', { tag: 'still usable' })).data.tag, 'still usable');
  await pause(180);
  assert.equal(f.client.failure, null);
  assert.equal((await f.requests()).filter(request => request.method === 'agent.describe').length, 1);
});

test('truncated, invalid UTF-8, duplicate, downgraded and exited streams fail closed', async t => {
  for (const scenario of ['transport-truncated', 'transport-invalid-utf8', 'transport-downgrade', 'transport-exit']) {
    const f = await fixture(t, scenario);
    await assert.rejects(f.client.request('agent.describe', { schemaVersion: 2 }));
    assert(f.client.failure);
  }
  const duplicate = await fixture(t, 'transport-duplicate');
  await duplicate.client.request('agent.describe'); await pause(20);
  await assert.rejects(duplicate.client.request('agent.preflight'), /duplicate/);
});

test('state revision regression and oversized replies are rejected', async t => {
  const f = await fixture(t, 'transport-reorder');
  await f.client.request('agent.session', { revision: 2 });
  await assert.rejects(f.client.request('agent.session', { revision: 1 }), /backwards/);
  const big = await fixture(t, 'transport-reorder', { maxResponseBytes: 100 });
  await assert.rejects(big.client.request('agent.describe'), /byte limit/);
});

test('unknown requires opt-in, failed preflight never connects', async t => {
  for (const [scenario, allowUnknown] of [['preflight-unknown', false], ['preflight-blocked', true]]) {
    const f = await fixture(t, scenario);
    const result = await runWorkflow(configuration(f, { allowUnknown }));
    assert.equal(result.status, 'blocked');
    assert.equal((await f.requests()).filter(request => request.method === 'agent.connect').length, 0);
  }
  const permitted = await fixture(t, 'preflight-unknown');
  assert.equal((await runWorkflow(configuration(permitted, { allowUnknown: true }))).status, 'passed');
});

test('ordinary workflow verifies real artifacts and releases before handoff', async t => {
  const f = await fixture(t, 'pass');
  let handedOff = false;
  const result = await runWorkflow(configuration(f, { onHandoff: async () => {
    const methods = (await f.requests()).map(request => request.method);
    assert(methods.includes('agent.release')); assert.equal(methods.at(-1), 'agent.session');
    handedOff = true; return { exitCode: 0 };
  } }));
  assert.equal(result.status, 'passed'); assert(handedOff);
  assert.equal(result.attempts.length, 2);
  assert(result.attempts.every(attempt => attempt.verification.checkedFiles === 2));
  assert.notEqual(result.attempts[0].params.attemptId, result.attempts[1].params.attemptId);
  assert.equal(result.bridgeExit.code, 0);
});

test('lost action acknowledgement queries the original attempt without resending', async t => {
  const f = await fixture(t, 'action-timeout', { requestTimeoutMs: 80 });
  const result = await runWorkflow(configuration(f));
  assert.equal(result.status, 'passed');
  assert(result.attempts.every(attempt => attempt.responseError.name === 'RequestTimeoutError'));
  const sent = (await f.requests()).filter(request => request.method === 'agent.action');
  assert.equal(sent.length, 2); assert.equal(new Set(sent.map(request => request.params.attemptId)).size, 2);
});

test('caller invocation reservation refuses reuse before sending any new request', async t => {
  const f = await fixture(t, 'pass');
  const invocationId = randomUUID();
  const result = await runWorkflow(configuration(f, { invocationId }));
  const planPath = path.join(result.directory, 'invocation.json');
  const before = await fs.readFile(planPath, 'utf8');
  const count = (await f.requests()).length;
  await assert.rejects(runWorkflow(configuration(f, { invocationId })), { code: 'EEXIST' });
  assert.equal(await fs.readFile(planPath, 'utf8'), before);
  assert.equal((await f.requests()).length, count);
});

test('an existing attempt is queried without replay or cancelling its previous owner', async t => {
  const f = await fixture(t, 'action-existing');
  const abort = new AbortController();
  const result = await runWorkflow(configuration(f, { signal: abort.signal,
    onEvent: event => { if (event.name === 'submitted') abort.abort(); } }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.attempts[0].responseError.code, 'ATTEMPT_ALREADY_EXISTS');
  assert.equal(result.attempts[0].result.data.status, 'passed');
  const sent = await f.requests();
  assert.equal(sent.filter(request => request.method === 'agent.action').length, 1);
  assert.equal(sent.filter(request => request.method === 'agent.cancel').length, 0);
});

test('invalid preflight states fail closed before connect', async t => {
  const f = await fixture(t, 'preflight-invalid');
  const result = await runWorkflow(configuration(f, { allowUnknown: true }));
  assert.equal(result.status, 'unknown');
  assert.equal((await f.requests()).filter(request => request.method === 'agent.connect').length, 0);
});

test('failed assertion retains result and verified evidence without continuing', async t => {
  const f = await fixture(t, 'failure-evidence');
  const result = await runWorkflow(configuration(f, { onHandoff: () => { throw new Error('Must not hand off failed business flow'); } }));
  assert.equal(result.status, 'failed'); assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].result.data.error.code, 'ASSERTION_FAILED');
  assert.equal(result.attempts[0].verification.checkedFiles, 2);
  assert.equal(result.session.data.handoffReady, true);
});

test('cancel demonstration waits for recovery proof and keeps original cancelled result', async t => {
  const f = await fixture(t, 'cancel-recover');
  let handedOff = false;
  const result = await runWorkflow(configuration(f, { cancelAfterMs: 0, onHandoff: async () => { handedOff = true; return { exitCode: 0 }; } }));
  assert.equal(result.status, 'cancelled'); assert(handedOff);
  assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].result.data.cleanup.state, 'unknown');
  assert.equal(result.session.data.cleanup.state, 'complete'); assert.equal(result.recovery[0].data.state, 'complete');
  const methods = (await f.requests()).map(request => request.method);
  assert(methods.indexOf('agent.cancel') < methods.indexOf('agent.release'));
  assert(methods.indexOf('agent.release') < methods.indexOf('agent.recover'));
});

test('unknown recovery prevents handoff and does not retry cleanup or the action', async t => {
  const f = await fixture(t, 'cancel-unknown');
  const result = await runWorkflow(configuration(f, { cancelAfterMs: 0, onHandoff: () => { throw new Error('Unsafe handoff'); } }));
  assert.equal(result.status, 'unknown'); assert.equal(result.session.data.handoffReady, false);
  const sent = await f.requests();
  assert.equal(sent.filter(request => request.method === 'agent.action').length, 1);
  assert.equal(sent.filter(request => request.method === 'agent.recover').length, 1);
});

test('contradictory recovery reports and wrong report hashes are retained and block handoff', async t => {
  for (const scenario of ['cancel-invalid-recovery', 'cancel-bad-report-hash']) {
    const f = await fixture(t, scenario);
    const result = await runWorkflow(configuration(f, { cancelAfterMs: 0, onHandoff: () => { throw new Error('Unsafe recovery proof'); } }));
    assert.equal(result.status, 'unknown'); assert.equal(result.handoff, null);
    assert.equal(result.recovery.length, 1);
    assert.equal(result.attempts[0].result.data.cleanup.state, 'unknown');
    assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'recovery-1.json'), 'utf8')).kind, 'recoveryReport');
  }
});

test('a correctly hashed audit must match the response owner, state, counters and completion issues', async t => {
  for (const field of ['device', 'session', 'state', 'operations', 'pendingOperations', 'temporaryFiles', 'issues']) {
    const f = await fixture(t, `cancel-audit-${field}`);
    const result = await runWorkflow(configuration(f, { cancelAfterMs: 0,
      onHandoff: () => { throw new Error('An unrelated or contradictory audit cannot authorize handoff'); } }));
    assert.equal(result.status, 'unknown', field);
    assert.equal(result.handoff, null, field);
    assert.equal(result.recovery.length, 1, field);
    assert.equal(result.attempts[0].result.data.cleanup.state, 'unknown', field);
    const report = result.recovery[0].data;
    const bytes = await fs.readFile(report.reportPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), report.reportSha256, field);
    assert(result.errors.some(error => /Recovery audit does not match|Complete recovery audit still lists issues/.test(error.message)), field);
  }
});

test('user stop cancels only its attempt and never starts handoff', async t => {
  const f = await fixture(t, 'cancel-recover');
  const abort = new AbortController();
  const result = await runWorkflow(configuration(f, { signal: abort.signal, onEvent: event => { if (event.name === 'submitted') abort.abort(); },
    onHandoff: () => { throw new Error('Ctrl+C must not start another process'); } }));
  assert.equal(result.status, 'cancelled'); assert.equal(result.handoff, null);
  const sent = await f.requests();
  const action = sent.find(request => request.method === 'agent.action');
  const cancel = sent.find(request => request.method === 'agent.cancel');
  assert.equal(cancel.params.attemptId, action.params.attemptId); assert.equal(cancel.params.sessionId, action.params.sessionId);
});

test('stop during connect releases late connection before any action', async t => {
  const f = await fixture(t, 'connect-delay');
  const abort = new AbortController();
  const timer = setInterval(async () => { try { if ((await f.requests()).some(request => request.method === 'agent.connect')) abort.abort(); } catch {} }, 10);
  try {
    const result = await runWorkflow(configuration(f, { signal: abort.signal }));
    assert.equal(result.status, 'cancelled'); assert.equal(result.session.data.handoffReady, true);
    assert.equal((await f.requests()).filter(request => request.method === 'agent.action').length, 0);
  } finally { clearInterval(timer); }
});

test('cross-process recovery rechecks preflight and cannot bypass unknown conditions', async t => {
  const f = await fixture(t, 'recovery-needed');
  const result = await runWorkflow(configuration(f));
  assert.equal(result.status, 'passed'); assert.equal(result.recovery.length, 1); assert.equal(result.preflights.length, 2);
  const blocked = await fixture(t, 'recovery-needed-unknown');
  const blockedResult = await runWorkflow(configuration(blocked));
  assert.equal(blockedResult.status, 'blocked');
  assert.equal((await blocked.requests()).filter(request => request.method === 'agent.action').length, 0);
});

test('recovery gate race releases observational connection before rechecking', async t => {
  const f = await fixture(t, 'recovery-race');
  const result = await runWorkflow(configuration(f));
  assert.equal(result.status, 'passed');
  const methods = (await f.requests()).map(request => request.method);
  assert.equal(methods.filter(method => method === 'agent.connect').length, 2);
  assert(methods.indexOf('agent.release') < methods.indexOf('agent.action'));
});

test('bad hashes and escaping evidence paths preserve result and block handoff', async t => {
  for (const scenario of ['bad-hash', 'escape-path']) {
    const f = await fixture(t, scenario);
    const result = await runWorkflow(configuration(f, { onHandoff: () => { throw new Error('Untrusted evidence must not pass'); } }));
    assert.equal(result.status, 'unknown'); assert.equal(result.attempts[0].result.data.status, 'passed'); assert.equal(result.handoff, null);
  }
});

test('evidence containment resolves directory links before reading', async t => {
  await fs.mkdir(testArtifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(testArtifacts, 'paths-'));
  const base = path.join(root, 'attempt'); const outside = path.join(root, 'outside');
  await fs.mkdir(base); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'not evidence');
  await fs.symlink(outside, path.join(base, 'link'), 'junction');
  await assert.rejects(confinedFile(base, 'link/secret'), /escapes/);
});
