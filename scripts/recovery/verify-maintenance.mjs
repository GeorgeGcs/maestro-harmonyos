import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { readBytes } from '../validation/io.mjs';
import { parseObservation, restarted, sameBoot } from './windows-boot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const fields = (value, names) => requireValue(value && !Array.isArray(value) &&
  equal(Object.keys(value).sort(), names.split(' ').sort()), 'Unexpected maintenance document fields.');
const phases = ['prepared', 'host_verified', 'phone_prepared', 'terminated', 'cleaning', 'cleaned', 'receipt_written', 'complete'];
const stepFields = 'schemaVersion checkpointSha256 revision previous phase observedAt journal calls hostResume phoneBefore hostComplete phoneAfter termination cleanupBatches receipt';

// Preserve large journal integers (notably process start ticks), and reject duplicate decoded keys.
// JSON.parse first validates syntax; the bounded token walk adds lossless integers and depth checks.
export function parseMaintenanceJson(text) {
  JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g);
  let cursor = 0;
  function value(depth = 0) {
    requireValue(depth <= 64, 'Maintenance metadata is too deeply nested.');
    const token = tokens[cursor++];
    if (token === '{') {
      const result = {};
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]); cursor++;
        requireValue(!Object.hasOwn(result, key), 'Duplicate maintenance JSON key.');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
        if (tokens[cursor] === ',') cursor++; else break;
      }
      cursor++; return result;
    }
    if (token === '[') {
      const result = [];
      while (tokens[cursor] !== ']') { result.push(value(depth + 1)); if (tokens[cursor] === ',') cursor++; else break; }
      cursor++; return result;
    }
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return BigInt(token);
    const result = JSON.parse(token);
    requireValue(typeof result !== 'number' || Number.isFinite(result), 'Nonfinite maintenance number.');
    return result;
  }
  return value();
}

function phone(node, deviceId, ownerId) {
  fields(node, 'schemaVersion provider deviceId ownerId hostCallId raw minutes lowerBoundMilliseconds upperBoundMillisecondsExclusive');
  requireValue(node.schemaVersion === 1 && node.provider === 'toybox-uptime-english-floor-minute-v1' &&
    node.deviceId === deviceId && node.ownerId === ownerId && uuid(node.hostCallId) && typeof node.raw === 'string' && node.raw.length <= 512,
  'Invalid phone observation identity.');
  const load = '(?:0|[1-9][0-9]*)\\.[0-9]{2}';
  const match = new RegExp('^ ([0-9]{2}):([0-5][0-9]):([0-5][0-9]) up (?:([1-9][0-9]*) (day|days), )?' +
    '(?:( [1-9]|1[0-9]|2[0-3]):([0-5][0-9])|([0-9]|[1-5][0-9]) min),  (0|[1-9][0-9]*) (user|users),  load average: ' +
    load + ', ' + load + ', ' + load + '\\r?\\n$').exec(node.raw);
  requireValue(match && match[0] === node.raw && Number(match[1]) <= 23, 'Unsupported phone uptime output.');
  const days = BigInt(match[4] ?? 0), users = BigInt(match[9]);
  requireValue((!match[4] || match[5] === (days === 1n ? 'day' : 'days')) && match[10] === (users === 1n ? 'user' : 'users'), 'Invalid uptime plurality.');
  const minutes = days * 1440n + (match[6] ? BigInt(match[6].trim()) * 60n + BigInt(match[7]) : BigInt(match[8]));
  requireValue(node.minutes === String(minutes) && node.lowerBoundMilliseconds === String(minutes * 60000n) &&
    node.upperBoundMillisecondsExclusive === String((minutes + 1n) * 60000n), 'Phone observation differs from raw uptime.');
  return minutes;
}

/** Read-only validation of a completed maintenance chain. Never invokes a tool or changes a gate. */
export async function verifyMaintenanceRelease({ deviceId, recoveryRoot, createdAt, responsePath = null }) {
  requireValue(typeof deviceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(deviceId) &&
    typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)), 'Invalid maintenance verification identity.');
  const records = new Map(), deadline = Date.now() + 30000;
  let totalBytes = 0;
  async function read(file) {
    file = path.resolve(file);
    if (records.has(file)) return records.get(file);
    requireValue(Date.now() <= deadline && records.size < 4096, 'Maintenance evidence budget exceeded.');
    const bytes = await readBytes(file, 32 * 1024 * 1024);
    totalBytes += bytes.length;
    requireValue(totalBytes <= 256 * 1024 * 1024, 'Maintenance evidence byte budget exceeded.');
    const record = { path: file, sha256: hash(bytes), value: parseMaintenanceJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    records.set(file, record); return record;
  }
  const root = path.resolve(recoveryRoot), key = hash(Buffer.from(deviceId));
  const gateRecord = await read(path.join(root, key + '.owner.json')), gate = gateRecord.value;
  fields(gate, 'schemaVersion deviceId ownerSessionId state journalPath updatedAt closeFailure reportPath reportSha256 requiresRecovery uncertainReason unresolvedRecording maintenance');
  requireValue(gate.schemaVersion === 2 && gate.deviceId === deviceId && uuid(gate.ownerSessionId) && gate.state === 'clean' &&
    gate.requiresRecovery === false && gate.closeFailure === null && gate.unresolvedRecording === false && gate.uncertainReason === null,
  'Maintenance has not confirmed device release.');
  const ownerId = gate.ownerSessionId, owner = path.join(root, key, ownerId), management = gate.maintenance;
  fields(management, 'maintenanceId checkpoint head');
  requireValue(uuid(management.maintenanceId), 'Invalid maintenance ID.');
  const evidenceRoot = path.join(owner, 'maintenance', management.maintenanceId);
  async function ref(reference) {
    fields(reference, 'path sha256');
    requireValue(typeof reference.path === 'string' && /^[a-z][a-z-]{0,40}-[0-9a-f-]{36}\.json$/.test(reference.path) && digest(reference.sha256), 'Invalid maintenance reference.');
    const record = await read(path.join(evidenceRoot, reference.path));
    requireValue(record.sha256 === reference.sha256, 'Maintenance evidence fingerprint changed.');
    return record.value;
  }
  const cp = await ref(management.checkpoint), final = await ref(management.head);
  fields(cp, 'schemaVersion maintenanceId deviceId ownerId generation createdAt originalGate originalJournal originalReceipt hostBefore tools');
  requireValue(cp.schemaVersion === 1 && cp.maintenanceId === management.maintenanceId && cp.deviceId === deviceId && cp.ownerId === ownerId && uuid(cp.generation), 'Checkpoint identity differs.');
  const original = await ref(cp.originalJournal), originalGate = await ref(cp.originalGate), originalReceipt = await ref(cp.originalReceipt);
  requireValue(original.version === 1 && original.deviceId === deviceId && original.ownerId === ownerId && original.generation === cp.generation &&
    original.remoteRoot === '/data/local/tmp/maestro-session-' + cp.generation && original.sealed === true &&
    Array.isArray(original.temporaryFiles) && original.temporaryFiles.length === 0 && Array.isArray(original.operations) &&
    original.operations.every(op => uuid(op.id) && typeof op.completed === 'boolean' && (op.completed || op.recoverable === true)) &&
    new Set(original.operations.map(op => op.id)).size === original.operations.length && Array.isArray(original.hostCalls) &&
    original.hostCalls.every(call => call.returned === true && call.stopped === true), 'Original journal is outside maintenance scope.');
  const pending = original.operations.filter(op => !op.completed).map(op => op.id);
  requireValue(pending.length > 0 && originalGate.schemaVersion === 1 && originalGate.deviceId === deviceId &&
    originalGate.ownerSessionId === ownerId && originalGate.state === 'quarantined' && originalGate.closeFailure === null &&
    originalGate.unresolvedRecording === false && same(originalGate.journalPath, gate.journalPath), 'Invalid original lease.');
  requireValue(same(gate.journalPath, path.join(owner, 'recovery-journal.json')), 'Unexpected journal location.');
  try { await fs.lstat(path.join(owner, 'recording-resources.json')); throw new Error('Recording resources exclude finite-command maintenance.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  requireValue(uuid(originalReceipt.recoveryId) && same(originalGate.reportPath, path.join(owner, 'recoveries', originalReceipt.recoveryId + '.json')) &&
    originalGate.reportSha256 === cp.originalReceipt.sha256 && (await read(originalGate.reportPath)).sha256 === cp.originalReceipt.sha256 &&
    originalReceipt.schemaVersion === 1 && originalReceipt.deviceId === deviceId && originalReceipt.sessionId === ownerId &&
    originalReceipt.state === 'unknown' && originalReceipt.closeFailure === null && originalReceipt.unresolvedRecording === false &&
    originalReceipt.operations === original.operations.length && originalReceipt.pendingOperations === pending.length && originalReceipt.temporaryFiles === 0,
  'Original recovery receipt differs.');
  const chain = []; let cursor = final;
  while (true) {
    fields(cursor, stepFields);
    requireValue(chain.length < 10000 && cursor.schemaVersion === 1 && cursor.checkpointSha256 === management.checkpoint.sha256 &&
      phases.includes(cursor.phase) && Number.isSafeInteger(cursor.revision) && cursor.revision >= 0, 'Invalid maintenance chain.');
    await ref(cursor.journal); chain.push(cursor);
    if (cursor.previous === null) { requireValue(cursor.revision === 0 && cursor.phase === 'prepared', 'Maintenance chain lacks prepare.'); break; }
    const previous = await ref(cursor.previous);
    requireValue(previous.revision + 1 === cursor.revision && phases.indexOf(previous.phase) <= phases.indexOf(cursor.phase), 'Maintenance chain order differs.');
    cursor = previous;
  }
  requireValue(final.phase === 'complete' && Array.isArray(final.calls) && Array.isArray(final.cleanupBatches), 'Maintenance is incomplete.');
  const withoutCalls = journal => Object.fromEntries(Object.entries(journal).filter(([name]) => name !== 'hostCalls'));
  function journal(value, calls, allowPending = false) {
    requireValue(equal(withoutCalls(value), withoutCalls(original)) && Array.isArray(value.hostCalls) &&
      equal(value.hostCalls.slice(0, original.hostCalls.length), original.hostCalls) && value.hostCalls.length === original.hostCalls.length + calls.length,
    'Maintenance changed original operations or journal ownership.');
    value.hostCalls.slice(original.hostCalls.length).forEach((call, index) => requireValue(call.id === calls[index].hostCallId &&
      ((allowPending && index === calls.length - 1) || (call.returned === true && call.stopped === true)), 'Maintenance call is unconfirmed.'));
  }
  requireValue(new Set(final.calls.map(call => call.hostCallId)).size === final.calls.length, 'Duplicate maintenance call.');
  for (const [index, call] of final.calls.entries()) {
    fields(call, 'hostCallId phase purpose argumentsSha256 registeredJournal outcome endedJournal');
    requireValue(uuid(call.hostCallId) && digest(call.argumentsSha256) &&
      ((['host_verified', 'phone_prepared'].includes(call.phase) && call.purpose === 'observe_uptime') ||
      (call.phase === 'cleaning' && call.purpose === 'cleanup_owned_paths')), 'Invalid maintenance call binding.');
    journal(await ref(call.registeredJournal), final.calls.slice(0, index + 1), true);
    journal(await ref(call.endedJournal), final.calls.slice(0, index + 1)); await ref(call.outcome);
    requireValue(chain.some(step => step.phase === call.phase && equal(step.journal, call.registeredJournal) &&
      step.calls.length === index + 1 && equal(step.calls[index], { ...call, outcome: null, endedJournal: null })), 'Call has no pre-dispatch phase record.');
  }
  journal(await ref(final.journal), final.calls);
  requireValue((await read(gate.journalPath)).sha256 === final.journal.sha256, 'Current journal changed after maintenance.');
  const hostBefore = await ref(cp.hostBefore), hostResume = await ref(final.hostResume), hostComplete = await ref(final.hostComplete);
  // The provider carries PowerShell's version; checkpoint fingerprints intentionally omit it.
  const expectedTools = { powershell: { ...cp.tools.powershell, version: hostBefore.tools?.powershell?.version }, script: cp.tools.script };
  parseObservation(hostBefore, expectedTools);
  requireValue(restarted(hostBefore, hostResume, expectedTools).confirmed && sameBoot(hostResume, hostComplete, expectedTools).confirmed, 'Ordered host restart is unconfirmed.');
  const before = await ref(final.phoneBefore), after = await ref(final.phoneAfter);
  requireValue(phone(after, deviceId, ownerId) < phone(before, deviceId, ownerId), 'Phone uptime did not decrease.');
  for (const [phase, reference, observation] of [['host_verified', final.phoneBefore, before], ['phone_prepared', final.phoneAfter, after]]) {
    const calls = final.calls.filter(call => call.phase === phase && equal(call.outcome, reference));
    requireValue(calls.length === 1 && calls[0].hostCallId === observation.hostCallId && calls[0].argumentsSha256 === hash(Buffer.from('["uptime"]')), 'Phone observation is not bound to the uptime call.');
  }
  const termination = { schemaVersion: 1, deviceId, ownerId, checkpointSha256: management.checkpoint.sha256,
    hostBefore: cp.hostBefore, hostResume: final.hostResume, hostComplete: final.hostComplete, phoneBefore: final.phoneBefore,
    phoneAfter: final.phoneAfter, disposition: 'terminated_by_ordered_host_device_restart', originalResult: 'unknown', operationIds: pending };
  requireValue(equal(await ref(final.termination), termination), 'Termination proof differs.');
  const paths = [];
  for (const [index, reference] of final.cleanupBatches.entries()) {
    const batch = await ref(reference); fields(batch, 'index paths hostCallId');
    const calls = final.calls.filter(call => call.hostCallId === batch.hostCallId && call.phase === 'cleaning' && equal(call.outcome, reference));
    requireValue(batch.index === index && Array.isArray(batch.paths) && calls.length === 1, 'Cleanup batch is unconfirmed.'); paths.push(...batch.paths);
  }
  const remote = original.remoteRoot;
  requireValue(equal(paths, [...original.operations.flatMap(op => [`${remote}/${op.id}/done`, `${remote}/${op.id}/done.pending`, `${remote}/${op.id}`]), `${remote}/files`, remote]) &&
    final.cleanupBatches.length === final.calls.filter(call => call.phase === 'cleaning').length, 'Cleanup does not cover precisely the owned paths.');
  const receipt = await ref(final.receipt), cleaned = await ref(receipt.evidenceHead);
  requireValue(cleaned.phase === 'cleaned' && chain.some(step => equal(step, cleaned)) &&
    ['journal', 'calls', 'cleanupBatches', 'termination'].every(name => equal(cleaned[name], final[name])), 'Receipt does not identify the cleaned chain.');
  const expectedReceipt = { schemaVersion: 3, recoveryId: cp.maintenanceId, deviceId, observedAt: cleaned.observedAt, sessionId: ownerId,
    reason: 'ordered_restart_maintenance', state: 'complete', originalExecutionResult: 'unknown', operations: original.operations.length,
    originalPendingOperations: pending.length, pendingOperations: 0, temporaryFiles: 0, issues: [], maintenanceId: cp.maintenanceId,
    checkpoint: management.checkpoint, evidenceHead: receipt.evidenceHead, termination: final.termination, originalJournal: cp.originalJournal,
    finalJournal: final.journal, originalReceipt: cp.originalReceipt, cleanupBatches: final.cleanupBatches };
  requireValue(equal(receipt, expectedReceipt) && Number.isFinite(Date.parse(receipt.observedAt)) && Date.parse(receipt.observedAt) >= Date.parse(createdAt) &&
    same(gate.reportPath, path.join(owner, 'recoveries', cp.maintenanceId + '.json')) && gate.reportSha256 === final.receipt.sha256 &&
    (await read(gate.reportPath)).sha256 === final.receipt.sha256, 'Final maintenance receipt differs or is stale.');
  let responseSha256 = null;
  if (responsePath !== null) {
    const response = await read(responsePath), expected = { protocol: 'harmonyos.reboot-recovery', schemaVersion: 1,
      maintenanceId: cp.maintenanceId, deviceId, ownerId, state: 'complete', cleanup: { state: 'complete' }, phase: 'complete',
      handoffReady: true, checkpoint: management.checkpoint, head: management.head, evidenceDirectory: evidenceRoot,
      receipt: { path: gate.reportPath, sha256: gate.reportSha256, schemaVersion: 3 } };
    fields(response.value.receipt, 'path sha256 schemaVersion');
    requireValue(same(response.value.evidenceDirectory, evidenceRoot) && same(response.value.receipt?.path, gate.reportPath) &&
      equal({ ...response.value, evidenceDirectory: evidenceRoot, receipt: expected.receipt }, expected) &&
      response.value.receipt.sha256 === gate.reportSha256 && response.value.receipt.schemaVersion === 3, 'Maintenance response differs from the current lease.');
    responseSha256 = response.sha256;
  }
  // Recheck the entire read set, including the gate. This is evidence verification, not a device lock reservation.
  for (const record of records.values()) {
    requireValue(Date.now() <= deadline && hash(await readBytes(record.path, 32 * 1024 * 1024)) === record.sha256, 'Maintenance evidence changed during verification.');
  }
  return { sessionId: ownerId, reportPath: gate.reportPath, reportSha256: gate.reportSha256, observedAt: receipt.observedAt,
    maintenanceId: cp.maintenanceId, originalExecutionResult: 'unknown', originalPendingOperations: pending.length,
    recordingResources: null, recordingCheckedFiles: 0, maintenanceCheckedFiles: records.size,
    recoveryResponsePath: responsePath === null ? null : path.resolve(responsePath), recoveryResponseSha256: responseSha256 };
}
