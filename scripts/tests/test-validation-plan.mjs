import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { freezePlan, minimumCount, checkFrozen } from '../validation/plan.mjs';
import { startBatch, importBatch, finishPlan, reviewPlan } from '../validation/main.mjs';
import { verifyTrace } from '../validation/retry-evidence.mjs';
import { hash, hashFile, readJson } from '../validation/io.mjs';
import { fixturePlan, writeMatrixFixture, traceFixture, json } from './validation-fixture.mjs';

async function setup(t, options = {}, modify = () => {}) {
  const testRoot = path.resolve('artifacts/validation-unit-tests'); await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(() => { assert.equal(path.dirname(root), testRoot); return fs.rm(root, { recursive: true, force: true }); });
  const source = await fixturePlan(root, options); await modify(source.plan, root); await json(source.file, source.plan);
  const output = path.join(root, 'output'), project = path.join(root, 'project'); await fs.mkdir(project);
  const result = await freezePlan(source.file, output, project);
  const plan = (await readJson(result.snapshotPath)).value;
  return { root, output, project, source, plan, ...result };
}

async function execute(context, modes = [], index = 0, edit = async () => {}) {
  const batch = context.batches[index], outputDirectory = path.join(context.output, batch.batchId);
  const pointerPath = path.join(outputDirectory, 'pointer.json'), controlIndexPath = path.join(context.root, 'controls', batch.batchId, 'control-index.json');
  const started = await startBatch({ summaryPath: context.summaryPath, batchId: batch.batchId, outputDirectory, pointerPath, controlIndexPath });
  const recoveryRoot = path.join(context.root, 'recovery');
  const generated = await writeMatrixFixture({ plan: context.plan, ...started, outputDirectory, pointerPath, controlIndexPath, recoveryRoot, modes });
  await edit(generated, { pointerPath, controlIndexPath });
  const imported = await importBatch({ summaryPath: context.summaryPath, batchId: batch.batchId, matrixExitCode: generated.matrixExitCode, recoveryRoot });
  return { ...generated, imported, state: (await readJson(context.summaryPath)).value };
}

async function review(context, intervention = 'none') {
  const finished = await finishPlan({ summaryPath: context.summaryPath, interrupted: false });
  const state = (await readJson(context.summaryPath)).value;
  const file = path.join(context.root, 'review.json');
  await json(file, { schemaVersion: 1, planId: state.planId, planSha256: state.planSha256, observedAt: new Date().toISOString(),
    slots: state.slots.map(slot => ({ slotId: slot.slotId, manualIntervention: intervention })) });
  return { finished, reviewed: await reviewPlan({ summaryPath: context.summaryPath, reviewPath: file }) };
}

test('freezes every denominator slot before dispatch and uses exact decimal ceilings', async t => {
  const context = await setup(t, { repeat: 3, units: 2 });
  const state = (await readJson(context.summaryPath)).value;
  assert.equal(state.slots.length, 6); assert.equal(state.slots.every(slot => slot.status === 'pending'), true);
  assert.equal(minimumCount('0.95', 20), 19); assert.equal(minimumCount('0.95', 3), 3);
  assert.equal(minimumCount('0.333333', 3), 1);
  state.slots.pop(); await json(context.summaryPath, state);
  await assert.rejects(finishPlan({ summaryPath: context.summaryPath }), /denominator/);
});

test('all-pass import keeps manual review separate and then qualifies', async t => {
  const context = await setup(t);
  const result = await execute(context);
  assert.deepEqual(result.state.slots.map(slot => [slot.status, slot.reason, slot.firstPassStatus]), [
    ['passed', null, 'passed'], ['passed', null, 'passed']]);
  assert.equal(result.imported.releaseConfirmed, true, result.imported.error);
  assert.equal(result.state.groups[0].qualified, false);
  const outcome = await review(context);
  assert.equal(outcome.finished.originalExecutionSucceeded, true);
  assert.equal(outcome.reviewed.qualified, true);
});

test('recovered retry and original failure produce 18/20 first, 19/20 final without erasing exit failure', async t => {
  const context = await setup(t, { repeat: 20 }, plan => { plan.thresholdPolicy.metric = 'finalPass'; });
  const result = await execute(context, [...Array(18).fill('pass'), 'retry', 'fail']);
  assert.equal(result.state.groups[0].firstPassCount, 18, JSON.stringify(result.state.slots.map(slot => slot.reason)));
  assert.equal(result.state.groups[0].finalPassCount, 19);
  assert.equal(result.imported.stopDevice, false);
  const outcome = await review(context);
  assert.equal(outcome.finished.originalExecutionSucceeded, false);
  assert.equal(outcome.reviewed.groups[0].minimumPassCount, 19);
  assert.equal(outcome.reviewed.qualified, true);
});

test('manual intervention excludes unattended successes but does not rewrite raw results', async t => {
  const context = await setup(t); await execute(context);
  const result = await review(context, 'present');
  assert.equal(result.reviewed.groups[0].finalPassCount, 2);
  assert.equal(result.reviewed.groups[0].unattendedPassCount, 0); assert.equal(result.reviewed.qualified, false);
});

test('each counted unattended success must cover its required scenario', async t => {
  const context = await setup(t, { repeat: 3 }); await execute(context, ['pass', 'skip', 'skip']);
  const result = await review(context);
  assert.equal(result.reviewed.groups[0].finalPassCount, 3);
  assert.equal(result.reviewed.groups[0].unattendedPassCount, 1);
  assert.equal(result.reviewed.qualified, false);
});

test('missing captured evidence cannot become evidence-complete', async t => {
  const context = await setup(t, { repeat: 1 });
  const result = await execute(context, [], 0, async generated => {
    const base = path.dirname(generated.matrix.runs[0].runResultPath), file = path.join(base, 'evidence-index.json');
    const index = (await readJson(file)).value;
    index.data.entries[0].evidence.push({ kind: 'screenshot', state: 'capture_failed', path: null, sha256: null, capturedAt: null, phase: 'after', error: 'fixture capture failed' });
    await json(file, index);
    const manifestPath = path.join(base, 'agent-manifest.json'), manifest = (await readJson(manifestPath)).value;
    manifest.files.find(item => item.path === 'evidence-index.json').sha256 = await hashFile(file); await json(manifestPath, manifest);
  });
  assert.equal(result.state.slots[0].finalPass, true, result.state.slots[0].reason);
  assert.equal(result.state.slots[0].evidenceComplete, false);
  assert.equal((await review(context)).reviewed.qualified, false);
});

test('review recomputes automatic fields and rejects deleted evidence after import', async t => {
  const context = await setup(t, { repeat: 2 }); const result = await execute(context, ['retry', 'pass']);
  let state = (await readJson(context.summaryPath)).value;
  state.slots[0].firstPassStatus = 'passed'; state.slots[0].coverageComplete = true; await json(context.summaryPath, state);
  let outcome = await review(context);
  assert.equal(outcome.reviewed.groups[0].firstPassCount, 1);
  await fs.unlink(path.join(path.dirname(result.matrix.runs[1].runResultPath), 'junit.xml'));
  outcome = await review(context);
  assert.equal(outcome.reviewed.groups[0].finalPassCount, 1);
  assert.equal(outcome.reviewed.groups[0].unknown, 1); assert.equal(outcome.reviewed.qualified, false);
});

test('missing retained cleanup receipt prevents qualification while preserving raw pass', async t => {
  const context = await setup(t, { repeat: 1 }); const result = await execute(context);
  await fs.unlink(result.imported.release.reportPath);
  const reviewed = (await review(context)).reviewed;
  assert.equal(reviewed.groups[0].finalPassCount, 1); assert.equal(reviewed.qualified, false);
  assert.equal((await readJson(context.summaryPath)).value.batches[0].releaseConfirmed, false);
});

test('finish cannot substitute hand-edited fields for an explicit review', async t => {
  const context = await setup(t, { repeat: 1 }); await execute(context);
  const state = (await readJson(context.summaryPath)).value;
  state.slots[0].manualIntervention = 'none'; await json(context.summaryPath, state);
  assert.equal((await finishPlan({ summaryPath: context.summaryPath, interrupted: false })).qualified, false);
});

test('required video stays incomplete until a matching complete decode report is reviewed', async t => {
  const context = await setup(t, { repeat: 1 }, plan => { plan.evidencePolicy.requireVideo = true; });
  let videoPath, videoSha256;
  await execute(context, [], 0, async generated => {
    const base = path.dirname(generated.matrix.runs[0].runResultPath), file = path.join(base, 'evidence-index.json');
    videoPath = path.join(base, 'fixture.mp4'); await fs.writeFile(videoPath, 'synthetic video bytes'); videoSha256 = await hashFile(videoPath);
    const index = (await readJson(file)).value;
    index.data.entries[0].evidence.push({ kind: 'video', state: 'available', path: 'fixture.mp4', sha256: videoSha256, capturedAt: new Date().toISOString(), phase: 'after', error: null });
    await json(file, index);
    const manifestPath = path.join(base, 'agent-manifest.json'), manifest = (await readJson(manifestPath)).value;
    manifest.files.find(item => item.path === 'evidence-index.json').sha256 = await hashFile(file); await json(manifestPath, manifest);
  });
  assert.equal((await review(context)).reviewed.qualified, false);
  const reportPath = path.join(context.root, 'decode', 'verification.json');
  await json(reportPath, { protocol: 'maestro.harmonyos.recording-verification', schemaVersion: 1, status: 'passed', exitCode: 0,
    inputPath: videoPath, inputSha256: videoSha256, inputSha256After: videoSha256, error: null, timedOut: false, frames: 3, progressEnded: true, stderr: 'stderr.log' });
  await fs.writeFile(path.join(context.root, 'decode', 'stderr.log'), '');
  const reviewPath = path.join(context.root, 'review.json'), audit = (await readJson(reviewPath)).value;
  audit.slots[0].videoReports = [{ path: reportPath, sha256: await hashFile(reportPath) }]; await json(reviewPath, audit);
  assert.equal((await reviewPlan({ summaryPath: context.summaryPath, reviewPath })).qualified, true);
  await fs.appendFile(videoPath, 'changed');
  await assert.rejects(reviewPlan({ summaryPath: context.summaryPath, reviewPath }), /original video|changed/);
  assert.equal((await readJson(context.summaryPath)).value.qualified, false);
});

test('missing retry trace preserves trusted final result and leaves first pass unknown', async t => {
  const context = await setup(t, { repeat: 1 }); const result = await execute(context, ['missing-trace']);
  assert.equal(result.state.slots[0].finalPass, true);
  assert.equal(result.state.slots[0].firstPassStatus, 'unknown');
  assert.equal(result.state.slots[0].retryComplete, false);
  assert.equal((await review(context)).reviewed.qualified, false);
});

test('cancelled and undispatched rounds stay in denominator and stop the next unit', async t => {
  const context = await setup(t, { units: 2 }); const result = await execute(context, ['cancel', 'not-run']);
  assert.equal(result.state.groups[0].planned, 2); assert.equal(result.state.groups[0].cancelled, 1);
  assert.equal(result.state.groups[0].notRun, 1); assert.equal(result.imported.stopDevice, true);
  await assert.rejects(execute(context, [], 1), /stopped earlier batch/);
  await finishPlan({ summaryPath: context.summaryPath, interrupted: true });
  const state = (await readJson(context.summaryPath)).value;
  assert.equal(state.groups[1].planned, 2); assert.equal(state.groups[1].notRun, 2);
});

test('unconfirmed cleanup retains raw success and blocks subsequent dispatch', async t => {
  const context = await setup(t, { repeat: 1, units: 2 }); const result = await execute(context, ['unknown-cleanup']);
  assert.equal(result.state.slots[0].finalPass, true); assert.equal(result.imported.releaseConfirmed, false);
  await assert.rejects(execute(context, [], 1), /stopped earlier batch/);
});

test('changed core evidence invalidates success and clean handoff', async t => {
  const context = await setup(t, { repeat: 1 });
  const result = await execute(context, [], 0, async generated => {
    const run = generated.matrix.runs[0]; await fs.appendFile(path.join(path.dirname(run.runResultPath), 'input.json'), ' ');
  });
  assert.equal(result.state.slots[0].status, 'unknown'); assert.equal(result.state.slots[0].finalPass, false);
  assert.equal(result.imported.releaseConfirmed, false);
});

test('a returned control cannot change the observed agent status', async t => {
  const context = await setup(t, { repeat: 1 });
  const result = await execute(context, [], 0, async (generated, files) => {
    const index = (await readJson(files.controlIndexPath)).value, file = index.entries[0].controlRecordPath;
    const control = (await readJson(file)).value; control.agentStatus = 'failed'; await json(file, control);
  });
  assert.equal(result.state.slots[0].status, 'unknown'); assert.equal(result.imported.stopDevice, true);
});

test('source changes, output overlap, and unconfirmed formal plans are rejected before execution', async t => {
  const context = await setup(t);
  await fs.appendFile(context.plan.units[0].entry, '# changed'); await assert.rejects(checkFrozen(context.plan), /sources changed/);
  await assert.rejects(freezePlan(context.source.file, context.plan.units[0].sourceRoot, context.project), /outside/);
  context.source.plan.purpose = 'formal'; await json(context.source.file, context.source.plan);
  await assert.rejects(freezePlan(context.source.file, path.join(context.root, 'formal'), context.project), /confirmed scope/);
});

test('suite counts one invocation per round and requires all declared top-level members', async t => {
  const context = await setup(t, { repeat: 1, mode: 'suite' }, async (plan, root) => {
    const second = path.join(root, 'flows', '0', 'second.yaml'); await fs.writeFile(second, 'appId: fixture\n---\n- assertTrue: true\n');
    plan.units[0].requiredTopLevelFlows.push({ path: second, name: 'second', requiredSteps: [{ path: second, commandIndex: 0, role: 'assertion' }] });
  });
  const result = await execute(context, ['suite-missing']);
  assert.equal(result.state.groups[0].planned, 1); assert.equal(result.state.slots[0].finalPass, true);
  assert.equal(result.state.slots[0].retryComplete, false); assert.equal((await review(context)).reviewed.qualified, false);
});

test('workspace-config suites are rejected before dispatch and effective module is frozen', async t => {
  const context = await setup(t, { repeat: 1, mode: 'suite' });
  await fs.writeFile(path.join(context.plan.units[0].entry, 'config.yaml'), 'flows:\n  - flow.yaml\n');
  await assert.rejects(freezePlan(context.source.file, path.join(context.root, 'another'), context.project), /workspace config/);
  await fs.unlink(path.join(context.plan.units[0].entry, 'config.yaml'));
  const result = await freezePlan(context.source.file, path.join(context.root, 'module'), context.project, { MAESTRO_HARMONYOS_MODULE: 'entry' });
  assert.equal((await readJson(result.snapshotPath)).value.profiles.fixture.moduleName, 'entry');
});

test('raw skipped assertion is not required scenario coverage', async t => {
  const context = await setup(t, { repeat: 1 }); const result = await execute(context, ['skip']);
  assert.equal(result.state.slots[0].coverageComplete, false); assert.equal(result.state.slots[0].retryComplete, true);
  assert.equal((await review(context)).reviewed.qualified, false);
});

test('trace verifies attempt context, sequence, terminal state and unique v1 step identity', () => {
  const identity = { protocol: 'maestro.harmonyos.retry-trace', schemaVersion: 1, runId: randomUUID(), attemptId: randomUUID(), flowExecutionId: randomUUID(), flowPath: 'flow.yaml', flowSha256: hash(Buffer.from('flow')) };
  const fixture = traceFixture(identity, { sha256: identity.flowSha256 }, 'retry');
  const evidence = new Map(fixture.entries.map(step => [step.stepId, step]));
  const hashes = new Set([identity.flowSha256]);
  assert.equal(verifyTrace(fixture.summary, fixture.events, evidence, hashes).retryUsed, true);
  const mutation = structuredClone(fixture.events); mutation.find(event => event.event === 'stepStarted' && event.retryContext.length).retryContext[0].tryNo = 2;
  assert.throws(() => verifyTrace(fixture.summary, mutation, evidence, hashes));
  const gap = structuredClone(fixture.events); gap[2].sequence++;
  assert.throws(() => verifyTrace(fixture.summary, gap, evidence, hashes));
  assert.throws(() => verifyTrace(fixture.summary, fixture.events.slice(0, -1), evidence, hashes));
});
