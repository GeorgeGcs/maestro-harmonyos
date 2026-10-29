import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateDocument } from '../examples/agent-client/client.mjs';
import { verifyEvidence, confinedFile } from '../examples/agent-client/evidence.mjs';

export const DEFAULT_LIMITS = Object.freeze({ metadataBytes: 4 * 1024 ** 2, fileBytes: 64 * 1024 ** 2,
  totalBytes: 256 * 1024 ** 2, lineBytes: 32 * 1024, files: 2048, lines: 200000, events: 20000, contexts: 128 });
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const PREFIX = 'HARMONYOS_RECORDING_DIAGNOSTIC ';
const BINDING = 'MAESTRO_RECORDING_OUTPUT ';
const STAGES = new Set(('created service processes captures query start ready stop capture_ended export export_scratch export_media stat receive validate archive copy flush delete media_retained media_removed limit_reached resource_failure cleanup_remote cleanup_local cleanup_temp cleanup_resource cleanup close abort truncated').split(' '));
const RESULTS = new Set('begin returned acknowledged observed absent present invalid incomplete failed skipped'.split(' '));
const FIELD_KEYS = new Set(('result stageElapsedMs attempt expectedBytes receivedBytes copiedBytes archiveBytes archiveSha256 archiveMetadataUnavailable count pids pidsTruncated retentionRequested persistent priorFailure cleanupErrors mediaUri uriUnavailable mediaUriPreviouslyObserved errorKind truncated droppedEvents emissionFailures terminal expectedEventCount').split(' '));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
class InputLimitError extends Error {}
const same = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';
const within = (base, file) => { const relative = path.relative(base, file); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function relativeFile(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid relative artifact path.');
  return value;
}
function utc(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function json(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text); // Reject invalid syntax and trailing tokens first.
  // JSON.parse silently replaces duplicate keys. Scan the validated token stream
  // as well, comparing decoded keys so escaped spellings cannot hide duplicates.
  const containers = [];
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '{' || char === '[') {
      containers.push(char === '{' ? new Set() : null);
      requireValue(containers.length <= 64, 'Metadata JSON exceeds the structural limit.');
    } else if (char === '}' || char === ']') containers.pop();
    else if (char === '"') {
      const start = cursor++;
      while (text[cursor] !== '"') { if (text[cursor] === '\\') cursor++; cursor++; }
      let next = cursor + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, cursor + 1)), keys = containers.at(-1);
        requireValue(keys instanceof Set && !keys.has(key), 'Duplicate JSON object key.'); keys.add(key);
      }
    }
  }
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    requireValue(++nodes <= 100000 && depth <= 64, 'Metadata JSON exceeds the structural limit.');
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1]);
    else if (typeof item === 'number') requireValue(Number.isFinite(item), 'Non-finite metadata number.');
  }
  return value;
}
function validError(value) {
  return object(value) && Object.keys(value).every(key => ['kind', 'code', 'message', 'details'].includes(key)) &&
    ['assertion', 'environment', 'unsupported', 'timeout', 'cancelled', 'invalid_input', 'transport', 'internal'].includes(value.kind) &&
    typeof value.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value.code) && typeof value.message === 'string' && value.message.length > 0 &&
    (!Object.hasOwn(value, 'details') || value.details === null || object(value.details));
}
async function noLinks(file) {
  requireValue(path.resolve(file).length <= 32768, 'Absolute path exceeds the limit.');
  for (let item = path.resolve(file); ; item = path.dirname(item)) {
    requireValue(!(await fs.lstat(item)).isSymbolicLink(), 'Linked input/output path is not allowed.');
    if (path.dirname(item) === item) break;
  }
  requireValue(same(realpathSync(file), file), 'Resolved path differs from its declared path.');
}
async function missingBoundOutput(base, file) {
  requireValue(within(base, file), 'Missing output is outside its attempt.');
  await noLinks(base);
  const parts = relativeFile(path.relative(base, file).split(path.sep).join('/')).split('/');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    requireValue(!info.isSymbolicLink() && same(realpathSync(current), current), 'Missing output follows a linked ancestor.');
    if (index < parts.length - 1) requireValue(info.isDirectory(), 'Output ancestor is not a directory.');
  }
  return false;
}
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
async function boundedRead(file, limit) {
  await noLinks(file);
  const before = await fs.stat(file);
  requireValue(before.isFile() && before.size <= limit, 'Input is not a bounded regular file.');
  const handle = await fs.open(file, 'r');
  const parts = []; let size = 0;
  try {
    requireValue(stamp(await handle.stat()) === stamp(before), 'Input changed while opening.');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      size += chunk.length;
      requireValue(size <= limit && size <= before.size, 'Input grew beyond its declared size.');
      parts.push(chunk);
    }
    requireValue(size === before.size && stamp(await handle.stat()) === stamp(before), 'Input changed while reading.');
  } finally { await handle.close(); }
  await noLinks(file);
  requireValue(stamp(await fs.stat(file)) === stamp(before), 'Input changed after reading.');
  const bytes = Buffer.concat(parts, size);
  return { bytes, reference: { path: path.resolve(file), bytes: size, sha256: digest(bytes), sha256After: null }, stamp: stamp(before) };
}

function validEvent(event) {
  requireValue(object(event) && Object.keys(event).every(key => ['schemaVersion', 'recordingId', 'contextId', 'resourceId', 'seq', 'observedAt', 'elapsedMs', 'stage', 'fields'].includes(key)), 'Invalid diagnostic event fields.');
  requireValue(event.schemaVersion === 1 && matches(ID, event.recordingId) && (event.contextId === null || matches(UUID, event.contextId)) &&
    (!Object.hasOwn(event, 'resourceId') || matches(UUID, event.resourceId)) && integer(event.seq) && event.seq > 0 &&
    integer(event.elapsedMs) && utc(event.observedAt) && STAGES.has(event.stage) && object(event.fields), 'Invalid diagnostic event identity.');
  if (Object.hasOwn(event, 'resourceId')) requireValue(event.resourceId.replaceAll('-', '') === event.recordingId, 'Recording ID does not match its durable resource ID.');
  const fields = event.fields;
  requireValue(Object.keys(fields).every(key => FIELD_KEYS.has(key)) && RESULTS.has(fields.result), 'Unknown diagnostic fields or result.');
  for (const key of ['stageElapsedMs', 'attempt', 'expectedBytes', 'receivedBytes', 'copiedBytes', 'archiveBytes', 'count', 'cleanupErrors', 'droppedEvents', 'emissionFailures', 'expectedEventCount']) {
    if (Object.hasOwn(fields, key)) requireValue(integer(fields[key]) && (!['attempt', 'expectedEventCount'].includes(key) || fields[key] > 0), 'Invalid diagnostic number.');
  }
  for (const key of ['pidsTruncated', 'retentionRequested', 'persistent', 'priorFailure', 'archiveMetadataUnavailable', 'uriUnavailable', 'mediaUriPreviouslyObserved', 'truncated', 'terminal']) {
    if (Object.hasOwn(fields, key)) requireValue(typeof fields[key] === 'boolean', 'Invalid diagnostic flag.');
  }
  if (Object.hasOwn(fields, 'pids')) requireValue(Array.isArray(fields.pids) && fields.pids.length <= 8 && fields.pids.every(pid => integer(pid) && pid > 0), 'Invalid observed PID list.');
  if (Object.hasOwn(fields, 'errorKind')) requireValue(['timeout', 'interrupted', 'invalid_mp4', 'io', 'other'].includes(fields.errorKind), 'Invalid diagnostic error kind.');
  if (Object.hasOwn(fields, 'archiveSha256')) requireValue(matches(HASH, fields.archiveSha256), 'Invalid archive observation hash.');
  if (event.stage === 'archive' && fields.result === 'observed') requireValue(fields.archiveMetadataUnavailable === true ||
    (integer(fields.archiveBytes) && matches(HASH, fields.archiveSha256)), 'Archive observation lacks size/hash or an explicit unavailable marker.');
  if (Object.hasOwn(fields, 'mediaUri')) requireValue(typeof fields.mediaUri === 'string' && fields.mediaUri.length <= 512 &&
    new RegExp(`^file://media/Photo/[0-9]+/[A-Za-z0-9_.-]+/maestro-recording-${event.recordingId}\\.mp4$`).test(fields.mediaUri), 'Media URI does not identify this recording.');
  if (fields.terminal === true) requireValue(['close', 'abort'].includes(event.stage) && ['returned', 'failed'].includes(fields.result) &&
    integer(fields.expectedEventCount) && typeof fields.truncated === 'boolean' && integer(fields.droppedEvents) && integer(fields.emissionFailures), 'Invalid terminal diagnostic event.');
}

/** Collect observations from a fixed attempt. This never queries or changes device state. */
export async function collectRecordingDiagnostics({ resultPath, outputDirectory, limits: requestedLimits = {} }) {
  requireValue(typeof resultPath === 'string' && typeof outputDirectory === 'string', 'resultPath and outputDirectory are required.');
  const resultFile = path.resolve(resultPath), output = path.resolve(outputDirectory), base = path.dirname(resultFile);
  requireValue(!same(base, output) && !within(base, output), 'Output must be outside the original attempt.');
  await noLinks(path.dirname(output));
  await fs.mkdir(output); // Exclusive creation: never resume or overwrite an old diagnosis.
  const report = { protocol: 'maestro.harmonyos.recording-diagnostics', schemaVersion: 1, status: 'incomplete',
    startedAt: new Date().toISOString(), finishedAt: null, limits: { ...DEFAULT_LIMITS }, run: null, execution: null,
    sources: { result: null, index: null, manifest: null }, sourceFiles: [], sourcesVerified: false, logs: [],
    recordings: [], foreignContexts: [], issues: [], videoValidation: 'not_performed', resourceHandoff: 'not_assessed' };
  const issues = (code, message, contextId = null, location = {}) => {
    if (report.issues.length < DEFAULT_LIMITS.events) report.issues.push({ code, message, contextId,
      logPath: location.logPath ?? null, line: location.line ?? null });
  };
  const originalFiles = new Map(), snapshotFiles = [], snapshotDirectories = [];
  const temporary = path.join(output, '.verification');
  let snapshotBase;
  async function makeDirectory(directory) {
    requireValue(same(directory, temporary) || within(temporary, directory), 'Unsafe temporary directory.');
    if (snapshotDirectories.includes(directory)) return;
    if (!same(directory, temporary)) await makeDirectory(path.dirname(directory));
    await noLinks(path.dirname(directory)); await fs.mkdir(directory); snapshotDirectories.push(directory);
  }
  async function saveSnapshot(relative, bytes) {
    const target = path.resolve(snapshotBase, relative);
    requireValue(within(temporary, target), 'Snapshot escapes this diagnosis.');
    await makeDirectory(path.dirname(target)); await noLinks(path.dirname(target));
    await fs.writeFile(target, bytes, { flag: 'wx' }); snapshotFiles.push(target);
  }
  try {
    requireValue(object(requestedLimits) && Object.keys(requestedLimits).every(key => Object.hasOwn(DEFAULT_LIMITS, key)), 'Unknown limit override.');
    for (const [key, value] of Object.entries(requestedLimits)) {
      requireValue(Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_LIMITS[key], 'Limits may only be reduced.'); report.limits[key] = value;
    }
    const limit = report.limits;
    let total = 0;
    async function sourceRead(file, sizeLimit) {
      const absolute = path.resolve(file);
      if (originalFiles.has(absolute)) return originalFiles.get(absolute);
      requireValue(originalFiles.size < limit.files, 'Too many referenced files.');
      const read = await boundedRead(absolute, Math.min(sizeLimit, limit.fileBytes, limit.totalBytes - total));
      total += read.reference.bytes; originalFiles.set(absolute, read); return read;
    }
    const resultRead = await sourceRead(resultFile, limit.metadataBytes), result = json(resultRead.bytes);
    report.sources.result = resultRead.reference;
    validateDocument(result, 'runResult', [1]);
    const data = result.data;
    requireValue(matches(UUID, data.runId) && matches(UUID, data.attemptId) && object(data.artifacts) &&
      typeof data.artifacts.baseDir === 'string' && path.isAbsolute(data.artifacts.baseDir) && same(base, data.artifacts.baseDir) &&
      path.basename(resultFile) === 'result.json' && path.basename(base) === data.attemptId &&
      path.basename(path.dirname(base)) === data.runId && path.basename(path.dirname(path.dirname(base))) === 'runs', 'Result path does not identify its declared attempt.');
    report.run = { runId: data.runId, attemptId: data.attemptId, baseDir: base };
    requireValue(['passed', 'failed', 'blocked', 'cancelled', 'unknown'].includes(data.status) && object(data.cleanup) &&
      Object.keys(data.cleanup).sort().join(',') === 'errors,state' && ['not_started', 'in_progress', 'complete', 'failed', 'unknown'].includes(data.cleanup.state) &&
      Array.isArray(data.cleanup.errors) && data.cleanup.errors.length <= limit.events && data.cleanup.errors.every(validError) &&
      (data.cleanup.state !== 'complete' || data.cleanup.errors.length === 0) && (data.cleanup.state !== 'failed' || data.cleanup.errors.length > 0) &&
      (data.error === null || validError(data.error)), 'Execution error/cleanup is missing or invalid.');
    report.execution = { status: data.status, error: data.error, cleanup: data.cleanup };
    const indexRelative = relativeFile(data.artifacts.evidenceIndexPath);
    const indexRead = await sourceRead(path.join(base, indexRelative), limit.metadataBytes), index = json(indexRead.bytes);
    report.sources.index = indexRead.reference;
    validateDocument(index, 'evidenceIndex', [1]);
    requireValue(index.data.runId === data.runId && index.data.attemptId === data.attemptId && Array.isArray(index.data.entries) && index.data.entries.length <= limit.files, 'Evidence index identity or size is invalid.');
    const manifestRead = await sourceRead(path.join(base, 'agent-manifest.json'), limit.metadataBytes), manifest = json(manifestRead.bytes);
    report.sources.manifest = manifestRead.reference;
    requireValue(manifest.schemaVersion === 1 && manifest.runId === data.runId && manifest.attemptId === data.attemptId && Array.isArray(manifest.files) && manifest.files.length <= limit.files, 'Invalid agent metadata manifest.');
    const references = new Map(), manifestPaths = new Set(), videos = new Map(), logs = new Set();
    function add(relative, expected = null) {
      relativeFile(relative); requireValue(expected === null || matches(HASH, expected), 'Invalid artifact hash.');
      const prior = references.get(relative);
      requireValue(!prior || !prior.expected || !expected || prior.expected === expected, 'Conflicting artifact hashes.');
      references.set(relative, { expected: expected ?? prior?.expected ?? null });
      requireValue(references.size <= limit.files, 'Too many referenced files.');
    }
    for (const reference of manifest.files) {
      requireValue(object(reference) && matches(HASH, reference.sha256) &&
        !manifestPaths.has(reference.path) && reference.path !== 'agent-manifest.json', 'Missing hash, duplicate or recursive manifest reference.');
      manifestPaths.add(reference.path); add(reference.path, reference.sha256);
    }
    for (const required of ['result.json', indexRelative, 'input.json']) requireValue(manifestPaths.has(required), 'Manifest omits required metadata hash.');
    add('agent-manifest.json', manifestRead.reference.sha256);
    for (const reference of [data.input, data.flow].filter(value => value !== null)) {
      requireValue(object(reference), 'Missing input/flow reference.'); add(reference.path, reference.sha256);
    }
    requireValue(Array.isArray(data.artifacts.manifestPaths) && data.artifacts.manifestPaths.length <= limit.files && data.artifacts.manifestPaths.includes('agent-manifest.json'), 'Missing metadata manifest declaration.');
    for (const relative of data.artifacts.manifestPaths) { if (relative !== 'agent-manifest.json') requireValue(manifestPaths.has(relative), 'Unhashed manifest reference.'); add(relative); }
    if (data.artifacts.junitPath !== null) { requireValue(manifestPaths.has(data.artifacts.junitPath), 'Unhashed JUnit reference.'); add(data.artifacts.junitPath); }
    let referenceCount = 0;
    for (const entry of index.data.entries) {
      requireValue(Array.isArray(entry.evidence), 'Missing evidence list.');
      for (const item of entry.evidence) {
        requireValue(++referenceCount <= limit.events, 'Too many evidence references.');
        if (item.state === 'available') {
          add(item.path, item.sha256);
          if (item.kind === 'log') logs.add(item.path);
          if (item.kind === 'video') videos.set(item.path, item.sha256);
        } else if (item.kind === 'log') issues('log_unavailable', 'An indexed log is unavailable.');
      }
    }
    snapshotBase = path.join(temporary, 'agent', 'runs', data.runId, data.attemptId);
    for (const [relative, reference] of references) {
      const original = path.resolve(base, relative);
      requireValue(within(base, original), 'Artifact escapes the attempt.');
      const read = await sourceRead(original, limit.fileBytes);
      requireValue(!reference.expected || read.reference.sha256 === reference.expected, 'Artifact hash mismatch: ' + relative);
      await saveSnapshot(relative, read.bytes);
      // Avoid keeping all videos in memory. Snapshot verification uses bounded, private files.
      delete read.bytes;
    }
    const snapshotResult = structuredClone(result); snapshotResult.data.artifacts.baseDir = snapshotBase;
    await verifyEvidence(snapshotResult, index, path.join(temporary, 'agent'));
    report.logs = [...logs].map(relative => originalFiles.get(path.resolve(base, relative)).reference);

    const bindings = new Map(), groups = new Map(); let lines = 0, events = 0;
    for (const relative of logs) {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await confinedFile(snapshotBase, relative));
      for (let offset = 0, position = 0; position < contents.length; offset++) {
        const end = contents.indexOf('\n', position);
        const line = contents.slice(position, end < 0 ? contents.length : end).replace(/\r$/, '');
        position = end < 0 ? contents.length : end + 1;
        requireValue(++lines <= limit.lines, 'Log line count exceeds the limit.');
        requireValue(Buffer.byteLength(line, 'utf8') <= limit.lineBytes, 'Log line exceeds the byte limit.');
        const eventAt = line.indexOf(PREFIX), bindingAt = line.indexOf(BINDING);
        if (eventAt < 0 && bindingAt < 0) continue;
        const source = { logPath: relative, line: offset + 1, payloadSha256: null };
        if (end < 0) { issues('truncated_log_line', 'Diagnostic line has no terminating newline.', null, source); continue; }
        requireValue(++events <= limit.events, 'Diagnostic event count exceeds the limit.');
        try {
          requireValue(eventAt < 0 || bindingAt < 0, 'Multiple diagnostic prefixes in one line.');
          const isBinding = bindingAt >= 0, payload = line.slice((isBinding ? bindingAt : eventAt) + (isBinding ? BINDING.length : PREFIX.length));
          source.payloadSha256 = digest(Buffer.from(payload));
          const value = json(Buffer.from(payload, 'utf8'));
          if (isBinding) {
            requireValue(object(value) && Object.keys(value).sort().join(',') === 'contextId,outputPath,pathAvailable,schemaVersion' && value.schemaVersion === 1 && matches(UUID, value.contextId) &&
              typeof value.pathAvailable === 'boolean' && (value.pathAvailable ? typeof value.outputPath === 'string' && value.outputPath.length <= 4096 && path.isAbsolute(value.outputPath) &&
                !/[\x00-\x1f\x7f]/.test(value.outputPath) && !/(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(value.outputPath) : value.outputPath === null), 'Invalid recording output binding.');
            const list = bindings.get(value.contextId) ?? [];
            const known = list.find(binding => binding.outputPath === value.outputPath && binding.pathAvailable === value.pathAvailable);
            if (known) known.sources.push(source); else list.push({ ...value, sources: [source] });
            bindings.set(value.contextId, list);
          } else {
            validEvent(value);
            const key = `${value.contextId}/${value.recordingId}`;
            const group = groups.get(key) ?? { contextId: value.contextId, recordingId: value.recordingId, eventMap: new Map(), issueCodes: [] };
            const previous = group.eventMap.get(value.seq);
            if (previous) {
              if (previous.payload !== payload) { group.issueCodes.push('event_conflict'); issues('event_conflict', 'Same event identity has different JSON bytes.', value.contextId, source); }
              else previous.event.sources.push(source);
            } else group.eventMap.set(value.seq, { payload, event: { ...value, resourceId: value.resourceId ?? null, sources: [source] } });
            groups.set(key, group);
          }
          if (groups.size > limit.contexts || new Set([...bindings.keys(), ...[...groups.values()].map(group => group.contextId)]).size > limit.contexts) throw new InputLimitError('Context count exceeds the limit.');
        } catch (error) {
          if (error instanceof InputLimitError) throw error;
          issues('invalid_log_record', error.message, null, source);
        }
      }
    }
    const pathContexts = new Map();
    for (const [contextId, values] of bindings) for (const binding of values) if (binding.pathAvailable && within(base, path.resolve(binding.outputPath))) {
      const key = path.resolve(binding.outputPath).toLowerCase();
      const owners = pathContexts.get(key) ?? new Set(); owners.add(contextId); pathContexts.set(key, owners);
    }
    for (const group of groups.values()) {
      const bindingList = bindings.get(group.contextId) ?? [];
      const binding = bindingList.length === 1 ? bindingList[0] : null;
      const ordered = [...group.eventMap.values()].map(item => item.event).sort((a, b) => a.seq - b.seq);
      if (binding?.pathAvailable && !within(base, path.resolve(binding.outputPath))) {
        report.foreignContexts.push({ contextId: group.contextId, recordingId: group.recordingId,
          outputPath: binding.outputPath, reason: 'outside_attempt', eventCount: ordered.length, bindingSources: binding.sources });
        continue;
      }
      const problem = (code, message) => { if (!group.issueCodes.includes(code)) group.issueCodes.push(code); issues(code, message, group.contextId); };
      const resources = [...new Set(ordered.map(event => event.resourceId))];
      if (resources.length !== 1) problem('resource_conflict', 'Resource identity changes within a recording.');
      if ([...groups.values()].filter(other => other.contextId === group.contextId).length !== 1) problem('context_reused', 'One context identifies multiple recordings.');
      if ([...groups.values()].filter(other => other.recordingId === group.recordingId).length !== 1) problem('recording_id_reused', 'One recording identity appears in multiple contexts.');
      if (!binding) problem(bindingList.length ? 'binding_conflict' : 'binding_missing', 'Recording has no unique output binding.');
      else if (!binding.pathAvailable) problem('binding_unavailable', 'Output binding has no available path.');
      if (!ordered.length || ordered[0].stage !== 'created') problem('start_missing', 'Recording creation event is missing.');
      let elapsed = -1;
      for (let index = 0; index < ordered.length; index++) {
        const event = ordered[index];
        if (event.seq !== index + 1) problem('sequence_gap', 'Recording sequence is not contiguous from 1.');
        if (event.elapsedMs < elapsed) problem('elapsed_regressed', 'Monotonic observation elapsed time regressed.');
        elapsed = event.elapsedMs;
        if (event.stage === 'truncated' || event.fields.truncated || event.fields.droppedEvents > 0 || event.fields.emissionFailures > 0) problem('emission_incomplete', 'Producer reports truncation, dropped events or emission failure.');
      }
      const terminals = ordered.filter(event => event.fields.terminal === true), last = ordered.at(-1);
      if (terminals.length !== 1 || terminals[0] !== last || last.fields.expectedEventCount !== ordered.length) problem('terminal_missing_or_conflicting', 'Expected final event/count is missing or inconsistent.');
      const video = { state: 'missing', path: null, bytes: null, sha256: null };
      if (binding?.pathAvailable) {
        const absolute = path.resolve(binding.outputPath), relative = path.relative(base, absolute).split(path.sep).join('/');
        video.path = relativeFile(relative);
        if (pathContexts.get(absolute.toLowerCase())?.size > 1) {
          video.state = 'ambiguous'; problem('output_reused', 'Multiple contexts bind the same output; the current video may overwrite an earlier recording.');
        } else if (videos.has(relative)) {
          const reference = originalFiles.get(absolute)?.reference;
          requireValue(reference && reference.sha256 === videos.get(relative), 'Video reference is not verified.');
          Object.assign(video, { state: 'available', bytes: reference.bytes, sha256: reference.sha256 });
        } else {
          // A failed start deletes its empty output. A complete abort trace can describe that absence.
          const earlyAbort = last?.stage === 'abort' && last.fields.result === 'failed' && !ordered.some(event => ['copy', 'flush'].includes(event.stage) && event.fields.result === 'returned');
          const absent = await missingBoundOutput(base, absolute);
          if (!earlyAbort || !absent) { video.state = 'unindexed'; problem('video_unavailable', 'Bound video is not available in the verified evidence index.'); }
        }
      }
      const matches = (stage, result) => ordered.filter(event => event.stage === stage && event.fields.result === result).map(event => event.seq);
      const attempts = [...new Set(ordered.map(event => event.fields.attempt).filter(value => value !== undefined))].sort((a, b) => a - b).map(attempt => {
        const selected = ordered.filter(event => event.fields.attempt === attempt);
        const observed = (stage, key) => selected.filter(event => event.stage === stage && event.fields.result === 'observed' && event.fields[key] !== undefined).at(-1)?.fields[key] ?? null;
        return { attempt, remoteBeforeBytes: observed('stat', 'expectedBytes'), receivedBytes: observed('receive', 'receivedBytes'),
          remoteAfterBytes: null, remoteAfterObservation: 'not_observed', eventSequences: selected.map(event => event.seq) };
      });
      report.recordings.push({ contextId: group.contextId, recordingId: group.recordingId, resourceId: resources.length === 1 ? resources[0] : null,
        status: group.issueCodes.length ? 'incomplete' : 'complete', video, bindingSources: binding?.sources ?? [], events: ordered,
        archiveObservations: ordered.filter(event => event.stage === 'archive' && event.fields.result === 'observed').map(event => ({
          seq: event.seq, attempt: event.fields.attempt ?? null, bytes: event.fields.archiveBytes ?? null, sha256: event.fields.archiveSha256 ?? null,
          metadataUnavailable: event.fields.archiveMetadataUnavailable === true,
          indexedVideoMatch: video.state === 'available' && event.fields.archiveMetadataUnavailable !== true && event.fields.archiveSha256 !== undefined ?
            video.bytes === event.fields.archiveBytes && video.sha256 === event.fields.archiveSha256 : null,
          archiveFileVerification: 'not_performed',
        })),
        stageDurations: ordered.filter(event => event.fields.stageElapsedMs !== undefined).map(event => ({ seq: event.seq, stage: event.stage,
          result: event.fields.result, elapsedMs: event.fields.stageElapsedMs })), exportAttempts: attempts,
        observations: { captureEnded: matches('capture_ended', 'observed'), structureValidated: matches('validate', 'returned'),
          copyCompleted: matches('copy', 'returned'), flushCompleted: matches('flush', 'returned'),
          mediaRetained: matches('media_retained', 'observed'), mediaRemoved: matches('media_removed', 'observed') }, issueCodes: group.issueCodes });
    }
    for (const [contextId, list] of bindings) if (!groups.size || ![...groups.values()].some(group => group.contextId === contextId)) {
      if (list.some(binding => !binding.pathAvailable || within(base, path.resolve(binding.outputPath)))) issues('events_missing', 'A local output binding has no valid diagnostic events.', contextId);
    }
    if (!report.recordings.length) issues('recordings_missing', 'No recording trace is unambiguously associated with this attempt.');
    report.sourcesVerified = true;
  } catch (error) { issues('input_verification_failed', error.message); }
  finally {
    // Check every original again, even after a partial failure. Never replace the saved initial hash.
    for (const [file, initial] of originalFiles) {
      try {
        const after = await boundedRead(file, Math.min(report.limits.fileBytes, Math.max(initial.reference.bytes, 1)));
        initial.reference.sha256After = after.reference.sha256;
        requireValue(after.stamp === initial.stamp && after.reference.sha256 === initial.reference.sha256, 'Source changed during collection.');
      } catch (error) { report.sourcesVerified = false; issues('source_changed', error.message); }
    }
    report.sourceFiles = [...originalFiles.values()].map(read => read.reference);
    // Only remove individually registered private files and then empty directories, never a recursive tree.
    try {
      for (const file of [...snapshotFiles].reverse()) { requireValue(within(temporary, file), 'Unsafe snapshot cleanup.'); await noLinks(file); await fs.unlink(file); }
      for (const directory of [...snapshotDirectories].reverse()) { requireValue(same(temporary, directory) || within(temporary, directory), 'Unsafe snapshot cleanup.'); await noLinks(directory); await fs.rmdir(directory); }
    } catch (error) { issues('snapshot_cleanup_failed', error.message); }
  }
  report.status = report.sourcesVerified && report.recordings.length > 0 && report.issues.length === 0 ? 'complete' : 'incomplete';
  report.finishedAt = new Date().toISOString();
  await noLinks(output);
  await fs.writeFile(path.join(output, 'recording-diagnostics.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 4 && args[0] === '--result' && args[2] === '--output-directory', 'Usage: node scripts/collect-recording-diagnostics.mjs --result <result.json> --output-directory <new-directory>');
    const report = await collectRecordingDiagnostics({ resultPath: args[1], outputDirectory: args[3] });
    console.log(JSON.stringify({ status: report.status, recordings: report.recordings.length, issues: report.issues.length,
      reportPath: path.resolve(args[3], 'recording-diagnostics.json') }));
    process.exitCode = report.status === 'complete' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
