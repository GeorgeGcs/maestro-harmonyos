import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RemoteError, RequestTimeoutError } from './client.mjs';
import { verifyEvidence, verifyRecoveryReport } from './evidence.mjs';

const terminal = new Set(['passed', 'failed', 'blocked', 'cancelled', 'unknown']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

function failure(error, phase) {
  return { phase, name: error.name, code: error.code ?? null, message: error.message, ...(error.details ? { details: error.details } : {}) };
}

function sessionData(document, sessionId) {
  const value = document.data;
  if (value.sessionId !== sessionId || value.owner !== 'bridge' || typeof value.handoffReady !== 'boolean' ||
      !['idle', 'inspecting', 'busy', 'cancelling', 'releasing', 'closed', 'unknown'].includes(value.state) ||
      !['held', 'released', 'unknown'].includes(value.lockState) || !Array.isArray(value.cleanup?.errors) ||
      !['not_started', 'in_progress', 'complete', 'failed', 'unknown'].includes(value.cleanup.state)) throw new Error('Session identity or cleanup is invalid.');
  if (value.handoffReady && !(value.state === 'closed' && value.activeAttemptId === null && value.lockState === 'released' &&
      value.cleanup.state === 'complete' && Array.isArray(value.cleanup.errors) && value.cleanup.errors.length === 0)) {
    throw new Error('Session claims handoff readiness without confirmed release.');
  }
  return value;
}

/** A bounded caller workflow. Only read-only queries are polled; actions are never retried. */
export async function runWorkflow({ client, deviceId, appId, abilityName, moduleName, artifactsRoot, assertText,
  launch = false, allowUnknown = false, cancelAfterMs, signal, recover = true, onHandoff,
  recoveryRoot = path.join(os.homedir(), '.maestro', 'harmonyos-sessions'),
  invocationId = randomUUID(), timeoutMs = 90_000, pollMs = 100, onEvent = () => {} }) {
  if (![deviceId, appId, abilityName, artifactsRoot, assertText].every(value => typeof value === 'string' && value.trim()) ||
      !uuid.test(invocationId)) throw new Error('Provide explicit device, application, ability, artifact root and assertion text.');
  if (cancelAfterMs !== undefined && (!Number.isInteger(cancelAfterMs) || cancelAfterMs < 0)) throw new Error('cancelAfterMs must be a nonnegative integer.');
  const directory = path.resolve(artifactsRoot, 'client', invocationId);
  const registry = path.resolve(artifactsRoot, 'server');
  await fs.mkdir(directory, { recursive: true });
  const actions = [...(launch ? [{ type: 'launchApp' }] : []), { type: 'assertVisible', text: assertText }, { type: 'takeScreenshot', name: 'agent-example' }];
  const plans = actions.map(action => ({ runId: randomUUID(), attemptId: randomUUID(), attemptNo: 1, action }));
  // Refuse to overwrite a previous caller invocation, even if the server has not registered it yet.
  const reservation = await fs.open(path.join(directory, 'invocation.json'), 'wx');
  try { await reservation.writeFile(JSON.stringify({ invocationId, deviceId, appId, abilityName, moduleName, plans }, null, 2)); await reservation.sync(); }
  finally { await reservation.close(); }
  const summary = { invocationId, directory, status: 'unknown', preflight: null, preflights: [], attempts: [], session: null,
    recovery: [], handoff: null, bridgeExit: null, errors: [] };
  let sessionId; let active; let stopping = signal?.aborted === true; let stopReason = stopping ? 'user' : null;
  let methods = new Set();
  const config = { deviceId, appId, abilityName, artifactsDir: registry, ...(moduleName ? { moduleName } : {}) };
  const event = (name, data = {}) => onEvent({ name, ...data });

  const cancelActive = () => {
    if (!active?.sent || !active.canCancel || active.cancel) return active?.cancel;
    const item = active;
    item.cancel = client.request('agent.cancel', { sessionId, attemptId: item.params.attemptId }).then(ack => {
      if (ack.data.sessionId !== sessionId || ack.data.attemptId !== item.params.attemptId ||
          !['accepted', 'already_requested', 'already_finished'].includes(ack.data.acceptance)) throw new Error('Cancellation acknowledged another attempt or an invalid state.');
      item.record.cancelAck = ack; event('cancel', { acceptance: ack.data.acceptance });
    }).catch(error => { summary.errors.push(failure(error, 'cancel')); });
    return item.cancel;
  };
  const stop = () => { stopping = true; stopReason = 'user'; void cancelActive(); };
  signal?.addEventListener('abort', stop);
  async function pollSession(predicate) {
    const until = Date.now() + timeoutMs;
    do {
      const document = await client.request('agent.session', { sessionId });
      const data = sessionData(document, sessionId);
      if (predicate(data)) return document;
      await sleep(pollMs);
    } while (Date.now() < until);
    throw new Error('Session state did not settle within the caller budget; release remains unconfirmed.');
  }
  async function recovery(targetSession) {
    if (!uuid.test(targetSession)) throw new Error('Invalid recovery session identity.');
    const document = await client.request('agent.recover', { deviceId, sessionId: targetSession });
    summary.recovery.push(document);
    await saveJson(path.join(directory, `recovery-${summary.recovery.length}.json`), document);
    const value = document.data;
    if (value.sessionId !== targetSession || value.deviceId !== deviceId || !['complete', 'unknown'].includes(value.state) ||
        !Array.isArray(value.cleanup?.errors) || ['operations', 'pendingOperations', 'temporaryFiles'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
        typeof value.handoffReady !== 'boolean' || value.handoffReady !== (value.state === 'complete') ||
        (value.handoffReady && (value.cleanup.state !== 'complete' || value.cleanup.errors.length !== 0 || value.pendingOperations !== 0 || value.temporaryFiles !== 0)) ||
        (!value.handoffReady && value.cleanup.state !== 'unknown')) {
      throw new Error('Recovery report does not confirm this device and session.');
    }
    await verifyRecoveryReport(document, recoveryRoot);
    event('recovery', { state: value.state, handoffReady: value.handoffReady });
    return value.handoffReady;
  }
  async function preflight() {
    const document = await client.request('agent.preflight', { deviceId, commands: actions.map(action => action.type), appId, abilityName, ...(moduleName ? { moduleName } : {}) });
    summary.preflight = document; summary.preflights.push(document);
    await saveJson(path.join(directory, `preflight-${summary.preflights.length}.json`), document);
    const value = document.data;
    if (value.deviceId !== deviceId || !Array.isArray(value.checks) || !value.checks.some(check => check.required === true) ||
        !value.checks.every(check => check && typeof check.required === 'boolean' && ['passed', 'failed', 'unknown'].includes(check.status))) {
      throw new Error('Preflight does not identify the requested target and valid checks.');
    }
    const failed = value.checks.filter(check => check.required && check.status === 'failed');
    const unknown = value.checks.some(check => check.required && check.status === 'unknown');
    const readiness = failed.length ? 'blocked' : unknown ? 'unknown' : 'ready';
    if (value.readiness !== readiness) throw new Error('Preflight readiness contradicts its checks.');
    event('preflight', { readiness });
    // A connection attempt may obtain the blocking owner's structured identity, but may not run actions.
    if (readiness === 'blocked' && recover && failed.every(check => check.code === 'DEVICE_RECOVERY_REQUIRED')) return 'recovery-only';
    if (readiness === 'blocked' || (readiness === 'unknown' && !allowUnknown)) {
      summary.status = 'blocked';
      throw new Error('Preflight did not confirm readiness. Inspect the saved preflight; --allow-unknown explicitly permits unknown checks, never failed checks.');
    }
    return 'execute';
  }
  try {
    let capabilities;
    try { capabilities = await client.request('agent.describe', { schemaVersion: 2 }); }
    catch (error) {
      if (error instanceof RemoteError && ['INVALID_PARAMS', 'UNKNOWN_METHOD'].includes(error.code)) {
        throw new Error('This CLI does not support protocol v2 recovery. Rebuild the current repository CLI before using this example.');
      }
      throw error;
    }
    methods = new Set(capabilities.data.methods);
    for (const required of ['agent.preflight', 'agent.connect', 'agent.session', 'agent.action', 'agent.cancel', 'agent.release', 'agent.result', 'agent.evidence', 'agent.recover']) {
      if (!methods.has(required)) throw new Error(`The server does not declare ${required}.`);
    }
    if (stopping) { summary.status = 'cancelled'; return summary; }
    let permission = await preflight();
    if (stopping) { summary.status = 'cancelled'; return summary; }
    let connected;
    try { connected = await client.request('agent.connect', config); }
    catch (error) {
      if (!(error instanceof RemoteError) || error.code !== 'DEVICE_RECOVERY_REQUIRED' || !recover ||
          !uuid.test(error.details?.recoverySessionId ?? '')) throw error;
      if (!(await recovery(error.details.recoverySessionId)) || stopping) throw error;
      permission = await preflight();
      if (permission !== 'execute') throw new Error('Another recovery gate remains after the checked recovery. No actions were started.');
      connected = await client.request('agent.connect', config); // Retry acquiring a session, never an action.
    }
    sessionId = connected.data.sessionId;
    if (!uuid.test(sessionId) || sessionData(connected, sessionId).state !== 'idle') throw new Error('Connection did not return an owned idle session.');
    if (permission === 'recovery-only') {
      // The gate disappeared between preflight and connect. Release this observational connection and recheck.
      await client.request('agent.release', { sessionId });
      const released = await pollSession(data => data.state === 'closed');
      if (!released.data.handoffReady) throw new Error('Connection race did not confirm release. No actions were started.');
      sessionId = undefined;
      permission = await preflight();
      if (permission !== 'execute' || stopping) throw new Error('Preflight did not permit execution after the recovery race.');
      connected = await client.request('agent.connect', config); sessionId = connected.data.sessionId;
      if (!uuid.test(sessionId) || sessionData(connected, sessionId).state !== 'idle') throw new Error('Expected an idle session after rechecking preflight.');
    }
    await saveJson(path.join(directory, 'connected.json'), connected);
    for (const plan of plans) {
      if (stopping) break;
      const params = { sessionId, ...plan };
      const record = { params, result: null, evidence: null, verification: null, cancelAck: null, responseError: null };
      summary.attempts.push(record);
      const requestFile = path.join(directory, `${plan.attemptId}.request.json`);
      await saveJson(requestFile, params); // Identity and input survive a lost acknowledgement.
      if (stopping) break;
      active = { params, record, sent: false, canCancel: true, cancel: null };
      try {
        const response = client.request('agent.action', params); active.sent = true;
        await response;
      } catch (error) {
        record.responseError = failure(error, 'action acknowledgement');
        if (error instanceof RemoteError && error.code === 'ATTEMPT_ALREADY_EXISTS') active.canCancel = false;
        else if (!(error instanceof RequestTimeoutError)) throw error;
        // Query the already identified attempt, including when its acknowledgement was lost.
      }
      event('submitted', { type: plan.action.type, runId: plan.runId, attemptId: plan.attemptId });
      let runningSince;
      const until = Date.now() + timeoutMs;
      do {
        const result = await client.request('agent.result', { runId: plan.runId, attemptId: plan.attemptId });
        if (result.data.runId !== plan.runId || result.data.attemptId !== plan.attemptId || result.data.deviceId !== deviceId) throw new Error('Result identifies another attempt or device.');
        record.result = result;
        if (terminal.has(result.data.status)) break;
        if (!['pending', 'running', 'cancelling'].includes(result.data.status)) throw new Error('Unknown execution status.');
        if (result.data.startedAt !== null && runningSince === undefined) runningSince = Date.now();
        if (!stopping && plan.action.type === 'assertVisible' && cancelAfterMs !== undefined && runningSince !== undefined && Date.now() - runningSince >= cancelAfterMs) {
          stopping = true; stopReason = 'demo';
        }
        if (stopping) await cancelActive();
        if (Date.now() >= until) throw new Error('Attempt exceeded the caller polling budget. Its identity is retained; it will not be resent.');
        await sleep(pollMs);
      } while (true);
      await active.cancel;
      active.canCancel = false;
      await pollSession(data => ['idle', 'unknown', 'closed'].includes(data.state) && data.activeAttemptId === null);
      record.result = await client.request('agent.result', { runId: plan.runId, attemptId: plan.attemptId });
      record.evidence = await client.request('agent.evidence', { runId: plan.runId, attemptId: plan.attemptId });
      await saveJson(path.join(directory, `${plan.attemptId}.result.json`), record.result);
      await saveJson(path.join(directory, `${plan.attemptId}.evidence.json`), record.evidence);
      record.verification = await verifyEvidence(record.result, record.evidence, registry);
      event('attempt', { type: plan.action.type, status: record.result.data.status, ...record.verification });
      active = null;
      summary.status = record.result.data.status;
      if (record.result.data.status !== 'passed') break;
    }
    if (stopping && (!summary.attempts.length || (stopReason === 'user' && summary.status === 'passed'))) summary.status = 'cancelled';
  } catch (error) {
    summary.errors.push(failure(error, 'workflow')); event('error', { message: error.message });
    if (summary.status !== 'blocked') summary.status = 'unknown';
  } finally {
    if (sessionId) {
      try {
        await cancelActive(); // No-op after a confirmed terminal action.
        await client.request('agent.release', { sessionId });
        summary.session = await pollSession(data => data.state === 'closed');
        if (!summary.session.data.handoffReady && recover && methods.has('agent.recover')) {
          if (!(await recovery(sessionId))) summary.status = 'unknown';
          summary.session = await client.request('agent.session', { sessionId });
        }
        const released = sessionData(summary.session, sessionId);
        await saveJson(path.join(directory, 'released.json'), summary.session);
        event('released', { cleanup: released.cleanup.state, handoffReady: released.handoffReady });
        if (!released.handoffReady) { summary.status = 'unknown'; summary.errors.push({ phase: 'release', message: 'Device handoff remains blocked; no subsequent CLI was started.' }); }
        else if (onHandoff && stopReason !== 'user' && (summary.status === 'passed' || (summary.status === 'cancelled' && stopReason === 'demo'))) {
          summary.handoff = await onHandoff({ directory, deviceId, signal });
          const status = summary.handoff.result?.data.status;
          if (status && terminal.has(status) && status !== 'passed') summary.status = status;
          else if (summary.handoff.exitCode !== 0 || summary.handoff.confirmed === false) summary.status = 'unknown';
        }
      } catch (error) { summary.errors.push(failure(error, 'release or recovery')); summary.status = 'unknown'; }
    }
    signal?.removeEventListener('abort', stop);
    summary.bridgeExit = await client.close();
    if (summary.bridgeExit.forced || (sessionId && summary.bridgeExit.code !== 0)) summary.status = 'unknown';
    await saveJson(path.join(directory, 'summary.json'), summary);
  }
  return summary;
}
