import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { artifact, atomicJson, canonical, hash, hashFile, inside, key, noLinks, requireValue, samePath, sourceFiles } from '../validation/io.mjs';
import { checkFrozen } from '../validation/plan.mjs';
import { verifyAttemptInput } from '../validation/retry-evidence.mjs';
import { readMetadata as readJson, verifyBuildReference } from './snapshot-build.mjs';
import { verifyVideos } from './verify-videos.mjs';

const execute = promisify(execFile);
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const unique = (values, label) => requireValue(new Set(values).size === values.length, label + ' must be unique.');

export async function freezeVideoPolicy(value, base, expectedFlows) {
  if (value === undefined) return null;
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(name => ['requiredFlows', 'ffmpeg', 'timeoutSeconds', 'maxVideos', 'budgetSeconds'].includes(name)), 'Invalid videoPolicy fields.');
  requireValue(Array.isArray(value.requiredFlows) && value.requiredFlows.length > 0 && value.requiredFlows.every(file => typeof file === 'string'),
    'videoPolicy requires explicit top-level requiredFlows.');
  const requiredFlows = value.requiredFlows.map(file => path.resolve(base, file));
  unique(requiredFlows.map(key), 'Required video Flow paths');
  requireValue(requiredFlows.every(file => expectedFlows.some(flow => samePath(flow.path, file))), 'Required video Flow is not a frozen top-level member.');
  requireValue(Number.isSafeInteger(value.timeoutSeconds) && value.timeoutSeconds >= 1 && value.timeoutSeconds <= 3600 &&
    Number.isSafeInteger(value.maxVideos) && value.maxVideos >= requiredFlows.length && value.maxVideos <= 100 &&
    Number.isSafeInteger(value.budgetSeconds) && value.budgetSeconds <= 86400 &&
    value.budgetSeconds >= value.maxVideos * (value.timeoutSeconds + 20) + 10,
    'Video budget must cover maxVideos times (decode timeout + 20 seconds), plus 10 seconds.');
  requireValue(value.ffmpeg && typeof value.ffmpeg.path === 'string' && typeof value.ffmpeg.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.ffmpeg.sha256) && Object.keys(value.ffmpeg).every(name => ['path', 'sha256'].includes(name)), 'videoPolicy needs an explicit FFmpeg path and SHA-256.');
  const ffmpeg = { path: path.resolve(base, value.ffmpeg.path), sha256: value.ffmpeg.sha256 };
  requireValue(await hashFile(ffmpeg.path) === ffmpeg.sha256, 'Declared FFmpeg fingerprint differs.');
  return { requiredFlows, ffmpeg, timeoutSeconds: value.timeoutSeconds, maxVideos: value.maxVideos, budgetSeconds: value.budgetSeconds };
}

async function javaExecutable(environment) {
  if (environment.JAVA_HOME) return path.resolve(environment.JAVA_HOME, 'bin/java.exe');
  const { stdout } = await execute('where.exe', ['java.exe'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  const file = stdout.trim().split(/\r?\n/)[0];
  requireValue(file && path.isAbsolute(file), 'A direct JDK 17+ Java executable is required; configure JAVA_HOME.');
  return file;
}

export async function inspectFlows(projectRoot, sourceRoot, flows, sources, outputDirectory, environment = process.env) {
  const java = await javaExecutable(environment), library = path.join(projectRoot, '.upstream/maestro/maestro-cli/build/install/maestro/lib');
  const helper = path.join(projectRoot, 'scripts/ci/InspectFlows.java');
  const classpath = (await fs.readdir(library)).filter(name => /\.jar$/i.test(name)).sort().map(name => path.join(library, name));
  const files = [];
  for (const file of [java, helper, ...classpath]) files.push({ path: file, sha256: await hashFile(file) });
  const requestPath = path.join(outputDirectory, 'static-request.json'), responsePath = path.join(outputDirectory, 'static-flows.json');
  await atomicJson(requestPath, { schemaVersion: 1, sourceRoot, flows: flows.map(({ path, name }) => ({ path, name })), sources }, true);
  let stdout = '', stderr = '', failure = null;
  try {
    ({ stdout, stderr } = await execute(java, ['-Dfile.encoding=UTF-8', '--class-path', path.join(library, '*'), helper, requestPath, responsePath],
      { cwd: projectRoot, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; failure = error; }
  const stdoutPath = path.join(outputDirectory, 'static-parser.stdout.log'), stderrPath = path.join(outputDirectory, 'static-parser.stderr.log');
  await fs.writeFile(stdoutPath, stdout, { flag: 'wx' }); await fs.writeFile(stderrPath, stderr, { flag: 'wx' });
  requireValue(!failure, 'Static Maestro parsing failed before dispatch; see static-parser.stderr.log. ' + (failure?.message ?? ''));
  const parsed = await readJson(responsePath), value = parsed.value, sourceMap = new Map(sources.map(file => [key(file.path), file.sha256]));
  requireValue(value.protocol === 'maestro.harmonyos.ci-static-flows' && value.schemaVersion === 1 &&
    canonical(value.flows?.map(flow => ({ path: key(flow.path), name: flow.name }))) === canonical(flows.map(flow => ({ path: key(flow.path), name: flow.name }))) &&
    Array.isArray(value.dependencies), 'Static parser returned another Flow set.');
  for (const dependency of value.dependencies) requireValue(typeof dependency.path === 'string' &&
    sourceMap.get(key(dependency.path)) === dependency.sha256 && ['yaml', 'script'].includes(dependency.kind), 'A parsed dependency is outside the frozen YAML/JS source set.');
  for (const flow of flows) requireValue(value.dependencies.some(dependency => samePath(dependency.path, flow.path)), 'Static parser omitted a top-level source.');
  for (const file of files) requireValue(await hashFile(file.path) === file.sha256, 'Static parser implementation changed while reading inputs.');
  return { javaPath: java, libraryDirectory: library, classpath, implementationFiles: files,
    evidenceFiles: await Promise.all([requestPath, responsePath, stdoutPath, stderrPath].map(async file => ({ path: file, sha256: await hashFile(file) }))),
    dependencies: value.dependencies, scriptsExecuted: false };
}

export async function freezeSuite({ manifestPath, projectRoot, deviceId, outputDirectory, powershellPath }, environment = process.env) {
  projectRoot = path.resolve(projectRoot);
  const document = await readJson(manifestPath), manifest = document.value, base = path.dirname(document.path);
  requireValue(manifest.schemaVersion === 2, 'CI suite schemaVersion 1 is no longer dispatched. Migrate to v2 with sourceRoot, expectedFlows and buildManifest; see docs/ci.md.');
  requireValue(typeof manifest.suiteId === 'string' && id.test(manifest.suiteId) && typeof manifest.flowPath === 'string' && typeof manifest.sourceRoot === 'string', 'Suite requires suiteId, flowPath and sourceRoot.');
  requireValue(typeof deviceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(deviceId), 'Explicit device identity is required.');
  const entry = path.resolve(base, manifest.flowPath), sourceRoot = path.resolve(base, manifest.sourceRoot);
  await noLinks(entry); await noLinks(sourceRoot);
  requireValue(samePath(entry, sourceRoot) || inside(sourceRoot, entry), 'Flow entry must be inside sourceRoot.');
  requireValue(!samePath(sourceRoot, outputDirectory) && !inside(sourceRoot, outputDirectory), 'CI output must be outside the frozen sourceRoot.');
  const stat = await fs.stat(entry), suite = stat.isDirectory();
  requireValue(suite || stat.isFile() && /\.ya?ml$/i.test(entry), 'Flow entry must be a YAML file or suite directory.');
  const sources = await sourceFiles(sourceRoot), sourceMap = new Map(sources.map(file => [key(file.path), file.sha256]));
  requireValue(sources.length > 0 && sources.length <= 10000, 'Source tree must contain 1 to 10000 YAML/JS files.');
  requireValue(!suite || !sources.some(file => samePath(path.dirname(file.path), entry) && /^config\.ya?ml$/i.test(path.basename(file.path))), 'CI v2 does not accept workspace config.yaml/config.yml; list the fixed top-level flows explicitly.');
  requireValue(Array.isArray(manifest.expectedFlows) && manifest.expectedFlows.length > 0, 'Declare expectedFlows with unique path and name.');
  const expected = manifest.expectedFlows.map(flow => {
    requireValue(typeof flow.path === 'string' && typeof flow.name === 'string' && flow.name.trim() && flow.name.length <= 4096, 'Expected Flow requires path and name.');
    const file = path.resolve(base, flow.path);
    requireValue(sourceMap.has(key(file)) && /\.ya?ml$/i.test(file) && (suite ? samePath(path.dirname(file), entry) : samePath(file, entry)), 'Expected Flow is not a frozen top-level member.');
    return { path: file, name: flow.name, sha256: sourceMap.get(key(file)), requiredSteps: [] };
  });
  unique(expected.map(flow => key(flow.path)), 'Flow paths'); unique(expected.map(flow => flow.name), 'Flow names');
  const members = suite ? sources.filter(file => samePath(path.dirname(file.path), entry) && /\.ya?ml$/i.test(file.path)).map(file => key(file.path)).sort() : [key(entry)];
  requireValue(canonical(members) === canonical(expected.map(flow => key(flow.path)).sort()), 'Declared Flow members differ from the actual top-level files.');
  requireValue(typeof manifest.bundleId === 'string' && manifest.bundleId.trim() && typeof manifest.abilityName === 'string' && manifest.abilityName.trim(), 'Application bundleId and abilityName are required.');
  const names = manifest.environmentNames ?? [];
  requireValue(Array.isArray(names) && names.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.toUpperCase() !== 'APP_ID' && typeof environment[name] === 'string'), 'Environment name is invalid, reserved or unset.');
  unique(names.map(name => name.toUpperCase()), 'Environment names');
  const moduleName = manifest.moduleName ?? environment.MAESTRO_HARMONYOS_MODULE ?? null;
  requireValue(moduleName === null || typeof moduleName === 'string' && moduleName.trim(), 'moduleName must be nonempty when supplied.');
  const profile = { bundleId: manifest.bundleId, abilityName: manifest.abilityName, moduleName,
    environmentNames: [...names].sort(), environmentHashes: Object.fromEntries(names.map(name => [name, hash(Buffer.from(environment[name]))])) };
  const build = await verifyBuildReference(manifest.buildManifest, base, projectRoot);
  const videoPolicy = await freezeVideoPolicy(manifest.videoPolicy, base, expected);
  const staticInspection = await inspectFlows(projectRoot, sourceRoot, expected, sources, outputDirectory, environment);
  const applicationFiles = [];
  if (manifest.applicationFile !== undefined) {
    const reference = manifest.applicationFile;
    requireValue(typeof reference?.path === 'string' && typeof reference.sha256 === 'string' && /^[0-9a-f]{64}$/.test(reference.sha256), 'applicationFile requires path and SHA-256.');
    const file = path.resolve(base, reference.path);
    requireValue(await hashFile(file) === reference.sha256, 'Declared local HAP fingerprint differs.');
    applicationFiles.push({ path: file, sha256: reference.sha256 });
  }
  const toolFiles = [];
  const configurationPath = path.join(projectRoot, 'config.local.ps1');
  const configurationPresent = await fs.stat(configurationPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  for (const name of ['scripts/run-harmonyos.ps1', 'scripts/ci/run-device-suite.ps1', 'scripts/ci/suite.mjs', 'scripts/ci/snapshot-build.mjs',
    'scripts/ci/read-junit.ps1', 'scripts/ci/verify-state.mjs', 'scripts/ci/device-reservation.ps1', 'scripts/ci/verify-videos.mjs',
    'scripts/verify-recording.ps1', 'scripts/validation/io.mjs',
    'scripts/validation/plan.mjs', 'scripts/validation/runtime.mjs', 'scripts/validation/preparation.mjs',
    'scripts/validation/retry-evidence.mjs', 'examples/agent-client/client.mjs', 'examples/agent-client/evidence.mjs',
    'upstream.lock.json', 'patches/maestro/0001-harmonyos-host.patch', 'config.local.ps1']) {
    const file = path.join(projectRoot, name);
    try { toolFiles.push({ path: file, sha256: await hashFile(file) }); } catch (error) { if (name !== 'config.local.ps1' || error.code !== 'ENOENT') throw error; }
  }
  requireValue(typeof powershellPath === 'string' && path.isAbsolute(powershellPath), 'XML reader requires an explicit PowerShell executable.');
  toolFiles.push({ path: powershellPath, sha256: await hashFile(powershellPath) }, { path: process.execPath, sha256: await hashFile(process.execPath) },
    ...staticInspection.implementationFiles);
  if (videoPolicy) toolFiles.push(videoPolicy.ffmpeg);
  const value = { protocol: 'maestro.harmonyos.ci-inputs', schemaVersion: 1, frozenAt: new Date().toISOString(), suiteId: manifest.suiteId,
    projectRoot, deviceId, manifest: { path: document.path, sha256: document.sha256 }, powershellPath, configurationPresent,
    units: [{ unitId: manifest.suiteId, entry, sourceRoot, sources, requiredTopLevelFlows: expected }], profiles: { suite: profile },
    buildFiles: [...build.files.map(({ path, sha256 }) => ({ path, sha256 })), build.reference, { path: document.path, sha256: document.sha256 }],
    applicationFiles, toolFiles, confirmation: null, build, staticInspection, videoPolicy,
    installedApplicationCorrespondence: 'unverified', formalEligibility: false };
  await checkFrozen(value, environment);
  const snapshotPath = path.join(outputDirectory, 'ci-inputs.json'); await atomicJson(snapshotPath, value, true);
  return { snapshotPath: path.resolve(snapshotPath), snapshotSha256: await hashFile(snapshotPath), suiteId: value.suiteId, unit: value.units[0], profile,
    videoBudgetSeconds: videoPolicy?.budgetSeconds ?? 0 };
}

export async function loadSuite(snapshotPath, expectedHash, environment = process.env) {
  const document = await readJson(snapshotPath), snapshot = document.value;
  requireValue(document.sha256 === expectedHash && snapshot.protocol === 'maestro.harmonyos.ci-inputs' && snapshot.schemaVersion === 1, 'CI input snapshot differs from the retained launch.');
  await checkFrozen(snapshot, environment);
  requireValue(samePath(await javaExecutable(environment), snapshot.staticInspection.javaPath), 'Configured Java differs from the frozen parser and runner Java.');
  const classpath = (await fs.readdir(snapshot.staticInspection.libraryDirectory)).filter(name => /\.jar$/i.test(name)).sort().map(name => path.join(snapshot.staticInspection.libraryDirectory, name));
  requireValue(canonical(classpath.map(key)) === canonical(snapshot.staticInspection.classpath.map(key)), 'Installed classpath membership changed.');
  for (const file of snapshot.staticInspection.evidenceFiles) requireValue(await hashFile(file.path) === file.sha256, 'Static inspection evidence changed.');
  const configurationPresent = await fs.stat(path.join(snapshot.projectRoot, 'config.local.ps1')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  requireValue(configurationPresent === snapshot.configurationPresent, 'Local configuration presence changed after freezing.');
  await verifyBuildReference(snapshot.build.reference, path.dirname(snapshotPath), snapshot.projectRoot);
  return snapshot;
}

export function checkJunit(document, snapshot, execution) {
  requireValue(document.schemaVersion === 1 && Array.isArray(document.suites) && document.suites.length === 1, 'Expected one native single-device JUnit testsuite.');
  const suite = document.suites[0], expected = snapshot.units[0].requiredTopLevelFlows;
  requireValue(Array.isArray(suite.testCases) && Number.isSafeInteger(suite.tests) && Number.isSafeInteger(suite.failures) &&
    suite.tests === suite.testCases.length && suite.failures >= 0, 'JUnit count differs from its actual testcases.');
  requireValue(suite.testCases.length === expected.length, 'JUnit is missing or adding declared scenarios.');
  const seen = new Set(), cases = [];
  for (const test of suite.testCases) {
    requireValue(typeof test.file === 'string' && test.file && typeof test.name === 'string' && ['SUCCESS', 'ERROR'].includes(test.status), 'JUnit testcase lacks a supported source/name/status.');
    const source = path.resolve(snapshot.projectRoot, test.file), identity = key(source);
    const flow = expected.find(item => samePath(item.path, source) && item.name === test.name);
    requireValue(flow && !seen.has(identity), 'JUnit scenario is foreign, duplicated or has a different name.'); seen.add(identity);
    requireValue(test.failureCount === (test.status === 'ERROR' ? 1 : 0), 'JUnit status contradicts its failure element.');
    cases.push({ sourcePath: flow.path, sourceSha256: flow.sha256, name: flow.name, status: test.status });
  }
  requireValue(suite.failures === cases.filter(test => test.status === 'ERROR').length, 'JUnit failures count is inconsistent.');
  if (execution === 'passed') requireValue(cases.every(test => test.status === 'SUCCESS'), 'Passed execution contradicts native JUnit failures.');
  return { scenarios: cases, tests: suite.tests, failures: suite.failures };
}

export async function verifySuite(input, environment = process.env) {
  const report = { protocol: 'maestro.harmonyos.ci-quality', schemaVersion: 1, status: 'failed', checkedAt: new Date().toISOString(),
    runId: input.runId, attemptId: input.attemptId, deviceId: input.deviceId, snapshotPath: input.snapshotPath,
    snapshotSha256: input.snapshotSha256, execution: null, cleanup: null, installedApplicationCorrespondence: 'unverified',
    formalEligibility: false, error: null, originalFiles: [], video: { status: 'not_assessed' } };
  async function observed(file) { const doc = await readJson(file); report.originalFiles.push({ path: doc.path, sha256: doc.sha256 }); return doc; }
  try {
    const result = await observed(input.resultPath), data = result.value.data;
    report.execution = data?.status; report.cleanup = data?.cleanup;
    requireValue(result.sha256 === input.resultSha256 && data.runId === input.runId && data.attemptId === input.attemptId && data.deviceId === input.deviceId, 'Native result differs from release verification.');
    const snapshot = await loadSuite(input.snapshotPath, input.snapshotSha256, environment);
    if (!snapshot.videoPolicy) report.video = { status: 'not_required' };
    requireValue(snapshot.deviceId === input.deviceId, 'Snapshot belongs to another device.');
    const control = await observed(input.controlRecordPath);
    requireValue(control.sha256 === input.controlSha256 && control.value.runId === input.runId && control.value.attemptId === input.attemptId &&
      control.value.deviceId === input.deviceId && typeof control.value.process?.executable === 'string' &&
      samePath(control.value.process.executable, snapshot.staticInspection.javaPath), 'Actual runner Java differs from the frozen static parser Java.');
    const base = path.dirname(result.path), index = await observed(await artifact(base, data.artifacts.evidenceIndexPath));
    const verifiedInput = await verifyAttemptInput(result.value, index.value, input.agentRoot, snapshot.units[0], snapshot.profiles.suite);
    const registered = await observed(await artifact(base, data.input.path));
    requireValue(registered.value.request.sources.length === 1 && samePath(registered.value.request.sources[0].path, snapshot.units[0].entry), 'Registered entry differs from the frozen invocation.');
    requireValue(typeof data.artifacts.junitPath === 'string', 'Native JUnit is unavailable for this execution; scenarios cannot be verified.');
    const xml = await artifact(base, data.artifacts.junitPath), before = await hashFile(xml);
    const { stdout } = await execute(snapshot.powershellPath, ['-NoProfile', '-File', path.join(snapshot.projectRoot, 'scripts/ci/read-junit.ps1'), '-Path', xml],
      { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim());
    requireValue(samePath(parsed.sourcePath, xml) && parsed.sha256 === before && await hashFile(xml) === before, 'JUnit changed during XML inspection.');
    report.originalFiles.push({ path: xml, sha256: before });
    report.junit = { path: xml, sha256: before, ...checkJunit(parsed, snapshot, data.status) };
    if (snapshot.videoPolicy) {
      const videoDirectory = path.join(path.dirname(input.outputPath), 'video-verification');
      try {
        await noLinks(videoDirectory); await fs.mkdir(videoDirectory);
        report.video = await verifyVideos({ snapshot, result: result.value, index: index.value, agentRoot: input.agentRoot,
          outputDirectory: videoDirectory, verifiedInput });
      } catch (error) { report.video = { status: 'failed', error: String(error.message ?? error) }; throw error; }
      requireValue(report.video.status === 'passed', report.video.error ?? 'Required video verification failed.');
    }
    await loadSuite(input.snapshotPath, input.snapshotSha256, environment);
    report.build = snapshot.build; report.status = 'passed';
  } catch (error) { report.error = String(error.message ?? error); }
  for (const file of report.originalFiles) {
    file.sha256After = await hashFile(file.path).catch(() => null);
    if (file.sha256After !== file.sha256) { report.status = 'failed'; report.error = 'An original report changed during quality verification.'; }
  }
  await atomicJson(input.outputPath, report, true);
  return { path: path.resolve(input.outputPath), sha256: await hashFile(input.outputPath), status: report.status, error: report.error };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const input = (await readJson(process.argv[2])).value;
    let result;
    if (input.operation === 'freeze') result = await freezeSuite(input);
    else if (input.operation === 'check') { await loadSuite(input.snapshotPath, input.snapshotSha256); result = { checked: true }; }
    else if (input.operation === 'quality') result = await verifySuite(input);
    else throw new Error('Unknown CI metadata operation.');
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
