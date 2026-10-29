import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectRecordingDiagnostics } from '../collect-recording-diagnostics.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = path.join(projectRoot, 'artifacts', 'recording-diagnostics-tests');
const stamp = '2026-10-30T01:02:03.000Z';
const eventPrefix = 'HARMONYOS_RECORDING_DIAGNOSTIC ';
const bindingPrefix = 'MAESTRO_RECORDING_OUTPUT ';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = async file => sha256(await fs.readFile(file));
const envelope = (kind, data) => ({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1,
  kind, revision: 1, observedAt: stamp, data });
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

// Retain fixtures for inspection. No recursive deletion or symlink traversal is needed.
async function newFixtureDirectory() {
  const absolute = path.resolve(fixtureRoot);
  for (let current = absolute; ; current = path.dirname(current)) {
    try { assert.equal((await fs.lstat(current)).isSymbolicLink(), false, `Fixture ancestor is a link: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
  await fs.mkdir(absolute, { recursive: true });
  return fs.mkdtemp(path.join(absolute, 'case-'));
}

function recording(baseDir, ordinal = 0) {
  const contextId = randomUUID(), resourceId = randomUUID(), recordingId = resourceId.replaceAll('-', '');
  const relative = `flows/recording/video-${ordinal}.mp4`, outputPath = path.join(baseDir, relative);
  // These are hash fixtures, not claims that a video has passed a decoder.
  const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisomfixture-recording-' + ordinal)]);
  const binding = { schemaVersion: 1, contextId, outputPath, pathAvailable: true };
  const mediaUri = `file://media/Photo/123/VID_123/maestro-recording-${recordingId}.mp4`;
  const stages = [
    ['created', { result: 'observed', persistent: true }],
    ['start', { result: 'acknowledged' }],
    ['query', { result: 'present', mediaUri, uriUnavailable: false, mediaUriPreviouslyObserved: false }],
    ['receive', { result: 'returned', receivedBytes: videoBytes.length }],
    ['flush', { result: 'returned' }],
    ['close', { result: 'returned', terminal: true, expectedEventCount: 6,
      truncated: false, droppedEvents: 0, emissionFailures: 0 }],
  ];
  const events = stages.map(([stage, fields], index) => ({ schemaVersion: 1, recordingId, contextId, resourceId,
    seq: index + 1, observedAt: stamp, elapsedMs: index * 10, stage, fields }));
  return { contextId, recordingId, resourceId, binding, events, relative, outputPath, videoBytes };
}

function logText(bindings, events, name = 'fixture') {
  const prefix = `01:02:03.000 [main] INFO ${name} - `;
  return ['ordinary log line', ...bindings.map(value => prefix + bindingPrefix + JSON.stringify(value)),
    ...events.map(value => prefix + eventPrefix + JSON.stringify(value))].join('\n') + '\n';
}

async function manifest(fixture, extra = []) {
  const files = await Promise.all(fixture.manifestFiles.map(async relative => ({ path: relative,
    sha256: await digest(path.join(fixture.baseDir, relative)) })));
  await writeJson(path.join(fixture.baseDir, 'agent-manifest.json'), {
    schemaVersion: 1, runId: fixture.runId, attemptId: fixture.attemptId, files: [...files, ...extra],
  });
}

async function makeFixture({ duplicateLogs = false, count = 1, edit } = {}) {
  const root = await newFixtureDirectory(), runId = randomUUID(), attemptId = randomUUID();
  const baseDir = path.join(root, 'agent', 'runs', runId, attemptId);
  await fs.mkdir(baseDir, { recursive: true });
  const resultPath = path.join(baseDir, 'result.json');
  const recordings = Array.from({ length: count }, (_, ordinal) => recording(baseDir, ordinal));
  const fixture = { root, baseDir, resultPath, runId, attemptId, recordings,
    bindings: recordings.map(value => value.binding), events: recordings.flatMap(value => value.events),
    videos: recordings.map(value => ({ relative: value.relative, bytes: value.videoBytes })),
    logNames: ['flows/recording/logs/maestro.log', ...(duplicateLogs ? ['flows/second/logs/maestro.log'] : [])],
    status: 'passed', error: null, cleanup: { state: 'complete', errors: [] } };
  await edit?.(fixture);
  const flow = 'appId: org.example.fixture\n---\n- startRecording: fixture\n- stopRecording\n';
  await fs.writeFile(path.join(baseDir, 'flow.yaml'), flow);
  await writeJson(path.join(baseDir, 'input.json'), { kind: 'flow', deviceId: 'fixture-device', request: {
    configuration: { ability: 'EntryAbility', module: null, environment: { APP_ID: 'org.example.fixture' } },
    sources: [{ path: path.join(baseDir, 'flow.yaml'), files: [{ path: path.join(baseDir, 'flow.yaml'),
      content: flow, sha256: sha256(flow), dependencies: [] }] }],
  } });
  const evidence = [];
  for (const [index, relative] of fixture.logNames.entries()) {
    const file = path.join(baseDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, logText(fixture.bindings, fixture.events, `fixture-${index}`));
    evidence.push({ kind: 'log', state: 'available', path: relative, sha256: await digest(file),
      capturedAt: stamp, phase: 'after', error: null });
  }
  for (const { relative, bytes } of fixture.videos) {
    const file = path.join(baseDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    evidence.push({ kind: 'video', state: 'available', path: relative, sha256: await digest(file),
      capturedAt: stamp, phase: 'after', error: null });
  }
  const data = { runId, attemptId, attemptNo: 1, deviceId: 'fixture-device', sessionId: null,
    input: { kind: 'flow', path: 'input.json', sha256: await digest(path.join(baseDir, 'input.json')) },
    flow: { path: 'flow.yaml', sha256: sha256(flow) }, status: fixture.status, startedAt: stamp, endedAt: stamp,
    effects: 'possible', error: fixture.error, failedStepId: null, cleanup: fixture.cleanup,
    artifacts: { baseDir, evidenceIndexPath: 'evidence-index.json', manifestPaths: ['agent-manifest.json'], junitPath: null } };
  await writeJson(resultPath, envelope('runResult', data));
  await writeJson(path.join(baseDir, 'evidence-index.json'), envelope('evidenceIndex', { runId, attemptId,
    entries: [{ stepId: randomUUID(), source: { flow: 'flow.yaml', commandIndex: 0, commandName: 'StartRecordingCommand' },
      status: fixture.status, error: fixture.error, evidence }] }));
  fixture.manifestFiles = ['result.json', 'evidence-index.json', 'input.json', 'flow.yaml',
    ...fixture.logNames, ...fixture.videos.map(value => value.relative)];
  await manifest(fixture);
  return fixture;
}

async function collect(fixture, limits) {
  const outputDirectory = path.join(fixture.root, 'output-' + randomUUID());
  const report = await collectRecordingDiagnostics({ resultPath: fixture.resultPath, outputDirectory, ...(limits ? { limits } : {}) });
  assert.deepEqual(await readJson(path.join(outputDirectory, 'recording-diagnostics.json')), report,
    'The returned report must be the same durable report that a later consumer reads.');
  return report;
}

function incomplete(report) {
  assert.equal(report.status, 'incomplete');
  assert.ok(report.issues.length > 0, 'An incomplete report must explain the missing or untrusted evidence.');
  for (const issue of report.issues) {
    assert.equal(typeof issue.code, 'string');
    assert.equal(typeof issue.message, 'string');
  }
}

async function sourceSnapshot(fixture) {
  return Object.fromEntries(await Promise.all([...fixture.manifestFiles, 'agent-manifest.json']
    .map(async relative => [relative, await digest(path.join(fixture.baseDir, relative))])));
}

test('verified duplicate log payloads yield one recording with both original source locations', async () => {
  const fixture = await makeFixture({ duplicateLogs: true }), before = await sourceSnapshot(fixture);
  const report = await collect(fixture), expected = fixture.recordings[0];
  assert.equal(report.status, 'complete');
  assert.equal(report.sourcesVerified, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual({ runId: report.run.runId, attemptId: report.run.attemptId },
    { runId: fixture.runId, attemptId: fixture.attemptId });
  assert.equal(path.normalize(report.run.baseDir), path.normalize(fixture.baseDir));
  assert.equal(report.recordings.length, 1);
  const actual = report.recordings[0];
  assert.equal(actual.contextId, expected.contextId);
  assert.equal(actual.recordingId, expected.recordingId);
  assert.equal(actual.resourceId, expected.resourceId);
  assert.equal(actual.status, 'complete');
  assert.equal(actual.video.state, 'available');
  assert.equal(path.resolve(fixture.baseDir, actual.video.path), expected.outputPath);
  assert.equal(actual.video.bytes, expected.videoBytes.length);
  assert.equal(actual.video.sha256, sha256(expected.videoBytes));
  assert.deepEqual(actual.events.map(event => event.seq), expected.events.map(event => event.seq));
  for (const [index, event] of actual.events.entries()) {
    assert.equal(event.resourceId, expected.resourceId);
    assert.equal(event.sources.length, 2);
    assert.equal(new Set(event.sources.map(source => source.logPath)).size, 2);
    assert.ok(event.sources.every(source => source.line > 0 && Number.isInteger(source.line) &&
      source.payloadSha256 === sha256(JSON.stringify(expected.events[index]))));
  }
  assert.ok(report.sourceFiles.length >= fixture.manifestFiles.length);
  assert.ok(report.sourceFiles.every(file => file.sha256 === file.sha256After && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.deepEqual(await sourceSnapshot(fixture), before, 'Collecting diagnostics must not change execution evidence.');
});

test('a failed execution and unknown cleanup remain intact when its diagnostic trace is complete', async () => {
  const error = { kind: 'assertion', code: 'ASSERTION_FAILED', message: 'The original assertion failed.' };
  const cleanup = { state: 'unknown', errors: [{ kind: 'environment', code: 'DEVICE_RECOVERY_REQUIRED',
    message: 'Independent cleanup blocker.', details: { recoverySessionId: randomUUID() } }] };
  const fixture = await makeFixture({ edit(f) {
    f.status = 'failed'; f.error = error; f.cleanup = cleanup;
    Object.assign(f.events.at(-1).fields, { result: 'failed', errorKind: 'io' });
  } });
  const before = await sourceSnapshot(fixture), report = await collect(fixture);
  assert.equal(report.status, 'complete');
  assert.equal(report.recordings[0].status, 'complete');
  assert.equal(report.execution.status, 'failed');
  assert.deepEqual(report.execution.error, error);
  assert.deepEqual(report.execution.cleanup, cleanup);
  assert.deepEqual(await sourceSnapshot(fixture), before);
});

test('export attempts retain observed sizes and durations without inventing an after stat', async () => {
  const fixture = await makeFixture({ edit(f) {
    const seed = f.events[0];
    const stages = [
      ['created', { result: 'observed' }], ['capture_ended', { result: 'observed' }],
      ['stat', { result: 'observed', attempt: 1, expectedBytes: 10 }],
      ['receive', { result: 'observed', attempt: 1, expectedBytes: 10, receivedBytes: 10 }],
      ['validate', { result: 'invalid', attempt: 1 }],
      ['stat', { result: 'observed', attempt: 2, expectedBytes: 20 }],
      ['receive', { result: 'observed', attempt: 2, expectedBytes: 20, receivedBytes: 20 }],
      ['validate', { result: 'returned', attempt: 2, stageElapsedMs: 3 }],
      ['copy', { result: 'returned', stageElapsedMs: 4 }], ['flush', { result: 'returned', stageElapsedMs: 2 }],
      ['media_retained', { result: 'observed' }],
      ['cleanup', { result: 'returned', priorFailure: false, cleanupErrors: 0 }],
      ['close', { result: 'returned', terminal: true, expectedEventCount: 13, truncated: false, droppedEvents: 0, emissionFailures: 0 }],
    ];
    f.events = stages.map(([stage, fields], index) => ({ ...seed, seq: index + 1, elapsedMs: index * 10, stage, fields }));
  } });
  const report = await collect(fixture), recording = report.recordings[0];
  assert.equal(report.status, 'complete');
  assert.deepEqual(recording.exportAttempts.map(attempt => [attempt.attempt, attempt.remoteBeforeBytes, attempt.receivedBytes,
    attempt.remoteAfterBytes, attempt.remoteAfterObservation]), [[1, 10, 10, null, 'not_observed'], [2, 20, 20, null, 'not_observed']]);
  assert.deepEqual(recording.observations.captureEnded, [2]);
  assert.deepEqual(recording.observations.structureValidated, [8]);
  assert.deepEqual(recording.observations.copyCompleted, [9]);
  assert.deepEqual(recording.observations.flushCompleted, [10]);
  assert.deepEqual(recording.observations.mediaRetained, [11]);
  assert.deepEqual(recording.observations.mediaRemoved, []);
  assert.equal(recording.stageDurations.find(stage => stage.seq === 8).elapsedMs, 3);
});

test('archive metadata is an observation and only compares to the uniquely indexed video', async () => {
  const fixture = await makeFixture({ edit(f) {
    const seed = f.events[0], bytes = f.recordings[0].videoBytes;
    const observations = [{ archiveBytes: 5, archiveSha256: '0'.repeat(64), attempt: 1 },
      { archiveBytes: bytes.length, archiveSha256: sha256(bytes), attempt: 2 }, { archiveMetadataUnavailable: true }];
    f.events.splice(-1, 0, ...observations.map(fields => ({ ...seed, stage: 'archive', fields: { result: 'observed', ...fields } })));
    f.events.forEach((event, index) => { event.seq = index + 1; event.elapsedMs = index * 10; });
    f.events.at(-1).fields.expectedEventCount = f.events.length;
  } });
  const report = await collect(fixture), observed = report.recordings[0].archiveObservations;
  assert.equal(report.status, 'complete');
  assert.deepEqual(observed.map(value => value.indexedVideoMatch), [false, true, null]);
  assert.deepEqual(observed.map(value => value.attempt), [1, 2, null]);
  assert.ok(observed.every(value => value.archiveFileVerification === 'not_performed'));
  assert.equal(observed[2].metadataUnavailable, true);
  assert.equal(observed[2].sha256, null);
});

test('conflicting bindings cannot attach a video even when the recording events agree', async () => {
  const fixture = await makeFixture({ edit(f) { f.bindings.push({ ...f.bindings[0], outputPath: path.join(f.baseDir, 'other.mp4') }); } });
  const report = await collect(fixture);
  incomplete(report);
  assert.equal(report.recordings[0].video.sha256, null);
  assert.ok(report.issues.some(issue => issue.code === 'binding_conflict'));
});

test('an unterminated final log line is incomplete despite valid JSON and matching file hashes', async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.baseDir, fixture.logNames[0]);
  const text = await fs.readFile(file, 'utf8'); await fs.writeFile(file, text.replace(/\n$/, ''));
  const indexPath = path.join(fixture.baseDir, 'evidence-index.json'), index = await readJson(indexPath);
  index.data.entries[0].evidence.find(item => item.kind === 'log').sha256 = await digest(file);
  await writeJson(indexPath, index); await manifest(fixture);
  const report = await collect(fixture);
  incomplete(report);
  assert.ok(report.issues.some(issue => issue.code === 'truncated_log_line'));
});

test('malformed execution metadata produces a schema-safe partial report', async () => {
  const fixture = await makeFixture();
  const source = await readJson(fixture.resultPath); source.data.cleanup = { state: 'complete', errors: [], invented: true };
  await writeJson(fixture.resultPath, source); await manifest(fixture);
  const report = await collect(fixture);
  incomplete(report); assert.equal(report.execution, null);
});

for (const target of ['result.json', 'evidence-index.json']) for (const absent of ['missing', 'null']) {
  test(`the manifest cannot omit the ${target} hash by using ${absent}`, async () => {
    const fixture = await makeFixture(), file = path.join(fixture.baseDir, 'agent-manifest.json');
    const original = await readJson(file), reference = original.files.find(item => item.path === target);
    if (absent === 'missing') delete reference.sha256; else reference.sha256 = null;
    await writeJson(file, original);
    const before = await fs.readFile(file), report = await collect(fixture);
    incomplete(report); assert.equal(report.sourcesVerified, false);
    assert.deepEqual(await fs.readFile(file), before);
  });
}

test('an explicitly foreign output context is excluded without poisoning an owned complete recording', async () => {
  let foreign;
  const fixture = await makeFixture({ edit(f) {
    foreign = recording(path.join(f.root, 'another-attempt'));
    f.bindings.push(foreign.binding); f.events.push(...foreign.events);
  } });
  const report = await collect(fixture);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.recordings.map(value => value.contextId), [fixture.recordings[0].contextId]);
  assert.ok(report.foreignContexts.some(value => (typeof value === 'string' ? value : value.contextId) === foreign.contextId));
  assert.ok(report.sourceFiles.every(value => path.resolve(fixture.baseDir, value.path) !== foreign.outputPath));
});

test('a log containing only an explicitly foreign recording cannot claim a complete collection', async () => {
  const fixture = await makeFixture({ edit(f) {
    const foreign = recording(path.join(f.root, 'another-attempt'));
    f.bindings = [foreign.binding]; f.events = foreign.events; f.videos = [];
  } });
  const report = await collect(fixture);
  incomplete(report);
  assert.equal(report.recordings.length, 0);
});

const damagedTraceCases = [
  ['missing output binding', f => { f.bindings = []; }],
  ['missing sequence', f => { f.events.splice(2, 1); }],
  ['missing terminal event', f => { f.events.pop(); }],
  ['conflicting duplicate sequence', f => {
    const conflict = structuredClone(f.events[2]); conflict.fields.result = 'absent'; f.events.push(conflict);
  }],
  ['monotonic elapsed time moving backwards', f => { f.events[3].elapsedMs = 0; }],
  ['producer truncation', f => { Object.assign(f.events.at(-1).fields, { truncated: true, droppedEvents: 1 }); }],
  ['producer emission failure', f => { f.events.at(-1).fields.emissionFailures = 1; }],
  ['terminal event count mismatch', f => { f.events.at(-1).fields.expectedEventCount++; }],
  ['negative expected size', f => { f.events[3].fields.expectedBytes = -1; }],
];
for (const [name, edit] of damagedTraceCases) {
  test(`${name} is retained as incomplete evidence`, async () => {
    const fixture = await makeFixture({ edit }), report = await collect(fixture);
    incomplete(report);
    assert.ok(report.recordings.some(value => value.contextId === fixture.recordings[0].contextId));
  });
}

test('a consistently wrong durable resource ID cannot identify a recording', async () => {
  const fixture = await makeFixture({ edit(f) {
    const otherResource = randomUUID(); f.events.forEach(event => { event.resourceId = otherResource; });
  } });
  const report = await collect(fixture);
  incomplete(report);
  assert.ok(report.issues.some(issue => issue.message.includes('durable resource ID')));
});

for (const kind of ['recordingId', 'event contextId', 'binding contextId', 'resourceId', 'archiveSha256']) {
  test(`a single-element ${kind} array is not coerced into a valid identifier`, async () => {
    const fixture = await makeFixture({ edit(f) {
      if (kind === 'binding contextId') f.bindings[0].contextId = [f.bindings[0].contextId];
      else for (const event of f.events) {
        if (kind === 'recordingId') { event.recordingId = [event.recordingId]; delete event.resourceId; }
        else if (kind === 'event contextId') event.contextId = [event.contextId];
        else if (kind === 'resourceId') event.resourceId = [event.resourceId];
        else event.fields.archiveSha256 = ['0'.repeat(64)];
      }
    } });
    incomplete(await collect(fixture));
  });
}

test('a missing output below a junction is not accepted as an early abort absence', async t => {
  const fixture = await makeFixture({ edit(f) {
    f.bindings[0].outputPath = path.join(f.baseDir, 'linked-parent', 'missing.mp4'); f.videos = [];
    f.events = [f.events[0], { ...f.events.at(-1), seq: 2, stage: 'abort', fields: { result: 'failed', errorKind: 'io',
      terminal: true, expectedEventCount: 2, truncated: false, droppedEvents: 0, emissionFailures: 0 } }];
    f.status = 'failed'; f.error = { kind: 'internal', code: 'INTERNAL_ERROR', message: 'Failed before recording started.' };
  } });
  const target = path.join(fixture.root, 'empty-external-directory'); await fs.mkdir(target);
  try { await fs.symlink(target, path.join(fixture.baseDir, 'linked-parent'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Cannot create a link: ${error.code}`); return; } throw error; }
  incomplete(await collect(fixture));
  assert.deepEqual(await fs.readdir(target), []);
});

for (const [name, uri] of [
  ['non-media scheme', () => 'https://example.invalid/private-video.mp4'],
  ['another recording name', () => `file://media/Photo/123/VID_123/maestro-recording-${'0'.repeat(32)}.mp4`],
  ['encoded path separator', f => `file://media/Photo/123/VID%2f123/maestro-recording-${f.recordings[0].recordingId}.mp4`],
  ['overlong media URI', f => `file://media/Photo/123/${'x'.repeat(512)}/maestro-recording-${f.recordings[0].recordingId}.mp4`],
]) {
  test(`untrusted media URI with ${name} cannot become complete diagnostics`, async () => {
    const fixture = await makeFixture({ edit(f) { f.events[2].fields.mediaUri = uri(f); } });
    incomplete(await collect(fixture));
  });
}

test('two recording contexts bound to one output file make that video ambiguous', async () => {
  const fixture = await makeFixture({ count: 2, edit(f) {
    f.bindings[1].outputPath = f.bindings[0].outputPath; f.videos.pop();
  } });
  const report = await collect(fixture);
  incomplete(report);
  assert.equal(report.recordings.length, 2);
  assert.ok(report.recordings.every(value => value.video.state === 'ambiguous'));
});

test('an early failed start may have complete diagnostics without producing a video', async () => {
  const fixture = await makeFixture({ edit(f) {
    f.videos = [];
    f.events = [f.events[0], { ...f.events[1], stage: 'service', fields: { result: 'failed', errorKind: 'io' } },
      { ...f.events.at(-1), seq: 3, elapsedMs: 20, stage: 'abort', fields: { result: 'failed', errorKind: 'io',
        terminal: true, expectedEventCount: 3, truncated: false, droppedEvents: 0, emissionFailures: 0 } }];
    for (const event of f.events) delete event.resourceId;
    f.status = 'failed'; f.error = { kind: 'internal', code: 'INTERNAL_ERROR', message: 'Recorder did not start.' };
  } });
  const report = await collect(fixture);
  assert.equal(report.status, 'complete');
  assert.equal(report.recordings[0].status, 'complete');
  assert.equal(report.recordings[0].resourceId, null);
  assert.ok(report.recordings[0].events.every(event => event.resourceId === null));
  assert.notEqual(report.recordings[0].video.state, 'available');
  assert.equal(report.execution.status, 'failed');
});

for (const [name, relative] of [
  ['input', 'input.json'], ['evidence index', 'evidence-index.json'],
  ['log', 'flows/recording/logs/maestro.log'], ['video', 'flows/recording/video-0.mp4'],
]) {
  test(`changed ${name} bytes are rejected against the retained hashes`, async () => {
    const fixture = await makeFixture();
    await fs.appendFile(path.join(fixture.baseDir, relative), '\n');
    const report = await collect(fixture);
    incomplete(report);
    assert.equal(report.sourcesVerified, false);
  });
}

for (const variant of ['metadata', 'escaped metadata key', 'event', 'binding', 'metadata trailing token', 'event trailing token']) {
  test(`duplicate keys or trailing tokens are rejected in ${variant}`, async () => {
    const fixture = await makeFixture();
    if (variant.startsWith('metadata') || variant === 'escaped metadata key') {
      const source = await fs.readFile(fixture.resultPath, 'utf8');
      const changed = variant === 'metadata trailing token' ? source + '{}\n' : source.replace('"schemaVersion": 1,',
        variant === 'escaped metadata key' ? '"schemaVersion": 1,"\\u0073chemaVersion":1,' : '"schemaVersion":1,"schemaVersion":1,');
      assert.notEqual(changed, source); await fs.writeFile(fixture.resultPath, changed);
    } else {
      const file = path.join(fixture.baseDir, fixture.logNames[0]), source = await fs.readFile(file, 'utf8');
      let changed;
      if (variant === 'binding') changed = source.replace('"pathAvailable":true', '"pathAvailable":true,"pathAvailable":true');
      else if (variant === 'event') changed = source.replace('"seq":1,', '"seq":1,"seq":1,');
      else changed = source.replace(/(HARMONYOS_RECORDING_DIAGNOSTIC [^\n]+)\n/, '$1 {}\n');
      assert.notEqual(changed, source); await fs.writeFile(file, changed);
      const indexPath = path.join(fixture.baseDir, 'evidence-index.json'), index = await readJson(indexPath);
      index.data.entries[0].evidence.find(item => item.kind === 'log').sha256 = await digest(file);
      await writeJson(indexPath, index);
    }
    await manifest(fixture);
    incomplete(await collect(fixture));
  });
}

for (const reference of ['../outside.log', '..\\outside.log']) {
  test(`a hashed evidence reference cannot escape the attempt with ${JSON.stringify(reference)}`, async () => {
    const fixture = await makeFixture(), outside = path.join(path.dirname(fixture.baseDir), 'outside.log');
    await fs.writeFile(outside, 'outside the attempt');
    const indexPath = path.join(fixture.baseDir, 'evidence-index.json'), index = await readJson(indexPath);
    index.data.entries[0].evidence.push({ kind: 'log', state: 'available', path: reference,
      sha256: await digest(outside), capturedAt: stamp, phase: 'after', error: null });
    await writeJson(indexPath, index);
    await manifest(fixture, [{ path: reference, sha256: await digest(outside) }]);
    incomplete(await collect(fixture));
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside the attempt');
  });
}

test('a directory link cannot redirect an indexed log outside its attempt', async t => {
  const fixture = await makeFixture(), target = path.join(fixture.root, 'outside-logs');
  await fs.mkdir(target);
  const targetLog = path.join(target, 'maestro.log');
  await fs.writeFile(targetLog, logText(fixture.bindings, fixture.events));
  try { await fs.symlink(target, path.join(fixture.baseDir, 'linked-logs'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Cannot create a link: ${error.code}`); return; } throw error; }
  const indexPath = path.join(fixture.baseDir, 'evidence-index.json'), index = await readJson(indexPath);
  index.data.entries[0].evidence.push({ kind: 'log', state: 'available', path: 'linked-logs/maestro.log',
    sha256: await digest(targetLog), capturedAt: stamp, phase: 'after', error: null });
  await writeJson(indexPath, index);
  await manifest(fixture, [{ path: 'linked-logs/maestro.log', sha256: await digest(targetLog) }]);
  incomplete(await collect(fixture));
});

for (const [limit, value] of Object.entries({ metadataBytes: 32, fileBytes: 16, totalBytes: 64,
  lineBytes: 32, files: 1, lines: 1, events: 1, contexts: 1 })) {
  test(`the ${limit} budget produces a durable incomplete report instead of unbounded collection`, async () => {
    const fixture = await makeFixture({ count: limit === 'contexts' ? 2 : 1 });
    incomplete(await collect(fixture, { [limit]: value }));
  });
}

test('an existing output directory is never overwritten, even when it is empty', async () => {
  const fixture = await makeFixture(), outputDirectory = path.join(fixture.root, 'existing-output');
  await fs.mkdir(outputDirectory);
  await assert.rejects(collectRecordingDiagnostics({ resultPath: fixture.resultPath, outputDirectory }));
  assert.deepEqual(await fs.readdir(outputDirectory), []);
  const sentinel = path.join(outputDirectory, 'recording-diagnostics.json');
  await fs.writeFile(sentinel, 'keep the existing report');
  await assert.rejects(collectRecordingDiagnostics({ resultPath: fixture.resultPath, outputDirectory }));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep the existing report');
});

test('the collector does not create a missing output parent', async () => {
  const fixture = await makeFixture(), parent = path.join(fixture.root, 'missing-parent');
  await assert.rejects(collectRecordingDiagnostics({ resultPath: fixture.resultPath,
    outputDirectory: path.join(parent, 'output') }));
  await assert.rejects(fs.lstat(parent), { code: 'ENOENT' });
});

test('an output directory cannot be created through a linked parent', async t => {
  const fixture = await makeFixture(), target = path.join(fixture.root, 'output-target');
  await fs.mkdir(target);
  const link = path.join(fixture.root, 'output-link');
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`Cannot create a link: ${error.code}`); return; } throw error; }
  await assert.rejects(collectRecordingDiagnostics({ resultPath: fixture.resultPath, outputDirectory: path.join(link, 'output') }));
  assert.deepEqual(await fs.readdir(target), []);
});
