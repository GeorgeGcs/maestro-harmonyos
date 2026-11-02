import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { samePath, requireValue, uuid, digestPattern } from '../validation/io.mjs';

/** Copy the graph named by one retained fence, preserving partials. Never authorizes device release. */
export async function collectCleanupFenceEvidence({ retained, ownerDirectory, deviceId, prefix, resolution = null, read, issue, checkBudget }) {
  const fields = (value, names) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    equal(Object.keys(value).sort(), names.split(' ').sort()), 'Unsupported cleanup-fence archive fields.');
  fields(retained, 'ownerId recoveryId checkpoint receipt');
  const owner = retained.ownerId, id = retained.recoveryId;
  requireValue(uuid.test(owner) && uuid.test(id) && path.basename(ownerDirectory) === owner, 'Invalid retained fence owner.');
  const root = path.join(ownerDirectory, 'cleanup-fence', id), queue = [], seen = new Map();
  let complete = true, checkpoint = null;
  const failed = (error, file = null) => { complete = false; issue('cleanup_fence_evidence_incomplete', error.message, file); };
  function enqueue(reference, role) {
    fields(reference, 'path sha256');
    requireValue(typeof reference.path === 'string' && /^[a-z][a-z-]{0,40}-[0-9a-f-]{36}\.json$/.test(reference.path) &&
      typeof reference.sha256 === 'string' && digestPattern.test(reference.sha256), 'Invalid cleanup-fence archive reference.');
    const previous = seen.get(reference.path);
    if (previous) {
      requireValue(previous.sha256 === reference.sha256 && previous.role === role, 'Conflicting cleanup-fence reference.');
      return;
    }
    requireValue(seen.size < 4096, 'Cleanup-fence graph file budget exceeded.');
    const item = { ...reference, role }; seen.set(reference.path, item); queue.push(item);
  }
  function reference(value, role) { try { enqueue(value, role); } catch (error) { failed(error); } }
  async function live(file, relative, expected, inspect) {
    try { checkBudget(); requireValue(typeof expected === 'string' && digestPattern.test(expected), 'Missing bound cleanup-fence hash.'); inspect(await read(file, relative, expected)); }
    catch (error) { failed(error, file); }
  }
  function journal(value, expectedOwner) {
    requireValue(value.version === 1 && value.deviceId === deviceId && value.ownerId === expectedOwner &&
      Array.isArray(value.operations) && Array.isArray(value.hostCalls), 'Foreign cleanup-fence journal.');
  }
  async function follow(value, item) {
    if (item.role === 'checkpoint') {
      fields(value, 'schemaVersion recoveryId deviceId ownerId createdAt scope originalGate originalJournal originalReceipt origin tools');
      requireValue(value.schemaVersion === 1 && value.recoveryId === id && value.ownerId === owner && value.deviceId === deviceId &&
        value.scope?.deviceId === deviceId && value.scope.ownerId === owner, 'Foreign cleanup-fence checkpoint.');
      checkpoint = value;
      reference(value.originalGate, 'original-gate'); reference(value.originalJournal, 'original-journal'); reference(value.originalReceipt, 'original-receipt');
      // Tools and any earlier retained owners are descriptions, not file references to follow.
    } else if (item.role === 'receipt') {
      fields(value, 'schemaVersion recoveryId deviceId sessionId observedAt state handoffReady disposition originalResult pendingOperations temporaryFiles checkpoint verifiedHead retainedDirectories');
      requireValue(value.schemaVersion === 4 && value.recoveryId === id && value.sessionId === owner && value.deviceId === deviceId &&
        value.state === 'isolated' && value.handoffReady === true && value.originalResult === 'unknown' &&
        value.disposition === 'prevented_before_dispatch' && value.pendingOperations === 1 && value.temporaryFiles === 0 &&
        equal(value.checkpoint, retained.checkpoint), 'Foreign or inconsistent cleanup-fence receipt.');
      reference(value.checkpoint, 'checkpoint'); reference(value.verifiedHead, 'step');
    } else if (item.role === 'step') {
      fields(value, 'schemaVersion checkpointSha256 revision previous phase observedAt journal calls receipt');
      requireValue(value.schemaVersion === 1 && value.checkpointSha256 === retained.checkpoint.sha256 &&
        Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision <= 256 &&
        ['prepared', 'claimed', 'cleaned', 'complete'].includes(value.phase) && Array.isArray(value.calls) && value.calls.length <= 64,
      'Foreign or invalid cleanup-fence step.');
      if (value.previous !== null) reference(value.previous, 'step');
      reference(value.journal, 'calls');
      if (value.receipt !== null) reference(value.receipt, 'receipt');
      for (const call of value.calls) {
        try { fields(call, 'call outcome'); if (call.outcome !== null) reference(call.outcome, 'observation'); }
        catch (error) { failed(error); }
      }
      // Only the receipt's verified head binds the final dedicated calls journal.
      if (item.finalHead) await live(path.join(root, 'calls.json'), `${prefix}/cleanup-fence/${id}/calls.json`, value.journal?.sha256,
        value => journal(value, id));
    } else if (item.role === 'calls') journal(value, id);
    else if (item.role === 'original-journal') {
      journal(value, owner);
      await live(path.join(ownerDirectory, 'recovery-journal.json'), `${prefix}/recovery-journal.json`, item.sha256, value => journal(value, owner));
    } else if (item.role === 'original-gate') {
      requireValue([1, 3].includes(value.schemaVersion) && value.deviceId === deviceId && value.ownerSessionId === owner &&
        value.state === 'quarantined' && !value.maintenance && !value.cleanupFence, 'Foreign original cleanup-fence gate.');
      requireValue(checkpoint && value.reportSha256 === checkpoint.originalReceipt.sha256 && typeof value.reportPath === 'string' &&
        samePath(path.dirname(value.reportPath), path.join(ownerDirectory, 'recoveries')) &&
        uuid.test(path.basename(value.reportPath, '.json')) && path.basename(value.reportPath).endsWith('.json'), 'Original receipt escaped its owner.');
      await live(value.reportPath, `${prefix}/recoveries/${path.basename(value.reportPath)}`, checkpoint.originalReceipt.sha256,
        value => requireValue(value.deviceId === deviceId && value.sessionId === owner && value.state === 'unknown', 'Foreign original receipt.'));
    } else if (item.role === 'original-receipt') {
      requireValue(value.deviceId === deviceId && value.sessionId === owner && value.state === 'unknown', 'Foreign original receipt snapshot.');
    } else if (item.role === 'observation') {
      fields(value, 'hostCallId action nonce phase stdout stderr');
      requireValue(uuid.test(value.hostCallId) && uuid.test(value.nonce) && ['claim', 'clean', 'verify'].includes(value.action) &&
        ['claimed', 'cleaned'].includes(value.phase), 'Invalid cleanup-fence observation.');
    }
  }
  // Independent roots allow collecting the checkpoint when its receipt is absent, and vice versa.
  reference(retained.checkpoint, 'checkpoint'); reference(retained.receipt, 'receipt');
  if (resolution !== null) {
    try {
      requireValue(typeof resolution.recoveryResponsePath === 'string' && path.isAbsolute(resolution.recoveryResponsePath) &&
        typeof resolution.recoveryResponseSha256 === 'string' && digestPattern.test(resolution.recoveryResponseSha256), 'Missing saved fence recovery response.');
      checkBudget();
      const response = await read(resolution.recoveryResponsePath, 'recovery/fence-response.json', resolution.recoveryResponseSha256);
      requireValue(response.protocol === 'maestro.harmonyos.cleanup-fence-recovery' && response.schemaVersion === 1 &&
        response.deviceId === deviceId && response.sessionId === owner && response.recoveryId === id && response.handoffReady === true &&
        response.state === 'isolated' && response.originalResult === 'unknown' && response.disposition === 'prevented_before_dispatch' &&
        response.receipt?.schemaVersion === 4 && samePath(response.receipt.path, path.join(root, retained.receipt.path)) &&
        response.receipt.sha256 === retained.receipt.sha256, 'Fence response differs from its archived receipt.');
    } catch (error) { failed(error, resolution.recoveryResponsePath ?? null); }
  }
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index], source = path.join(root, item.path);
    try { checkBudget(); } catch (error) { failed(error, source); break; }
    try {
      const value = await read(source, `${prefix}/cleanup-fence/${id}/${item.path}`, item.sha256);
      if (item.role === 'receipt' && item.path === retained.receipt.path) {
        // Mark only after the receipt passes identity and shape checks in follow().
        await follow(value, item);
        const head = seen.get(value.verifiedHead?.path);
        if (head) head.finalHead = true;
      } else await follow(value, item);
    } catch (error) { failed(error, source); }
  }
  return { complete, referencedFiles: seen.size };
}
