import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { verifyRecordingResources, verifyRecoveryReport } from '../evidence.mjs';

const artifacts = fileURLToPath(new URL('../../../artifacts/agent-client-tests/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'recording-'));
  const deviceId = 'recording-fixture-device';
  const sessionId = randomUUID();
  const generation = randomUUID();
  const recoveryId = randomUUID();
  const id = randomUUID();
  const owner = path.join(root, sha(deviceId), sessionId);
  const receipts = path.join(owner, 'recoveries');
  const originals = path.join(owner, 'recording-originals');
  await fs.mkdir(receipts, { recursive: true }); await fs.mkdir(originals);
  const raw = Buffer.from('original video bytes; decoding is a separate concern');
  const archive = { name: `${id}-${randomUUID()}.mp4`, size: raw.length, sha256: sha(raw) };
  const fileName = `maestro-recording-${id.replaceAll('-', '')}.mp4`;
  const snapshot = { schemaVersion: 1, deviceId, ownerId: sessionId, generation,
    remoteRoot: `/data/local/tmp/maestro-session-${generation}`, resources: [{
      id, fileName, remotePath: `/data/local/tmp/maestro-session-${generation}/files/recording-${randomUUID()}.mp4`,
      startRequested: true, startAcknowledged: true, ownerPid: 51, stopRequested: true, captureEnded: true,
      uri: `file://media/Photo/123/VID_123/${fileName}`, archiveName: archive.name, archiveSize: archive.size,
      archiveSha256: archive.sha256, mediaRemoved: true, clean: true, failureFingerprint: null, archives: [archive],
    }] };
  const reportPath = path.join(receipts, `${recoveryId}.json`);
  const snapshotPath = path.join(receipts, `${recoveryId}-recordings.json`);
  const audit = { schemaVersion: 2, recoveryId, deviceId, sessionId, state: 'complete', operations: 7,
    pendingOperations: 0, temporaryFiles: 0, issues: [], unresolvedRecording: false, closeFailure: null,
    recordingResources: { path: snapshotPath, sha256: '' } };
  await fs.writeFile(path.join(originals, archive.name), raw);
  async function write() {
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
    await fs.writeFile(snapshotPath, snapshotBytes);
    audit.recordingResources.sha256 = sha(snapshotBytes);
    const bytes = Buffer.from(JSON.stringify(audit));
    await fs.writeFile(reportPath, bytes);
    const data = { deviceId, sessionId, state: audit.state, operations: audit.operations, pendingOperations: audit.pendingOperations,
      temporaryFiles: audit.temporaryFiles, cleanup: { state: audit.state, errors: [] }, handoffReady: audit.state === 'complete',
      reportPath, reportSha256: sha(bytes) };
    return { protocol: 'maestro.harmonyos.agent', schemaVersion: 2, kind: 'recoveryReport', revision: 1,
      observedAt: new Date().toISOString(), data };
  }
  await write();
  return { root, reportPath, snapshotPath, originals, audit, snapshot, archive, raw, write };
}

test('recording receipt v2 verifies its snapshot and raw archive while receipt v1 needs neither', async () => {
  const f = await fixture();
  assert.deepEqual(await verifyRecordingResources(f.audit, f.reportPath, f.root), { checkedFiles: 2 });
  assert.deepEqual(await verifyRecoveryReport(await f.write(), f.root), { checkedFiles: 3 });
  assert.deepEqual(await verifyRecordingResources({ schemaVersion: 1 }, 'unused', 'unused'), { checkedFiles: 0 });
});

test('recording snapshot v2 accepts a confirmed rejected start without inventing an archived video', async () => {
  const f = await fixture();
  const resource = f.snapshot.resources[0];
  f.snapshot.schemaVersion = 2;
  Object.assign(resource, {startAcknowledged: false, ownerPid: null, stopRequested: false, captureEnded: false,
    uri: null, archiveName: null, archiveSize: null, archiveSha256: null, mediaRemoved: false, archives: [],
    failureFingerprint: 'a'.repeat(64), rejectedStart: {errorCode: 10106102, failureFingerprint: 'a'.repeat(64),
      firstObservedAt: '2026-11-03T01:00:00Z', secondObservedAt: '2026-11-03T01:00:02Z'}});
  await f.write();
  assert.deepEqual(await verifyRecordingResources(f.audit, f.reportPath, f.root), {checkedFiles: 1});
  for (const change of [
    r => { r.rejectedStart.errorCode = 0; },
    r => { r.rejectedStart.failureFingerprint = 'b'.repeat(64); },
    r => { r.rejectedStart.secondObservedAt = r.rejectedStart.firstObservedAt; },
    r => { r.startAcknowledged = true; r.ownerPid = 51; },
    r => { r.clean = false; },
    r => { r.mediaRemoved = true; },
  ]) {
    const changed = structuredClone(resource);
    change(changed);
    f.snapshot.resources[0] = changed;
    await f.write();
    await assert.rejects(verifyRecordingResources(f.audit, f.reportPath, f.root));
  }
});

test('matching snapshot hash cannot conceal another owner, unfinished resource or invalid identity', async () => {
  for (const change of [
    f => { f.snapshot.ownerId = randomUUID(); },
    f => { f.snapshot.deviceId = 'other-device'; },
    f => { f.snapshot.resources[0].clean = false; },
    f => { f.snapshot.resources[0].captureEnded = false; },
    f => { f.snapshot.resources[0].mediaRemoved = false; },
    f => { delete f.snapshot.resources[0].startRequested; },
    f => { f.snapshot.resources[0].archives[0].name = '../outside.mp4'; },
    f => { f.snapshot.resources[0].remotePath = '/data/local/tmp/another-owner.mp4'; },
  ]) {
    const f = await fixture(); change(f); await f.write();
    await assert.rejects(verifyRecordingResources(f.audit, f.reportPath, f.root));
  }
});

test('snapshot hash and exact sibling location are both mandatory', async () => {
  const f = await fixture();
  f.audit.recordingResources.sha256 = '0'.repeat(64);
  await assert.rejects(verifyRecordingResources(f.audit, f.reportPath, f.root), /snapshot hash/);
  await f.write();
  const other = path.join(path.dirname(f.snapshotPath), `${randomUUID()}-recordings.json`);
  await fs.copyFile(f.snapshotPath, other); f.audit.recordingResources.path = other;
  await assert.rejects(verifyRecordingResources(f.audit, f.reportPath, f.root), /snapshot reference/);
});

test('changed or missing raw originals prevent handoff even with a valid snapshot', async () => {
  for (const missing of [false, true]) {
    const f = await fixture();
    const original = path.join(f.originals, f.archive.name);
    if (missing) await fs.unlink(original); else await fs.writeFile(original, Buffer.alloc(f.raw.length, 88));
    await assert.rejects(verifyRecordingResources(f.audit, f.reportPath, f.root));
  }
});

test('all original versions are checked and an unknown snapshot cannot authorize completion', async () => {
  const f = await fixture();
  const raw = Buffer.from('a later finalized version');
  const archive = { name: `${f.snapshot.resources[0].id}-${randomUUID()}.mp4`, size: raw.length, sha256: sha(raw) };
  await fs.writeFile(path.join(f.originals, archive.name), raw);
  const resource = f.snapshot.resources[0];
  resource.archives.push(archive); resource.archiveName = archive.name; resource.archiveSize = archive.size; resource.archiveSha256 = archive.sha256;
  await f.write();
  assert.deepEqual(await verifyRecordingResources(f.audit, f.reportPath, f.root), { checkedFiles: 3 });
  resource.clean = false; resource.mediaRemoved = false; f.audit.state = 'unknown'; f.audit.unresolvedRecording = true;
  await f.write();
  assert.deepEqual(await verifyRecordingResources(f.audit, f.reportPath, f.root), { checkedFiles: 3 });
  f.audit.state = 'complete';
  await assert.rejects(verifyRecordingResources(f.audit, f.reportPath, f.root), /unresolved resources/);
});
