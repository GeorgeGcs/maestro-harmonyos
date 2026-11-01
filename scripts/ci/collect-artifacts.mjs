import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { noLinks, samePath, inside, requireValue, key } from '../validation/io.mjs';
import { readMetadata } from './snapshot-build.mjs';
import { validateDocument } from '../../examples/agent-client/client.mjs';
import { isDeepStrictEqual } from 'node:util';
import { collectMaintenanceEvidence } from '../recovery/maintenance-archive.mjs';
import { verifyCleanupFenceReceipt } from '../recovery/verify-cleanup-fence.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const uuid = value => typeof value === 'string' && UUID.test(value);
const digest = value => typeof value === 'string' && HASH.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
export const limits = Object.freeze({ files: 4096, fileBytes: 1024 ** 3, totalBytes: 4 * 1024 ** 3, milliseconds: 120000 });

function relativeFile(root, relative) {
  requireValue(typeof relative === 'string' && relative && !/[\\:\x00-\x1f\x7f]/.test(relative) &&
    relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid relative artifact path.');
  const target = path.resolve(root, ...relative.split('/'));
  requireValue(inside(root, target), 'Artifact reference escapes this attempt.');
  return target;
}

/** Read-only collection. It never queries a device, changes a reservation or authorizes release. */
export async function collectArtifacts({ ciDirectory, outputDirectory, stateRecord = null, recoveryStateRecord = null, expectedLaunchId = null, limits: overrides = {} }) {
  requireValue(typeof ciDirectory === 'string' && typeof outputDirectory === 'string', 'Explicit CI and new output directories are required.');
  const source = path.resolve(ciDirectory), output = path.resolve(outputDirectory);
  requireValue(path.basename(source).startsWith('ci-') && uuid(path.basename(source).slice(3)), 'Select one exact ci-UUID invocation directory.');
  requireValue(expectedLaunchId === null || uuid(expectedLaunchId) && path.basename(source) === 'ci-' + expectedLaunchId,
    'Expected launch does not identify the selected CI directory.');
  requireValue(recoveryStateRecord === null || (typeof recoveryStateRecord === 'string' && stateRecord === null && uuid(expectedLaunchId)),
    'Supplemental recovery state requires an explicit launch UUID and cannot replace a hard-stop state.');
  requireValue(!samePath(source, output) && !inside(source, output) && !inside(output, source), 'Output overlaps the CI input directory.');
  requireValue(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'Invalid collector limits.');
  const budget = { ...limits };
  for (const [name, value] of Object.entries(overrides)) {
    requireValue(Object.hasOwn(limits, name) && Number.isSafeInteger(value) && value > 0 && value <= limits[name], 'Limits may only be reduced.');
    budget[name] = value;
  }
  await noLinks(source); await noLinks(output);
  requireValue((await fs.stat(source)).isDirectory(), 'CI input must be a directory.');
  // Reject overlap before creating anything inside a later-discovered input root.
  let declared;
  try { declared = (await readMetadata(path.join(source, 'ci-result.json'))).value; }
  catch (error) {
    if (stateRecord !== null) { requireValue(typeof stateRecord === 'string' && uuid(expectedLaunchId), 'An explicit state record requires the expected launch UUID.'); declared = (await readMetadata(stateRecord)).value; }
  }
  for (const root of [declared?.agentRoot, declared?.recoveryRoot, stateRecord, recoveryStateRecord].filter(value => typeof value === 'string')) {
    requireValue(!samePath(root, output) && !inside(root, output) && !inside(output, root), 'Output overlaps a declared input root.');
  }
  await fs.mkdir(output); // Exclusive creation; existing and interrupted archives are never overwritten.
  const report = { protocol: 'maestro.harmonyos.ci-archive', schemaVersion: 1, status: 'incomplete',
    startedAt: new Date().toISOString(), finishedAt: null, sourceDirectory: source, limits: budget,
    identity: null, originals: { ci: null, preflight: null, control: null, result: null },
    recoveryEvidence: 'not_referenced', files: [], issues: [],
    scope: { executionEvidence: true, buildReplayPackage: false, toolAndApplicationBytes: 'fingerprints_only',
      deviceReleaseAssessment: 'not_performed', upload: 'not_performed' } };
  const started = performance.now(), copied = new Map(), directories = new Set();
  let totalBytes = 0, halted = false;
  function time() { requireValue(performance.now() - started < budget.milliseconds, 'Collection time budget exceeded.'); }
  function issue(code, message, sourcePath = null) {
    if (report.issues.length < budget.files + 32) report.issues.push({ code, message, sourcePath });
  }
  function overlap(root) {
    requireValue(!samePath(root, output) && !inside(root, output) && !inside(output, root), 'Output overlaps an input tree.');
  }
  async function stat(file) {
    time(); await noLinks(file);
    const info = await fs.lstat(file);
    requireValue(!info.isSymbolicLink(), 'Linked input is not permitted.');
    return info;
  }
  async function fileHash(file) {
    const info = await stat(file);
    requireValue(info.isFile() && info.size <= budget.fileBytes, 'Expected a bounded regular file.');
    const handle = await fs.open(file, 'r'), hasher = createHash('sha256');
    let bytes = 0;
    try {
      const buffer = Buffer.alloc(256 * 1024);
      while (true) {
        time(); const read = await handle.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead; requireValue(bytes <= budget.fileBytes, 'File grew beyond the size limit.');
        hasher.update(buffer.subarray(0, read.bytesRead));
      }
    } finally { await handle.close(); }
    const after = await stat(file);
    requireValue(bytes === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ino === info.ino,
      'File changed while being read.');
    return { sha256: hasher.digest('hex'), bytes };
  }
  async function copy(sourcePath, relative) {
    const absolute = path.resolve(sourcePath);
    if (copied.has(key(absolute))) return copied.get(key(absolute));
    if (halted || report.files.length >= budget.files) {
      halted = true; issue('copy_budget_exhausted', 'No more files can be collected within the budget.', absolute);
      return { status: 'incomplete', bytes: null };
    }
    const destination = relativeFile(output, relative);
    const entry = { source: absolute, path: relative, status: 'incomplete', bytes: null,
      sourceSha256Before: null, copySha256: null, sourceSha256After: null, expectedSha256: null, error: null };
    report.files.push(entry); copied.set(key(absolute), entry);
    try {
      time(); requireValue(report.files.length <= budget.files, 'File count limit exceeded.');
      const before = await fileHash(absolute);
      requireValue(totalBytes + before.bytes <= budget.totalBytes, 'Total byte limit exceeded.');
      entry.bytes = before.bytes; entry.sourceSha256Before = before.sha256; totalBytes += before.bytes;
      await noLinks(path.dirname(destination)); await fs.mkdir(path.dirname(destination), { recursive: true });
      const input = await fs.open(absolute, 'r'); let target;
      try {
        target = await fs.open(destination, 'wx');
        const buffer = Buffer.alloc(256 * 1024); let bytes = 0;
        while (true) {
          time(); const read = await input.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          bytes += read.bytesRead; requireValue(bytes <= before.bytes, 'Input grew during copy.');
          let written = 0;
          while (written < read.bytesRead) {
            time(); const next = await target.write(buffer, written, read.bytesRead - written, null);
            requireValue(next.bytesWritten > 0, 'Copy made no progress.'); written += next.bytesWritten;
          }
        }
        requireValue(bytes === before.bytes, 'Input shortened during copy.'); await target.sync();
      } finally { await input.close(); await target?.close(); }
      entry.copySha256 = (await fileHash(destination)).sha256;
      entry.sourceSha256After = (await fileHash(absolute)).sha256;
      requireValue(entry.sourceSha256Before === entry.copySha256 && entry.copySha256 === entry.sourceSha256After, 'Source or copied bytes changed.');
      entry.status = 'copied';
    } catch (error) {
      entry.error = error.message; issue('file_not_collected', error.message, absolute);
      if (/limit exceeded|budget exceeded/.test(error.message)) halted = true;
    }
    return entry;
  }
  async function tree(root, prefix) {
    overlap(root);
    async function visit(directory, relative, depth) {
      time(); requireValue(depth <= 64, 'Directory depth limit exceeded.');
      requireValue((await stat(directory)).isDirectory(), 'Expected an input directory.');
      directories.add(key(directory));
      requireValue(directories.size <= budget.files, 'Directory count limit exceeded.');
      let count = 0;
      for await (const itemInfo of await fs.opendir(directory)) {
        if (halted) return;
        requireValue(++count <= budget.files, 'Directory entry limit exceeded.');
        const name = itemInfo.name;
        const item = path.join(directory, name), target = relative + '/' + name;
        try {
          const info = await stat(item);
          if (info.isDirectory()) await visit(item, target, depth + 1);
          else if (info.isFile()) await copy(item, target);
          else throw new Error('Only regular files and directories may be collected.');
        } catch (error) { issue('tree_entry_rejected', error.message, item); }
      }
    }
    await visit(root, prefix, 0);
  }
  async function metadata(file, expected = null) {
    const entry = copied.get(key(file));
    requireValue(entry?.status === 'copied', 'Required metadata was not collected: ' + file);
    if (expected !== null) {
      requireValue(digest(expected), 'Invalid expected metadata hash.'); entry.expectedSha256 = expected;
      requireValue(entry.copySha256 === expected, 'Metadata hash differs: ' + file);
    }
    time(); const read = await readMetadata(relativeFile(output, entry.path));
    requireValue(read.sha256 === entry.copySha256, 'Archived metadata changed.');
    return read.value;
  }
  function reference(base, item) {
    requireValue(item && digest(item.sha256), 'Reference has no valid SHA-256.');
    const absolute = relativeFile(base, item.path), entry = copied.get(key(absolute));
    requireValue(entry?.status === 'copied', 'Referenced evidence is missing: ' + item.path);
    requireValue(entry.expectedSha256 === null || entry.expectedSha256 === item.sha256, 'Conflicting reference hashes.');
    entry.expectedSha256 = item.sha256;
    requireValue(entry.copySha256 === item.sha256, 'Evidence hash differs: ' + item.path);
    return absolute;
  }
  async function evidence(record, attempt, result) {
    validateDocument(result, 'runResult', [1]); const data = result.data;
    requireValue(data.runId === record.runId && data.attemptId === record.attemptId && data.deviceId === record.deviceId &&
      samePath(data.artifacts.baseDir, attempt), 'Result belongs to another attempt.');
    report.originals.result = data;
    requireValue(['passed', 'failed', 'blocked', 'cancelled'].includes(data.status), 'No terminal native result was obtained.');
    requireValue(!['passed', 'failed'].includes(data.status) || typeof data.artifacts.junitPath === 'string', 'Native JUnit is missing.');
    const indexPath = relativeFile(attempt, data.artifacts.evidenceIndexPath), index = await metadata(indexPath);
    validateDocument(index, 'evidenceIndex', [1]);
    requireValue(index.data.runId === record.runId && index.data.attemptId === record.attemptId, 'Evidence index belongs to another attempt.');
    const manifest = await metadata(path.join(attempt, 'agent-manifest.json'));
    requireValue(manifest.schemaVersion === 1 && manifest.runId === record.runId && manifest.attemptId === record.attemptId &&
      Array.isArray(manifest.files) && manifest.files.length <= budget.files, 'Invalid agent metadata manifest.');
    const required = new Set(['input.json', 'result.json', 'state.json', 'registration.json', data.artifacts.evidenceIndexPath,
      ...data.artifacts.manifestPaths.filter(p => p !== 'agent-manifest.json'), ...(data.artifacts.junitPath ? [data.artifacts.junitPath] : []),
      ...(data.flow ? [data.flow.path] : [])]);
    requireValue(data.artifacts.manifestPaths.filter(p => p === 'agent-manifest.json').length === 1, 'Agent manifest must be declared once.');
    const seen = new Set();
    for (const item of manifest.files) {
      requireValue(item.path !== 'agent-manifest.json' && !seen.has(item.path), 'Recursive or duplicate metadata reference.');
      seen.add(item.path); reference(attempt, item); required.delete(item.path);
    }
    requireValue(required.size === 0, 'Agent manifest omits required metadata.');
    for (const relative of data.artifacts.manifestPaths.filter(p => p !== 'agent-manifest.json')) {
      const file = relativeFile(attempt, relative), flowManifest = await metadata(file);
      requireValue(Array.isArray(flowManifest.entries) && flowManifest.entries.length <= budget.files, 'Invalid Flow artifact manifest.');
      for (const item of flowManifest.entries) {
        const target = relativeFile(path.dirname(file), item.relativePath), entry = copied.get(key(target));
        requireValue(entry?.status === 'copied' || directories.has(key(target)), 'Flow manifest artifact was not collected.');
        if (item.sizeBytes !== undefined) requireValue(Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 &&
          entry?.bytes === item.sizeBytes, 'Flow manifest size differs from collected bytes.');
      }
    }
    reference(attempt, data.input); if (data.flow) reference(attempt, data.flow);
    const steps = new Set();
    for (const step of index.data.entries) {
      if (step.stepId !== null) { requireValue(uuid(step.stepId) && !steps.has(step.stepId), 'Duplicate or invalid evidence step.'); steps.add(step.stepId); }
      if (step.source != null) {
        requireValue(typeof step.source.flow === 'string', 'Invalid step source reference.');
        const match = /^sources\/([0-9a-f]{64})\.yaml$/.exec(step.source.flow);
        requireValue(match !== null, 'Step source is not a registered content-addressed snapshot.');
        reference(attempt, { path: step.source.flow, sha256: match[1] });
      }
      for (const item of step.evidence) {
        if (item.state === 'available') reference(attempt, item);
        else {
          requireValue(['missing', 'capture_failed'].includes(item.state) && item.path === null && item.sha256 === null, 'Invalid unavailable evidence.');
          issue('unavailable_evidence', 'Native evidence was ' + item.state);
        }
      }
    }
    requireValue(data.failedStepId === null || steps.has(data.failedStepId), 'Failed step is absent from the index.');
  }
  async function videoEvidence(quality, record, attempt, inputs) {
    const declaredVideo = quality.video;
    if (!declaredVideo?.path) {
      requireValue(declaredVideo?.status !== 'passed', 'Passed video quality has no retained report.');
      return;
    }
    async function ciReference(item) {
      requireValue(typeof item?.path === 'string' && path.isAbsolute(item.path) && inside(source, item.path) && digest(item.sha256),
        'Video metadata reference escapes this CI invocation or lacks a hash.');
      return metadata(item.path, item.sha256);
    }
    const videos = await ciReference(declaredVideo);
    requireValue(videos.protocol === 'maestro.harmonyos.ci-videos' && videos.schemaVersion === 1 &&
      videos.runId === record.runId && videos.attemptId === record.attemptId && videos.status === declaredVideo.status &&
      Array.isArray(videos.videos) && videos.videos.length <= budget.files && Array.isArray(videos.originalFiles) &&
      videos.originalFiles.length <= budget.files, 'Video report belongs to another attempt or is malformed.');
    for (const observed of videos.originalFiles) {
      try {
        requireValue(typeof observed.path === 'string' && path.isAbsolute(observed.path) && digest(observed.sha256), 'Invalid video observation reference.');
        if (inside(source, observed.path) || inside(attempt, observed.path)) {
          const root = inside(source, observed.path) ? source : attempt;
          reference(root, { path: path.relative(root, observed.path).split(path.sep).join('/'), sha256: observed.sha256 });
        } else {
          requireValue(inputs?.toolFiles?.some(tool => samePath(tool.path, observed.path) && tool.sha256 === observed.sha256),
            'External video observation is not a frozen tool fingerprint.');
        }
      } catch (error) { issue('video_observation_not_collected', error.message, observed?.path ?? null); }
    }
    for (const video of videos.videos) {
      try {
        const original = reference(attempt, { path: video.path, sha256: video.sha256 });
        requireValue(samePath(original, video.sourcePath), 'Video input belongs to another attempt.');
        if (video.process) {
          for (const name of ['stdout', 'stderr']) {
            const log = video.process[name];
            requireValue(typeof log?.path === 'string' && path.isAbsolute(log.path) && inside(source, log.path) && digest(log.sha256),
              'Video verifier process log has no exact CI reference.');
            reference(source, { path: path.relative(source, log.path).split(path.sep).join('/'), sha256: log.sha256 });
          }
        }
        if (!video.pointer && !video.verification) {
          requireValue(video.status !== 'passed', 'Passed video has no pointer or verification report.');
          continue;
        }
        const pointer = await ciReference(video.pointer);
        requireValue(pointer.protocol === 'maestro.harmonyos.recording-report-pointer' && pointer.schemaVersion === 1 &&
          typeof pointer.reportPath === 'string' && digest(pointer.reportSha256) &&
          samePath(pointer.reportPath, video.verification?.path) && pointer.reportSha256 === video.verification?.sha256,
          'Video pointer and verification reference differ.');
        const decoded = await ciReference(video.verification);
        requireValue(decoded.protocol === 'maestro.harmonyos.recording-verification' && decoded.schemaVersion === 1 &&
          samePath(decoded.inputPath, original) && decoded.inputSha256 === video.sha256,
          'Decoded input differs from the collected original.');
        for (const name of ['stdout', 'stderr']) {
          const log = relativeFile(path.dirname(pointer.reportPath), decoded[name]);
          const observation = videos.originalFiles.find(item => samePath(item.path, log));
          requireValue(observation && digest(observation.sha256), 'Decode log lacks a retained hash observation.');
          reference(source, { path: path.relative(source, log).split(path.sep).join('/'), sha256: observation.sha256 });
        }
      } catch (error) { issue('video_evidence_not_collected', error.message, video?.path ?? null); }
    }
  }
  async function recovery(record, resolved = record.resolution) {
    const result = report.originals.result;
    const errors = [result?.error, ...(Array.isArray(result?.cleanup?.errors) ? result.cleanup.errors : [])].filter(Boolean);
    const requiredOwners = errors.filter(error => error.code === 'DEVICE_RECOVERY_REQUIRED').map(error => error.details?.recoverySessionId);
    if (requiredOwners.some(owner => !uuid(owner))) issue('recovery_owner_unresolved', 'Native recovery requirement has no valid explicit owner.');
    const boundOwner = typeof resolved?.reportPath === 'string' && digest(resolved.reportSha256) && uuid(resolved.sessionId) ? resolved.sessionId : null;
    const unresolved = requiredOwners.filter(owner => uuid(owner) && owner !== boundOwner);
    if (unresolved.length) {
      report.recoveryEvidence = 'owner_referenced_not_collected';
      issue('uncollected_recovery_owner', 'Native errors identify a recovery owner, but no bound receipt was supplied. Its journal/originals were not collected; an explicit receipt is needed.');
    }
    if (!resolved?.reportPath) return;
    requireValue(uuid(resolved.sessionId) && digest(resolved.reportSha256), 'Invalid recovery reference.');
    const owner = path.resolve(record.recoveryRoot, hash(record.deviceId), resolved.sessionId);
    overlap(owner);
    if (resolved.deviceGateVersion === 3) {
      requireValue(Array.isArray(resolved.retainedFences) && resolved.retainedFences.length > 0 && resolved.retainedFences.length <= 8,
        'A later session omitted its retained fence inventory.');
      for (const retained of resolved.retainedFences) {
        const closure = await verifyCleanupFenceReceipt({ deviceId: record.deviceId, recoveryRoot: record.recoveryRoot, retained });
        const priorOwner = path.resolve(record.recoveryRoot, hash(record.deviceId), retained.ownerId);
        for (const entry of closure.records) {
          const relative = path.relative(priorOwner, entry.path);
          requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Retained fence evidence escaped its owner.');
          overlap(entry.path); await copy(entry.path, `recovery/retained/${retained.ownerId}/` + relative.replaceAll('\\', '/'));
          await metadata(entry.path, entry.sha256);
        }
      }
      report.retainedFenceEvidence = 'receipt_and_chain';
    }
    if (resolved.recoveryKind === 'cleanup_fence') {
      requireValue(resolved.cleanupFenceId === resolved.retained?.recoveryId && resolved.retained?.ownerId === resolved.sessionId &&
        uuid(resolved.cleanupFenceId) && digest(resolved.retained?.receipt?.sha256) &&
        samePath(resolved.reportPath, path.join(owner, 'cleanup-fence', resolved.cleanupFenceId, resolved.retained.receipt.path)) &&
        resolved.reportSha256 === resolved.retained.receipt.sha256, 'Invalid retained fence recovery reference.');
      const closure = await verifyCleanupFenceReceipt({ deviceId: record.deviceId, recoveryRoot: record.recoveryRoot, retained: resolved.retained });
      for (const entry of closure.records) {
        const relative = path.relative(owner, entry.path);
        requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Fence evidence escaped its owner.');
        overlap(entry.path); await copy(entry.path, 'recovery/fence/' + relative.replaceAll('\\', '/'));
        await metadata(entry.path, entry.sha256);
      }
      requireValue(typeof resolved.recoveryResponsePath === 'string' && digest(resolved.recoveryResponseSha256), 'Missing saved fence recovery response.');
      overlap(resolved.recoveryResponsePath); await copy(resolved.recoveryResponsePath, 'recovery/fence-response.json');
      const response = await metadata(resolved.recoveryResponsePath, resolved.recoveryResponseSha256);
      requireValue(response.protocol === 'maestro.harmonyos.cleanup-fence-recovery' && response.schemaVersion === 1 &&
        response.deviceId === record.deviceId && response.sessionId === resolved.sessionId && response.recoveryId === resolved.cleanupFenceId &&
        response.handoffReady === true && response.state === 'isolated' && response.originalResult === 'unknown' &&
        samePath(response.receipt?.path, resolved.reportPath) && response.receipt.sha256 === resolved.reportSha256,
      'Fence response differs from its archived receipt.');
      if (unresolved.length === 0) report.recoveryEvidence = 'cleanup_fence_receipt_and_chain';
      return;
    }
    requireValue(samePath(path.dirname(resolved.reportPath), path.join(owner, 'recoveries')), 'Receipt is outside its exact owner.');
    const recoveryId = path.basename(resolved.reportPath, '.json');
    requireValue(uuid(recoveryId) && path.basename(resolved.reportPath) === recoveryId + '.json', 'Invalid recovery receipt name.');
    await copy(resolved.reportPath, 'recovery/receipt.json');
    const receipt = await metadata(resolved.reportPath, resolved.reportSha256);
    requireValue([1, 2, 3].includes(receipt.schemaVersion) && receipt.deviceId === record.deviceId && receipt.sessionId === resolved.sessionId &&
      receipt.recoveryId === recoveryId, 'Receipt belongs to another device or owner.');
    report.recoveryEvidence = 'receipt';
    if (receipt.schemaVersion === 3) {
      const closure = await collectMaintenanceEvidence({ receipt, resolution: resolved, ownerDirectory: owner, deviceId: record.deviceId,
        issue, read: async (file, relative, expected) => {
          overlap(file); await copy(file, relative); return metadata(file, expected);
        } });
      if (closure.complete && unresolved.length === 0) report.recoveryEvidence = 'maintenance_receipt_and_chain';
      return;
    }
    if (receipt.schemaVersion === 1) { requireValue(!('recordingResources' in receipt), 'Unexpected v1 recording resources.'); return; }
    const resource = receipt.recordingResources, snapshotPath = path.join(owner, 'recoveries', recoveryId + '-recordings.json');
    requireValue(resource && samePath(resource.path, snapshotPath) && digest(resource.sha256), 'Invalid recording snapshot reference.');
    await copy(snapshotPath, 'recovery/recordings.json');
    const snapshot = await metadata(snapshotPath, resource.sha256);
    requireValue(snapshot.schemaVersion === 1 && snapshot.deviceId === record.deviceId && snapshot.ownerId === resolved.sessionId &&
      uuid(snapshot.generation) && snapshot.remoteRoot === '/data/local/tmp/maestro-session-' + snapshot.generation && Array.isArray(snapshot.resources) &&
      snapshot.resources.length <= budget.files,
    'Recording snapshot belongs to another owner.');
    const ids = new Set();
    for (const recording of snapshot.resources) {
      try {
        time(); requireValue(uuid(recording.id) && !ids.has(recording.id) && recording.fileName === 'maestro-recording-' + recording.id.replaceAll('-', '') + '.mp4' &&
          Array.isArray(recording.archives) && recording.archives.length <= budget.files, 'Invalid recording resource identity.'); ids.add(recording.id);
        const names = new Set();
        for (const original of recording.archives) {
          try {
            time(); const prefix = recording.id + '-';
            requireValue(typeof original.name === 'string' && original.name.startsWith(prefix) && original.name.endsWith('.mp4') &&
              uuid(original.name.slice(prefix.length, -4)) && !names.has(original.name) && digest(original.sha256) &&
              Number.isSafeInteger(original.size) && original.size >= 0 && original.size <= budget.fileBytes, 'Invalid owned recording original.');
            names.add(original.name);
            const file = path.join(owner, 'recording-originals', original.name), entry = await copy(file, 'recovery/originals/' + original.name);
            reference(path.join(owner, 'recording-originals'), { path: original.name, sha256: original.sha256 });
            requireValue(entry.bytes === original.size, 'Recording original size differs.');
          } catch (error) { issue('recording_original_not_verified', error.message); }
        }
      } catch (error) { issue('recording_resource_not_verified', error.message); }
    }
    if (unresolved.length === 0) report.recoveryEvidence = 'receipt_snapshot_originals';
  }
  try {
    // Capture the selected CI tree even when a malformed record prevents following external references.
    await tree(source, 'ci');
    const ciResult = path.join(source, 'ci-result.json');
    let record;
    if (copied.has(key(ciResult))) {
      requireValue(stateRecord === null, 'Do not override an existing CI result with a different state record.');
      record = await metadata(ciResult);
    } else if (stateRecord !== null) {
      requireValue(typeof stateRecord === 'string' && uuid(expectedLaunchId), 'Hard-stop collection requires an explicit state record and expected launch UUID.');
      overlap(path.resolve(stateRecord)); await copy(stateRecord, 'control/ci-state.json'); record = await metadata(path.resolve(stateRecord));
    } else {
      const preflight = await metadata(path.join(source, 'ci-preflight.json'));
      requireValue(preflight.status === 'blocked' && preflight.dispatched === false, 'No matching CI result, explicit retained state, or blocked preflight.');
      report.originals.preflight = preflight;
    }
    requireValue(recoveryStateRecord === null || copied.has(key(ciResult)), 'Supplemental recovery requires an existing CI result.');
    if (record) {
      requireValue(record.protocol === 'maestro.harmonyos.ci-device' && record.schemaVersion === 1 && record.kind === 'single' &&
        uuid(record.launchId) && uuid(record.runId) && uuid(record.attemptId) && typeof record.deviceId === 'string' && record.deviceId &&
        samePath(record.artifactDirectory, source) && path.basename(source) === 'ci-' + record.launchId &&
        (expectedLaunchId === null || expectedLaunchId === record.launchId), 'CI record or expected launch identity differs.');
      requireValue(typeof record.agentRoot === 'string' && path.isAbsolute(record.agentRoot) && typeof record.recoveryRoot === 'string' &&
        path.isAbsolute(record.recoveryRoot), 'Invalid declared evidence roots.');
      report.identity = { launchId: record.launchId, runId: record.runId, attemptId: record.attemptId };
      report.originals.ci = record;
      const attempt = path.resolve(record.agentRoot, 'runs', record.runId, record.attemptId);
      overlap(attempt); overlap(record.recoveryRoot);
      const controlPath = path.resolve(path.dirname(record.agentRoot), 'launches', record.launchId + '.json');
      requireValue(samePath(record.controlRecordPath, controlPath), 'Control path is not the exact retained launch.');
      await copy(controlPath, 'control/runner.json');
      let control;
      try {
        control = await metadata(controlPath, record.resolution?.controlSha256 ?? null);
        requireValue(control.protocol === 'maestro.harmonyos.runner-control' && control.schemaVersion === 1 && control.runId === record.runId &&
          control.attemptId === record.attemptId && control.deviceId === record.deviceId &&
          samePath(control.runResultPath, path.join(attempt, 'result.json')) && inside(source, control.artifactDirectory), 'Control identifies another invocation.');
        for (const [field, filename] of [['invocationPath', 'invocation.json'], ['stdoutPath', 'stdout.log'], ['stderrPath', 'stderr.log']]) {
          requireValue(samePath(control[field], path.join(control.artifactDirectory, filename)), 'Invalid control output reference.');
          requireValue(copied.get(key(control[field]))?.status === 'copied', 'Control output is missing: ' + filename);
        }
        const invocation = await metadata(control.invocationPath);
        requireValue(invocation.runId === record.runId && invocation.attemptId === record.attemptId &&
          samePath(invocation.runResultPath, control.runResultPath), 'Invocation identifies another attempt.');
        report.originals.control = control;
        if (control.stdoutComplete !== true || control.stderrComplete !== true || control.processExitObserved !== true)
          issue('unfinished_runner', 'Runner termination or output completion was not observed.');
      } catch (error) { issue('control_verification_failed', error.message, controlPath); }
      try { await tree(attempt, 'attempt'); } catch (error) { issue('attempt_not_collected', error.message, attempt); }
      try {
        const result = await metadata(path.join(attempt, 'result.json'), record.resolution?.resultSha256 ?? null);
        await evidence(record, attempt, result);
      } catch (error) { issue('evidence_verification_failed', error.message, attempt); }
      let inputs = null;
      for (const [name, item] of [['inputs', record.inputs], ['quality', record.quality]]) {
        if (item?.path) {
          try {
            requireValue(inside(source, item.path) && digest(item.sha256), 'CI metadata reference escapes this invocation or lacks a hash.');
            const value = await metadata(item.path, item.sha256);
            if (name === 'inputs') inputs = value;
            else await videoEvidence(value, record, attempt, inputs);
          }
          catch (error) { issue(name + '_verification_failed', error.message, item.path); }
        } else if (name === 'inputs') issue('inputs_missing', 'The fixed input snapshot is missing.');
      }
      let resolution = record.resolution;
      if (recoveryStateRecord !== null) {
        try {
          requireValue(copied.has(key(ciResult)), 'Supplemental recovery requires an existing immutable CI result.');
          await copy(recoveryStateRecord, 'control/recovery-state.json');
          const recovered = await metadata(recoveryStateRecord);
          const originalFields = value => Object.fromEntries(Object.entries(value).filter(([name]) => !['state', 'updatedAt', 'resolution'].includes(name)));
          requireValue(record.state !== 'released' && recovered.state === 'released' && recovered.resolution?.mode === 'recovery' &&
            recovered.resolution?.releaseConfirmed === true && isDeepStrictEqual(originalFields(record), originalFields(recovered)),
          'Supplemental recovery state changed the original CI invocation or execution.');
          report.originals.recoveryState = recovered;
          resolution = recovered.resolution;
        } catch (error) { issue('supplemental_recovery_rejected', error.message, recoveryStateRecord); }
      }
      try { await recovery(record, resolution); } catch (error) { issue('recovery_verification_failed', error.message); }
    }
  } catch (error) { issue('collection_failed', error.message); }
  // Recheck all inputs after the closure is collected, not merely after each copy.
  for (const entry of report.files) {
    if (entry.status !== 'copied') continue;
    try {
      const final = await fileHash(entry.source), target = await fileHash(relativeFile(output, entry.path));
      requireValue(final.sha256 === entry.copySha256 && target.sha256 === entry.copySha256, 'Source or archive changed before finalization.');
      entry.sourceSha256After = final.sha256;
    } catch (error) { entry.status = 'incomplete'; entry.error = error.message; issue('final_hash_check_failed', error.message, entry.source); }
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.issues.length === 0 ? 'complete' : 'incomplete';
  await noLinks(output);
  await fs.writeFile(path.join(output, 'archive-manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {}, names = { '--ci-directory': 'ciDirectory', '--output-directory': 'outputDirectory',
      '--state-record': 'stateRecord', '--recovery-state-record': 'recoveryStateRecord', '--expected-launch-id': 'expectedLaunchId' };
    for (let i = 2; i < process.argv.length; i += 2) {
      const field = names[process.argv[i]];
      requireValue(field && typeof process.argv[i + 1] === 'string' && !Object.hasOwn(options, field), 'Use explicit, unique collector flags and values.');
      options[field] = process.argv[i + 1];
    }
    const report = await collectArtifacts(options);
    process.stdout.write(JSON.stringify({ status: report.status, files: report.files.length, issues: report.issues.length,
      manifest: path.resolve(options.outputDirectory, 'archive-manifest.json') }) + '\n');
    if (report.status !== 'complete') process.exitCode = 1;
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
