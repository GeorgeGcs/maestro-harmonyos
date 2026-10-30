import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { freezeSuite, freezeVideoPolicy, loadSuite, checkJunit, verifySuite, inspectFlows } from '../ci/suite.mjs';
import { gitIdentity, readMetadata } from '../ci/snapshot-build.mjs';
import { hash, hashFile, sourceFiles } from '../validation/io.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.join(repo, 'artifacts/ci-suite-tests');
const powershell = process.env.CI_TEST_POWERSHELL ?? execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const json = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
const environment = { ...process.env, TEST_VALUE: 'fixture-value' };
const toolNames = ['scripts/run-harmonyos.ps1', 'scripts/ci/run-device-suite.ps1', 'scripts/ci/suite.mjs', 'scripts/ci/snapshot-build.mjs',
  'scripts/ci/read-junit.ps1', 'scripts/ci/verify-state.mjs', 'scripts/ci/device-reservation.ps1', 'scripts/ci/verify-videos.mjs',
  'scripts/verify-recording.ps1', 'scripts/validation/io.mjs',
  'scripts/validation/plan.mjs', 'scripts/validation/runtime.mjs', 'scripts/validation/preparation.mjs',
  'scripts/validation/static-flows.mjs', 'scripts/validation/static-plan.mjs',
  'scripts/validation/retry-evidence.mjs', 'examples/agent-client/client.mjs', 'examples/agent-client/evidence.mjs'];

async function setup(t) {
  const root = path.join(parent, 'case-' + randomUUID()), project = path.join(root, 'checkout with spaces'), flows = path.join(root, 'flows');
  await fs.mkdir(flows, { recursive: true });
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('case-')); await fs.rm(root, { recursive: true, force: true }); });
  for (const name of toolNames) { const file = path.join(project, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile(path.join(repo, name), file); }
  const fakeParser = path.join(root, 'fixture-parser.mjs');
  await fs.writeFile(fakeParser, `import fs from 'node:fs/promises'; const input=JSON.parse(await fs.readFile(process.argv[2],'utf8')); await fs.writeFile(process.argv[3],JSON.stringify({protocol:'maestro.harmonyos.ci-static-flows',schemaVersion:1,flows:input.flows,dependencies:input.sources.map(file=>({...file,kind:file.path.endsWith('.js')?'script':'yaml'}))}),{flag:'wx'});`);
  await fs.writeFile(path.join(project, 'scripts/ci/InspectFlows.java'), `class InspectFlows { public static void main(String[] args) throws Exception { System.exit(new ProcessBuilder(${JSON.stringify(process.execPath)},${JSON.stringify(fakeParser)},args[0],args[1]).inheritIO().start().waitFor()); } }`);
  const flow = path.join(flows, 'flow.yaml'), dependency = path.join(flows, 'child.yaml');
  await fs.writeFile(flow, 'appId: ${APP_ID}\nname: fixture\n---\n- assertVisible: TestLogin\n');
  // This directory is a per-flow sourceRoot; an unused sibling is still frozen.
  await fs.writeFile(dependency, 'appId: ${APP_ID}\n---\n- assertTrue: true\n');
  const patch = path.join(project, 'patches/maestro/0001-harmonyos-host.patch');
  await fs.mkdir(path.dirname(patch), { recursive: true }); await fs.writeFile(patch, 'fixture patch');
  await json(path.join(project, 'upstream.lock.json'), { commit: 'a'.repeat(40) });
  const outputFiles = [];
  for (const name of ['maestro-cli-2.12.0.jar', 'maestro-client.jar', 'maestro-orchestra.jar', 'maestro-orchestra-models.jar']) {
    const file = path.join(project, '.upstream/maestro/maestro-cli/build/install/maestro/lib', name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
    outputFiles.push({ path: file, sha256: await hashFile(file), bytes: (await fs.stat(file)).size });
  }
  const buildPath = path.join(root, 'build.json');
  await json(buildPath, { status: 'passed', cliBuildStatus: 'passed', cliVersionStatus: 'passed', projectCommit: 'b'.repeat(40),
    sourceDirectory: project, upstreamCommit: 'a'.repeat(40), patchSha256: await hashFile(patch), outputFiles });
  const manifestPath = path.join(root, 'suite.json'), manifest = { schemaVersion: 2, suiteId: 'fixture', flowPath: flow, sourceRoot: flows,
    expectedFlows: [{ path: flow, name: 'fixture' }], bundleId: 'com.example.testlogin', abilityName: 'EntryAbility', moduleName: 'entry',
    environmentNames: ['TEST_VALUE'], buildManifest: { path: buildPath, sha256: await hashFile(buildPath) } };
  await json(manifestPath, manifest);
  const input = { manifestPath, projectRoot: project, deviceId: 'fixture-device', outputDirectory: path.join(root, 'outputs'), powershellPath: powershell };
  return { root, project, flow, dependency, patch, outputFiles, buildPath, manifest, manifestPath, input,
    freeze: async () => { await json(manifestPath, manifest); return freezeSuite(input, environment); } };
}

const parsedXml = (snapshot, status = 'SUCCESS') => ({ schemaVersion: 1, suites: [{ name: 'Test Suite', tests: 1, failures: status === 'ERROR' ? 1 : 0,
  testCases: [{ file: snapshot.units[0].entry, name: 'fixture', id: 'custom-id', classname: 'custom-class', status,
    failureCount: status === 'ERROR' ? 1 : 0, failureText: status === 'ERROR' ? 'assertion' : null }] }] });

test('fixed CI inputs retain exact four roles, optional HAP boundary and unchanged profile', async t => {
  const context = await setup(t), frozen = await context.freeze();
  const value = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  assert.equal(value.build.files.length, 4); assert.equal(value.installedApplicationCorrespondence, 'unverified');
  assert.equal(value.formalEligibility, false); assert.equal(value.applicationFiles.length, 0);
  assert.equal(value.profiles.suite.environmentHashes.TEST_VALUE, hash(Buffer.from(environment.TEST_VALUE)));
});

test('frozen sources, implementation, metadata and environment changes are rejected before dispatch', async t => {
  for (const target of ['flow', 'dependency', 'new-source', 'jar', 'extra-uppercase-jar', 'patch', 'upstream', 'new-config', 'environment', 'runtime-module', 'preparation-module', 'static-flows-module']) await t.test(target, async t => {
    const context = await setup(t), frozen = await context.freeze();
    if (target === 'flow' || target === 'dependency' || target === 'patch') await fs.appendFile(context[target], '\nchanged');
    else if (target === 'jar') await fs.appendFile(context.outputFiles[0].path, 'changed');
    else if (target === 'extra-uppercase-jar') await fs.copyFile(context.outputFiles[0].path, path.join(path.dirname(context.outputFiles[0].path), 'extra.JAR'));
    else if (target === 'upstream') await json(path.join(context.project, 'upstream.lock.json'), { commit: 'c'.repeat(40) });
    else if (target === 'new-source') await fs.writeFile(path.join(path.dirname(context.flow), 'new.js'), 'changed');
    else if (target === 'new-config') await fs.writeFile(path.join(context.project, 'config.local.ps1'), '# added');
    else if (target === 'runtime-module' || target === 'preparation-module' || target === 'static-flows-module') await fs.appendFile(path.join(context.project, 'scripts/validation', target.replace('-module', '.mjs')), '\n// changed after freeze');
    await assert.rejects(loadSuite(frozen.snapshotPath, frozen.snapshotSha256, target === 'environment' ? { ...environment, TEST_VALUE: 'changed' } : environment));
  });
});

test('v1 migration, wrong source roots, duplicate members/names and incomplete JAR records refuse freeze', async t => {
  for (const mode of ['v1', 'outside-root', 'duplicate-name', 'missing-member', 'missing-jar', 'extra-role', 'wrong-build-root']) await t.test(mode, async t => {
    const context = await setup(t);
    if (mode === 'v1') context.manifest.schemaVersion = 1;
    if (mode === 'outside-root') context.manifest.sourceRoot = context.project;
    if (mode === 'duplicate-name' || mode === 'missing-member') {
      context.manifest.flowPath = path.dirname(context.flow);
      if (mode === 'duplicate-name') context.manifest.expectedFlows.push({ path: context.dependency, name: 'fixture' });
    }
    if (mode === 'missing-jar') await fs.unlink(context.outputFiles[1].path);
    if (mode === 'extra-role') await fs.copyFile(context.outputFiles[1].path, path.join(path.dirname(context.outputFiles[1].path), 'maestro-client-2.12.0.jar'));
    if (mode === 'wrong-build-root') { const value = (await readMetadata(context.buildPath)).value; value.sourceDirectory = context.root; await json(context.buildPath, value); context.manifest.buildManifest.sha256 = await hashFile(context.buildPath); }
    await assert.rejects(context.freeze(), mode === 'v1' ? /Migrate to v2/ : undefined);
  });
});

test('explicit local HAP is fingerprinted but never proves installed correspondence', async t => {
  const context = await setup(t), hap = path.join(context.root, 'candidate.hap'); await fs.writeFile(hap, 'fixture local app');
  context.manifest.applicationFile = { path: hap, sha256: await hashFile(hap) };
  const frozen = await context.freeze(), value = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  assert.equal(value.applicationFiles.length, 1); assert.equal(value.installedApplicationCorrespondence, 'unverified');
  await fs.appendFile(hap, 'changed'); await assert.rejects(loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment));
});

test('video policy is optional and freezes an explicit required Flow subset, decoder and budgets', async t => {
  const context = await setup(t), decoder = path.join(context.root, 'fixture-ffmpeg.exe'); await fs.writeFile(decoder, 'fixture decoder; not executed');
  assert.equal(await freezeVideoPolicy(undefined, context.root, []), null);
  const policy = { requiredFlows: [context.flow], ffmpeg: { path: decoder, sha256: await hashFile(decoder) }, timeoutSeconds: 2, maxVideos: 2, budgetSeconds: 54 };
  context.manifest.videoPolicy = policy;
  const frozen = await context.freeze(), snapshot = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  assert.equal(frozen.videoBudgetSeconds, 54); assert.deepEqual(snapshot.videoPolicy.requiredFlows, [context.flow]);
  assert.ok(snapshot.toolFiles.some(file => file.path === decoder && file.sha256 === policy.ffmpeg.sha256));
  assert.ok(snapshot.toolFiles.some(file => file.path.endsWith('verify-recording.ps1')));
  await fs.appendFile(decoder, ' changed'); await assert.rejects(loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment));
});

test('video policy rejects unlisted Flows, duplicate paths, missing hashes and inadequate budgets before dispatch', async t => {
  const context = await setup(t), decoder = path.join(context.root, 'fixture-ffmpeg.exe'); await fs.writeFile(decoder, 'fixture decoder');
  const policy = { requiredFlows: [context.flow], ffmpeg: { path: decoder, sha256: await hashFile(decoder) }, timeoutSeconds: 1, maxVideos: 1, budgetSeconds: 31 };
  for (const mutate of [value => { value.requiredFlows = [context.dependency]; }, value => { value.requiredFlows.push(context.flow); },
    value => { delete value.ffmpeg.sha256; }, value => { value.ffmpeg.sha256 = '0'.repeat(64); }, value => { value.budgetSeconds = 30; },
    value => { value.maxVideos = 0; }, value => { value.requiredFlows = []; }, value => { value.timeoutSeconds = 0; }]) {
    const value = structuredClone(policy); mutate(value);
    await assert.rejects(freezeVideoPolicy(value, context.root, [{ path: context.flow }]));
  }
});

test('video-required quality failure preserves the native result and confirmed cleanup', async t => {
  const context = await setup(t), decoder = path.join(context.root, 'fixture-ffmpeg.exe'); await fs.writeFile(decoder, 'fixture decoder; never run');
  context.manifest.videoPolicy = { requiredFlows: [context.flow], ffmpeg: { path: decoder, sha256: await hashFile(decoder) }, timeoutSeconds: 1, maxVideos: 1, budgetSeconds: 31 };
  const frozen = await context.freeze(), snapshot = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  const attempt = await nativeAttempt(context, 'passed', snapshot.staticInspection.javaPath), outputPath = path.join(context.root, 'quality.json');
  const output = await verifySuite({ ...attempt, ...frozen, outputPath }, environment), report = (await readMetadata(outputPath)).value;
  assert.equal(output.status, 'failed'); assert.equal(report.video.status, 'failed');
  assert.equal(report.execution, 'passed'); assert.equal(report.cleanup.state, 'complete');
  assert.equal(await hashFile(attempt.resultPath), attempt.resultSha256);
});

test('directory suite membership excludes common subflows and rejects its workspace config before dispatch', async t => {
  const context = await setup(t), directory = path.dirname(context.flow);
  await fs.mkdir(path.join(directory, 'common')); await fs.rename(context.dependency, path.join(directory, 'common/child.yaml'));
  context.manifest.flowPath = directory;
  const frozen = await context.freeze(), value = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  assert.equal(value.units[0].requiredTopLevelFlows.length, 1); assert.equal(value.units[0].sources.length, 2);
  await fs.writeFile(path.join(directory, 'config.yaml'), 'flows:\n- "**"\n');
  await assert.rejects(freezeSuite({ ...context.input, outputDirectory: path.join(context.root, 'another-output') }, environment), /workspace config/);
});

test('JUnit maps exact source/name, preserves custom IDs, and does not turn outer failures into success', async t => {
  const context = await setup(t), frozen = await context.freeze(), snapshot = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  const report = parsedXml(snapshot); report.suites[0].testCases[0].file = path.relative(snapshot.projectRoot, context.flow);
  assert.equal(checkJunit(report, snapshot, 'passed').tests, 1);
  assert.equal(checkJunit(report, snapshot, 'failed').failures, 0);
  assert.equal(checkJunit(parsedXml(snapshot, 'ERROR'), snapshot, 'failed').failures, 1);
  assert.throws(() => checkJunit(parsedXml(snapshot, 'ERROR'), snapshot, 'passed'));
});

test('empty, duplicated, missing, foreign and contradictory native cases cannot pass', async t => {
  const context = await setup(t), frozen = await context.freeze(), snapshot = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
  const mutations = [
    value => { value.suites[0].testCases = []; },
    value => { value.suites[0].testCases = []; value.suites[0].tests = 0; },
    value => { value.suites[0].testCases.push({ ...value.suites[0].testCases[0] }); value.suites[0].tests = 2; },
    value => { value.suites[0].testCases[0].file = context.dependency; },
    value => { value.suites[0].testCases[0].name = 'other'; },
    value => { value.suites[0].failures = 1; },
    value => { value.suites[0].testCases[0].failureCount = 1; },
    value => { value.suites[0].testCases[0].status = 'CANCELED'; },
  ];
  for (const mutate of mutations) { const report = parsedXml(snapshot); mutate(report); assert.throws(() => checkJunit(report, snapshot, 'passed')); }
});

test('build observation refuses the parent-workspace Git trap and strict metadata rejects duplicate keys', async t => {
  const context = await setup(t);
  await assert.rejects(gitIdentity(context.project), /parent repository/);
  const file = path.join(context.root, 'duplicates.json'); await fs.writeFile(file, '{"schemaVersion":1,"schemaVersion":2}');
  await assert.rejects(readMetadata(file), /Duplicate/);
  await fs.writeFile(file, '{} {}'); await assert.rejects(readMetadata(file));
});

async function nativeAttempt(context, mode, javaPath) {
  const runId = randomUUID(), attemptId = randomUUID(), agentRoot = path.join(context.root, 'agent');
  const base = path.join(agentRoot, 'runs', runId, attemptId); await fs.mkdir(base, { recursive: true });
  const document = (kind, data) => ({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, revision: 1, observedAt: new Date().toISOString(), data });
  const content = await fs.readFile(context.flow, 'utf8');
  const input = { kind: 'flow', deviceId: 'fixture-device', request: { sources: [{ path: context.flow, files: [{ path: context.flow, content, sha256: hash(Buffer.from(content)), dependencies: [] }] }],
    configuration: { ability: 'EntryAbility', module: 'entry', environment: { APP_ID: 'com.example.testlogin', TEST_VALUE: environment.TEST_VALUE } } } };
  if (mode === 'wrong-input') input.request.configuration.environment.APP_ID = 'wrong.app';
  await json(path.join(base, 'input.json'), input);
  const file = context.flow.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  await fs.writeFile(path.join(base, 'junit.xml'), mode === 'empty-junit' ? '<testsuites><testsuite tests="1" failures="0"/></testsuites>' :
    `<testsuites><testsuite tests="1" failures="0"><testcase file="${file}" name="fixture" status="SUCCESS"/></testsuite></testsuites>`);
  const result = document('runResult', { runId, attemptId, attemptNo: 1, sessionId: null, deviceId: 'fixture-device', flow: null,
    status: mode === 'outer-failed' ? 'failed' : 'passed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), effects: 'observed',
    error: mode === 'outer-failed' ? { kind: 'transport', code: 'OUTER_FAILURE', message: 'fixture' } : null,
    cleanup: { state: 'complete', errors: [] }, failedStepId: null, input: { kind: 'flow', path: 'input.json', sha256: await hashFile(path.join(base, 'input.json')) },
    artifacts: { baseDir: base, manifestPaths: ['agent-manifest.json'], junitPath: 'junit.xml', evidenceIndexPath: 'evidence-index.json' } });
  await json(path.join(base, 'result.json'), result);
  await json(path.join(base, 'evidence-index.json'), document('evidenceIndex', { runId, attemptId, entries: [] }));
  await json(path.join(base, 'state.json'), {}); await json(path.join(base, 'registration.json'), {});
  const files = [];
  for (const name of ['input.json', 'result.json', 'evidence-index.json', 'state.json', 'registration.json', 'junit.xml']) files.push({ path: name, sha256: await hashFile(path.join(base, name)) });
  await json(path.join(base, 'agent-manifest.json'), { schemaVersion: 1, runId, attemptId, files });
  const controlRecordPath = path.join(context.root, 'control.json');
  await json(controlRecordPath, { runId, attemptId, deviceId: 'fixture-device', process: { executable: mode === 'wrong-java' ? path.join(context.root, 'other-java.exe') : javaPath } });
  return { runId, attemptId, deviceId: 'fixture-device', agentRoot, resultPath: path.join(base, 'result.json'), resultSha256: await hashFile(path.join(base, 'result.json')),
    controlRecordPath, controlSha256: await hashFile(controlRecordPath) };
}

test('public quality verification reads real XML and registered inputs without rewriting native execution', async t => {
  for (const mode of ['passed', 'outer-failed', 'empty-junit', 'wrong-input', 'wrong-java', 'post-change']) await t.test(mode, async t => {
    const context = await setup(t), frozen = await context.freeze(), snapshot = await loadSuite(frozen.snapshotPath, frozen.snapshotSha256, environment);
    const attempt = await nativeAttempt(context, mode, snapshot.staticInspection.javaPath);
    if (mode === 'post-change') await fs.appendFile(context.dependency, 'changed');
    const outputPath = path.join(context.root, 'quality.json');
    const output = await verifySuite({ ...attempt, ...frozen, outputPath }, environment);
    assert.equal(output.status, ['passed', 'outer-failed'].includes(mode) ? 'passed' : 'failed', (await readMetadata(outputPath)).value.error);
    assert.equal(await hashFile(attempt.resultPath), attempt.resultSha256);
    assert.equal((await readMetadata(outputPath)).value.execution, mode === 'outer-failed' ? 'failed' : 'passed');
    await assert.rejects(verifySuite({ ...attempt, ...frozen, outputPath }, environment), /EEXIST/);
  });
});

test('actual installed Maestro statically accepts common flows and scripts without executing their contents', async t => {
  const root = path.join(parent, 'case-' + randomUUID()), flows = path.join(root, 'flows');
  await fs.mkdir(path.join(flows, 'common'), { recursive: true });
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const main = path.join(flows, 'main.yaml'), child = path.join(flows, 'common/child.yaml'), script = path.join(flows, 'common/helper.js');
  await fs.writeFile(main, 'appId: example.fixture\nname: actual-static-fixture\n---\n- runFlow: common/child.yaml\n- runScript: common/helper.js\n');
  await fs.writeFile(child, 'appId: example.fixture\n---\n- assertTrue: true\n');
  await fs.writeFile(script, 'throw new Error("This script must never execute during static inspection");\n');
  const inspected = await inspectFlows(repo, flows, [{ path: main, name: 'actual-static-fixture' }], await sourceFiles(flows), path.join(root, 'positive'), environment);
  assert.equal(inspected.scriptsExecuted, false); assert.equal(inspected.dependencies.length, 3);
  assert.ok(inspected.dependencies.some(value => value.path === script && value.kind === 'script'));
  const outside = path.join(root, 'outside.yaml'); await fs.writeFile(outside, 'appId: example.fixture\n---\n- assertTrue: true\n');
  for (const [label, command] of [['outside-flow', 'runFlow: ../outside.yaml'], ['outside-script', 'runScript: ../outside.js'],
    ['nonstandard-script', 'runScript: common/helper.txt'], ['nonstandard-flow', 'runFlow: common/child.flow'], ['dynamic-path', 'runFlow: ${CHILD_PATH}']]) {
    await fs.writeFile(path.join(root, 'outside.js'), 'throw new Error("do not execute");');
    await fs.writeFile(path.join(flows, 'common/helper.txt'), 'throw new Error("do not execute");');
    await fs.writeFile(path.join(flows, 'common/child.flow'), 'appId: example.fixture\n---\n- assertTrue: true\n');
    await fs.writeFile(main, 'appId: example.fixture\nname: actual-static-fixture\n---\n- ' + command + '\n');
    await assert.rejects(inspectFlows(repo, flows, [{ path: main, name: 'actual-static-fixture' }], await sourceFiles(flows), path.join(root, label), environment), /Static Maestro parsing failed/);
  }
  for (const command of ['runFlow', 'retry']) for (const extension of ['yaml', 'flow']) {
    const empty = path.join(flows, 'common/empty.' + extension);
    await fs.writeFile(empty, 'appId: example.fixture\n---\n[]\n');
    const body = command === 'runFlow' ? '- runFlow: common/empty.' + extension : '- retry:\n    maxRetries: 1\n    file: common/empty.' + extension;
    await fs.writeFile(main, 'appId: example.fixture\nname: actual-static-fixture\n---\n' + body + '\n');
    const inspect = inspectFlows(repo, flows, [{ path: main, name: 'actual-static-fixture' }], await sourceFiles(flows), path.join(root, 'empty-' + command + '-' + extension), environment);
    if (extension === 'flow') await assert.rejects(inspect, /Static Maestro parsing failed/);
    else assert.ok((await inspect).dependencies.some(value => value.path === empty), 'Empty child must be frozen even with no child command SourceInfo');
  }
  for (const name of ['config.yaml', 'upper.YAML']) {
    const selected = path.join(flows, name);
    await fs.writeFile(selected, 'appId: example.fixture\nname: actual-static-fixture\n---\n- assertTrue: true\n');
    await assert.rejects(inspectFlows(repo, flows, [{ path: selected, name: 'actual-static-fixture' }], await sourceFiles(flows),
      path.join(root, 'native-filter-' + name), environment), /Static Maestro parsing failed/);
  }
});
