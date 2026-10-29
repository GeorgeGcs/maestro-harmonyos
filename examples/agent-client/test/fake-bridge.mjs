import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';

const root = process.env.AGENT_EXAMPLE_FIXTURE;
const mode = process.env.AGENT_EXAMPLE_SCENARIO;
const trace = path.join(root, 'requests.jsonl');
let version = 1, sessionId = randomUUID(), sessionRevision = 1, connected = false, closed = false, cleanup = 'not_started';
let registry, current, recovered = false, preflights = 0;
const previousSession = randomUUID();
const attempts = new Map();
const methods = ['describe', 'preflight', 'connect', 'session', 'snapshot', 'action', 'cancel', 'release', 'result', 'evidence', 'recover'].map(name => `agent.${name}`);
function document(kind, data, revision = 0, schemaVersion = version) {
  return { protocol: 'maestro.harmonyos.agent', schemaVersion, kind, revision, observedAt: new Date().toISOString(), data };
}
function respond(id, kind, data, revision, delay = 0) {
  const response = JSON.stringify({ id, result: document(kind, data, revision) }) + '\n';
  setTimeout(() => process.stdout.write(response), delay);
}
function error(id, code, details) {
  process.stdout.write(JSON.stringify({ id, error: { kind: 'environment', code, message: code, ...(details ? { details } : {}) } }) + '\n');
}
function session() {
  return { sessionId, owner: 'bridge', state: closed ? 'closed' : current?.data.status === 'running' ? 'busy' : cleanup === 'unknown' ? 'unknown' : 'idle',
    activeAttemptId: current?.data.status === 'running' ? current.data.attemptId : null, lockState: closed ? 'released' : 'held',
    cleanup: { state: cleanup, errors: [] }, handoffReady: closed && cleanup === 'complete' };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function persist(attempt) {
  const base = attempt.data.artifacts.baseDir;
  write(path.join(base, 'result.json'), document('runResult', attempt.data, attempt.revision, 1));
  write(path.join(base, 'evidence-index.json'), document('evidenceIndex', attempt.evidence, attempt.revision, 1));
}
function action(params) {
  const base = path.join(registry, 'runs', params.runId, params.attemptId);
  const bytes = JSON.stringify(params.action);
  write(path.join(base, 'input.json'), bytes);
  write(path.join(base, 'agent-manifest.json'), { files: ['input.json', 'result.json', 'evidence-index.json'] });
  const wait = mode.startsWith('cancel-') && params.action.type === 'assertVisible';
  const failed = mode === 'failure-evidence';
  const stepId = randomUUID();
  const issue = failed ? { kind: 'assertion', code: 'ASSERTION_FAILED', message: 'Fixture expected failure' } : null;
  const attempt = { revision: 1, data: { runId: params.runId, attemptId: params.attemptId, attemptNo: params.attemptNo,
    sessionId, deviceId: 'fixture-device', input: { kind: 'action', path: 'input.json', sha256: sha(bytes) }, flow: null,
    status: wait ? 'running' : failed ? 'failed' : 'passed', startedAt: new Date().toISOString(), endedAt: wait ? null : new Date().toISOString(),
    effects: 'none', error: issue, failedStepId: failed ? stepId : null, cleanup: { state: wait ? 'in_progress' : 'complete', errors: [] },
    artifacts: { baseDir: base, manifestPaths: ['agent-manifest.json'], junitPath: null, evidenceIndexPath: 'evidence-index.json' } },
  evidence: { runId: params.runId, attemptId: params.attemptId, entries: [{ stepId, source: null, status: failed ? 'failed' : 'passed', error: issue,
    evidence: [{ kind: 'log', state: 'available', path: 'input.json', sha256: sha(bytes), capturedAt: new Date().toISOString(), phase: failed ? 'failure' : 'after', error: null }] }] } };
  if (mode === 'bad-hash') attempt.evidence.entries[0].evidence[0].sha256 = '0'.repeat(64);
  if (mode === 'escape-path') attempt.evidence.entries[0].evidence[0].path = '../outside.json';
  persist(attempt); attempts.set(params.attemptId, attempt); current = attempt;
  return attempt;
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(trace, line + '\n');
  if (mode === 'transport-truncated') { process.stdout.write(`{"id":${id},"result":`, () => process.exit(0)); return; }
  if (mode === 'transport-exit') { process.exit(7); }
  if (mode === 'transport-invalid-utf8') { process.stdout.write(Buffer.from([0xff, 10])); return; }
  if (mode.startsWith('transport-')) {
    if (method === 'agent.describe') version = mode === 'transport-downgrade' ? 1 : (params.schemaVersion ?? 1);
    const kind = method === 'agent.describe' ? 'capabilities' : method === 'agent.session' ? 'session' : 'preflight';
    const response = { id, result: document(kind, { tag: params.tag ?? '熊猫', sessionId: '10000000-0000-4000-8000-000000000000' }, params.revision ?? 0) };
    const encoded = Buffer.from(JSON.stringify(response) + '\n');
    if (mode === 'transport-utf8') { for (let n = 0; n < encoded.length; n += 3) process.stdout.write(encoded.subarray(n, n + 3)); return; }
    setTimeout(() => {
      process.stdout.write(encoded);
      if (mode === 'transport-duplicate') process.stdout.write(encoded);
    }, params.delayMs ?? 0);
    return;
  }
  if (method === 'agent.describe') { version = params.schemaVersion ?? version; respond(id, 'capabilities', { methods, commands: [] }); }
  else if (method === 'agent.preflight') {
    preflights++;
    const gate = (mode.startsWith('recovery-needed') && !recovered) || (mode === 'recovery-race' && preflights === 1);
    const blocked = mode === 'preflight-blocked';
    const unknown = mode === 'preflight-unknown' || mode === 'recovery-needed-unknown';
    const checks = [{ name: 'fixture', required: true, status: gate || blocked ? 'failed' : 'passed', code: gate ? 'DEVICE_RECOVERY_REQUIRED' : blocked ? 'DEVICE_NOT_FOUND' : 'READY', message: 'fixture' }];
    if (unknown) checks.push({ name: 'screen', required: true, status: 'unknown', code: 'PRECONDITION_UNKNOWN', message: 'fixture' });
    if (mode === 'preflight-invalid') checks[0].status = 'maybe';
    respond(id, 'preflight', { deviceId: params.deviceId, readiness: gate || blocked ? 'blocked' : unknown ? 'unknown' : 'ready', checks });
  } else if (method === 'agent.connect') {
    if (mode.startsWith('recovery-needed') && !recovered) { error(id, 'DEVICE_RECOVERY_REQUIRED', { recoverySessionId: previousSession }); return; }
    registry = params.artifactsDir; sessionId = randomUUID(); connected = true; closed = false; cleanup = 'not_started';
    respond(id, 'session', session(), ++sessionRevision, mode === 'connect-delay' ? 100 : 0);
  } else if (method === 'agent.session') respond(id, 'session', session(), sessionRevision);
  else if (method === 'agent.action') {
    if (attempts.has(params.attemptId)) { error(id, 'ATTEMPT_ALREADY_EXISTS'); return; }
    const attempt = action(params); sessionRevision++;
    if (mode === 'action-existing') { attempt.data.sessionId = previousSession; persist(attempt); error(id, 'ATTEMPT_ALREADY_EXISTS'); return; }
    if (mode !== 'action-timeout') respond(id, 'runResult', attempt.data, attempt.revision);
  } else if (method === 'agent.result' || method === 'agent.evidence') {
    const attempt = attempts.get(params.attemptId);
    if (!attempt) { error(id, 'NOT_FOUND'); return; }
    respond(id, method === 'agent.result' ? 'runResult' : 'evidenceIndex', method === 'agent.result' ? attempt.data : attempt.evidence, attempt.revision);
  } else if (method === 'agent.cancel') {
    const attempt = attempts.get(params.attemptId);
    if (!attempt || params.sessionId !== sessionId) { error(id, 'STALE_ATTEMPT'); return; }
    let acceptance = 'already_finished';
    if (attempt.data.status === 'running') {
      acceptance = 'accepted'; attempt.data.status = 'cancelled'; attempt.data.endedAt = new Date().toISOString();
      attempt.data.error = { kind: 'cancelled', code: 'CANCELLED', message: 'Fixture cancellation' };
      attempt.data.cleanup.state = 'unknown'; attempt.revision++; cleanup = 'unknown'; sessionRevision++;
      persist(attempt);
    }
    respond(id, 'cancelAck', { sessionId, attemptId: params.attemptId, acceptance }, sessionRevision);
  } else if (method === 'agent.release') {
    closed = true; if (cleanup !== 'unknown') cleanup = 'complete'; sessionRevision++;
    respond(id, 'session', session(), sessionRevision);
  } else if (method === 'agent.recover') {
    const ready = mode !== 'cancel-unknown';
    recovered = ready;
    const reportPath = path.join(root, 'recovery', `${params.sessionId}.json`);
    const report = { deviceId: params.deviceId, sessionId: params.sessionId, state: ready ? 'complete' : 'unknown', operations: 1,
      pendingOperations: mode === 'cancel-invalid-recovery' ? 1 : ready ? 0 : 1, temporaryFiles: 0 };
    const audit = { schemaVersion: 1, recoveryId: randomUUID(), observedAt: new Date().toISOString(), reason: 'recovery',
      previousState: 'quarantined', previousReportPath: null, previousReportSha256: null, requiresRecovery: true,
      uncertainReason: 'Fixture cancellation', unresolvedRecording: false, closeFailure: null, ...report,
      issues: ready ? [] : [{ code: 'REMOTE_COMPLETION_UNCONFIRMED', message: 'Fixture completion is unknown' }] };
    if (mode === 'cancel-audit-device') audit.deviceId = 'another-fixture-device';
    if (mode === 'cancel-audit-session') audit.sessionId = previousSession;
    if (mode === 'cancel-audit-state') audit.state = 'unknown';
    for (const key of ['operations', 'pendingOperations', 'temporaryFiles']) {
      if (mode === `cancel-audit-${key}`) audit[key]++;
    }
    if (mode === 'cancel-audit-issues') audit.issues.push({ code: 'OWNED_RESOURCES_REMAIN', message: 'Fixture contradictory proof' });
    write(reportPath, audit);
    if (ready && params.sessionId === sessionId) { cleanup = 'complete'; sessionRevision++; }
    respond(id, 'recoveryReport', { ...report, cleanup: { state: ready ? 'complete' : 'unknown', errors: [] }, handoffReady: ready,
      reportPath, reportSha256: mode === 'cancel-bad-report-hash' ? '0'.repeat(64) : sha(fs.readFileSync(reportPath)) }, 0,
      mode === 'recovery-needed-delayed' ? 250 : 0);
  } else error(id, 'UNKNOWN_METHOD');
}).on('close', () => { process.exitCode = connected && cleanup !== 'complete' ? 1 : 0; });
write(path.join(root, 'ready'), 'ready');
