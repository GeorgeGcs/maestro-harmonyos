import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const requireValue = (value, message) => { if (!value) throw new Error(message); };
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const fields = (value, names) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
  equal(Object.keys(value).sort(), names.split(' ').sort()), 'Unexpected cleanup-fence fields.');
const q = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function fenceScope(journal) {
  fields(journal, 'version deviceId ownerId generation remoteRoot sealed rootRemoved operations temporaryFiles hostCalls');
  requireValue(journal.version === 1 && journal.sealed === true && journal.rootRemoved === false && uuid(journal.ownerId) &&
    uuid(journal.generation) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(journal.deviceId) &&
    journal.remoteRoot === `/data/local/tmp/maestro-session-${journal.generation}`, 'Invalid original fence journal.');
  const operations = journal.operations, paths = journal.temporaryFiles;
  requireValue(Array.isArray(operations) && operations.length >= 1 && operations.length <= 16 &&
    new Set(operations.map(op => op.id)).size === operations.length, 'Invalid original operations.');
  for (const op of operations) {
    fields(op, 'id token sha256 recoverable completed markerRemoved');
    requireValue(uuid(op.id) && uuid(op.token) && /^[0-9a-f]{64}$/.test(op.sha256) &&
      ['recoverable', 'completed', 'markerRemoved'].every(key => typeof op[key] === 'boolean') &&
      (!op.markerRemoved || op.completed), 'Invalid operation metadata.');
  }
  requireValue(Array.isArray(journal.hostCalls) && journal.hostCalls.every(call => call.stopped === true), 'Original host calls are not stopped.');
  const pending = operations.filter(op => !op.completed);
  requireValue(pending.length === 1 && pending[0].recoverable && !pending[0].markerRemoved, 'Fence scope requires one finite pending operation.');
  requireValue(Array.isArray(paths) && paths.length >= 1 && paths.length <= 16 && new Set(paths).size === paths.length &&
    paths.every(file => typeof file === 'string' && file.startsWith(journal.remoteRoot + '/files/') &&
      /^(?:layout-[0-9a-f-]{36}\.json|screen-[0-9a-f-]{36}\.png)$/.test(file.slice((journal.remoteRoot + '/files/').length))), 'Invalid fence resources.');
  const matching = paths.filter(file => file.endsWith('.json') && hash(JSON.stringify(['rm', '-f', file])) === pending[0].sha256);
  requireValue(matching.length === 1, 'The pending command is not one exact registered layout removal.');
  return { deviceId: journal.deviceId, ownerId: journal.ownerId, generation: journal.generation, remoteRoot: journal.remoteRoot,
    operationId: pending[0].id, operationSha256: pending[0].sha256, target: matching[0],
    operationIds: operations.map(op => op.id), temporaryFiles: paths };
}

// Byte-for-byte counterpart of HarmonyOSCleanupFenceTransport.arguments. The verifier does not execute it.
export function fenceArguments(scope, proof, action, nonce) {
  requireValue(['claim', 'clean', 'verify'].includes(action) && uuid(nonce) && /^MAESTRO_CLEANUP_FENCE_V1:[0-9a-f]{64}$/.test(proof), 'Invalid fence command identity.');
  const root = scope.remoteRoot, files = root + '/files', operation = root + '/' + scope.operationId;
  const directory = name => `[ -d ${q(name)} ] && [ ! -L ${q(name)} ] || exit 121; `;
  function children(parent, allowed, directories = false) {
    const cases = allowed.map(q).join('|') || '__no_allowed_children__';
    return `for __f in ${q(parent)}/* ${q(parent)}/.[!.]* ${q(parent)}/..?*; do ` +
      '[ -e "$__f" ] || [ -L "$__f" ] || continue; ' +
      `[ ! -L "$__f" ] || exit 121; case "$__f" in ${cases}) ;; *) exit 121;; esac; ` +
      (directories ? '[ -d "$__f" ]' : '[ -f "$__f" ]') + ' || exit 121; done; ';
  }
  let script = 'umask 077; ' + directory(root) + directory(files) +
    children(root, [files, ...scope.operationIds.map(id => root + '/' + id)], true) + children(files, scope.temporaryFiles);
  const completed = scope.operationIds.filter(id => id !== scope.operationId);
  if (completed.length) {
    script += `for __d in ${completed.map(id => q(root + '/' + id)).join(' ')}; do ` +
      'if [ -e "$__d" ]; then [ -d "$__d" ] && [ ! -L "$__d" ] || exit 121; ' +
      'for __f in "$__d"/* "$__d"/.[!.]* "$__d"/..?*; do ' +
      '[ -e "$__f" ] || [ -L "$__f" ] || continue; ' +
      '[ -f "$__f" ] && [ ! -L "$__f" ] || exit 121; ' +
      'case "$__f" in "$__d/done"|"$__d/done.pending") ;; *) exit 121;; esac; done; fi; done; ';
  }
  if (action === 'claim') {
    script += `mkdir ${q(operation)} 2>/dev/null || { printf '%s' ${q(`MAESTRO_FENCE:${nonce}:occupied`)}; exit 0; }; printf '%s' ${q(proof)} > ${q(operation + '/fence.pending')} && ` +
      `mv ${q(operation + '/fence.pending')} ${q(operation + '/fence')} || exit 124; `;
  }
  script += directory(operation) + children(operation, [operation + '/fence', operation + '/cleaned', operation + '/cleaned.pending']) +
    `[ -f ${q(operation + '/fence')} ] && [ "$(cat ${q(operation + '/fence')})" = ${q(proof)} ] || exit 125; `;
  if (action === 'clean') {
    for (const file of scope.temporaryFiles) script += `rm -f ${q(file)} && [ ! -e ${q(file)} ] || exit 121; `;
    script += `printf '%s' ${q(proof)} > ${q(operation + '/cleaned.pending')} && ` +
      `mv ${q(operation + '/cleaned.pending')} ${q(operation + '/cleaned')} || exit 124; `;
  }
  script += `if [ -e ${q(operation + '/cleaned')} ]; then [ "$(cat ${q(operation + '/cleaned')})" = ${q(proof)} ] || exit 125; `;
  for (const file of scope.temporaryFiles) script += `[ ! -e ${q(file)} ] && [ ! -L ${q(file)} ] || exit 121; `;
  script += `printf '%s' ${q(`MAESTRO_FENCE:${nonce}:cleaned`)}; else printf '%s' ${q(`MAESTRO_FENCE:${nonce}:claimed`)}; fi`;
  script = `__r=${q(root)}; __p=${q(proof)}; ` + script
    .replace(new RegExp("'" + root + "([^']*)'", 'g'), (_, suffix) => '"${__r}' + suffix + '"')
    .replaceAll(q(proof), '"$__p"');
  const args = ['sh', '-c', script];
  requireValue(Buffer.byteLength(args.map(q).join(' ')) <= 6 * 1024, 'Fence script exceeds the bounded scope.');
  return args;
}

export function confirmedPhase(outcome) {
  fields(outcome, 'hostCallId action nonce phase stdout stderr');
  requireValue(uuid(outcome.hostCallId) && uuid(outcome.nonce) && outcome.stderr === '' && typeof outcome.stdout === 'string', 'Invalid fence observation.');
  const text = outcome.stdout.replace(/\n$/, '').replace(/\r$/, '');
  requireValue(['claimed', 'cleaned', 'occupied'].includes(outcome.phase) && text === `MAESTRO_FENCE:${outcome.nonce}:${outcome.phase}`, 'Fence observation has no valid completion proof.');
  return outcome.phase;
}
