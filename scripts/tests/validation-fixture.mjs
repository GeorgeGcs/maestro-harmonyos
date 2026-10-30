import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hash, hashFile } from '../validation/io.mjs';

export async function json(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2)); }
const document = (kind, data) => ({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, revision: 1, observedAt: new Date().toISOString(), data });

// Metadata-only fixtures. These JAR/HAP bytes are never dispatched to a device.
export async function fixtureRuntime(project) {
  const home = path.join(project, '.upstream/maestro/maestro-cli/build/install/maestro');
  await fs.mkdir(path.join(home, 'lib'), { recursive: true });
  await fs.mkdir(path.join(home, 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, 'bin/maestro.bat'), 'synthetic launcher placeholder');
  await fs.writeFile(path.join(home, 'lib/dependency.jar'), 'synthetic dependency');
  return home;
}

export async function fixturePreparation(root, plan, hap) {
  const profile = plan.profiles.fixture;
  profile.applicationVersion = { versionCode: '1', versionName: '1.0-test' };
  const stamp = new Date().toISOString(), references = {};
  for (const name of ['install', 'package', 'prepare']) {
    const file = path.join(root, name + '.txt');
    await fs.writeFile(file, 'Synthetic ' + name + ' evidence for host tests; no app installed.');
    references[name] = { path: file, sha256: await hashFile(file) };
  }
  const value = { protocol: 'maestro.harmonyos.validation-preparation', schemaVersion: 1,
    preparationId: randomUUID(), planId: plan.planId, profileId: 'fixture', deviceId: 'fixture-device',
    application: { bundleId: profile.bundleId, abilityName: profile.abilityName, moduleName: profile.moduleName,
      ...profile.applicationVersion, hap },
    installation: { basis: 'operator_attested', installedAt: stamp, record: references.install },
    packageObservation: { basis: 'operator_attested', observedAt: stamp, bundleId: profile.bundleId,
      ...profile.applicationVersion, record: references.package },
    preparation: { basis: 'operator_attested', completedAt: stamp,
      procedureSha256: hash(Buffer.from(plan.preparationProcedure)), record: references.prepare } };
  const file = path.join(root, 'preparation.json'); await json(file, value);
  plan.preparations = [{ path: file, sha256: await hashFile(file) }];
  return { file, value };
}

export async function fixturePlan(root, { repeat = 2, mode = 'per-flow', units = 1 } = {}) {
  const flows = path.join(root, 'flows'); await fs.mkdir(flows, { recursive: true });
  const definitions = [];
  for (let index = 0; index < units; index++) {
    const directory = path.join(flows, String(index)); await fs.mkdir(directory);
    const source = path.join(directory, 'flow.yaml'); await fs.writeFile(source, 'appId: org.example.fixture\n---\n- assertTrue: true\n');
    definitions.push({ unitId: 'unit-' + index, profile: 'fixture', entry: mode === 'suite' ? directory : source, sourceRoot: directory,
      requiredTopLevelFlows: [{ path: source, name: 'fixture-' + index, requiredSteps: [{ path: source, commandIndex: 0, role: 'assertion' }] }] });
  }
  const plan = { schemaVersion: 1, planId: 'fixture', status: 'frozen', purpose: 'development', measurementMode: mode,
    repeat, runTimeoutSeconds: 5, thresholdPolicy: { metric: 'firstPass', minimumRate: '0.95' },
    profiles: { fixture: { bundleId: 'org.example.fixture', abilityName: 'EntryAbility', moduleName: null, environmentNames: [] } },
    devices: [{ deviceId: 'fixture-device' }], units: definitions, buildFingerprint: { files: [] }, applicationFingerprint: { files: [] },
    preparationProcedure: 'Reset the synthetic fixture before each round.', retryPolicy: 'One explicit retry in recovery fixtures.',
    evidencePolicy: { requireVideo: false }, manualInterventionPolicy: 'review-required' };
  const file = path.join(root, 'source-plan.json'); await json(file, plan); return { plan, file };
}

export function traceFixture(identity, source, mode = 'pass') {
  const events = [{ ...identity, event: 'traceStarted' }], entries = [], starts = [], counts = {}, coverage = {};
  const flowId = identity.flowExecutionId;
  const emit = (event, values = {}) => { const sequence = events.length - 1; events.push({ event, sequence, elapsedNanos: sequence * 100,
    flowExecutionId: flowId, ...values }); };
  function start(commandName, context, commandIndex = 0) {
    const executionSequence = starts.length, stepId = randomUUID();
    const fields = { stepId, executionSequence, parentExecutionSequence: context.length ? 0 : null,
      sourcePath: 'sources/' + source.sha256 + '.yaml', sourceSha256: source.sha256, commandIndex, commandName,
      sourceOffset: 0, sourceOrigin: 'yaml', commandOptional: false, selectorOptional: false,
      retryContext: context, flowScopeOwner: context.length ? 0 : null, phase: 'body', optionalAncestorSequences: [] };
    starts.push(fields); emit('stepStarted', fields); return fields;
  }
  function finish(fields, outcome) {
    emit('stepFinished', { ...fields, outcome, error: outcome === 'Failed' ? { class: 'AssertionFailure', message: 'fixture' } : null });
    counts[outcome] = (counts[outcome] ?? 0) + 1; (coverage[outcome] ??= []).push(fields.executionSequence);
    entries.push({ stepId: fields.stepId, source: { flow: fields.sourcePath, commandIndex: fields.commandIndex, commandName: fields.commandName },
      status: outcome === 'Completed' ? 'passed' : ['Skipped', 'Warned'].includes(outcome) ? 'skipped' : 'failed',
      error: outcome === 'Failed' ? { kind: 'assertion', code: 'ASSERTION_FAILED', message: 'fixture' } : null, evidence: [] });
  }
  if (mode === 'retry') {
    const owner = start('RetryCommand', [], 1), retryInvocationId = randomUUID();
    const block = { retryInvocationId, retryCommandStepId: owner.stepId, executionSequence: 0, parentRetryInvocationId: null,
      parentTryNo: null, retryContext: [], maxRetries: 1, optional: false };
    emit('retryBlockStarted', { ...block, tryNo: null, outcome: null, error: null });
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      emit('retryTryStarted', { ...block, tryNo, outcome: null, error: null });
      finish(start('AssertConditionCommand', [{ retryInvocationId, retryCommandStepId: owner.stepId, tryNo }]), tryNo === 1 ? 'Failed' : 'Completed');
      emit('retryTryFinished', { ...block, tryNo, outcome: tryNo === 1 ? 'failed' : 'completed', error: null });
      if (tryNo === 1) emit('retryScheduled', { ...block, tryNo: 2, outcome: null, error: null });
    }
    emit('retryBlockFinished', { ...block, tryNo: null, outcome: 'completed', error: null }); finish(owner, 'Completed');
  } else finish(start('AssertConditionCommand', []), mode === 'fail' ? 'Failed' : mode === 'skip' ? 'Skipped' : 'Completed');
  const expectedEventCount = events.length - 1 + 2;
  emit('flowFinished', { success: mode !== 'fail', error: null, expectedEventCount, lastExecutionSequence: starts.length - 1 });
  emit('traceCompleted', { expectedEventCount });
  const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const summary = { ...identity, state: 'complete', traceCompleted: true, tracePath: 'retry-trace.jsonl', traceSha256: hash(bytes),
    eventCount: expectedEventCount, expectedEventCount, stepCount: starts.length, retryUsed: mode === 'retry', optionalRetryUsed: false,
    firstPassStatus: ['retry', 'fail'].includes(mode) ? 'not_passed' : 'passed', outcomeCounts: counts, coverageIndex: coverage, error: null };
  return { summary, events, bytes, entries };
}

export async function writeGate(root, deviceId) {
  const sessionId = randomUUID(), recoveryId = randomUUID(), generation = randomUUID(), deviceKey = hash(Buffer.from(deviceId));
  const directory = path.join(root, deviceKey, sessionId, 'recoveries');
  const snapshotPath = path.join(directory, recoveryId + '-recordings.json');
  await json(snapshotPath, { schemaVersion: 1, deviceId, ownerId: sessionId, generation,
    remoteRoot: '/data/local/tmp/maestro-session-' + generation, resources: [] });
  const reportPath = path.join(directory, recoveryId + '.json');
  await json(reportPath, { schemaVersion: 2, deviceId, sessionId, recoveryId, state: 'complete', reason: 'session_close', observedAt: new Date().toISOString(),
    operations: 1, pendingOperations: 0, temporaryFiles: 0, issues: [], unresolvedRecording: false, closeFailure: null,
    recordingResources: { path: snapshotPath, sha256: await hashFile(snapshotPath) } });
  await json(path.join(root, deviceKey + '.owner.json'), { schemaVersion: 1, deviceId, ownerSessionId: sessionId, state: 'clean',
    requiresRecovery: false, unresolvedRecording: false, closeFailure: null, reportPath, reportSha256: await hashFile(reportPath) });
}

export async function writeMatrixFixture(input) {
  const { plan, batch, unit, profile, outputDirectory, pointerPath, controlIndexPath, recoveryRoot, modes = [] } = input;
  const matrixRoot = path.join(outputDirectory, 'matrix-fixture'), agentRoot = path.join(matrixRoot, 'agent'), runId = randomUUID();
  await fs.mkdir(matrixRoot, { recursive: true });
  const runs = [], controls = [];
  for (let round = 1; round <= plan.repeat; round++) {
    const mode = modes[round - 1] ?? 'pass', attemptId = randomUUID(), base = path.join(agentRoot, 'runs', runId, attemptId);
    const resultPath = path.join(base, 'result.json'), controlRecordPath = path.join(path.dirname(controlIndexPath), attemptId + '.json');
    const status = mode === 'fail' ? 'failed' : mode === 'cancel' ? 'cancelled' : mode === 'not-run' ? 'not-run' : 'passed';
    const stamp = new Date().toISOString();
    const run = { deviceKey: 'device-01', round, status, startedAt: mode === 'not-run' ? null : stamp, finishedAt: stamp,
      cliExitCode: status === 'passed' ? 0 : status === 'not-run' ? null : 1, reason: null, manualIntervention: 'unknown',
      runId, attemptId, deviceId: batch.deviceId, runResultPath: resultPath, cleanup: { state: mode === 'unknown-cleanup' ? 'unknown' : 'complete', errors: [] } };
    runs.push(run); controls.push({ deviceId: batch.deviceId, runId, attemptId, attemptNo: round, controlRecordPath, dispatchState: mode === 'not-run' ? 'planned' : 'returned' });
    if (mode === 'not-run') continue;
    await fs.mkdir(base, { recursive: true });
    const inputObject = { kind: 'flow', deviceId: batch.deviceId, request: { configuration: { ability: profile.abilityName, module: profile.moduleName,
      environment: { APP_ID: profile.bundleId } }, sources: [{ path: unit.entry, files: await Promise.all(unit.sources.map(async source => ({
        path: source.path, sha256: source.sha256, content: await fs.readFile(source.path, 'utf8'), dependencies: [] }))) }] } };
    await json(path.join(base, 'input.json'), inputObject);
    const entries = [], manifests = ['agent-manifest.json'];
    for (const [flowIndex, flow] of unit.requiredTopLevelFlows.entries()) {
      if (mode === 'suite-missing' && flowIndex > 0) continue;
      const directory = path.join(base, 'flows', 'flow-' + flowIndex); await fs.mkdir(directory, { recursive: true });
      const identity = { protocol: 'maestro.harmonyos.retry-trace', schemaVersion: 1, runId, attemptId,
        flowExecutionId: randomUUID(), flowPath: flow.path, flowSha256: flow.sha256 };
      const trace = traceFixture(identity, flow, mode === 'cancel' ? 'fail' : mode);
      await fs.mkdir(path.join(base, 'sources'), { recursive: true });
      await fs.copyFile(flow.path, path.join(base, 'sources', flow.sha256 + '.yaml'));
      entries.push(...trace.entries);
      const nativeFiles = [];
      if (mode !== 'missing-trace') {
        await fs.writeFile(path.join(directory, 'retry-trace.jsonl'), trace.bytes);
        await json(path.join(directory, 'retry-summary.json'), trace.summary);
        for (const name of ['retry-trace.jsonl', 'retry-summary.json']) {
          const relative = 'flows/flow-' + flowIndex + '/' + name, digest = await hashFile(path.join(base, relative));
          entries.push({ stepId: null, source: null, status: 'passed', error: null,
            evidence: [{ kind: 'log', state: 'available', path: relative, sha256: digest, capturedAt: stamp, phase: 'after', error: null }] });
          nativeFiles.push({ kind: 'MAESTRO_LOG', format: 'TXT', relativePath: name, sizeBytes: (await fs.stat(path.join(directory, name))).size });
        }
      }
      await json(path.join(directory, 'manifest.json'), { entries: nativeFiles }); manifests.push('flows/flow-' + flowIndex + '/manifest.json');
    }
    await fs.writeFile(path.join(base, 'junit.xml'), '<testsuites><testsuite tests="1"/></testsuites>');
    const data = { runId, attemptId, attemptNo: round, deviceId: batch.deviceId, sessionId: null,
      input: { kind: 'flow', path: 'input.json', sha256: await hashFile(path.join(base, 'input.json')) }, flow: null,
      status, startedAt: stamp, endedAt: stamp, effects: 'none', error: status === 'passed' ? null : { kind: status === 'cancelled' ? 'cancelled' : 'assertion', code: 'FIXTURE', message: 'fixture' },
      failedStepId: null, cleanup: run.cleanup, artifacts: { baseDir: base, evidenceIndexPath: 'evidence-index.json', manifestPaths: manifests, junitPath: 'junit.xml' } };
    await json(resultPath, document('runResult', data));
    await json(path.join(base, 'evidence-index.json'), document('evidenceIndex', { runId, attemptId, entries }));
    await json(path.join(base, 'state.json'), { data }); await json(path.join(base, 'registration.json'), { sha256: data.input.sha256, data });
    const required = ['input.json', 'result.json', 'evidence-index.json', 'state.json', 'registration.json', 'junit.xml', ...manifests.slice(1)];
    await json(path.join(base, 'agent-manifest.json'), { schemaVersion: 1, runId, attemptId, files: await Promise.all(required.map(async relative => ({ path: relative, sha256: await hashFile(path.join(base, relative)) }))) });
    await json(controlRecordPath, { protocol: 'maestro.harmonyos.runner-control', schemaVersion: 1, runId, attemptId, deviceId: batch.deviceId,
      executable: plan.runtime?.java.path, runtime: plan.runtime ? { schemaVersion: 1, cliHome: plan.runtime.cliHome,
        classpathArgument: plan.runtime.classpathArgument, java: plan.runtime.java, powershell: plan.runtime.powershell,
        classpath: plan.runtime.classpath, configuration: plan.runtime.configuration } : undefined,
      phase: 'exited', processExitObserved: true, processExitCode: run.cliExitCode, wrapperExitCode: run.cliExitCode, agentStatus: status,
      terminationRequested: false, stopReason: null, error: null, stdoutComplete: true, stderrComplete: true,
      runResultPath: resultPath, process: { pid: 99999999, startTimeTicks: 1, executable: plan.runtime?.java.path ?? 'fixture' } });
  }
  const files = plan.measurementMode === 'suite' ? unit.sources.filter(file => path.dirname(file.path) === unit.entry || file.path.startsWith(unit.entry + path.sep)) : unit.sources.filter(file => file.path === unit.entry);
  const matrix = { schemaVersion: 1, status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null,
    host: {}, build: { implementationJars: [] }, input: { flowPath: unit.entry, files, bundleId: profile.bundleId, abilityName: profile.abilityName,
      moduleName: profile.moduleName, environmentKeys: profile.environmentNames, repeat: plan.repeat },
    devices: [{ key: 'device-01', id: batch.deviceId, info: {}, runId }], runs };
  await json(path.join(matrixRoot, 'matrix.json'), matrix);
  await json(controlIndexPath, { protocol: 'maestro.harmonyos.control-index', schemaVersion: 1, invocationId: batch.batchId, matrixRoot, entries: controls });
  await json(pointerPath, { protocol: 'maestro.harmonyos.matrix-pointer', schemaVersion: 1, matrixDirectory: matrixRoot, reportPath: path.join(matrixRoot, 'matrix.json') });
  await writeGate(recoveryRoot, batch.deviceId);
  return { matrixRoot, agentRoot, matrix, matrixExitCode: runs.every(run => run.status === 'passed') ? 0 : 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  if (input.operation === 'source-plan') {
    process.stdout.write(JSON.stringify(await fixturePlan(input.root, input.options)));
  } else {
    const plan = JSON.parse(await fs.readFile(path.join(path.dirname(input.artifacts), 'plan.json'), 'utf8'));
    const batch = plan.batches.find(batch => batch.batchId === input.invocationId), unit = plan.units.find(unit => unit.unitId === batch.unitId);
    if (input.repeat !== plan.repeat || input.deviceId !== batch.deviceId || input.flowPath !== unit.entry) throw new Error('Wrapper dispatched different inputs.');
    const result = await writeMatrixFixture({ plan, batch, unit, profile: plan.profiles[unit.profile], outputDirectory: input.artifacts,
      pointerPath: input.pointerPath, controlIndexPath: path.join(input.controlDirectory, 'control-index.json'),
      recoveryRoot: input.recoveryRoot, modes: input.modes });
    process.exitCode = result.matrixExitCode;
  }
}
