import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateDocument } from '../../examples/agent-client/client.mjs';
import { verifyRecordingResources } from '../../examples/agent-client/evidence.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function checkedFile(file) {
  const absolute = path.resolve(file);
  for (let item = absolute; ; item = path.dirname(item)) {
    const info = await fs.lstat(item);
    if (info.isSymbolicLink()) throw new Error(`Metadata cannot follow a link: ${item}`);
    if (path.dirname(item) === item) break;
  }
  const info = await fs.stat(absolute);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Expected a bounded metadata file.');
  const bytes = await fs.readFile(absolute);
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sha256: sha256(bytes), path: absolute };
}

async function artifactFile(base, relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f\x7f]/.test(relative) || relative.startsWith('/') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid artifact reference.');
  // The synchronous resolver also works in restricted Windows hosts where native async realpath is denied.
  const root = realpathSync(base);
  const target = realpathSync(path.resolve(root, ...relative.split('/')));
  const relation = path.relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation) || !(await fs.stat(target)).isFile()) {
    throw new Error('Artifact escapes its declared directory or is not a file.');
  }
  return target;
}

export async function verifyEvidence(result, index, agentRoot) {
  validateDocument(result, 'runResult', [1]); validateDocument(index, 'evidenceIndex', [1]);
  const data = result.data;
  if (!uuid.test(data.runId) || !uuid.test(data.attemptId)) throw new Error('Invalid attempt identity in evidence.');
  const base = path.resolve(agentRoot, 'runs', data.runId, data.attemptId);
  if (!samePath(data.artifacts.baseDir, base) || index.data.runId !== data.runId || index.data.attemptId !== data.attemptId ||
      !Array.isArray(index.data.entries) || !Array.isArray(data.artifacts.manifestPaths)) throw new Error('Evidence identifies another attempt.');
  let checkedFiles = 0, unavailable = 0;
  const steps = new Set();
  const hashes = [];
  async function check(reference) {
    if (!reference || !/^[0-9a-f]{64}$/.test(reference.sha256)) throw new Error('Invalid evidence hash.');
    const file = await artifactFile(base, reference.path);
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== reference.sha256) throw new Error(`Artifact hash differs: ${reference.path}`);
    hashes.push({ path: reference.path, sha256: reference.sha256 }); checkedFiles++;
  }
  await check(data.input);
  if (data.flow !== null) await check(data.flow);
  for (const entry of index.data.entries) {
    if (entry.stepId !== null) {
      if (!uuid.test(entry.stepId) || steps.has(entry.stepId)) throw new Error('Invalid or duplicate evidence step.');
      steps.add(entry.stepId);
    }
    if (!Array.isArray(entry.evidence)) throw new Error('Missing step evidence.');
    for (const item of entry.evidence) {
      if (item.state === 'available') await check(item);
      else if (['missing', 'capture_failed'].includes(item.state) && item.path === null && item.sha256 === null) unavailable++;
      else throw new Error('Invalid evidence availability.');
    }
  }
  if (data.failedStepId !== null && !steps.has(data.failedStepId)) throw new Error('Failed step is missing from the evidence index.');
  if (data.artifacts.manifestPaths.filter(item => item === 'agent-manifest.json').length !== 1) throw new Error('The agent metadata manifest is missing or duplicated.');
  const manifestPath = await artifactFile(base, 'agent-manifest.json');
  const { value: manifest, sha256: manifestSha256 } = await checkedFile(manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.runId !== data.runId || manifest.attemptId !== data.attemptId || !Array.isArray(manifest.files)) {
    throw new Error('The agent metadata manifest identifies another attempt.');
  }
  const recordedPaths = new Set();
  for (const reference of manifest.files) {
    if (reference.path === 'agent-manifest.json' || recordedPaths.has(reference.path)) throw new Error('Duplicated or recursive metadata reference.');
    recordedPaths.add(reference.path);
    await check(reference);
  }
  const required = ['input.json', 'result.json', 'state.json', 'registration.json', data.artifacts.evidenceIndexPath,
    ...data.artifacts.manifestPaths.filter(item => item !== 'agent-manifest.json'), ...(data.flow === null ? [] : [data.flow.path]),
    ...(data.artifacts.junitPath === null ? [] : [data.artifacts.junitPath])];
  if (required.some(item => !recordedPaths.has(item))) throw new Error('The agent metadata manifest omits a required report hash.');
  hashes.push({ path: 'agent-manifest.json', sha256: manifestSha256 });
  return { checkedFiles, unavailable, steps: steps.size, hashes };
}

async function checkedGate(deviceId, recoveryRoot, since) {
  const key = sha256(Buffer.from(deviceId, 'utf8'));
  const gateFile = path.resolve(recoveryRoot, `${key}.owner.json`);
  const { value: gate } = await checkedFile(gateFile);
  if (gate.schemaVersion !== 1 || gate.deviceId !== deviceId || !uuid.test(gate.ownerSessionId) || gate.state !== 'clean' ||
      gate.requiresRecovery !== false || gate.unresolvedRecording !== false || gate.closeFailure !== null) {
    throw new Error('The existing device lease does not confirm clean release.');
  }
  const receiptDirectory = path.resolve(recoveryRoot, key, gate.ownerSessionId, 'recoveries');
  // Keep this layout aligned with HarmonyOsSessionLease.ownerDirectory.
  const receipt = await checkedFile(gate.reportPath);
  if (!samePath(path.dirname(receipt.path), receiptDirectory) || receipt.sha256 !== gate.reportSha256) {
    throw new Error('The current device lease does not reference a trusted cleanup receipt.');
  }
  const value = receipt.value;
  if (![1, 2].includes(value.schemaVersion) || !uuid.test(value.recoveryId) || path.basename(receipt.path) !== `${value.recoveryId}.json` ||
      value.deviceId !== deviceId || value.sessionId !== gate.ownerSessionId || value.state !== 'complete' ||
      !['session_close', 'recovery'].includes(value.reason) || value.pendingOperations !== 0 || value.temporaryFiles !== 0 ||
      !Number.isSafeInteger(value.operations) || value.operations < 0 || !Array.isArray(value.issues) || value.issues.length !== 0 ||
      value.unresolvedRecording !== false || value.closeFailure !== null || !Number.isFinite(Date.parse(value.observedAt)) ||
      Date.parse(value.observedAt) < Date.parse(since)) {
    throw new Error('The cleanup receipt is incomplete, stale, or belongs to another device session.');
  }
  if (value.schemaVersion === 1 && 'recordingResources' in value) throw new Error('A v1 cleanup receipt cannot contain v2 recording resources.');
  const recording = await verifyRecordingResources(value, receipt.path, recoveryRoot);
  return { sessionId: gate.ownerSessionId, reportPath: receipt.path, reportSha256: receipt.sha256, observedAt: value.observedAt,
    recordingResources: value.recordingResources ?? null, recordingCheckedFiles: recording.checkedFiles };
}

export async function verifyDeviceRelease({ deviceId, recoveryRoot, createdAt }) {
  if (typeof deviceId !== 'string' || !deviceId || !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid device release identity.');
  return checkedGate(deviceId, recoveryRoot, createdAt);
}

export async function verifyState(input) {
  if (!['completion', 'recovery'].includes(input.mode) || (input.mode === 'completion' && (!uuid.test(input.runId) || !uuid.test(input.attemptId))) ||
      typeof input.deviceId !== 'string' || !input.deviceId || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Invalid verification identity.');
  }
  const gate = await checkedGate(input.deviceId, input.recoveryRoot, input.createdAt);
  if (input.mode === 'recovery') {
    const { value: document, sha256: responseSha256 } = await checkedFile(input.recoveryReportPath);
    const value = document.data;
    if (document.protocol !== 'maestro.harmonyos.agent' || document.schemaVersion !== 2 || document.kind !== 'recoveryReport' ||
        value?.deviceId !== input.deviceId || value.sessionId !== gate.sessionId || value.state !== 'complete' || value.handoffReady !== true ||
        value.cleanup?.state !== 'complete' || !Array.isArray(value.cleanup.errors) || value.cleanup.errors.length !== 0 ||
        value.pendingOperations !== 0 || value.temporaryFiles !== 0 || !samePath(value.reportPath, gate.reportPath) || value.reportSha256 !== gate.reportSha256) {
      throw new Error('The v2 recovery response does not confirm the current device lease.');
    }
    validateDocument(document, 'recoveryReport', [2]);
    const { value: audit } = await checkedFile(gate.reportPath);
    for (const field of ['deviceId', 'sessionId', 'state', 'operations', 'pendingOperations', 'temporaryFiles']) {
      if (audit[field] !== value[field]) throw new Error(`Recovery audit differs from response: ${field}`);
    }
    return { mode: 'recovery', releaseConfirmed: true, ...gate, recoveryResponseSha256: responseSha256 };
  }
  const { value: control, sha256: controlSha256 } = await checkedFile(input.controlRecordPath);
  if (control.protocol !== 'maestro.harmonyos.runner-control' || control.schemaVersion !== 1 || control.runId !== input.runId ||
      control.attemptId !== input.attemptId || control.deviceId !== input.deviceId || control.phase !== 'exited' ||
      control.processExitObserved !== true || !Number.isInteger(control.processExitCode) || control.terminationRequested !== false ||
      !['passed', 'failed', 'blocked', 'cancelled'].includes(control.agentStatus) || control.wrapperExitCode !== control.processExitCode ||
      control.stopReason !== null || control.error !== null || control.stdoutComplete !== true || control.stderrComplete !== true) {
    throw new Error('Runner completion or output collection is unconfirmed.');
  }
  const expected = path.resolve(input.agentRoot, 'runs', input.runId, input.attemptId, 'result.json');
  if (!samePath(control.runResultPath, expected)) throw new Error('Unexpected result path.');
  const { value: result, sha256: resultSha256 } = await checkedFile(expected);
  const data = result.data;
  if (result.protocol !== 'maestro.harmonyos.agent' || result.schemaVersion !== 1 || result.kind !== 'runResult' ||
      data?.runId !== input.runId || data.attemptId !== input.attemptId || data.deviceId !== input.deviceId ||
      data.status !== control.agentStatus || data.cleanup?.state !== 'complete' ||
      !Array.isArray(data.cleanup.errors) || data.cleanup.errors.length !== 0 ||
      (data.status === 'passed' && control.processExitCode !== 0)) throw new Error('No matching, cleaned terminal execution result.');
  const evidenceFile = path.resolve(path.dirname(expected), 'evidence-index.json');
  const { value: evidence } = await checkedFile(evidenceFile);
  const verification = await verifyEvidence(result, evidence, input.agentRoot);
  if (['passed', 'failed'].includes(data.status) && !data.artifacts.junitPath) throw new Error('The native JUnit report is missing.');
  return { mode: 'completion', releaseConfirmed: true, ...gate, status: data.status, processExitCode: control.processExitCode,
    resultPath: expected, resultSha256, controlSha256, evidence: verification };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { value: input } = await checkedFile(process.argv[2]);
    const result = await verifyState(input);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
