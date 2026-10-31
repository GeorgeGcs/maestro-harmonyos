import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { freezePlan, minimumCount, checkFrozen } from '../validation/plan.mjs';
import { startBatch, importBatch, finishPlan, reviewPlan } from '../validation/main.mjs';
import { verifyTrace } from '../validation/retry-evidence.mjs';
import { hash, hashFile, readJson } from '../validation/io.mjs';
import { fixturePlan, fixtureRuntime, fixturePreparation, writeMatrixFixture, traceFixture, json } from './validation-fixture.mjs';

async function setup(t, options = {}, modify = () => {}) {
  const testRoot = path.resolve('artifacts/validation-unit-tests'); await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(() => { assert.equal(path.dirname(root), testRoot); return fs.rm(root, { recursive: true, force: true }); });
  const source = await fixturePlan(root, options);
  const output = path.join(root, 'output'), project = path.join(root, 'project'); await fs.mkdir(project);
  await fixtureRuntime(project); await modify(source.plan, root, project); await json(source.file, source.plan);
  const runtimeOptions = { powershellPath: process.env.TEST_POWERSHELL_PATH ?? process.execPath };
  const result = await freezePlan(source.file, output, project, process.env, runtimeOptions);
  const plan = (await readJson(result.snapshotPath)).value;
  return { root, output, project, source, plan, runtimeOptions, ...result };
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

test('maintenance verifier changes invalidate a frozen validation plan', async t => {
  for (const name of ['verify-maintenance.mjs', 'windows-boot.mjs']) await t.test(name, async t => {
    const context = await setup(t);
    const file = path.join(context.project, 'scripts/recovery', name);
    assert.ok(context.plan.toolFiles.some(item => item.path === file));
    await checkFrozen(context.plan);
    await fs.appendFile(file, '\n// changed after freeze');
    await assert.rejects(checkFrozen(context.plan), /Frozen implementation/);
  });
});

async function sourceIdentityScenario(t, { version = 2, actual = 'A', required = 'B', registered = ['A', 'B'],
  relocated = false, alterEvent = () => {} } = {}) {
  let children;
  const context = await setup(t, { repeat: 1 }, async (plan, root) => {
    const unit = plan.units[0];
    if (relocated) {
      const moved = path.join(root, 'relocated sources');
      await fs.rename(unit.sourceRoot, moved);
      unit.sourceRoot = moved; unit.entry = path.join(moved, 'flow.yaml');
      unit.requiredTopLevelFlows[0].path = unit.entry;
    }
    const directory = path.join(unit.sourceRoot, 'children'); await fs.mkdir(directory);
    children = { A: path.join(directory, 'A.yaml'), B: path.join(directory, 'B.yaml') };
    const source = 'appId: org.example.fixture\n---\n- assertVisible: Child\n';
    for (const file of Object.values(children)) await fs.writeFile(file, source);
    unit.requiredTopLevelFlows[0].requiredSteps = [{ path: children[required], commandIndex: 0, role: 'assertion' }];
  });
  const result = await execute(context, [], 0, async generated => {
    const resultPath = generated.matrix.runs[0].runResultPath, base = path.dirname(resultPath);
    const inputPath = path.join(base, 'input.json'), input = (await readJson(inputPath)).value;
    const files = input.request.sources[0].files;
    const main = files.find(file => file.path === context.plan.units[0].entry);
    main.dependencies = registered.map(name => files.find(file => file.path === children[name]));
    input.request.sources[0].files = [main];
    await json(inputPath, input);
    const sourceHash = await hashFile(children[actual]), sourcePath = 'sources/' + sourceHash + '.yaml';
    await fs.copyFile(children[actual], path.join(base, sourcePath));
    const tracePath = path.join(base, 'flows', 'flow-0', 'retry-trace.jsonl');
    const events = (await fs.readFile(tracePath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    events[0].schemaVersion = version;
    for (const event of events) if (['stepStarted', 'stepFinished', 'stepInterrupted'].includes(event.event)) {
      event.sourcePath = sourcePath; event.sourceSha256 = sourceHash;
      if (version === 2) event.sourceIdentity = children[actual];
      alterEvent(event, children);
    }
    await fs.writeFile(tracePath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    const summaryPath = path.join(base, 'flows', 'flow-0', 'retry-summary.json'), summary = (await readJson(summaryPath)).value;
    summary.schemaVersion = version; summary.traceSha256 = await hashFile(tracePath); await json(summaryPath, summary);
    const indexPath = path.join(base, 'evidence-index.json'), index = (await readJson(indexPath)).value;
    for (const entry of index.data.entries) {
      if (entry.stepId !== null) entry.source.flow = sourcePath;
      for (const evidence of entry.evidence) if (evidence.state === 'available') evidence.sha256 = await hashFile(path.join(base, evidence.path));
    }
    await json(indexPath, index);
    const result = (await readJson(resultPath)).value;
    result.data.input.sha256 = await hashFile(inputPath); await json(resultPath, result);
    await json(path.join(base, 'state.json'), { data: result.data });
    await json(path.join(base, 'registration.json'), { sha256: result.data.input.sha256, data: result.data });
    const manifestPath = path.join(base, 'agent-manifest.json'), manifest = (await readJson(manifestPath)).value;
    for (const file of manifest.files) file.sha256 = await hashFile(path.join(base, file.path));
    await json(manifestPath, manifest);
  });
  return { context, result };
}

const implementationRoles = ['maestro-cli', 'maestro-client', 'maestro-orchestra', 'maestro-orchestra-models'];
async function formalFixture(t, versioned = false) {
  return setup(t, { repeat: 1 }, async (plan, root, project) => {
    plan.schemaVersion = 2; plan.purpose = 'formal';
    const confirmationPath = path.join(root, 'confirmed-scope.txt'), applicationPath = path.join(root, 'fixture.hap');
    await fs.writeFile(confirmationPath, 'Synthetic scope confirmation for host tests only.');
    await fs.writeFile(applicationPath, 'Synthetic application fingerprint; never installed.');
    plan.confirmation = { status: 'confirmed', path: confirmationPath, sha256: await hashFile(confirmationPath) };
    plan.applicationFingerprint.files = [{ path: applicationPath, sha256: await hashFile(applicationPath) }];
    await fixturePreparation(root, plan, plan.applicationFingerprint.files[0]);
    for (const role of implementationRoles) {
      const file = path.join(project, '.upstream/maestro/maestro-cli/build/install/maestro/lib', role + (versioned || role === 'maestro-cli' ? '-2.12.0' : '') + '.jar');
      await fs.writeFile(file, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
      plan.buildFingerprint.files.push({ path: file, sha256: await hashFile(file) });
    }
  });
}

async function executeFormal(context, edit = jars => jars) {
  return execute(context, [], 0, async generated => {
    const jars = context.plan.buildFiles.map(file => ({ file: path.basename(file.path), sha256: file.sha256 }));
    generated.matrix.build.implementationJars = edit(jars);
    await json(path.join(generated.matrixRoot, 'matrix.json'), generated.matrix);
  });
}

test('formal fingerprints accept all four runtime roles with actual mixed names and versioned names', async t => {
  for (const versioned of [false, true]) await t.test(versioned ? 'all versioned' : 'CLI versioned, other runtime JARs unversioned', async t => {
    const context = await formalFixture(t, versioned), result = await executeFormal(context);
    assert.equal(result.imported.status, 'completed', result.imported.error);
    assert.equal(result.imported.releaseConfirmed, true);
    assert.equal(result.state.slots[0].status, 'passed');
    assert.equal((await review(context)).reviewed.qualified, true);
  });
});

test('formal fingerprints reject each missing implementation role', async t => {
  for (const role of implementationRoles) await t.test(role, async t => {
    const context = await formalFixture(t), file = context.plan.buildFiles[implementationRoles.indexOf(role)];
    const result = await executeFormal(context, jars => jars.filter(jar => jar.file !== path.basename(file.path)));
    assert.equal(result.imported.status, 'unknown');
    assert.match(result.imported.error, /must include CLI, client, orchestra, and orchestra-models/);
    assert.equal(result.imported.releaseConfirmed, false); assert.equal(result.imported.stopDevice, true);
    assert.equal(result.state.slots[0].finalPass, false);
  });
});

test('formal fingerprints reject mismatched hashes for every implementation role', async t => {
  for (const [index, role] of implementationRoles.entries()) await t.test(role, async t => {
    const context = await formalFixture(t), result = await executeFormal(context, jars => {
      jars[index].sha256 = hash(Buffer.from('Different runtime bytes: ' + role)); return jars;
    });
    assert.equal(result.imported.status, 'unknown');
    assert.match(result.imported.error, /does not uniquely cover/);
    assert.equal(result.imported.releaseConfirmed, false); assert.equal(result.state.slots[0].finalPass, false);
  });
});

test('formal fingerprints reject duplicate roles even with different runtime filenames', async t => {
  const context = await formalFixture(t), result = await executeFormal(context, jars => [
    ...jars, { file: 'maestro-client-2.12.0.jar', sha256: jars[1].sha256 },
  ]);
  assert.equal(result.imported.status, 'unknown'); assert.match(result.imported.error, /repeats a JAR role: maestro-client/);
  assert.equal(result.imported.releaseConfirmed, false);
});

test('formal fingerprints reject a CLI-only report and changed frozen runtime bytes', async t => {
  const context = await formalFixture(t), result = await executeFormal(context, jars => jars.slice(0, 1));
  assert.equal(result.imported.status, 'unknown'); assert.match(result.imported.error, /must include CLI, client, orchestra, and orchestra-models/);
  const changed = await formalFixture(t);
  await fs.appendFile(changed.plan.buildFiles[1].path, 'changed after freeze');
  await assert.rejects(executeFormal(changed), /Frozen implementation|runtime|classpath|changed/i);
  assert.equal((await readJson(changed.summaryPath)).value.batches[0].status, 'pending');
});

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
  assert.equal(context.plan.schemaVersion, 3);
  assert.equal(outcome.reviewed.formalQualified, false);
});

async function formalReview(context, edit = () => {}) {
  const state = (await readJson(context.summaryPath)).value;
  const entry = context.plan.preparations[0], file = path.join(context.root, 'formal-review.json');
  const audit = { schemaVersion: 2, planId: state.planId, planSha256: state.planSha256, observedAt: new Date().toISOString(),
    slots: state.slots.map(slot => ({ slotId: slot.slotId, manualIntervention: 'none', preparation: {
      preparationSha256: entry.reference.sha256, installationUnchanged: true, preparationUnchanged: true } })) };
  await edit(audit); await json(file, audit);
  return reviewPlan({ summaryPath: context.summaryPath, reviewPath: file });
}

test('formal qualification requires runtime and a v2 preparation review separate from manual intervention', async t => {
  const context = await formalFixture(t); await executeFormal(context);
  const oldReview = await review(context);
  assert.equal(oldReview.reviewed.qualified, true);
  assert.equal(oldReview.reviewed.formalQualified, false);
  const checked = await formalReview(context);
  assert.equal(checked.formalQualified, true);
  const state = (await readJson(context.summaryPath)).value;
  assert.equal(state.slots[0].runtimeVerification.state, 'verified');
  assert.equal(state.slots[0].preparationVerification.basis, 'operator_attested');
  assert.equal(state.groups[0].firstPassCount, 1);
  const changed = await formalReview(context, audit => { audit.slots[0].preparation.preparationUnchanged = false; });
  assert.equal(changed.qualified, true); assert.equal(changed.formalQualified, false);
  assert.equal(changed.groups[0].finalPassCount, 1);
});

test('changed installation evidence cannot qualify, and finish preserves original successful execution', async t => {
  const context = await formalFixture(t); await executeFormal(context);
  await fs.appendFile(context.plan.preparations[0].installation.record.path, '\nchanged evidence');
  const finished = await finishPlan({ summaryPath: context.summaryPath, interrupted: false });
  assert.equal(finished.originalExecutionSucceeded, true); assert.equal(finished.formalQualified, false);
  await assert.rejects(formalReview(context), /hash|fingerprint|changed|differs/i);
  const state = (await readJson(context.summaryPath)).value;
  assert.equal(state.groups[0].firstPassCount, 1); assert.equal(state.groups[0].finalPassCount, 1);
  assert.equal(state.batches[0].releaseConfirmed, true); assert.equal(state.formalQualified, false);
});

test('local HAP changes after execution do not erase native counts during the first import', async t => {
  for (const removed of [false, true]) await t.test(removed ? 'removed' : 'changed', async t => {
    const context = await formalFixture(t);
    const result = await execute(context, [], 0, async generated => {
      generated.matrix.build.implementationJars = context.plan.buildFiles.map(file => ({ file: path.basename(file.path), sha256: file.sha256 }));
      await json(path.join(generated.matrixRoot, 'matrix.json'), generated.matrix);
      const hap = context.plan.applicationFiles[0].path;
      if (removed) await fs.unlink(hap); else await fs.appendFile(hap, 'replaced after CLI exit');
    });
    assert.equal(result.state.groups[0].finalPassCount, 1); assert.equal(result.imported.releaseConfirmed, true);
    assert.equal((await finishPlan({ summaryPath: context.summaryPath })).originalExecutionSucceeded, true);
    await assert.rejects(formalReview(context));
    const state = (await readJson(context.summaryPath)).value;
    assert.equal(state.groups[0].firstPassCount, 1); assert.equal(state.formalQualified, false);
  });
});

test('wrong preparation hash and absent pre-run evidence cannot be supplied by a later review', async t => {
  const context = await formalFixture(t); await executeFormal(context); await review(context);
  await assert.rejects(formalReview(context, audit => { audit.slots[0].preparation.preparationSha256 = '0'.repeat(64); }), /bind|hash/i);
  const development = await setup(t); await execute(development); await review(development);
  const state = (await readJson(development.summaryPath)).value;
  const file = path.join(development.root, 'late-preparation.json');
  await json(file, { schemaVersion: 2, planId: state.planId, planSha256: state.planSha256, observedAt: new Date().toISOString(),
    slots: state.slots.map(slot => ({ slotId: slot.slotId, manualIntervention: 'none', preparation: {
      preparationSha256: '0'.repeat(64), installationUnchanged: true, preparationUnchanged: true } })) });
  await assert.rejects(reviewPlan({ summaryPath: development.summaryPath, reviewPath: file }), /absent at freeze/);
});

test('missing or mismatched executed runtime blocks formal qualification without erasing native pass or release', async t => {
  for (const mode of ['missing', 'dependency', 'java']) await t.test(mode, async t => {
    const context = await formalFixture(t);
    const result = await execute(context, [], 0, async (generated, paths) => {
      generated.matrix.build.implementationJars = context.plan.buildFiles.map(file => ({ file: path.basename(file.path), sha256: file.sha256 }));
      await json(path.join(generated.matrixRoot, 'matrix.json'), generated.matrix);
      const index = (await readJson(paths.controlIndexPath)).value;
      const file = index.entries[0].controlRecordPath, control = (await readJson(file)).value;
      if (mode === 'missing') delete control.runtime;
      else if (mode === 'java') control.runtime.java.sha256 = '0'.repeat(64);
      else control.runtime.classpath.find(file => path.basename(file.path) === 'dependency.jar').sha256 = '0'.repeat(64);
      await json(file, control);
    });
    assert.equal(result.state.slots[0].finalPass, true); assert.equal(result.imported.releaseConfirmed, true);
    await review(context);
    const checked = await formalReview(context);
    assert.equal(checked.qualified, true); assert.equal(checked.formalQualified, false);
    assert.equal(checked.groups[0].finalPassCount, 1); assert.equal(checked.groups[0].runtimeComplete, false);
  });
});

test('historical review checks retained launch identity without rereading replaced runtime bytes', async t => {
  const context = await formalFixture(t); await executeFormal(context); await review(context);
  const dependency = context.plan.runtime.classpath.find(file => path.basename(file.path) === 'dependency.jar');
  await fs.appendFile(dependency.path, 'new installed distribution after old execution');
  assert.equal((await formalReview(context)).formalQualified, true);
  await assert.rejects(checkFrozen(context.plan), /runtime|classpath|changed|differ/i);
});

test('legacy plans retain statistics but cannot dispatch new work or gain formal qualification', async t => {
  const context = await formalFixture(t); await executeFormal(context); await review(context);
  const legacy = structuredClone(context.plan); legacy.schemaVersion = 1; delete legacy.runtime; delete legacy.preparations;
  for (const unit of legacy.units) delete unit.staticInspection;
  for (const profile of Object.values(legacy.profiles)) delete profile.applicationVersion;
  await json(context.snapshotPath, legacy);
  const state = (await readJson(context.summaryPath)).value;
  state.schemaVersion = 1; state.planSha256 = await hashFile(context.snapshotPath);
  delete state.formalEligible; delete state.formalQualified;
  delete state.staticInspectionComplete; delete state.staticInspectionError;
  for (const group of state.groups) for (const name of ['runtimeComplete', 'preparationComplete', 'formalEligible', 'formalQualified', 'staticInspectionComplete']) delete group[name];
  for (const slot of state.slots) { delete slot.runtimeVerification; delete slot.preparationVerification; }
  await json(context.summaryPath, state);
  await assert.rejects(startBatch({ summaryPath: context.summaryPath }), /Legacy frozen v1/);
  assert.equal((await review(context)).reviewed.formalQualified, false);
  assert.equal((await readJson(context.summaryPath)).value.qualified, true);
  assert.equal(Object.hasOwn((await readJson(context.summaryPath)).value, 'formalQualified'), false);
  context.source.plan.schemaVersion = 1; await json(context.source.file, context.source.plan);
  await assert.rejects(freezePlan(context.source.file, path.join(context.root, 'new'), context.project, process.env, context.runtimeOptions), /New formal execution requires a v2/);
});

test('historical v2 retains its qualification rules but cannot dispatch or acquire a static guarantee', async t => {
  const context = await formalFixture(t); await executeFormal(context); await review(context);
  const legacy = structuredClone(context.plan); legacy.schemaVersion = 2;
  for (const unit of legacy.units) delete unit.staticInspection;
  await json(context.snapshotPath, legacy);
  const state = (await readJson(context.summaryPath)).value;
  state.schemaVersion = 2; state.planSha256 = await hashFile(context.snapshotPath);
  delete state.staticInspectionComplete; delete state.staticInspectionError;
  for (const group of state.groups) delete group.staticInspectionComplete;
  await json(context.summaryPath, state);
  const before = await hashFile(context.snapshotPath);
  await assert.rejects(startBatch({ summaryPath: context.summaryPath }), /Legacy frozen v1\/v2/);
  assert.equal((await formalReview(context)).formalQualified, true);
  const checked = (await readJson(context.summaryPath)).value;
  assert.equal(checked.schemaVersion, 2); assert.equal(checked.qualified, true);
  assert.equal(Object.hasOwn(checked, 'staticInspectionComplete'), false);
  assert.equal(Object.hasOwn(checked.groups[0], 'staticInspectionComplete'), false);
  assert.equal(await hashFile(context.snapshotPath), before);
});

test('v3 missing static evidence blocks qualification while preserving native pass and release', async t => {
  for (const when of ['before-import', 'before-review']) await t.test(when, async t => {
    const context = await formalFixture(t);
    const evidence = context.plan.units[0].staticInspection.evidenceFiles.find(file => file.path.endsWith('static-flows.json'));
    const remove = () => fs.unlink(evidence.path);
    await execute(context, [], 0, async generated => {
      generated.matrix.build.implementationJars = context.plan.buildFiles.map(file => ({ file: path.basename(file.path), sha256: file.sha256 }));
      await json(path.join(generated.matrixRoot, 'matrix.json'), generated.matrix);
      if (when === 'before-import') await remove();
    });
    if (when === 'before-review') await remove();
    await review(context); const checked = await formalReview(context);
    assert.equal(checked.qualified, false); assert.equal(checked.formalQualified, false);
    const state = (await readJson(context.summaryPath)).value;
    assert.equal(state.staticInspectionComplete, false); assert.ok(state.staticInspectionError);
    assert.equal(state.slots[0].status, 'passed'); assert.equal(state.slots[0].finalPass, true);
    assert.equal(state.slots[0].firstPassStatus, 'passed'); assert.equal(state.slots[0].cleanup.state, 'complete');
    assert.equal(state.batches[0].releaseConfirmed, true); assert.equal(state.batches[0].matrixExitCode, 0);
    assert.equal(state.groups[0].complete, false);
  });
});

test('a v3 label and claimed passed flag cannot substitute for retained static evidence', async t => {
  const context = await setup(t, { repeat: 1 });
  const plan = structuredClone(context.plan);
  plan.units[0].staticInspection = { status: 'passed', scriptsExecuted: false };
  await json(context.snapshotPath, plan);
  const state = (await readJson(context.summaryPath)).value; state.planSha256 = await hashFile(context.snapshotPath);
  await json(context.summaryPath, state);
  await assert.rejects(startBatch({ summaryPath: context.summaryPath }), /Static inspection/);
  assert.equal((await readJson(context.summaryPath)).value.batches[0].status, 'pending');
});

test('a last static check failure stops dispatch after the first check succeeded', async t => {
  for (const change of ['remove', 'modify']) await t.test(change, async t => {
    const context = await setup(t, { repeat: 1 });
    const evidence = context.plan.units[0].staticInspection.evidenceFiles.find(file => file.path.endsWith('static-flows.json'));
    const bytes = await fs.readFile(evidence.path);
    const input = { summaryPath: context.summaryPath, batchId: context.batches[0].batchId,
      outputDirectory: path.join(context.output, 'batch'), pointerPath: path.join(context.output, 'pointer.json'),
      controlIndexPath: path.join(context.output, 'control-index.json') };
    let firstCheckReached = 0, matrixCalls = 0;
    await assert.rejects(async () => {
      await startBatch(input, { beforeSummarySave: async () => {
        firstCheckReached++;
        assert.equal((await readJson(context.summaryPath)).value.batches[0].status, 'pending');
        if (change === 'remove') await fs.unlink(evidence.path);
        else await fs.appendFile(evidence.path, '\nchanged after the first check\n');
      } });
      matrixCalls++; // The wrapper invokes its matrix only after startBatch returns prepared metadata.
    }, /Static inspection failed before dispatch/);
    assert.equal(firstCheckReached, 1); assert.equal(matrixCalls, 0);
    const state = (await readJson(context.summaryPath)).value;
    assert.equal(state.staticInspectionComplete, false); assert.ok(state.staticInspectionError);
    assert.equal(state.batches[0].status, 'not-run'); assert.equal(state.batches[0].stopDevice, true);
    assert.equal(state.batches[0].releaseConfirmed, false); assert.equal(state.batches[0].matrixExitCode, null);
    assert.equal(Object.hasOwn(state.batches[0], 'startedAt'), false);
    assert.equal(Object.hasOwn(state.batches[0], 'release'), false);
    assert.equal(state.slots[0].status, 'not-run'); assert.equal(state.slots[0].firstPassStatus, 'not_run');
    assert.equal(state.slots[0].runId, null); assert.equal(state.slots[0].cleanup, null);
    await assert.rejects(fs.stat(input.controlIndexPath), { code: 'ENOENT' });
    await fs.writeFile(evidence.path, bytes);
    await assert.rejects(startBatch(input), /A batch cannot be restarted/);
  });
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
  context.source.plan.schemaVersion = 2; context.source.plan.purpose = 'formal'; await json(context.source.file, context.source.plan);
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
  const result = await freezePlan(context.source.file, path.join(context.root, 'module'), context.project, { ...process.env, MAESTRO_HARMONYOS_MODULE: 'entry' }, context.runtimeOptions);
  assert.equal((await readJson(result.snapshotPath)).value.profiles.fixture.moduleName, 'entry');
});

test('raw skipped assertion is not required scenario coverage', async t => {
  const context = await setup(t, { repeat: 1 }); const result = await execute(context, ['skip']);
  assert.equal(result.state.slots[0].coverageComplete, false); assert.equal(result.state.slots[0].retryComplete, true);
  assert.equal((await review(context)).reviewed.qualified, false);
});

test('version 2 coverage distinguishes byte-identical registered source identities', async t => {
  for (const actual of ['A', 'B']) await t.test('actual ' + actual + ', required B', async t => {
    const { context, result } = await sourceIdentityScenario(t, { actual });
    assert.equal(result.state.slots[0].status, 'passed');
    assert.equal(result.state.slots[0].retryComplete, true, result.state.slots[0].reason);
    assert.equal(result.state.slots[0].coverageComplete, actual === 'B');
    assert.equal((await review(context)).reviewed.qualified, actual === 'B');
  });
});

test('version 1 coverage uses only a unique registered frozen identity and never guesses from equal bytes', async t => {
  for (const scenario of [
    { name: 'A cannot cover frozen B', actual: 'A', registered: ['A'], expected: false },
    { name: 'both registered identities are ambiguous', actual: 'B', registered: ['A', 'B'], expected: false },
    { name: 'unique registered B remains compatible', actual: 'B', registered: ['B'], expected: true },
  ]) await t.test(scenario.name, async t => {
    const { context, result } = await sourceIdentityScenario(t, { version: 1, ...scenario });
    assert.equal(result.state.slots[0].retryComplete, true, result.state.slots[0].reason);
    assert.equal(result.state.slots[0].coverageComplete, scenario.expected);
    assert.equal((await review(context)).reviewed.qualified, scenario.expected);
  });
});

test('version 2 source identity rejects missing invalid unregistered and changing origins', async t => {
  const mutations = [
    ['missing', event => { delete event.sourceIdentity; }],
    ['null YAML identity', event => { event.sourceIdentity = null; }],
    ['array identity', event => { event.sourceIdentity = [event.sourceIdentity]; }],
    ['relative identity', event => { event.sourceIdentity = 'children/B.yaml'; }],
    ['foreign identity', event => { event.sourceIdentity += '.unregistered'; }],
    ['registered identity has different bytes', (event, children) => { event.sourceIdentity = path.join(path.dirname(path.dirname(children.A)), 'flow.yaml'); }],
    ['identity changed at finish', (event, children) => { if (event.event === 'stepFinished') event.sourceIdentity = children.A; }],
  ];
  for (const [name, alterEvent] of mutations) await t.test(name, async t => {
    const { context, result } = await sourceIdentityScenario(t, { actual: 'B', alterEvent });
    assert.equal(result.state.slots[0].retryComplete, false);
    assert.equal(result.state.slots[0].coverageComplete, false);
    assert.equal((await review(context)).reviewed.qualified, false);
  });
  await t.test('frozen A is not registered for this attempt', async t => {
    const { context, result } = await sourceIdentityScenario(t, { actual: 'B', registered: ['B'], alterEvent: (event, children) => { event.sourceIdentity = children.A; } });
    assert.equal(result.state.slots[0].retryComplete, false);
    assert.equal(result.state.slots[0].coverageComplete, false);
    assert.equal((await review(context)).reviewed.qualified, false);
  });
});

test('new plans under relocated source roots preserve explicit identity despite content-addressed archives', async t => {
  for (const version of [1, 2]) await t.test('trace version ' + version, async t => {
    const { context, result } = await sourceIdentityScenario(t, { version, actual: 'B', registered: version === 1 ? ['B'] : ['A', 'B'], relocated: true });
    assert.equal(result.state.slots[0].coverageComplete, true, result.state.slots[0].reason);
    assert.equal((await review(context)).reviewed.qualified, true);
  });
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
