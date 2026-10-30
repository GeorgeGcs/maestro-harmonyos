import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashFile, key, noLinks, requireValue, samePath } from './io.mjs';

const execute = promisify(execFile);
const MAX_JARS = 4096;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const sameBytes = (left, right) => samePath(left.path, right.path) && left.sha256 === right.sha256 && left.bytes === right.bytes;

function normalizedEnvironment(environment) {
  requireValue(environment && typeof environment === 'object' && !Array.isArray(environment), 'Runtime environment must be an object.');
  const values = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === null) continue;
    requireValue(typeof value === 'string', 'Runtime environment values must be strings.');
    const normalized = name.toUpperCase();
    requireValue(!Object.hasOwn(values, normalized) || values[normalized] === value, 'Environment contains conflicting case-insensitive names: ' + name);
    values[normalized] = value;
  }
  return values;
}

async function fingerprint(file) {
  requireValue(absolute(file), 'Runtime files must use absolute paths.');
  const resolved = path.resolve(file);
  await noLinks(resolved);
  const before = await fs.stat(resolved);
  requireValue(before.isFile() && Number.isSafeInteger(before.size), 'Runtime fingerprint requires a regular file.');
  const sha256 = await hashFile(resolved), after = await fs.stat(resolved);
  await noLinks(resolved);
  requireValue(after.isFile() && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino,
    'Runtime file changed while its fingerprint was read.');
  return { path: resolved, sha256, bytes: before.size };
}

async function configuration(projectRoot) {
  const file = path.join(projectRoot, 'config.local.ps1');
  await noLinks(file);
  try {
    const observed = await fingerprint(file);
    return { path: file, present: true, sha256: observed.sha256, bytes: observed.bytes };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { path: file, present: false, sha256: null, bytes: null };
  }
}

async function javaPath(projectRoot, powershellPath, environment) {
  if (environment.JAVA_HOME) {
    requireValue(absolute(environment.JAVA_HOME), 'Use an absolute JAVA_HOME for a frozen runtime.');
    // The runner does not fall back to PATH when JAVA_HOME is nonempty but invalid.
    return path.resolve(environment.JAVA_HOME, 'bin/java.exe');
  }
  const locations = (environment.PATH ?? '').split(path.delimiter).filter(value => value !== '');
  requireValue(locations.every(absolute), 'Relative PATH entries cannot be frozen reliably; set an absolute JAVA_HOME.');
  // Use the same PowerShell command-resolution semantics, including PATHEXT and
  // .cmd/.com candidates. Never run Java, a launcher, config.local or a version probe.
  const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "$javaCommand=Get-Command java -CommandType Application -ErrorAction Stop | Select-Object -First 1; " +
    "if ($null -eq $javaCommand) { throw 'No Java application was found.' }; [Console]::Out.Write($javaCommand.Source)";
  const { stdout, stderr } = await execute(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: projectRoot, env: environment, windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' });
  const selected = stdout.trim();
  requireValue(!stderr.trim() && absolute(selected) && !/[\r\n\x00]/.test(selected), 'PowerShell did not return one absolute Java application path.');
  return path.resolve(selected);
}

async function classpath(cliHome) {
  const library = path.join(cliHome, 'lib');
  await noLinks(library);
  requireValue((await fs.stat(library)).isDirectory(), 'Installed CLI library directory is missing.');
  const files = [];
  for await (const item of await fs.opendir(library)) {
    if (!/\.jar$/i.test(item.name)) continue;
    requireValue(!item.isSymbolicLink(), 'Classpath JAR must not be a link.');
    if (!item.isFile()) continue; // JVM wildcard includes direct JAR files only.
    requireValue(files.length < MAX_JARS, 'Installed classpath exceeds the JAR count limit.');
    files.push(await fingerprint(path.join(library, item.name)));
  }
  requireValue(files.length > 0, 'Installed CLI classpath is empty.');
  files.sort((left, right) => key(left.path) < key(right.path) ? -1 : key(left.path) > key(right.path) ? 1 : 0);
  requireValue(new Set(files.map(file => key(file.path))).size === files.length, 'Installed classpath has duplicate canonical paths.');
  return files;
}

async function observe(projectRoot, powershellPath, environment, expectedPowershell = null) {
  requireValue(absolute(projectRoot) && absolute(powershellPath), 'Explicit absolute projectRoot and powershellPath are required.');
  const root = path.resolve(projectRoot);
  await noLinks(root); requireValue((await fs.stat(root)).isDirectory(), 'Runtime project root is not a directory.');
  // This is the public runner's fixed distribution. MAESTRO_CLI_HOME and
  // MAESTRO_JAVA_HOME are not overrides in scripts/run-harmonyos.ps1.
  const cliHome = path.join(root, '.upstream/maestro/maestro-cli/build/install/maestro');
  const launcher = path.join(cliHome, 'bin/maestro.bat');
  await noLinks(launcher); requireValue((await fs.stat(launcher)).isFile(), 'Installed CLI launcher is missing.');
  const config = await configuration(root), powershell = await fingerprint(powershellPath);
  requireValue(expectedPowershell === null || sameBytes(expectedPowershell, powershell), 'Frozen runtime powershell changed before Java path resolution.');
  const selectedJava = await javaPath(root, powershell.path, normalizedEnvironment(environment));
  return { schemaVersion: 1, projectRoot: root, cliHome, classpathArgument: path.join(cliHome, 'lib', '*'),
    java: await fingerprint(selectedJava), classpath: await classpath(cliHome),
    node: await fingerprint(process.execPath), powershell, configuration: config };
}

function validateFile(value) {
  requireValue(value && absolute(value.path) && digest(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0,
    'Invalid frozen runtime file fingerprint.');
}

function validateSnapshot(snapshot) {
  requireValue(snapshot?.schemaVersion === 1 && absolute(snapshot.projectRoot) && absolute(snapshot.cliHome) &&
    samePath(snapshot.cliHome, path.join(snapshot.projectRoot, '.upstream/maestro/maestro-cli/build/install/maestro')) &&
    samePath(snapshot.classpathArgument, path.join(snapshot.cliHome, 'lib', '*')), 'Invalid frozen runtime layout.');
  for (const file of [snapshot.java, snapshot.node, snapshot.powershell]) validateFile(file);
  requireValue(Array.isArray(snapshot.classpath) && snapshot.classpath.length > 0 && snapshot.classpath.length <= MAX_JARS,
    'Invalid frozen runtime classpath.');
  const paths = new Set();
  for (const file of snapshot.classpath) {
    validateFile(file);
    requireValue(samePath(path.dirname(file.path), path.join(snapshot.cliHome, 'lib')) && /\.jar$/i.test(path.basename(file.path)) &&
      !paths.has(key(file.path)), 'Frozen classpath is duplicated or outside the installed library.');
    paths.add(key(file.path));
  }
  const config = snapshot.configuration;
  requireValue(config && samePath(config.path, path.join(snapshot.projectRoot, 'config.local.ps1')) && typeof config.present === 'boolean',
    'Invalid frozen local configuration.');
  if (config.present) validateFile(config);
  else requireValue(config.sha256 === null && config.bytes === null, 'Absent configuration cannot claim a file fingerprint.');
}

/** The caller loads config.local in its existing PowerShell process first. */
export async function freezeRuntime(projectRoot, { powershellPath } = {}, environment = process.env) {
  const snapshot = await observe(path.resolve(projectRoot), powershellPath, environment);
  // A second observation checks membership and files that could change while
  // the first pass was reading other JARs. This is a local observation, not a signed build proof.
  await checkRuntime(snapshot, environment);
  return snapshot;
}

/** Only use before dispatch: current binaries are intentionally read here. */
export async function checkRuntime(snapshot, environment = process.env) {
  validateSnapshot(snapshot);
  const observed = await observe(snapshot.projectRoot, snapshot.powershell.path, environment, snapshot.powershell);
  requireValue(samePath(observed.cliHome, snapshot.cliHome) && samePath(observed.classpathArgument, snapshot.classpathArgument), 'Runtime CLI location changed.');
  for (const name of ['java', 'node', 'powershell']) requireValue(sameBytes(snapshot[name], observed[name]), 'Frozen runtime ' + name + ' changed.');
  requireValue(observed.configuration.present === snapshot.configuration.present && samePath(observed.configuration.path, snapshot.configuration.path) &&
    observed.configuration.sha256 === snapshot.configuration.sha256 && observed.configuration.bytes === snapshot.configuration.bytes,
    'Local configuration presence or bytes changed.');
  const expected = new Map(snapshot.classpath.map(file => [key(file.path), file]));
  requireValue(observed.classpath.length === expected.size && observed.classpath.every(file =>
    expected.has(key(file.path)) && sameBytes(expected.get(key(file.path)), file)), 'Frozen runtime classpath membership or bytes changed.');
  return { verified: true, status: 'verified', reason: null };
}

/** Historical comparison only. Do not read today's tools to authenticate yesterday's run. */
export function verifyControlRuntime(snapshot, control) {
  validateSnapshot(snapshot);
  if (!control?.runtime) return { verified: false, status: 'unverified', reason: 'Runner control does not record a runtime fingerprint.' };
  const runtime = control.runtime;
  requireValue(runtime.schemaVersion === 1 && samePath(runtime.cliHome, snapshot.cliHome) &&
    samePath(runtime.classpathArgument, snapshot.classpathArgument), 'Executed CLI/classpath location differs from the frozen runtime.');
  for (const name of ['java', 'powershell']) {
    requireValue(runtime[name] && samePath(runtime[name].path, snapshot[name].path) && digest(runtime[name].sha256) &&
      runtime[name].sha256 === snapshot[name].sha256, 'Executed ' + name + ' differs from the frozen runtime.');
  }
  requireValue(samePath(control.executable, snapshot.java.path) && samePath(control.process?.executable, snapshot.java.path),
    'Actual Java process does not match its frozen runtime.');
  const config = runtime.configuration, frozenConfig = snapshot.configuration;
  requireValue(config && samePath(config.path, frozenConfig.path) && config.present === frozenConfig.present &&
    config.sha256 === frozenConfig.sha256 && (config.present ? digest(config.sha256) : config.sha256 === null),
    'Executed local configuration differs from the frozen runtime.');
  requireValue(Array.isArray(runtime.classpath) && runtime.classpath.length === snapshot.classpath.length, 'Executed classpath is incomplete.');
  const expected = new Map(snapshot.classpath.map(file => [key(file.path), file.sha256])), seen = new Set();
  for (const file of runtime.classpath) {
    requireValue(file && absolute(file.path) && digest(file.sha256) && !seen.has(key(file.path)) && expected.get(key(file.path)) === file.sha256,
      'Executed classpath membership or hash differs from the frozen runtime.');
    seen.add(key(file.path));
  }
  return { verified: true, status: 'verified', reason: null };
}
