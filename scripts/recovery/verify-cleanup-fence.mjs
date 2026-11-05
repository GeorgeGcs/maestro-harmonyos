import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { readBytes } from '../validation/io.mjs';
import { parseMaintenanceJson } from './verify-maintenance.mjs';
import { hash, requireValue, uuid, fields, fenceScope, fenceArguments, confirmedPhase, splitInventory } from './cleanup-fence-scripts.mjs';

const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const phases = ['prepared', 'claimed', 'cleaned', 'complete'];
const gateFields = 'schemaVersion deviceId ownerSessionId state journalPath updatedAt closeFailure reportPath reportSha256 requiresRecovery uncertainReason unresolvedRecording cleanupFence retainedFences';
const supportedClasses = new Set(['c1de9567295e53022f9a2422593c5b7516b30bef4a66de956ff8d510fc20b0ac',
  'f68fd1582450c8ee4276899d44c655554b602c2190d40bf0d5b002ebe6bcd3f9']);

function reader() {
  const records = new Map(), deadline = Date.now() + 30000;
  let bytesRead = 0;
  async function read(file) {
    file = path.resolve(file);
    if (records.has(file)) return records.get(file);
    requireValue(Date.now() <= deadline && records.size < 4096, 'Cleanup-fence evidence budget exceeded.');
    const bytes = await readBytes(file, 32 * 1024 * 1024);
    bytesRead += bytes.length;
    requireValue(bytesRead <= 256 * 1024 * 1024, 'Cleanup-fence byte budget exceeded.');
    const record = { path: file, sha256: hash(bytes), value: parseMaintenanceJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    records.set(file, record); return record;
  }
  async function unchanged() {
    for (const record of records.values()) requireValue(Date.now() <= deadline && hash(await readBytes(record.path, 32 * 1024 * 1024)) === record.sha256,
      'Cleanup-fence evidence changed during verification.');
  }
  return { read, records, unchanged };
}

function identity(deviceId, recoveryRoot) {
  requireValue(typeof deviceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(deviceId) && typeof recoveryRoot === 'string', 'Invalid cleanup-fence identity.');
  return { root: path.resolve(recoveryRoot), key: hash(Buffer.from(deviceId)) };
}

function callsJournal(node, cp, step, stopped) {
  fields(node, 'version deviceId ownerId generation remoteRoot sealed rootRemoved operations temporaryFiles hostCalls');
  requireValue(node.version === 1 && node.deviceId === cp.deviceId && node.ownerId === cp.recoveryId && uuid(node.generation) &&
    node.remoteRoot === `/data/local/tmp/maestro-session-${node.generation}` && node.sealed === true && node.rootRemoved === true &&
    equal(node.operations, []) && equal(node.temporaryFiles, []) && Array.isArray(node.hostCalls) &&
    equal(node.hostCalls.map(call => call.id), step.calls.map(item => item.call.hostCallId)) &&
    new Set(node.hostCalls.map(call => call.id)).size === node.hostCalls.length, 'Unbound recovery journal invocation.');
  for (const call of node.hostCalls) {
    fields(call, 'id processes returned stopped');
    requireValue(uuid(call.id) && Array.isArray(call.processes) && typeof call.returned === 'boolean' && typeof call.stopped === 'boolean' &&
      (!stopped || call.stopped) && (!call.stopped || call.returned || call.processes.length > 0), 'Recovery native invocation is unconfirmed.');
    for (const process of call.processes) {
      fields(process, 'pid startedAt');
      requireValue(Number.isSafeInteger(process.pid) && process.pid > 0 &&
        (process.startedAt === null || Number.isFinite(Date.parse(process.startedAt))), 'Invalid native process identity.');
    }
  }
}

async function bundle({ deviceId, root, key, retained, io }) {
  fields(retained, 'ownerId recoveryId checkpoint receipt');
  requireValue(uuid(retained.ownerId) && uuid(retained.recoveryId), 'Invalid retained fence identity.');
  const owner = path.join(root, key, retained.ownerId), base = path.join(owner, 'cleanup-fence', retained.recoveryId);
  async function ref(reference) {
    fields(reference, 'path sha256');
    requireValue(typeof reference.path === 'string' && /^[a-z][a-z-]{0,40}-[0-9a-f-]{36}\.json$/.test(reference.path) && digest(reference.sha256), 'Invalid cleanup-fence evidence reference.');
    const record = await io.read(path.join(base, reference.path));
    requireValue(record.sha256 === reference.sha256, 'Cleanup-fence evidence fingerprint changed.');
    return record.value;
  }
  const cp = await ref(retained.checkpoint);
  fields(cp, 'schemaVersion recoveryId deviceId ownerId createdAt scope originalGate originalJournal originalReceipt origin tools');
  requireValue(cp.schemaVersion === 1 && cp.recoveryId === retained.recoveryId && cp.deviceId === deviceId && cp.ownerId === retained.ownerId &&
    Number.isFinite(Date.parse(cp.createdAt)), 'Checkpoint owner differs.');
  fields(cp.origin, 'profile journalClassSha256 clientJar');
  requireValue(cp.origin.profile === 'exclusive-operation-mkdir-v1' && supportedClasses.has(cp.origin.journalClassSha256),
    'Original wrapper has no supported compatibility profile.');
  function tool(value) {
    fields(value, 'path sha256 bytes');
    requireValue(typeof value.path === 'string' && path.isAbsolute(value.path) && digest(value.sha256) &&
      Number.isSafeInteger(value.bytes) && value.bytes > 0, 'Invalid frozen fence tool.');
  }
  tool(cp.origin.clientJar);
  requireValue(cp.tools && typeof cp.tools === 'object' && Object.keys(cp.tools).length > 0, 'Missing recovery tools.');
  Object.values(cp.tools).forEach(tool);
  const original = await ref(cp.originalJournal), originalGate = await ref(cp.originalGate), originalReceipt = await ref(cp.originalReceipt);
  requireValue(equal(fenceScope(original), cp.scope), 'Checkpoint changed the original scope.');
  requireValue([1, 3].includes(originalGate.schemaVersion) && originalGate.deviceId === deviceId && originalGate.ownerSessionId === cp.ownerId &&
    originalGate.state === 'quarantined' && originalGate.closeFailure === null && originalGate.unresolvedRecording === false &&
    !originalGate.maintenance && !originalGate.cleanupFence && same(originalGate.journalPath, path.join(owner, 'recovery-journal.json')) &&
    originalGate.reportSha256 === cp.originalReceipt.sha256 && same(path.dirname(originalGate.reportPath), path.join(owner, 'recoveries')),
  'Original owner gate is incompatible.');
  requireValue(originalReceipt.deviceId === deviceId && originalReceipt.sessionId === cp.ownerId && originalReceipt.state === 'unknown', 'Original receipt differs.');
  requireValue((await io.read(path.join(owner, 'recovery-journal.json'))).sha256 === cp.originalJournal.sha256 &&
    (await io.read(originalGate.reportPath)).sha256 === cp.originalReceipt.sha256, 'Original journal or result was rewritten.');
  try { await fs.lstat(path.join(owner, 'recording-resources.json')); throw new Error('Recording resources are outside cleanup-fence scope.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  async function step(reference) {
    const value = await ref(reference);
    fields(value, 'schemaVersion checkpointSha256 revision previous phase observedAt journal calls receipt');
    requireValue(value.schemaVersion === 1 && value.checkpointSha256 === retained.checkpoint.sha256 &&
      Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision <= 256 && phases.includes(value.phase) &&
      Number.isFinite(Date.parse(value.observedAt)) && Array.isArray(value.calls) && value.calls.length <= 64, 'Invalid cleanup-fence step.');
    callsJournal(await ref(value.journal), cp, value, false);
    for (const item of value.calls) {
      fields(item, 'call outcome'); fields(item.call, 'hostCallId action nonce argumentsSha256');
      requireValue(uuid(item.call.hostCallId) && uuid(item.call.nonce) && digest(item.call.argumentsSha256), 'Invalid recovery call binding.');
      const args = fenceArguments(cp.scope, `MAESTRO_CLEANUP_FENCE_V1:${retained.checkpoint.sha256}`, item.call.action, item.call.nonce);
      requireValue(hash(JSON.stringify(args)) === item.call.argumentsSha256, 'Recovery command differs from its fixed scope.');
      if (item.outcome) {
        const result = await ref(item.outcome); confirmedPhase(result);
        requireValue(result.hostCallId === item.call.hostCallId && result.action === item.call.action && result.nonce === item.call.nonce &&
          (result.action !== 'claim' || result.phase === 'claimed') && (result.action !== 'clean' || result.phase === 'cleaned'), 'Recovery observation differs from its call.');
      }
    }
    return value;
  }
  async function chain(reference) {
    let current = await step(reference), count = 0;
    while (current.previous) {
      requireValue(++count <= 256, 'Fence chain is too long.');
      const previous = await step(current.previous);
      requireValue(previous.revision + 1 === current.revision && phases.indexOf(previous.phase) <= phases.indexOf(current.phase) &&
        previous.calls.length <= current.calls.length && previous.calls.every((item, i) => equal(item.call, current.calls[i].call) &&
          (item.outcome === null || equal(item.outcome, current.calls[i].outcome))), 'Recovery history was rewritten.');
      current = previous;
    }
    requireValue(current.revision === 0 && current.phase === 'prepared' && current.calls.length === 0 && current.receipt === null, 'Fence chain lacks the original intent.');
  }
  const receipt = await ref(retained.receipt);
  fields(receipt, 'schemaVersion recoveryId deviceId sessionId observedAt state handoffReady disposition originalResult pendingOperations temporaryFiles checkpoint verifiedHead retainedDirectories');
  requireValue(receipt.schemaVersion === 4 && receipt.recoveryId === cp.recoveryId && receipt.deviceId === deviceId && receipt.sessionId === cp.ownerId &&
    equal(receipt.checkpoint, retained.checkpoint) && receipt.state === 'isolated' && receipt.handoffReady === true &&
    receipt.disposition === 'prevented_before_dispatch' && receipt.originalResult === 'unknown' && receipt.pendingOperations === 1 &&
    receipt.temporaryFiles === 0 && equal(receipt.retainedDirectories, [cp.scope.remoteRoot]) &&
    Number.isFinite(Date.parse(receipt.observedAt)) && Date.parse(receipt.observedAt) >= Date.parse(cp.createdAt), 'Fence receipt does not establish isolation.');
  const verified = await step(receipt.verifiedHead);
  await chain(receipt.verifiedHead);
  requireValue(verified.phase === 'cleaned' && verified.calls.filter(item => item.call.action === 'claim').length === 1 &&
    verified.calls.filter(item => item.call.action === 'clean').length === 1, 'Missing claim or cleanup transaction.');
  callsJournal(await ref(verified.journal), cp, verified, true);
  requireValue((await io.read(path.join(base, 'calls.json'))).sha256 === verified.journal.sha256, 'Recovery journal changed after release.');
  const last = verified.calls.at(-1);
  requireValue(last?.call.action === 'verify' && last.outcome && (await ref(last.outcome)).phase === 'cleaned', 'Final remote isolation was not verified.');
  if (splitInventory(cp.scope)) {
    const rootCheck = verified.calls.at(-2);
    requireValue(rootCheck?.call.action === 'verify-root' && rootCheck.outcome && (await ref(rootCheck.outcome)).phase === 'cleaned',
      'Split inventory lacks its final root verification.');
  }
  return { cp, receipt, originalGate, base, ref, step, chain };
}

/** No live gate dependency: used to archive an old recovery after later sessions have run. */
export async function verifyCleanupFenceReceipt({ deviceId, recoveryRoot, retained }) {
  const { root, key } = identity(deviceId, recoveryRoot), io = reader();
  const result = await bundle({ deviceId, root, key, retained, io });
  await io.unchanged();
  return { receipt: result.receipt, checkpoint: result.cp, records: [...io.records.values()].map(({ path, sha256 }) => ({ path, sha256 })) };
}

export async function verifyCleanupFenceGate({ deviceId, recoveryRoot, createdAt, responsePath = null }) {
  const { root, key } = identity(deviceId, recoveryRoot), io = reader();
  requireValue(Number.isFinite(Date.parse(createdAt)), 'Invalid recovery verification time.');
  const gateRecord = await io.read(path.join(root, key + '.owner.json')), gate = gateRecord.value;
  fields(gate, gateFields);
  requireValue(gate.schemaVersion === 3 && gate.deviceId === deviceId && uuid(gate.ownerSessionId) && gate.state === 'clean' &&
    gate.requiresRecovery === false && gate.closeFailure === null && gate.unresolvedRecording === false &&
    gate.uncertainReason === null && Array.isArray(gate.retainedFences) && gate.retainedFences.length > 0 && gate.retainedFences.length <= 8 &&
    new Set(gate.retainedFences.map(item => `${item.ownerId}:${item.recoveryId}`)).size === gate.retainedFences.length &&
    same(gate.journalPath, path.join(root, key, gate.ownerSessionId, 'recovery-journal.json')), 'Device is not released with valid retained fences.');
  let current = null;
  for (const retained of gate.retainedFences) {
    const result = await bundle({ deviceId, root, key, retained, io });
    requireValue((result.originalGate.retainedFences ?? []).every(previous => gate.retainedFences.some(item => equal(item, previous))), 'An earlier retained fence was dropped.');
    if (gate.cleanupFence && retained.ownerId === gate.ownerSessionId && retained.recoveryId === gate.cleanupFence.recoveryId) current = { ...result, retained };
  }
  let release = null;
  if (gate.cleanupFence !== null) {
    fields(gate.cleanupFence, 'recoveryId checkpoint head');
    requireValue(current && equal(gate.cleanupFence.checkpoint, current.retained.checkpoint), 'Current fence transaction has no retained receipt.');
    const head = await current.step(gate.cleanupFence.head); await current.chain(gate.cleanupFence.head);
    requireValue(head.phase === 'complete' && equal(head.receipt, current.retained.receipt) &&
      same(gate.reportPath, path.join(current.base, current.retained.receipt.path)) && gate.reportSha256 === current.retained.receipt.sha256 &&
      Date.parse(current.receipt.observedAt) >= Date.parse(createdAt), 'Gate does not point to a completed, current isolation receipt.');
    release = { sessionId: gate.ownerSessionId, gatePath: gateRecord.path, gateSha256: gateRecord.sha256,
      reportPath: gate.reportPath, reportSha256: gate.reportSha256, cleanupFenceId: gate.cleanupFence.recoveryId,
      retained: current.retained, retainedDirectories: current.receipt.retainedDirectories, originalResult: 'unknown' };
    if (responsePath !== null) {
      const response = await io.read(responsePath), value = response.value;
      fields(value, 'protocol schemaVersion deviceId sessionId recoveryId state handoffReady originalResult disposition retainedDirectories receipt');
      fields(value.receipt, 'path sha256 schemaVersion');
      requireValue(value.protocol === 'maestro.harmonyos.cleanup-fence-recovery' && value.schemaVersion === 1 && value.deviceId === deviceId &&
        value.sessionId === gate.ownerSessionId && value.recoveryId === gate.cleanupFence.recoveryId && value.state === 'isolated' &&
        value.handoffReady === true && value.originalResult === 'unknown' && value.disposition === 'prevented_before_dispatch' &&
        equal(value.retainedDirectories, current.receipt.retainedDirectories) && same(value.receipt.path, gate.reportPath) &&
        value.receipt.sha256 === gate.reportSha256 && value.receipt.schemaVersion === 4, 'Fence response differs from its receipt.');
      release.recoveryResponsePath = response.path; release.recoveryResponseSha256 = response.sha256;
    }
  }
  await io.unchanged();
  return { gate, release, checkedFiles: io.records.size, retainedFenceCount: gate.retainedFences.length };
}
