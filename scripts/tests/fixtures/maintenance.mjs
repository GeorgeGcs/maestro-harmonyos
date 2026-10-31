import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function encode(value) {
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ':' + encode(v)).join(',') + '}';
  return JSON.stringify(value);
}

// Synthetic evidence only. No installed CLI, device state, executable or HDC is accessed.
export async function maintenanceFixture(root, transform = (_kind, value) => value) {
  const deviceId = 'maintenance-fixture', ownerId = randomUUID(), maintenanceId = randomUUID(), generation = randomUUID();
  const recoveryRoot = path.join(root, 'recovery'), key = sha(Buffer.from(deviceId));
  const owner = path.join(recoveryRoot, key, ownerId), evidence = path.join(owner, 'maintenance', maintenanceId);
  await fs.mkdir(evidence, { recursive: true }); await fs.mkdir(path.join(owner, 'recoveries'));
  async function write(file, value) { await fs.writeFile(file, encode(value)); return sha(Buffer.from(encode(value))); }
  async function put(kind, value) {
    const file = `${kind}-${randomUUID()}.json`, changed = transform(kind, structuredClone(value));
    return { path: file, sha256: await write(path.join(evidence, file), changed) };
  }
  const createdAt = '2026-10-20T00:00:00.000Z', now = '2026-10-31T01:00:00.000Z';
  const tool = name => ({ path: 'C:\\fixture\\' + name, sha256: 'a'.repeat(64), bytes: 10 });
  const tools = { powershell: tool('pwsh.exe'), script: tool('observe.ps1'), hdc: tool('hdc.exe'), java: tool('java.exe'), 'classpath:0:fixture.jar': tool('fixture.jar') };
  const host = (observedAt, boot, uptime) => ({ protocol: 'maestro.harmonyos.host-boot-observation', schemaVersion: 1,
    provider: { name: 'windows-gettickcount64-cim', version: 1 }, observedAt, lastBootUpTime: boot, uptimeMilliseconds: uptime,
    machineIdSha256: 'b'.repeat(64), tools: { powershell: { ...tools.powershell, version: '5.1.1.1' }, script: tools.script } });
  const hostBefore = await put('host-before', host('2026-10-30T00:00:00.000Z', createdAt, '864000000'));
  const hostResume = await put('host-resume', host('2026-10-31T00:00:00.000Z', '2026-10-30T23:58:00.000Z', '120000'));
  const hostComplete = await put('host-complete', host('2026-10-31T00:10:00.000Z', '2026-10-30T23:58:00.000Z', '720000'));
  const remote = '/data/local/tmp/maestro-session-' + generation;
  const original = { version: 1, deviceId, ownerId, generation, sealed: true, remoteRoot: remote, temporaryFiles: [],
    operations: [{ id: randomUUID(), completed: false, recoverable: true }],
    hostCalls: [{ id: randomUUID(), returned: true, stopped: true, startTimeTicks: 9007199254740993n }] };
  const journalPath = path.join(owner, 'recovery-journal.json');
  const oldReceipt = { schemaVersion: 1, recoveryId: randomUUID(), deviceId, sessionId: ownerId, observedAt: createdAt,
    reason: 'recovery', previousState: 'quarantined', previousReportPath: null, previousReportSha256: null,
    requiresRecovery: true, uncertainReason: 'fixture', unresolvedRecording: false, closeFailure: null, state: 'unknown',
    operations: 1, pendingOperations: 1, temporaryFiles: 0, issues: ['fixture'] };
  const oldPath = path.join(owner, 'recoveries', oldReceipt.recoveryId + '.json');
  const oldHash = await write(oldPath, oldReceipt);
  const gateBase = { schemaVersion: 1, deviceId, ownerSessionId: ownerId, state: 'quarantined', journalPath, updatedAt: now,
    closeFailure: null, reportPath: oldPath, reportSha256: oldHash, requiresRecovery: true, uncertainReason: 'fixture', unresolvedRecording: false };
  const cp = { schemaVersion: 1, maintenanceId, deviceId, ownerId, generation, createdAt: now,
    originalGate: await put('original-gate', gateBase), originalJournal: await put('original-journal', original),
    originalReceipt: await put('original-receipt', oldReceipt), hostBefore, tools };
  const checkpoint = await put('checkpoint', cp);
  let step = { schemaVersion: 1, checkpointSha256: checkpoint.sha256, revision: 0, previous: null, phase: 'prepared', observedAt: now,
    journal: cp.originalJournal, calls: [], hostResume: null, phoneBefore: null, hostComplete: null, phoneAfter: null,
    termination: null, cleanupBatches: [], receipt: null };
  let head = await put('step', step), current = structuredClone(original);
  async function publish(change) {
    step = { ...step, ...change, previous: head, revision: step.revision + 1 };
    head = await put('step', step);
  }
  async function call(purpose, outcome) {
    const id = randomUUID();
    current.hostCalls.push({ id, returned: false, stopped: false });
    const binding = { hostCallId: id, phase: step.phase, purpose, argumentsSha256: purpose === 'observe_uptime' ? sha(Buffer.from('["uptime"]')) : 'c'.repeat(64),
      registeredJournal: await put('registered-journal', current), outcome: null, endedJournal: null };
    await publish({ journal: binding.registeredJournal, calls: [...step.calls, binding] });
    current.hostCalls.at(-1).returned = true; current.hostCalls.at(-1).stopped = true;
    binding.outcome = await outcome(id); binding.endedJournal = await put('ended-journal', current);
    await publish({ journal: binding.endedJournal, calls: [...step.calls.slice(0, -1), binding] });
    return binding.outcome;
  }
  const phone = (id, minutes) => ({ schemaVersion: 1, provider: 'toybox-uptime-english-floor-minute-v1', deviceId, ownerId,
    hostCallId: id, raw: ` 00:00:00 up ${minutes} min,  0 users,  load average: 0.00, 0.00, 0.00\n`, minutes: String(minutes),
    lowerBoundMilliseconds: String(minutes * 60000), upperBoundMillisecondsExclusive: String((minutes + 1) * 60000) });
  await publish({ phase: 'host_verified', hostResume });
  const phoneBefore = await call('observe_uptime', id => put('phone-before', phone(id, 50)));
  await publish({ phase: 'phone_prepared', phoneBefore }); await publish({ hostComplete });
  const phoneAfter = await call('observe_uptime', id => put('phone-after', phone(id, 1)));
  const termination = await put('termination', { schemaVersion: 1, deviceId, ownerId, checkpointSha256: checkpoint.sha256,
    hostBefore, hostResume, hostComplete, phoneBefore, phoneAfter, disposition: 'terminated_by_ordered_host_device_restart',
    originalResult: 'unknown', operationIds: original.operations.map(op => op.id) });
  await publish({ phase: 'terminated', phoneAfter, termination }); await publish({ phase: 'cleaning' });
  const batch = await call('cleanup_owned_paths', id => put('cleanup-batch', { index: 0, hostCallId: id,
    paths: [...original.operations.flatMap(op => [`${remote}/${op.id}/done`, `${remote}/${op.id}/done.pending`, `${remote}/${op.id}`]), `${remote}/files`, remote] }));
  await publish({ cleanupBatches: [batch] }); await publish({ phase: 'cleaned' });
  const receipt = { schemaVersion: 3, recoveryId: maintenanceId, deviceId, observedAt: now, sessionId: ownerId,
    reason: 'ordered_restart_maintenance', state: 'complete', originalExecutionResult: 'unknown', operations: 1,
    originalPendingOperations: 1, pendingOperations: 0, temporaryFiles: 0, issues: [], maintenanceId, checkpoint,
    evidenceHead: head, termination, originalJournal: cp.originalJournal, finalJournal: step.journal,
    originalReceipt: cp.originalReceipt, cleanupBatches: [batch] };
  const receiptRef = await put('receipt', receipt), reportPath = path.join(owner, 'recoveries', maintenanceId + '.json');
  await fs.copyFile(path.join(evidence, receiptRef.path), reportPath);
  await publish({ phase: 'receipt_written', receipt: receiptRef }); await publish({ phase: 'complete' });
  const gate = { ...gateBase, schemaVersion: 2, state: 'clean', requiresRecovery: false, uncertainReason: null,
    reportPath, reportSha256: receiptRef.sha256, maintenance: { maintenanceId, checkpoint, head } };
  const gatePath = path.join(recoveryRoot, key + '.owner.json'); await write(gatePath, gate);
  await fs.copyFile(path.join(evidence, step.journal.path), journalPath);
  const response = { protocol: 'harmonyos.reboot-recovery', schemaVersion: 1, maintenanceId, deviceId, ownerId,
    state: 'complete', cleanup: { state: 'complete' }, phase: 'complete', handoffReady: true, checkpoint, head,
    evidenceDirectory: evidence, receipt: { path: reportPath, sha256: receiptRef.sha256, schemaVersion: 3 } };
  const responsePath = path.join(root, 'response.json'); await write(responsePath, response);
  return { input: { deviceId, recoveryRoot, createdAt, responsePath }, gatePath, gate, response, evidence, owner, write, journalPath };
}
