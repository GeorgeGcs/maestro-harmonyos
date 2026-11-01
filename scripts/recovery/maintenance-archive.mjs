import path from 'node:path';
import { samePath, requireValue, uuid, digestPattern } from '../validation/io.mjs';

/** Collect only the immutable graph bound to one receipt. This does not assess device release. */
export async function collectMaintenanceEvidence({ receipt, resolution, ownerDirectory, deviceId, read, issue }) {
  const id = receipt.maintenanceId, ownerId = resolution.sessionId;
  requireValue(uuid.test(id) && receipt.schemaVersion === 3 && receipt.recoveryId === id &&
    receipt.deviceId === deviceId && receipt.sessionId === ownerId && receipt.reason === 'ordered_restart_maintenance' &&
    receipt.originalExecutionResult === 'unknown' && resolution.maintenanceId === id,
  'Maintenance receipt identifies another recovery.');
  const root = path.join(ownerDirectory, 'maintenance', id), queue = [], seen = new Map();
  let complete = true;
  const checkpoints = new Set([receipt.checkpoint?.sha256]);
  const failed = (error, file = null) => { complete = false; issue('maintenance_evidence_incomplete', error.message, file); };
  const fields = (value, names) => requireValue(Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '),
    'Unsupported maintenance document fields.');
  function enqueue(reference) {
    requireValue(reference && Object.keys(reference).length === 2 && typeof reference.path === 'string' &&
      /^[a-z][a-z-]{0,40}-[0-9a-f-]{36}\.json$/.test(reference.path) && typeof reference.sha256 === 'string' && digestPattern.test(reference.sha256),
    'Invalid maintenance archive reference.');
    if (seen.has(reference.path)) { requireValue(seen.get(reference.path) === reference.sha256, 'Conflicting maintenance hashes.'); return; }
    requireValue(seen.size < 4096, 'Maintenance graph file budget exceeded.');
    seen.set(reference.path, reference.sha256); queue.push(reference);
  }
  function reference(value) { try { enqueue(value); } catch (error) { failed(error); } }
  function references(values) {
    if (!Array.isArray(values)) { failed(new Error('Missing maintenance reference array.')); return; }
    for (const value of values) reference(value);
  }
  function follow(value) {
    if (value.schemaVersion === 3 && value.maintenanceId) {
      fields(value, 'schemaVersion recoveryId deviceId observedAt sessionId reason state originalExecutionResult operations originalPendingOperations pendingOperations temporaryFiles issues maintenanceId checkpoint evidenceHead termination originalJournal finalJournal originalReceipt cleanupBatches');
      requireValue(value.maintenanceId === id && value.sessionId === ownerId && value.deviceId === deviceId, 'Foreign maintenance receipt.');
      for (const name of ['checkpoint', 'evidenceHead', 'termination', 'originalJournal', 'finalJournal', 'originalReceipt']) reference(value[name]);
      references(value.cleanupBatches);
    } else if (value.schemaVersion === 1 && 'checkpointSha256' in value && 'revision' in value) {
      fields(value, 'schemaVersion checkpointSha256 revision previous phase observedAt journal calls hostResume phoneBefore hostComplete phoneAfter termination cleanupBatches receipt');
      requireValue(checkpoints.has(value.checkpointSha256) && Array.isArray(value.calls), 'Foreign maintenance stage.');
      for (const name of ['previous', 'hostResume', 'phoneBefore', 'hostComplete', 'phoneAfter', 'termination', 'receipt']) {
        if (value[name] !== null) reference(value[name]);
      }
      reference(value.journal); references(value.cleanupBatches);
      for (const call of value.calls) {
        fields(call, 'hostCallId phase purpose argumentsSha256 registeredJournal outcome endedJournal');
        reference(call.registeredJournal);
        if (call.outcome !== null) reference(call.outcome);
        if (call.endedJournal !== null) reference(call.endedJournal);
      }
    } else if ([1, 2].includes(value.schemaVersion) && 'tools' in value && 'originalGate' in value) {
      fields(value, 'schemaVersion maintenanceId deviceId ownerId generation createdAt originalGate originalJournal originalReceipt hostBefore tools' +
        (value.schemaVersion === 2 ? ' transition' : ''));
      requireValue(value.maintenanceId === id && value.deviceId === deviceId && value.ownerId === ownerId, 'Foreign maintenance checkpoint.');
      for (const name of ['originalGate', 'originalJournal', 'originalReceipt', 'hostBefore']) reference(value[name]);
      if (value.schemaVersion === 2) reference(value.transition);
    } else if (value.schemaVersion === 1 && value.reason === 'windows_powershell_update') {
      if ('previousCheckpoint' in value) {
        fields(value, 'schemaVersion reason previousCheckpoint previousHead previousGate approval hostObserved');
        requireValue(checkpoints.size === 1 && digestPattern.test(value.previousCheckpoint?.sha256), 'Repeated or invalid migration.');
        checkpoints.add(value.previousCheckpoint.sha256);
        for (const name of ['previousCheckpoint', 'previousHead', 'previousGate', 'approval', 'hostObserved']) reference(value[name]);
      } else {
        fields(value, 'schemaVersion reason checkpointSha256 tools');
        requireValue(checkpoints.has(value.checkpointSha256), 'Foreign migration approval.');
      }
    } else if (value.schemaVersion === 1 && 'disposition' in value) {
      fields(value, 'schemaVersion deviceId ownerId checkpointSha256 hostBefore hostResume hostComplete phoneBefore phoneAfter disposition originalResult operationIds');
      requireValue(value.deviceId === deviceId && value.ownerId === ownerId && value.checkpointSha256 === receipt.checkpoint.sha256,
        'Foreign termination record.');
      for (const name of ['hostBefore', 'hostResume', 'hostComplete', 'phoneBefore', 'phoneAfter']) reference(value[name]);
    } else if ('version' in value && 'operations' in value) {
      requireValue(value.version === 1 && value.deviceId === deviceId && value.ownerId === ownerId, 'Foreign journal snapshot.');
    } else if ('ownerSessionId' in value) {
      requireValue([1, 2].includes(value.schemaVersion) && value.deviceId === deviceId && value.ownerSessionId === ownerId, 'Foreign original gate snapshot.');
      if (value.schemaVersion === 2) {
        requireValue(value.maintenance?.maintenanceId === id && checkpoints.has(value.maintenance?.checkpoint?.sha256), 'Foreign previous maintenance gate.');
        reference(value.maintenance.checkpoint); reference(value.maintenance.head);
      }
    } else if ('recoveryId' in value) {
      requireValue(value.schemaVersion === 1 && value.deviceId === deviceId && value.sessionId === ownerId, 'Foreign original receipt snapshot.');
    } else if (value.protocol === 'maestro.harmonyos.host-boot-observation') {
      requireValue(value.schemaVersion === 1, 'Unsupported host observation.');
    } else if ('provider' in value && 'hostCallId' in value) {
      requireValue(value.schemaVersion === 1 && value.deviceId === deviceId && value.ownerId === ownerId, 'Foreign phone observation.');
    } else {
      requireValue(Object.keys(value).length === 3 && Number.isSafeInteger(value.index) && value.index >= 0 &&
        Array.isArray(value.paths) && uuid.test(value.hostCallId), 'Unsupported maintenance evidence document.');
    }
  }
  follow(receipt);
  try {
    requireValue(typeof resolution.recoveryResponsePath === 'string' && path.isAbsolute(resolution.recoveryResponsePath) &&
      typeof resolution.recoveryResponseSha256 === 'string' && digestPattern.test(resolution.recoveryResponseSha256),
    'The saved maintenance response path and hash are required.');
    const response = await read(resolution.recoveryResponsePath, 'recovery/maintenance-response.json', resolution.recoveryResponseSha256);
    requireValue(response.protocol === 'harmonyos.reboot-recovery' && response.schemaVersion === 1 && response.maintenanceId === id &&
      response.ownerId === ownerId && response.deviceId === deviceId && response.phase === 'complete' && response.state === 'complete' &&
      response.handoffReady === true && response.cleanup?.state === 'complete' && samePath(response.evidenceDirectory, root) &&
      response.receipt?.schemaVersion === 3 && samePath(response.receipt.path, resolution.reportPath) && response.receipt.sha256 === resolution.reportSha256 &&
      response.checkpoint?.path === receipt.checkpoint.path && response.checkpoint?.sha256 === receipt.checkpoint.sha256,
    'Saved maintenance response does not identify this receipt.');
    reference(response.head); reference(response.checkpoint);
  } catch (error) { failed(error, resolution.recoveryResponsePath ?? null); }
  // Every reference is inside this exact owner/maintenance directory. Never scan it or load current gate/tool files.
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index], source = path.join(root, item.path);
    try { follow(await read(source, `recovery/maintenance/${id}/${item.path}`, item.sha256)); }
    catch (error) { failed(error, source); }
  }
  return { complete, referencedFiles: seen.size };
}
