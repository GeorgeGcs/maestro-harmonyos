import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDocument } from '../../examples/agent-client/client.mjs';
import { verifyDeviceRelease } from '../ci/verify-state.mjs';
import { artifact, canonical, digestPattern, hashFile, inside, key, noLinks, readJson, requireValue, samePath, uuid } from './io.mjs';
import { checkFrozen, freezePlan, saveSummary } from './plan.mjs';
import { inspectAttempt, verifyAttemptInput } from './retry-evidence.mjs';

async function load(summaryPath) {
  const state = (await readJson(summaryPath)).value, frozen = await readJson(state.planPath), plan = frozen.value;
  requireValue(state.protocol === 'maestro.harmonyos.validation-summary' && state.schemaVersion === 1 &&
    frozen.sha256 === state.planSha256 && plan.planId === state.planId, 'Frozen plan and summary do not match.');
  requireValue(state.batches.length === plan.batches.length && state.slots.length === plan.batches.length * plan.repeat,
    'Planned denominator was changed.');
  const slots = new Set();
  for (const batch of plan.batches) {
    const actual = state.batches.filter(value => value.batchId === batch.batchId);
    requireValue(actual.length === 1 && actual[0].unitId === batch.unitId && actual[0].deviceId === batch.deviceId, 'Batch identity differs.');
    for (let round = 1; round <= plan.repeat; round++) {
      const selected = state.slots.filter(slot => slot.batchId === batch.batchId && slot.round === round);
      requireValue(selected.length === 1 && selected[0].unitId === batch.unitId && selected[0].deviceId === batch.deviceId &&
        selected[0].slotId === batch.batchId + ':' + round && !slots.has(selected[0].slotId), 'Planned slot identity differs.');
      slots.add(selected[0].slotId);
    }
  }
  return { state, plan };
}

export async function startBatch(input) {
  const { state, plan } = await load(input.summaryPath);
  await checkFrozen(plan);
  const batch = state.batches.find(value => value.batchId === input.batchId);
  requireValue(state.status === 'running' && batch?.status === 'pending', 'A batch cannot be restarted.');
  requireValue(!state.batches.some(value => value.deviceId === batch.deviceId && value.stopDevice), 'This device has a stopped earlier batch.');
  requireValue(path.isAbsolute(input.outputDirectory) && path.isAbsolute(input.pointerPath) && path.isAbsolute(input.controlIndexPath), 'Batch output references must be absolute.');
  Object.assign(batch, { status: 'running', startedAt: new Date().toISOString(), outputDirectory: input.outputDirectory,
    pointerPath: input.pointerPath, controlIndexPath: input.controlIndexPath });
  await saveSummary(input.summaryPath, state, plan);
  return { batch, unit: plan.units.find(unit => unit.unitId === batch.unitId),
    profile: plan.profiles[plan.units.find(unit => unit.unitId === batch.unitId).profile], repeat: plan.repeat, runTimeoutSeconds: plan.runTimeoutSeconds };
}

function matrixIdentity(matrix, unit, profile, batch, plan) {
  requireValue(matrix.schemaVersion === 1 && ['completed', 'interrupted'].includes(matrix.status) && matrix.finishedAt &&
    matrix.devices?.length === 1 && matrix.devices[0].id === batch.deviceId && matrix.runs?.length === plan.repeat,
    'Matrix is incomplete or belongs to another planned device/round count.');
  requireValue(samePath(matrix.input?.flowPath, unit.entry) && matrix.input.repeat === plan.repeat &&
    matrix.input.bundleId === profile.bundleId && matrix.input.abilityName === profile.abilityName &&
    (matrix.input.moduleName ?? null) === profile.moduleName &&
    canonical(matrix.input.environmentKeys?.slice().sort()) === canonical(profile.environmentNames), 'Matrix input differs from the frozen unit.');
  const expected = unit.sources.filter(file => samePath(file.path, unit.entry) || inside(unit.entry, file.path));
  const actual = matrix.input.files;
  requireValue(Array.isArray(actual) && actual.length === expected.length && actual.every(file =>
    expected.some(value => samePath(value.path, file.path) && value.sha256 === file.sha256)), 'Matrix source hashes differ.');
  const patch = plan.toolFiles.find(file => file.path.endsWith('0001-harmonyos-host.patch'));
  if (patch) requireValue(matrix.build?.patchSha256 === patch.sha256, 'Matrix patch differs from the frozen implementation.');
  const jars = matrix.build?.implementationJars;
  requireValue(Array.isArray(jars), 'Matrix implementation fingerprint is missing.');
  if (plan.purpose === 'formal') requireValue(jars.length > 0 && jars.every(jar => plan.buildFiles.some(file =>
    path.basename(file.path) === jar.file && file.sha256 === jar.sha256)), 'Formal build fingerprint does not cover every executed implementation JAR.');
  const device = plan.devices.find(value => value.deviceId === batch.deviceId);
  if (device.matrixInfoSha256) requireValue(digestPattern.test(device.matrixInfoSha256) &&
    device.matrixInfoSha256 === (awaitHashObject(matrix.devices[0].info)), 'Observed device baseline differs.');
}
// Kept synchronous so identity checks cannot dispatch any external command.
import { hash } from './io.mjs';
const awaitHashObject = value => hash(Buffer.from(canonical(value)));

async function controlEntry(entry, run, controlIndexPath) {
  requireValue(entry && entry.deviceId === run.deviceId && entry.runId === run.runId && entry.attemptId === run.attemptId &&
    entry.attemptNo === run.round && samePath(entry.controlRecordPath, path.join(path.dirname(controlIndexPath), run.attemptId + '.json')),
    'Control index entry differs from its matrix round.');
  if (entry.dispatchState === 'planned') {
    requireValue(run.status === 'not-run' && run.startedAt === null, 'An undispatched control is reported as executed.');
    try { await fs.lstat(entry.controlRecordPath); throw new Error('An undispatched control unexpectedly exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  requireValue(entry.dispatchState === 'returned', 'A dispatched invocation has not returned.');
  const record = await readJson(entry.controlRecordPath), control = record.value;
  requireValue(control.protocol === 'maestro.harmonyos.runner-control' && control.schemaVersion === 1 &&
    control.runId === run.runId && control.attemptId === run.attemptId && control.deviceId === run.deviceId &&
    control.phase === 'exited' && control.processExitObserved === true && control.processExitCode === run.cliExitCode &&
    control.wrapperExitCode === run.cliExitCode && control.agentStatus === run.status &&
    control.terminationRequested === false && control.stopReason === null && control.error === null &&
    control.stdoutComplete === true && control.stderrComplete === true && samePath(control.runResultPath, run.runResultPath),
    'Runner termination, result, or output collection is not confirmed.');
  return record;
}

export async function importBatch(input, recheck = null) {
  const { state, plan } = recheck ?? await load(input.summaryPath);
  const batch = state.batches.find(value => value.batchId === input.batchId);
  requireValue((recheck ? batch?.matrixPath : batch?.status === 'running') && Number.isInteger(input.matrixExitCode), 'Only an active batch with an observed exit code can be imported.');
  const unit = plan.units.find(value => value.unitId === batch.unitId), profile = plan.profiles[unit.profile];
  const selected = state.slots.filter(slot => slot.batchId === batch.batchId);
  const originalSlots = new Map(selected.map(slot => [slot.slotId, { ...slot }]));
  const originalBatch = { ...batch };
  for (const slot of selected) Object.assign(slot, { status: 'pending', firstPassStatus: 'not_run', finalPass: false,
    cleanup: null, evidenceComplete: false, coverageComplete: false, retryComplete: false,
    videoComplete: !plan.evidencePolicy.requireVideo, reason: null, flows: [], videos: [] });
  batch.releaseConfirmed = false;
  batch.matrixExitCode = input.matrixExitCode;
  let allControlsTrusted = true, attempted = 0;
  try {
    if (!recheck) await checkFrozen(plan);
    const pointer = await readJson(batch.pointerPath), value = pointer.value;
    requireValue(value.protocol === 'maestro.harmonyos.matrix-pointer' && value.schemaVersion === 1 &&
      path.isAbsolute(value.matrixDirectory) && inside(batch.outputDirectory, value.matrixDirectory) &&
      samePath(value.reportPath, path.join(value.matrixDirectory, 'matrix.json')), 'Matrix pointer is missing or points outside this batch.');
    const document = await readJson(value.reportPath), matrix = document.value;
    const indexDocument = await readJson(batch.controlIndexPath), controls = indexDocument.value;
    if (recheck) requireValue(pointer.sha256 === originalBatch.pointerSha256 && document.sha256 === originalBatch.matrixSha256 &&
      indexDocument.sha256 === originalBatch.controlIndexSha256, 'Imported matrix or dispatch records changed after execution.');
    requireValue(controls.protocol === 'maestro.harmonyos.control-index' && controls.schemaVersion === 1 &&
      controls.invocationId === batch.batchId && samePath(controls.matrixRoot, value.matrixDirectory) && controls.entries?.length === plan.repeat,
      'Control index belongs to another batch.');
    matrixIdentity(matrix, unit, profile, batch, plan);
    batch.matrixPath = document.path; batch.matrixSha256 = document.sha256; batch.pointerSha256 = pointer.sha256;
    batch.controlIndexSha256 = indexDocument.sha256; batch.agentRoot = path.join(value.matrixDirectory, 'agent');
    batch.observedHost = matrix.host; batch.observedDevice = matrix.devices[0].info; batch.observedBuild = matrix.build;
    const attemptIds = new Set();
    for (const slot of selected) {
      try {
        const runs = matrix.runs.filter(run => run.round === slot.round);
        requireValue(runs.length === 1, 'Matrix round is missing or duplicated.');
        const run = runs[0];
        requireValue(run.deviceId === batch.deviceId && uuid.test(run.runId) && uuid.test(run.attemptId) && !attemptIds.has(run.attemptId) &&
          run.runId === matrix.devices[0].runId && run.deviceKey === matrix.devices[0].key, 'Matrix attempt identity differs.');
        attemptIds.add(run.attemptId);
        const controlEntries = controls.entries.filter(entry => entry.attemptId === run.attemptId);
        requireValue(controlEntries.length === 1, 'Control identity is missing or duplicated.');
        Object.assign(slot, { runId: run.runId, attemptId: run.attemptId, attemptNo: run.round, cliExitCode: run.cliExitCode,
          startedAt: run.startedAt, endedAt: run.finishedAt, rawStatus: run.status });
        const control = await controlEntry(controlEntries[0], run, batch.controlIndexPath);
        if (!control) { slot.status = 'not-run'; slot.firstPassStatus = 'not_run'; slot.reason = run.reason; batch.stopDevice = true; continue; }
        attempted++;
        slot.controlPath = control.path; slot.controlSha256 = control.sha256;
        const expectedResult = path.join(batch.agentRoot, 'runs', run.runId, run.attemptId, 'result.json');
        requireValue(samePath(run.runResultPath, expectedResult), 'Result path differs from the planned attempt.');
        const result = await readJson(expectedResult); validateDocument(result.value, 'runResult', [1]);
        const data = result.value.data;
        requireValue(data.runId === run.runId && data.attemptId === run.attemptId && data.attemptNo === slot.round &&
          data.deviceId === batch.deviceId && data.status === run.status && ['passed', 'failed', 'blocked', 'cancelled', 'unknown'].includes(data.status) &&
          Number.isFinite(Date.parse(data.endedAt)) && (data.status !== 'passed' || data.error === null && run.cliExitCode === 0) &&
          (data.status === 'passed' || data.error && typeof data.error.code === 'string'), 'Terminal result does not match this invocation.');
        const evidencePath = await artifact(path.dirname(expectedResult), data.artifacts.evidenceIndexPath);
        const evidence = await readJson(evidencePath);
        if (recheck) {
          const original = originalSlots.get(slot.slotId);
          requireValue(control.sha256 === original.controlSha256 && result.sha256 === original.resultSha256 &&
            evidence.sha256 === original.evidenceIndexSha256, 'Imported attempt evidence changed after execution.');
        }
        const verified = await verifyAttemptInput(result.value, evidence.value, batch.agentRoot, unit, profile);
        requireValue(!['passed', 'failed'].includes(data.status) || data.artifacts.junitPath, 'Native JUnit report is missing.');
        Object.assign(slot, { status: data.status, finalPass: data.status === 'passed', cleanup: data.cleanup,
          resultPath: result.path, resultSha256: result.sha256, evidenceIndexPath: evidence.path, evidenceIndexSha256: evidence.sha256,
          evidenceComplete: verified.evidence.unavailable === 0, firstPassStatus: data.status === 'passed' || data.status === 'unknown' ? 'unknown' : 'not_passed' });
        if (data.cleanup?.state !== 'complete' || data.status === 'unknown' || data.status === 'cancelled') batch.stopDevice = true;
        if (data.cleanup?.state !== 'complete' || data.status === 'unknown') allControlsTrusted = false;
        try {
          const inspection = await inspectAttempt(result.value, evidence.value, batch.agentRoot, unit, profile, verified);
          Object.assign(slot, inspection);
          slot.firstPassStatus = data.status === 'passed' && !inspection.retryUsed ? 'passed' : data.status === 'unknown' ? 'unknown' : 'not_passed';
        } catch (error) { slot.reason = error.message; slot.retryComplete = false; }
      } catch (error) {
        Object.assign(slot, { status: 'unknown', firstPassStatus: 'unknown', finalPass: false, reason: error.message });
        allControlsTrusted = false; batch.stopDevice = true;
      }
    }
    if (allControlsTrusted) {
      if (recheck) {
        requireValue(originalBatch.releaseConfirmed === true, 'Original device handoff was not confirmed.');
        batch.release = originalBatch.release;
        if (attempted > 0) requireValue(batch.release?.reportPath &&
          await hashFile(batch.release.reportPath) === batch.release.reportSha256, 'Retained cleanup receipt changed.');
      } else batch.release = attempted === 0 ? { reason: 'all controls remained planned' } : await verifyDeviceRelease({
        deviceId: batch.deviceId, recoveryRoot: input.recoveryRoot, createdAt: batch.startedAt });
      batch.releaseConfirmed = true;
    }
    batch.status = 'completed';
  } catch (error) {
    batch.status = 'unknown'; batch.stopDevice = true; batch.releaseConfirmed = false; batch.error = error.message;
    for (const slot of selected) if (slot.status === 'pending') Object.assign(slot, { status: 'unknown', firstPassStatus: 'unknown', reason: error.message });
  }
  if (!batch.releaseConfirmed) batch.stopDevice = true;
  if (!recheck) { batch.endedAt = new Date().toISOString(); await saveSummary(input.summaryPath, state, plan); }
  return batch;
}

async function recheckResults(state, plan) {
  for (const batch of state.batches) if (batch.matrixPath && Number.isInteger(batch.matrixExitCode)) {
    await importBatch({ batchId: batch.batchId, matrixExitCode: batch.matrixExitCode }, { state, plan });
  } else for (const slot of state.slots.filter(slot => slot.batchId === batch.batchId)) {
    Object.assign(slot, { firstPassStatus: slot.status === 'not-run' ? 'not_run' : 'unknown', finalPass: false,
      evidenceComplete: false, coverageComplete: false, retryComplete: false, videoComplete: false });
  }
}

export async function skipBatch(input) {
  const { state, plan } = await load(input.summaryPath), batch = state.batches.find(value => value.batchId === input.batchId);
  requireValue(batch && ['pending', 'running'].includes(batch.status), 'Only an uncompleted batch can be stopped.');
  batch.status = input.started ? 'unknown' : 'not-run'; batch.stopDevice = true; batch.reason = input.reason;
  for (const slot of state.slots.filter(slot => slot.batchId === batch.batchId)) if (slot.status === 'pending') {
    Object.assign(slot, { status: input.started ? 'unknown' : 'not-run', firstPassStatus: input.started ? 'unknown' : 'not_run', reason: input.reason });
  }
  await saveSummary(input.summaryPath, state, plan); return batch;
}

export async function finishPlan(input) {
  const { state, plan } = await load(input.summaryPath);
  for (const batch of state.batches) if (['pending', 'running'].includes(batch.status)) {
    const started = batch.status === 'running'; batch.status = started ? 'unknown' : 'not-run'; batch.stopDevice = true;
    for (const slot of state.slots.filter(slot => slot.batchId === batch.batchId)) if (slot.status === 'pending') {
      slot.status = started ? 'unknown' : 'not-run'; slot.firstPassStatus = started ? 'unknown' : 'not_run'; slot.reason = 'Plan stopped before a confirmed batch result.';
    }
  }
  await recheckResults(state, plan);
  // Completion never constitutes a human review, including when invoked again later.
  for (const slot of state.slots) { slot.manualIntervention = 'unknown'; slot.reviewNotes = null; }
  state.status = input.interrupted ? 'interrupted' : 'completed'; state.endedAt = new Date().toISOString();
  await saveSummary(input.summaryPath, state, plan);
  return { qualified: state.qualified, originalExecutionSucceeded: state.batches.every(batch => batch.matrixExitCode === 0), summaryPath: input.summaryPath };
}

export async function reviewPlan(input) {
  const { state, plan } = await load(input.summaryPath), audit = await readJson(input.reviewPath), review = audit.value;
  requireValue(state.status !== 'running' && review.schemaVersion === 1 && review.planId === state.planId &&
    review.planSha256 === state.planSha256 && Array.isArray(review.slots) && Number.isFinite(Date.parse(review.observedAt)) &&
    Date.parse(review.observedAt) >= Date.parse(state.endedAt) && Date.parse(review.observedAt) <= Date.now() + 30000,
    'Review must identify the completed plan and a subsequent observation.');
  requireValue(review.slots.length === state.slots.length, 'A review must explicitly account for every planned slot.');
  await recheckResults(state, plan);
  try {
  const reviewed = new Set();
  for (const item of review.slots) {
    const slot = state.slots.find(value => value.slotId === item.slotId);
    requireValue(slot && !reviewed.has(item.slotId) && ['none', 'present'].includes(item.manualIntervention), 'Invalid or repeated reviewed slot.');
    reviewed.add(item.slotId); slot.manualIntervention = item.manualIntervention; slot.reviewNotes = item.notes ?? null;
    const reports = [];
    for (const reference of item.videoReports ?? []) {
      requireValue(digestPattern.test(reference.sha256), 'Video verification reference needs a hash.');
      const report = await readJson(path.resolve(path.dirname(audit.path), reference.path)), value = report.value;
      const video = slot.videos?.find(video => video.sha256 === value.inputSha256);
      requireValue(report.sha256 === reference.sha256 && video && value.protocol === 'maestro.harmonyos.recording-verification' && value.schemaVersion === 1 &&
        value.status === 'passed' && value.exitCode === 0 && value.error === null && value.timedOut === false && value.frames > 0 &&
        value.progressEnded === true && value.inputSha256After === video.sha256 &&
        samePath(value.inputPath, path.join(path.dirname(slot.resultPath), ...video.path.split('/'))), 'Video verification does not confirm this original video.');
      if (plan.evidencePolicy.decoderSha256) requireValue(value.decoderSha256 === plan.evidencePolicy.decoderSha256, 'Decoder differs from the plan.');
      requireValue(await hashFile(value.inputPath) === video.sha256, 'The verified video changed.');
      const stderr = await artifact(path.dirname(report.path), value.stderr);
      requireValue((await fs.readFile(stderr, 'utf8')).trim() === '', 'Decoder diagnostics were not empty.');
      reports.push({ path: report.path, sha256: report.sha256, videoSha256: video.sha256 });
    }
    slot.videoReports = reports;
    slot.videoComplete = !plan.evidencePolicy.requireVideo || slot.videos?.length > 0 && slot.videos.every(video => reports.some(report => report.videoSha256 === video.sha256));
  }
  (state.reviews ??= []).push({ path: audit.path, sha256: audit.sha256, observedAt: review.observedAt });
  state.reviewError = null;
  await saveSummary(input.summaryPath, state, plan); return { qualified: state.qualified, groups: state.groups };
  } catch (error) {
    // Keep the fresh evidence check visible even when a later review attachment fails.
    state.reviewError = error.message;
    for (const slot of state.slots) { slot.manualIntervention = 'unknown'; slot.videoComplete = !plan.evidencePolicy.requireVideo; }
    await saveSummary(input.summaryPath, state, plan);
    throw error;
  }
}

export async function dispatch(input) {
  if (input.operation === 'freeze') return freezePlan(input.planPath, input.outputDirectory, input.projectRoot);
  if (input.operation === 'start') return startBatch(input);
  if (input.operation === 'import') return importBatch(input);
  if (input.operation === 'skip') return skipBatch(input);
  if (input.operation === 'finish') return finishPlan(input);
  if (input.operation === 'review') return reviewPlan(input);
  throw new Error('Unknown validation operation.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const input = (await readJson(process.argv[2])).value; process.stdout.write(JSON.stringify(await dispatch(input)) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
