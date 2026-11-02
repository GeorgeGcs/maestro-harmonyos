import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { groupsFor, nodeVersionAllowed, tapCounts, acceptableStep, externalTemp, plans, runStep, preflight, platformExclusionsFor } from '../host-suite/suite.mjs';

test('default scope covers explicit host groups without opting in to an editor', () => {
  assert.deepEqual(groupsFor(), ['Jvm', 'Agent', 'Recovery', 'Scripts', 'Schemas', 'VSCode']);
  assert.deepEqual(groupsFor(['Recovery', 'Recovery', 'Agent']), ['Recovery', 'Agent']);
  for (const input of [[], ['Unknown'], ['All', 'Agent']]) assert.throws(() => groupsFor(input));
});
test('complete toolchain checks Node minimum and rejects malformed versions', () => {
  for (const version of ['22.12.0', 'v24.14.0', '23.0.0']) assert.equal(nodeVersionAllowed(version), true);
  for (const version of ['20.20.0', '22.11.9', '22.x', '999']) assert.equal(nodeVersionAllowed(version), false);
});
test('Windows excludes exactly the declared Linux and macOS symlink method without accepting runtime skips', async () => {
  const exclusions = platformExclusionsFor(['Jvm'], 'win32');
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0].className, 'maestro.harmonyos.driver.Mp4RecordingValidatorTest');
  assert.equal(exclusions[0].methodName, 'rejects symlinks even when their target is a valid recording');
  assert.equal(exclusions[0].status, 'not_executed'); assert.equal(exclusions[0].countedAsPassed, false);
  assert.match(exclusions[0].reason, /EnabledOnOs/);
  assert.deepEqual(platformExclusionsFor(['Jvm'], 'linux'), []);
  assert.deepEqual(platformExclusionsFor(['Agent'], 'win32'), []);
  const init = await fs.readFile('scripts/gradle/host-test-rerun.init.gradle', 'utf8');
  assert.match(init, /startsWith\('Windows'\)/);
  const filters = [...init.matchAll(/excludeTestsMatching\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(filters, [exclusions[0].className + '.' + exclusions[0].methodName]);
  assert.equal(acceptableStep(0, tapCounts(tap({ pass: 2, skipped: 1 }))), false);
});
const tap = (overrides = {}) => Object.entries({ tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides }).map(([k, v]) => '# ' + k + ' ' + v).join('\n') + '\n';
test('zero tests, silent skips, cancellation and missing summaries cannot pass', () => {
  assert.equal(acceptableStep(0, tapCounts(tap())), true);
  assert.equal(acceptableStep(0, tapCounts(tap({ pass: 2, skipped: 1 }))), false);
  assert.equal(acceptableStep(0, tapCounts(tap({ pass: 2, cancelled: 1 }))), false);
  assert.equal(acceptableStep(1, tapCounts(tap())), false);
  assert.throws(() => tapCounts(tap({ tests: 0, pass: 0 })));
  assert.throws(() => tapCounts(tap() + '# tests 3\n'));
  assert.throws(() => tapCounts('ok 1 - empty summary'));
});
test('CI fixture state must be outside the checkout, including mixed-case paths', () => {
  const project = path.resolve('fixture-checkout');
  assert.throws(() => externalTemp(project, project));
  assert.throws(() => externalTemp(project, path.join(project, 'state')));
  assert.throws(() => externalTemp(project, path.join(project.toUpperCase(), 'state')));
  assert.equal(externalTemp(project, path.resolve('fixture-checkout-sibling')), path.resolve('fixture-checkout-sibling'));
});
test('required Java and distribution are checked before tests can silently skip', { skip: process.platform !== 'win32' }, async () => {
  const powershell = process.env.CI_TEST_POWERSHELL ?? execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  await assert.rejects(preflight({ project: process.cwd(), powershell, groups: ['Recovery'] }), /JavaHome/);
});
test('schema plan requires actual producer and blocked CLI evidence, JVM includes session tests', async () => {
  const config = { project: process.cwd(), groups: ['Jvm', 'Schemas'], java: 'java-fixture', cli: 'cli-fixture',
    bash: 'bash-fixture', powershell: 'powershell-fixture', upstream: 'upstream-fixture', gradle: 'gradle-fixture', simulatorCache: 'cache-fixture' };
  const plan = await plans(config, path.resolve('output-fixture'));
  assert.ok(plan[0].args.includes('maestro.cli.session.*'));
  assert.ok(plan[0].args.includes('*ScreenRecordingOutputTest'));
  assert.ok(plan[0].args.includes('*ArtifactsGeneratorTest'));
  assert.ok(plan[0].args.some(arg => arg.endsWith('host-test-rerun.init.gradle')));
  assert.equal(plan[0].timeoutMs, 1800000);
  assert.equal(plan.find(step => step.id === 'schema-producer').timeoutMs, 600000);
  assert.ok(plan[0].args.includes('--offline'));
  const blocked = plan.find(step => step.id === 'schema-blocked');
  assert.equal(blocked.expectedExitCode, 1); assert.ok(blocked.args.includes('android'));
  assert.ok(plan.at(-1).args.includes('-RequireProductionEvidence'));
  assert.ok(plan.every(step => !step.args.includes('devices') && !step.args.includes('list-devices')));
});
test('step execution preserves logs, real exit codes and skipped counts', async t => {
  const parent = path.resolve('artifacts/host-suite-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'fixture.mjs');
  await fs.writeFile(source, 'process.stdout.write(process.env.FIXTURE_TAP); process.stderr.write("fixture diagnostics"); process.exitCode=Number(process.env.FIXTURE_EXIT);');
  const step = { group: 'Agent', id: 'pass', executable: process.execPath, args: [source], cwd: root, kind: 'tap' };
  const passed = await runStep(step, root, { ...process.env, FIXTURE_TAP: tap(), FIXTURE_EXIT: '0' });
  assert.equal(passed.status, 'passed'); assert.equal(passed.counts.tests, 3);
  assert.equal(await fs.readFile(passed.stderrPath, 'utf8'), 'fixture diagnostics');
  const skipped = await runStep({ ...step, id: 'skip' }, root, { ...process.env, FIXTURE_TAP: tap({ pass: 2, skipped: 1 }), FIXTURE_EXIT: '0' });
  assert.equal(skipped.status, 'failed'); assert.equal(skipped.exitCode, 0); assert.equal(skipped.counts.skipped, 1);
  const failed = await runStep({ ...step, id: 'fail' }, root, { ...process.env, FIXTURE_TAP: tap(), FIXTURE_EXIT: '42' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 42);
  const psSkip = await runStep({ ...step, id: 'ps-skip', kind: 'powershell' }, root,
    { ...process.env, FIXTURE_TAP: 'PASS: 10 CI behavior checks; skipped=1.', FIXTURE_EXIT: '0' });
  assert.equal(psSkip.status, 'failed'); assert.match(psSkip.error, /PowerShell checks were skipped/);
  await assert.rejects(runStep(step, root, process.env), /EEXIST/);
});
async function fixtureDirectory(t) {
  const parent = path.resolve('artifacts/host-suite-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
test('timeout stops only the spawned fixture tree and records the observed exit', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixtureDirectory(t);
  const source = path.join(root, 'timeout.mjs');
  await fs.writeFile(source, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)'], { stdio: 'ignore', windowsHide: true });
console.log(JSON.stringify({ pid: process.pid, childPid: child.pid }));
setTimeout(() => process.exit(0), 10000);`);
  const result = await runStep({ group: 'Scripts', id: 'timeout', executable: process.execPath, args: [source], cwd: root, kind: 'command', timeoutMs: 800 }, root, process.env);
  assert.equal(result.status, 'failed'); assert.equal(result.timedOut, true);
  assert.equal(result.processExitObserved, true); assert.equal(result.terminationError, null);
  assert.ok(Date.parse(result.finishedAt) - Date.parse(result.startedAt) < 8000);
  const spawned = JSON.parse(await fs.readFile(result.stdoutPath, 'utf8'));
  for (const pid of [spawned.pid, spawned.childPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('JUnit counts must come from fresh reports, never from an earlier run', async t => {
  const root = await fixtureDirectory(t), reports = path.join(root, 'reports'); await fs.mkdir(reports);
  const report = path.join(reports, 'TEST-fixture.xml');
  const xml = '<testsuite name="fixture" tests="2" failures="0" errors="0" skipped="0"></testsuite>';
  await fs.writeFile(report, xml); await fs.utimes(report, new Date(0), new Date(0));
  const step = { group: 'Jvm', id: 'stale', executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, kind: 'junit', reports: [reports] };
  const stale = await runStep(step, root, process.env);
  assert.equal(stale.status, 'failed'); assert.match(stale.error, /Stale JUnit report/);
  const fresh = await runStep({ ...step, id: 'fresh', args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', report, xml] }, root, process.env);
  assert.equal(fresh.status, 'passed'); assert.equal(fresh.counts.tests, 2);
});
test('failed JVM commands retain fresh failure and skip counts without counting missing or stale modules', async t => {
  const root = await fixtureDirectory(t), reports = path.join(root, 'reports'), oldReports = path.join(root, 'old');
  await fs.mkdir(reports); await fs.mkdir(oldReports);
  const report = path.join(reports, 'TEST-failed.xml'), oldReport = path.join(oldReports, 'TEST-old.xml');
  const xml = '<testsuite name="fixture" tests="3" failures="1" errors="0" skipped="1"></testsuite>';
  await fs.writeFile(oldReport, xml); await fs.utimes(oldReport, new Date(0), new Date(0));
  const result = await runStep({ group: 'Jvm', id: 'failed-reports', executable: process.execPath,
    args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2]); process.exit(1)', report, xml],
    cwd: root, kind: 'junit', reports: [path.join(root, 'missing'), oldReports, reports] }, root, process.env);
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 1);
  assert.deepEqual(result.counts, { tests: 3, pass: 1, fail: 1, skipped: 1, cancelled: 0, todo: 0 });
  assert.equal(result.countsComplete, false); assert.equal(result.reportErrors.length, 2);
  assert.match(result.error, /Incomplete JUnit reports/); assert.match(result.error, /Stale JUnit report/);
});
test('PowerShell wrapper preserves spaced paths and records preflight refusal before any test', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixtureDirectory(t), output = path.join(root, 'output with spaces');
  const powershell = process.env.CI_TEST_POWERSHELL ?? execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  const result = spawnSync(powershell, ['-NoProfile', '-File', path.resolve('scripts/test-host-suite.ps1'), '-Group', 'Recovery',
    '-NodePath', process.execPath, '-JavaHome', path.join(root, 'missing JDK'), '-OutputDirectory', output, '-CheckOnly'],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stdout + result.stderr);
  const summary = JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed'); assert.equal(summary.steps.length, 0);
  assert.equal(summary.deviceCommands, false); assert.match(summary.error, /missing JDK/);
});
