import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const defaultGroups = ['Jvm', 'Agent', 'Recovery', 'Scripts', 'Schemas', 'VSCode'];
export function platformExclusionsFor(groups, platform = process.platform) {
  return platform === 'win32' && groups.includes('Jvm') ? [{
    className: 'maestro.harmonyos.driver.Mp4RecordingValidatorTest',
    methodName: 'rejects symlinks even when their target is a valid recording',
    reason: 'The upstream test declares @EnabledOnOs(OS.LINUX, OS.MAC); Windows is outside its scope.',
    status: 'not_executed', countedAsPassed: false,
  }] : [];
}
export function groupsFor(input = ['All']) {
  if (!input.length || input.some(name => ![...defaultGroups, 'All', 'ExtensionHost'].includes(name))) throw Error('Unknown or empty host test group.');
  if (input.includes('All') && input.length !== 1) throw Error('All cannot be combined with another group.');
  return input[0] === 'All' ? [...defaultGroups] : [...new Set(input)];
}
export function nodeVersionAllowed(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return !!match && (+match[1] > 22 || +match[1] === 22 && +match[2] >= 12);
}
export function tapCounts(text) {
  const value = {};
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp('^# ' + field + ' (\\d+)\\s*$', 'gm'))];
    if (matches.length !== 1) throw Error('Missing or ambiguous TAP summary: ' + field);
    value[field] = Number(matches[0][1]);
  }
  if (value.tests <= 0 || value.tests !== value.pass + value.fail + value.cancelled + value.skipped + value.todo) throw Error('Incomplete TAP test counts.');
  return value;
}
export function acceptableStep(exitCode, counts) {
  return exitCode === 0 && (!counts || counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0);
}
const normalize = file => path.resolve(file).toLowerCase();
export function externalTemp(project, candidate) {
  const relative = path.relative(normalize(project), normalize(candidate));
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw Error('TestTempDirectory must be outside the repository (CI reservations reject in-repository state).');
  return path.resolve(candidate);
}
async function file(name) {
  if (!(await fs.stat(name)).isFile()) throw Error('Required tool/file is missing: ' + name);
  return path.resolve(name);
}
async function version(executable, args, environment) {
  const result = await execute(executable, args, { env: environment, windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  return (result.stdout + result.stderr).trim();
}
async function distribution(home, label) {
  if (!home) throw Error(label + ' is required. Supply a complete CLI distribution, not a single JAR.');
  const directory = path.resolve(home), names = await fs.readdir(path.join(directory, 'lib'));
  if (!names.some(name => /^maestro-cli.*\.jar$/.test(name)) || !names.some(name => /^maestro-client.*\.jar$/.test(name))) throw Error(label + ' lacks Maestro CLI/client JARs.');
  return directory;
}

/** Read tool metadata and versions only. Never enumerates or communicates with a device. */
export async function preflight(options, environment = process.env) {
  const project = path.resolve(options.project), groups = groupsFor(options.groups);
  if (process.platform !== 'win32') throw Error('The host suite currently supports Windows only.');
  if (!nodeVersionAllowed(process.version)) throw Error('Node.js 22.12 or newer is required.');
  const powershell = await file(options.powershell);
  const psVersion = await version(powershell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], environment);
  if (Number(psVersion.split('.')[0]) < 7) throw Error('PowerShell 7 or newer is required.');
  const config = { project, groups, node: process.execPath, powershell, versions: { node: process.version, powershell: psVersion },
    temp: externalTemp(project, options.testTemp ?? path.resolve(project, '../../.local/maestro-host-tests')) };
  if (groups.some(name => ['Jvm', 'Scripts'].includes(name))) config.versions.git = await version('git', ['--version'], environment);
  const needsJava = groups.some(name => ['Jvm', 'Agent', 'Recovery', 'Scripts', 'Schemas'].includes(name));
  if (needsJava) {
    if (!options.javaHome) throw Error('JavaHome/JAVA_HOME must identify a complete JDK 17.');
    config.javaHome = path.resolve(options.javaHome);
    config.java = await file(path.join(config.javaHome, 'bin/java.exe'));
    config.javac = await file(path.join(config.javaHome, 'bin/javac.exe'));
    await file(path.join(config.javaHome, 'bin/jar.exe'));
    config.versions.java = await version(config.java, ['-version'], environment);
    config.versions.javac = await version(config.javac, ['-version'], environment);
    if (!/version "17(?:\.|\")/.test(config.versions.java) || !/^javac 17(?:\.|$)/.test(config.versions.javac)) throw Error('This pinned upstream build requires JDK 17.');
  }
  if (groups.some(name => ['Jvm', 'Recovery', 'Schemas'].includes(name))) {
    if (!options.bash) throw Error('BashPath must identify Git Bash; real shell recovery tests may not be skipped.');
    config.bash = await file(options.bash);
    config.versions.bash = await version(config.bash, ['--version'], environment);
    if (!config.versions.bash.includes('GNU bash')) throw Error('BashPath is not GNU Bash.');
  }
  if (groups.some(name => ['Agent', 'Recovery', 'Schemas'].includes(name))) config.cli = await distribution(options.cli, 'CliDirectory');
  if (groups.includes('Recovery')) config.originalCli = await distribution(options.originalCli, 'OriginalCliDirectory');
  if (groups.includes('Jvm')) {
    if (!options.gradleHome || !options.simulatorCache) throw Error('Jvm requires GradleHome (8.13) and SimulatorCache. This entry does not download build tools or resources.');
    config.gradle = await file(path.join(options.gradleHome, 'lib/gradle-launcher-8.13.jar'));
    config.gradleUserHome = path.resolve(options.gradleUserHome ?? path.join(project, '.gradle-user-home'));
    config.simulatorCache = path.resolve(options.simulatorCache);
    config.upstream = path.join(project, '.upstream/maestro');
    await file(path.join(config.upstream, 'settings.gradle.kts'));
    const spec = JSON.parse(await fs.readFile(path.join(project, 'upstream.lock.json'), 'utf8'));
    const actual = await version('git', ['-C', config.upstream, 'rev-parse', 'HEAD'], environment);
    if (actual !== spec.commit) throw Error('Prepared upstream differs from the pinned commit.');
    const patch = path.join(project, 'patches/maestro/0001-harmonyos-host.patch');
    await version('git', ['-C', config.upstream, 'apply', '--reverse', '--check', '--', patch], environment);
    await version(powershell, ['-NoProfile', '-File', path.join(project, 'scripts/gradle/verify-simulator-cache.ps1'), '-CacheDirectory', config.simulatorCache], environment);
  }
  if (groups.some(name => ['VSCode', 'ExtensionHost'].includes(name))) {
    config.npm = await file(path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'));
    config.versions.npm = await version(process.execPath, [config.npm, '--version'], environment);
    config.extension = path.join(project, 'packages/vscode');
    config.tsc = await file(path.join(config.extension, 'node_modules/typescript/bin/tsc'));
    await file(path.join(config.extension, 'node_modules/@vscode/test-electron/package.json'));
  }
  if (groups.includes('ExtensionHost')) {
    if (!options.code) throw Error('CodePath is required for the optional ExtensionHost group; no editor will be downloaded.');
    config.code = await file(options.code);
  }
  return config;
}

export async function plans(config, output) {
  const p = config.project, steps = [];
  const add = (group, id, executable, args, kind = 'command', cwd = p, extra = {}) => steps.push({ group, id, executable, args, kind, cwd,
    timeoutMs: group === 'Jvm' ? 1800000 : kind === 'tap' ? 900000 : 600000, ...extra });
  const ps = (group, name, args = []) => add(group, name, config.powershell, ['-NoProfile', '-File', path.join(p, 'scripts/tests', name + '.ps1'), ...args], 'powershell');
  const nodeTests = (group, id, files, cwd = p) => add(group, id, config.node, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], 'tap', cwd);
  for (const group of config.groups) {
    if (group === 'Jvm') {
      add(group, 'jvm', config.java, ['-Dmaestro.harmonyosRepository=' + p, '-Dmaestro.simulatorCache=' + config.simulatorCache,
        '-cp', config.gradle, 'org.gradle.launcher.GradleMain', '-p', config.upstream, '-I', path.join(p, 'scripts/gradle/simulator-cache.init.gradle'),
        '-I', path.join(p, 'scripts/gradle/host-test-rerun.init.gradle'),
        ':maestro-client:test', '--tests', 'maestro.harmonyos.*', ':maestro-test:test', '--tests', 'maestro.harmonyos.*',
        ':maestro-cli:test', '--tests', 'maestro.cli.harmonyos.*', '--tests', 'maestro.cli.session.*',
        ':maestro-orchestra:test', '--tests', '*ScreenRecordingOutputTest', '--tests', '*ArtifactsGeneratorTest',
        '--offline', '--no-daemon', '--no-build-cache', '--console=plain'], 'junit', p,
        { reports: ['maestro-client', 'maestro-test', 'maestro-cli', 'maestro-orchestra'].map(module => path.join(config.upstream, module, 'build/test-results/test')) });
    } else if (group === 'Agent') {
      nodeTests(group, 'agent', (await fs.readdir(path.join(p, 'examples/agent-client/test'))).filter(n => n.endsWith('.test.mjs')).sort().map(n => 'examples/agent-client/test/' + n));
    } else if (group === 'Recovery') {
      const names = ['test-cleanup-fence', 'test-maintenance-release', 'test-maintenance-tools', 'test-windows-boot', 'test-ci-collect-artifacts'];
      nodeTests(group, 'recovery', names.map(n => 'scripts/tests/' + n + '.mjs'));
    } else if (group === 'Scripts') {
      const names = (await fs.readdir(path.join(p, 'scripts/tests'))).filter(n => n.endsWith('.mjs') && /^test-/.test(n) &&
        !['test-cleanup-fence.mjs', 'test-maintenance-release.mjs', 'test-maintenance-tools.mjs', 'test-windows-boot.mjs', 'test-ci-collect-artifacts.mjs'].includes(n));
      nodeTests(group, 'scripts-node', names.sort().map(n => 'scripts/tests/' + n));
      for (const name of ['test-run-harmonyos', 'test-device-matrix', 'test-validation-plan', 'test-ci-junit', 'test-patch-scripts']) ps(group, name);
      ps(group, 'test-ci-device-suite', ['-TestArtifactsRoot', path.join(config.temp, 'ci')]);
    } else if (group === 'Schemas') {
      const producer = path.join(output, 'schema-producer');
      add(group, 'schema-producer', config.java, ['--class-path', path.join(config.cli, 'lib/*'), path.join(p, 'scripts/tests/fixtures/CleanupFenceProducer.java'), producer, config.bash, 'complete']);
      add(group, 'schema-blocked', config.java, ['-Duser.home=' + path.join(output, 'schema-user'), '--class-path', path.join(config.cli, 'lib/*'),
        'maestro.cli.AppKt', '--platform', 'android', '--device', 'cleanup-schema-fixture', 'harmonyos-cleanup-recovery',
        '--session', '11111111-1111-4111-8111-111111111111', '--hdc', path.join(output, 'no-hdc.exe'),
        '--original-cli', path.join(output, 'no-original-cli')], 'command', p, { expectedExitCode: 1 });
      for (const name of ['test-recording-schema', 'test-retry-validation-schema', 'test-maintenance-schema']) ps(group, name);
      ps(group, 'test-cleanup-fence-schema', ['-ProducerDirectory', producer,
        '-BlockedResponsePath', path.join(output, 'schema-blocked.stdout.log'), '-RequireProductionEvidence']);
    } else if (group === 'VSCode' || group === 'ExtensionHost') {
      add(group, group.toLowerCase() + '-compile', config.node, [config.tsc, '-p', config.extension]);
      if (group === 'VSCode') nodeTests(group, 'vscode-unit', ['dist/test/*.test.js'], config.extension);
      else add(group, 'extension-host', config.node, [path.join(config.extension, 'dist/test/runExtension.js')], 'command', config.extension);
    }
  }
  return steps;
}

export async function readJUnitReports(directories, startedAt) {
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 }, errors = [];
  for (const directory of directories) {
    let files;
    try {
      files = (await fs.readdir(directory)).filter(name => /^TEST-.*\.xml$/.test(name));
      if (!files.length) throw Error('JVM task has no XML test reports: ' + directory);
    } catch (failure) { errors.push(failure.message); continue; }
    for (const name of files) {
      try {
        if ((await fs.stat(path.join(directory, name))).mtimeMs < Date.parse(startedAt) - 2000) throw Error('Stale JUnit report; tests did not run in this invocation: ' + name);
        const xml = await fs.readFile(path.join(directory, name), 'utf8');
        const tag = /<testsuite\s[^>]*>/.exec(xml)?.[0];
        if (!tag) throw Error('Missing JUnit suite: ' + name);
        const n = field => { const value = new RegExp('\\b' + field + '="(\\d+)"').exec(tag); if (!value) throw Error('Invalid JUnit count: ' + name); return +value[1]; };
        const tests = n('tests'), fail = n('failures') + n('errors'), skipped = n('skipped');
        if (tests < fail + skipped) throw Error('Inconsistent JUnit counts: ' + name);
        counts.tests += tests; counts.fail += fail; counts.skipped += skipped; counts.pass += tests - fail - skipped;
      } catch (failure) { errors.push(failure.message); }
    }
  }
  return { counts, errors, complete: errors.length === 0 };
}

export async function runStep(step, output, environment) {
  const stdoutPath = path.join(output, step.id + '.stdout.log'), stderrPath = path.join(output, step.id + '.stderr.log');
  const out = openSync(stdoutPath, 'wx'), err = openSync(stderrPath, 'wx');
  const startedAt = new Date().toISOString();
  let exitCode = null, signal = null, error = null;
  let timedOut = false, processExitObserved = false, terminationError = null;
  try {
    const child = spawn(step.executable, step.args, { cwd: step.cwd, env: environment, windowsHide: true, shell: false, stdio: ['ignore', out, err] });
    ({ exitCode, signal } = await new Promise((resolve, reject) => {
      let ended = false, drainTimer, terminating = false, closed;
      const finish = value => { clearTimeout(timer); clearTimeout(drainTimer); resolve(value); };
      const timer = setTimeout(async () => {
        timedOut = true;
        terminating = true;
        if (!ended) {
          // The PID belongs to this still-running child, never a PID read from an old state file.
          try {
            if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
            else child.kill('SIGKILL');
          } catch (failure) { terminationError = failure.message; if (!ended) child.kill(); }
        }
        terminating = false;
        if (closed) finish(closed);
        else drainTimer = setTimeout(() => { child.unref(); finish({ exitCode: null, signal: null }); }, 5000);
      }, step.timeoutMs ?? 600000);
      child.once('error', failure => { clearTimeout(timer); clearTimeout(drainTimer); reject(failure); });
      child.once('exit', () => { ended = true; });
      child.once('close', (exitCode, signal) => {
        processExitObserved = true; closed = { exitCode, signal };
        if (!terminating) finish(closed);
      });
    }));
  } catch (failure) { error = failure.message; }
  finally { closeSync(out); closeSync(err); }
  let counts = null, countsComplete = null, reportErrors = [];
  try {
    if (step.kind === 'tap') counts = tapCounts(await fs.readFile(stdoutPath, 'utf8'));
    if (step.kind === 'powershell') {
      const text = await fs.readFile(stdoutPath, 'utf8');
      if (/^SKIP:/m.test(text) || /skipped\s*=\s*[1-9]\d*/i.test(text)) throw Error('Required PowerShell checks were skipped; inspect the host permissions and fixture logs.');
    }
    if (step.kind === 'junit') {
      // Gradle stops after a failed module. Count its fresh reports even when later modules did not run.
      const report = await readJUnitReports(step.reports, startedAt);
      counts = report.counts; countsComplete = report.complete; reportErrors = report.errors;
      if (!report.complete) throw Error('Incomplete JUnit reports: ' + report.errors.join('; '));
    }
  } catch (failure) { error = [error, failure.message].filter(Boolean).join('; '); }
  return { group: step.group, id: step.id, status: !error && !timedOut && processExitObserved && acceptableStep(exitCode === (step.expectedExitCode ?? 0) ? 0 : 1, counts) ? 'passed' : 'failed',
    startedAt, finishedAt: new Date().toISOString(), timeoutMs: step.timeoutMs ?? 600000, exitCode, signal, error, timedOut, processExitObserved, terminationError, counts, countsComplete, reportErrors, stdoutPath, stderrPath,
    command: { executable: step.executable, args: step.args, cwd: step.cwd } };
}
