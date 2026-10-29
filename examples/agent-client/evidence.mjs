import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateDocument } from './client.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const terminal = new Set(['passed', 'failed', 'blocked', 'cancelled', 'unknown']);

function contained(base, target) {
  const relative = path.relative(base, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function confinedFile(base, relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f\x7f]/.test(relative) ||
      relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid relative artifact path.');
  }
  const root = realpathSync(base);
  const target = realpathSync(path.resolve(root, ...relative.split('/')));
  if (!contained(root, target)) throw new Error('Artifact escapes its attempt directory.');
  const file = await fs.open(target, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Artifact is not a regular file.');
    return await file.readFile();
  } finally { await file.close(); }
}

/** Validates concrete references, not just JSON shape. Uses only this attempt's declared output root. */
export async function verifyEvidence(result, index, artifactsRoot) {
  validateDocument(result, 'runResult'); validateDocument(index, 'evidenceIndex');
  const data = result.data;
  if (!uuid.test(data.runId) || !uuid.test(data.attemptId) || !terminal.has(data.status) ||
      index.data.runId !== data.runId || index.data.attemptId !== data.attemptId || !Array.isArray(index.data.entries)) {
    throw new Error('Result and evidence do not identify the same terminal attempt.');
  }
  const expected = path.resolve(artifactsRoot, 'runs', data.runId, data.attemptId);
  const actual = path.resolve(data.artifacts.baseDir);
  if (path.relative(expected, actual) !== '') throw new Error('Result belongs to an unexpected attempt directory.');
  const root = realpathSync(artifactsRoot);
  const base = realpathSync(expected);
  if (!contained(root, base)) throw new Error('Attempt directory escapes the configured output root.');
  let checkedFiles = 0;
  async function check(reference) {
    if (!reference || !hash.test(reference.sha256)) throw new Error('Invalid artifact hash.');
    const bytes = await confinedFile(base, reference.path);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error(`Artifact hash differs: ${reference.path}`);
    checkedFiles++;
  }
  await check(data.input);
  if (data.flow !== null) await check(data.flow);
  const steps = new Set();
  let unavailable = 0;
  for (const entry of index.data.entries) {
    if (entry.stepId !== null) {
      if (!uuid.test(entry.stepId) || steps.has(entry.stepId)) throw new Error('Invalid or duplicate evidence step identity.');
      steps.add(entry.stepId);
    }
    if (!Array.isArray(entry.evidence)) throw new Error('Step evidence must be an array.');
    for (const item of entry.evidence) {
      if (item.state === 'available') await check(item);
      else if (item.state === 'missing' || item.state === 'capture_failed') {
        if (item.path !== null || item.sha256 !== null) throw new Error('Unavailable evidence claims a file.');
        unavailable++;
      } else throw new Error('Unknown evidence availability.');
    }
  }
  if (data.failedStepId !== null && !steps.has(data.failedStepId)) throw new Error('Failed step is absent from the evidence index.');
  if (!Array.isArray(data.artifacts.manifestPaths)) throw new Error('Missing manifest references.');
  for (const reference of data.artifacts.manifestPaths) await confinedFile(base, reference);
  if (data.artifacts.junitPath !== null) await confinedFile(base, data.artifacts.junitPath);
  await confinedFile(base, data.artifacts.evidenceIndexPath);
  return { checkedFiles, unavailable, steps: steps.size };
}

export async function verifyRecoveryReport(document, recoveryRoot) {
  validateDocument(document, 'recoveryReport', [2]);
  const { reportPath, reportSha256 } = document.data;
  if (typeof reportPath !== 'string' || !path.isAbsolute(reportPath) || !hash.test(reportSha256)) throw new Error('Invalid recovery report reference.');
  const root = realpathSync(recoveryRoot);
  const file = realpathSync(reportPath);
  if (!contained(root, file)) throw new Error('Recovery report escapes the explicitly trusted recovery root.');
  const bytes = await confinedFile(root, path.relative(root, file).split(path.sep).join('/'));
  if (createHash('sha256').update(bytes).digest('hex') !== reportSha256) throw new Error('Recovery report hash differs.');
  const audit = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!audit || typeof audit !== 'object' || Array.isArray(audit) || ![1, 2].includes(audit.schemaVersion) ||
      !Array.isArray(audit.issues)) throw new Error('Invalid recovery audit document.');
  for (const key of ['deviceId', 'sessionId', 'state', 'operations', 'pendingOperations', 'temporaryFiles']) {
    if (audit[key] !== document.data[key]) throw new Error(`Recovery audit does not match the response: ${key}`);
  }
  if (audit.state === 'complete' && audit.issues.length !== 0) throw new Error('Complete recovery audit still lists issues.');
  const recording = await verifyRecordingResources(audit, file, root);
  return { checkedFiles: 1 + recording.checkedFiles };
}

function fields(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

async function checkedRecordingFile(root, expected, limit, collect = false) {
  const absolute = path.resolve(expected);
  const actual = realpathSync(absolute);
  if (path.relative(absolute, actual) !== '' || !contained(root, actual)) throw new Error('Recording evidence path is linked or escapes its owner.');
  const file = await fs.open(actual, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new Error('Recording evidence is not a bounded regular file.');
    const digest = createHash('sha256');
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new Error('Recording evidence exceeded its byte limit.');
      digest.update(chunk);
      if (collect) chunks.push(chunk);
    }
    const after = await file.stat();
    if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Recording evidence changed while verifying.');
    }
    return { size, sha256: digest.digest('hex'), bytes: collect ? Buffer.concat(chunks) : null };
  } finally { await file.close(); }
}

/** Internal receipt v2 adds an immutable recorder snapshot; wire protocol versions do not change. */
export async function verifyRecordingResources(audit, reportPath, recoveryRoot) {
  if (audit?.schemaVersion === 1) return { checkedFiles: 0 };
  if (audit?.schemaVersion !== 2 || !uuid.test(audit.recoveryId) || !uuid.test(audit.sessionId) ||
      typeof audit.deviceId !== 'string' || !audit.deviceId || !['complete', 'unknown'].includes(audit.state)) {
    throw new Error('Invalid recording recovery receipt.');
  }
  if (audit.state === 'complete' && (audit.unresolvedRecording !== false || audit.closeFailure !== null ||
      audit.pendingOperations !== 0 || audit.temporaryFiles !== 0 || !Array.isArray(audit.issues) || audit.issues.length !== 0)) {
    throw new Error('Complete recording recovery receipt still has unresolved resources.');
  }
  const root = realpathSync(recoveryRoot);
  const owner = path.resolve(root, createHash('sha256').update(audit.deviceId, 'utf8').digest('hex'), audit.sessionId);
  const expectedReport = path.resolve(owner, 'recoveries', `${audit.recoveryId}.json`);
  if (path.relative(expectedReport, path.resolve(reportPath)) !== '') throw new Error('Recording receipt is outside its expected owner directory.');
  const reference = audit.recordingResources;
  const expectedSnapshot = path.resolve(owner, 'recoveries', `${audit.recoveryId}-recordings.json`);
  if (!fields(reference, ['path', 'sha256']) || typeof reference.path !== 'string' || !path.isAbsolute(reference.path) ||
      path.relative(expectedSnapshot, path.resolve(reference.path)) !== '' || !hash.test(reference.sha256)) {
    throw new Error('Invalid recording snapshot reference.');
  }
  const snapshotFile = await checkedRecordingFile(root, expectedSnapshot, 4 * 1024 * 1024, true);
  if (snapshotFile.sha256 !== reference.sha256) throw new Error('Recording snapshot hash differs.');
  const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshotFile.bytes));
  if (!fields(snapshot, ['schemaVersion', 'deviceId', 'ownerId', 'generation', 'remoteRoot', 'resources']) || snapshot.schemaVersion !== 1 ||
      snapshot.deviceId !== audit.deviceId || snapshot.ownerId !== audit.sessionId || !uuid.test(snapshot.generation) ||
      snapshot.remoteRoot !== `/data/local/tmp/maestro-session-${snapshot.generation}` || !Array.isArray(snapshot.resources)) {
    throw new Error('Recording snapshot belongs to another owner or has invalid metadata.');
  }
  const ids = new Set();
  const remotes = new Set();
  let checkedFiles = 1;
  for (const resource of snapshot.resources) {
    if (!fields(resource, ['id', 'fileName', 'remotePath', 'startRequested', 'startAcknowledged', 'ownerPid', 'stopRequested',
      'captureEnded', 'uri', 'archiveName', 'archiveSize', 'archiveSha256', 'mediaRemoved', 'clean', 'failureFingerprint', 'archives']) ||
        !uuid.test(resource.id) || ids.has(resource.id) || resource.fileName !== `maestro-recording-${resource.id.replaceAll('-', '')}.mp4` ||
        typeof resource.remotePath !== 'string' || !resource.remotePath.startsWith(`${snapshot.remoteRoot}/files/recording-`) ||
        !/^recording-[0-9a-f-]{36}\.mp4$/.test(path.posix.basename(resource.remotePath)) ||
        path.posix.dirname(resource.remotePath) !== `${snapshot.remoteRoot}/files` || remotes.has(resource.remotePath) ||
        ['startRequested', 'startAcknowledged', 'stopRequested', 'captureEnded', 'mediaRemoved', 'clean'].some(key => typeof resource[key] !== 'boolean') ||
        resource.ownerPid !== null && (!Number.isInteger(resource.ownerPid) || resource.ownerPid <= 0) ||
        resource.failureFingerprint !== null && !hash.test(resource.failureFingerprint) || !Array.isArray(resource.archives)) {
      throw new Error('Invalid recording resource identity or state.');
    }
    ids.add(resource.id); remotes.add(resource.remotePath);
    const nullableText = ['uri', 'archiveName', 'archiveSha256'].every(key => resource[key] === null || typeof resource[key] === 'string');
    const uriSuffix = typeof resource.uri === 'string' ? resource.uri.slice(resource.uri.lastIndexOf('/') + 1) : null;
    if (!nullableText || resource.startAcknowledged && (!resource.startRequested || resource.ownerPid === null) ||
        resource.captureEnded && !resource.startAcknowledged || resource.stopRequested && !resource.startAcknowledged ||
        resource.uri !== null && (!/^file:\/\/media\/Photo\/[0-9]+\/[A-Za-z0-9_.-]+\/maestro-recording-[0-9a-f]{32}\.mp4$/.test(resource.uri) || uriSuffix !== resource.fileName) ||
        resource.mediaRemoved && (!resource.captureEnded || resource.archiveName === null) ||
        resource.clean && resource.startRequested && !resource.mediaRemoved || audit.state === 'complete' && !resource.clean) {
      throw new Error('Recording cleanup is unconfirmed or contradictory.');
    }
    const names = new Set();
    for (const archive of resource.archives) {
      const prefix = `${resource.id}-`;
      if (!fields(archive, ['name', 'size', 'sha256']) || typeof archive.name !== 'string' || !archive.name.startsWith(prefix) ||
          !archive.name.endsWith('.mp4') || !uuid.test(archive.name.slice(prefix.length, -4)) || names.has(archive.name) ||
          !Number.isSafeInteger(archive.size) || archive.size < 0 || archive.size > 1024 ** 3 || !hash.test(archive.sha256)) {
        throw new Error('Invalid recording archive identity.');
      }
      names.add(archive.name);
      const original = await checkedRecordingFile(root, path.resolve(owner, 'recording-originals', archive.name), 1024 ** 3);
      if (original.size !== archive.size || original.sha256 !== archive.sha256) throw new Error('Recording original differs from its snapshot.');
      checkedFiles++;
    }
    const last = resource.archives.at(-1);
    if (last ? resource.archiveName !== last.name || resource.archiveSize !== last.size || resource.archiveSha256 !== last.sha256 :
      resource.archiveName !== null || resource.archiveSize !== null || resource.archiveSha256 !== null) {
      throw new Error('Recording latest archive does not match its history.');
    }
  }
  return { checkedFiles };
}
