import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { freezeRuntime, checkRuntime, verifyControlRuntime } from '../validation/runtime.mjs';
import { hashFile } from '../validation/io.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.join(repo, 'artifacts/validation-runtime-tests');
async function write(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
function envValue(env, name, value) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  if (value !== undefined) env[name] = value;
}

async function setup(t) {
  const root = path.join(parent, randomUUID()), project = path.join(root, 'checkout with spaces');
  const cli = path.join(project, '.upstream/maestro/maestro-cli/build/install/maestro'), library = path.join(cli, 'lib');
  const jdk = path.join(root, 'fake JDK'), powershell = path.join(root, 'fake-powershell.exe');
  await write(path.join(cli, 'bin/maestro.bat'), 'fixture launcher; never executed');
  await write(path.join(jdk, 'bin/java.exe'), 'fixture Java binary; never executed');
  await write(powershell, 'fixture PowerShell bytes; JAVA_HOME branch never executes it');
  for (const name of ['maestro-cli-2.12.0.jar', 'maestro-client.jar', 'maestro-orchestra.jar', 'maestro-orchestra-models.jar', 'dependency.JAR'])
    await write(path.join(library, name), 'fixture ' + name);
  const environment = { ...process.env }; envValue(environment, 'JAVA_HOME', jdk);
  t.after(async () => {
    assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true });
  });
  return { root, project, cli, library, jdk, powershell, environment,
    freeze: () => freezeRuntime(project, { powershellPath: powershell }, environment) };
}

function control(snapshot) {
  const withoutSize = ({ path, sha256 }) => ({ path, sha256 });
  return { executable: snapshot.java.path, process: { executable: snapshot.java.path }, runtime: {
    schemaVersion: 1, java: withoutSize(snapshot.java), powershell: withoutSize(snapshot.powershell),
    cliHome: snapshot.cliHome, classpathArgument: snapshot.classpathArgument, classpath: snapshot.classpath.map(withoutSize),
    configuration: { path: snapshot.configuration.path, present: snapshot.configuration.present, sha256: snapshot.configuration.sha256 } } };
}

test('freezes the runner fixed distribution and every direct JAR, not unused overrides or nested files', async t => {
  const f = await setup(t);
  f.environment.MAESTRO_CLI_HOME = path.join(f.root, 'ignored-cli'); f.environment.MAESTRO_JAVA_HOME = path.join(f.root, 'ignored-jdk');
  await write(path.join(f.library, 'nested', 'unused.jar'), 'not part of the wildcard'); await write(path.join(f.library, 'readme.txt'), 'not a JAR');
  const snapshot = await f.freeze();
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.cliHome, f.cli); assert.equal(snapshot.classpath.length, 5);
  assert.ok(snapshot.classpath.some(file => file.path.endsWith('dependency.JAR')));
  assert.equal(snapshot.java.path, path.join(f.jdk, 'bin/java.exe'));
  assert.equal(snapshot.node.path, process.execPath); assert.equal(snapshot.configuration.present, false);
  assert.equal(snapshot.configuration.sha256, null); assert.equal(snapshot.configuration.bytes, null);
  assert.deepEqual(await checkRuntime(snapshot, f.environment), { verified: true, status: 'verified', reason: null });
});

test('freezing observes config bytes but does not execute it', async t => {
  const f = await setup(t), file = path.join(f.project, 'config.local.ps1');
  await write(file, "throw 'A runtime reader must not execute this configuration.'\n");
  const snapshot = await f.freeze(); assert.equal(snapshot.configuration.present, true);
  assert.equal(snapshot.configuration.sha256, await hashFile(file));
});

test('pre-dispatch checks reject changed tools, classpath membership and local configuration', async t => {
  for (const mode of ['java-bytes', 'java-path', 'powershell', 'node-path', 'add-jar', 'remove-jar', 'jar-bytes', 'add-config', 'remove-config', 'config-bytes']) await t.test(mode, async t => {
    const f = await setup(t), config = path.join(f.project, 'config.local.ps1');
    if (mode === 'remove-config' || mode === 'config-bytes') await write(config, '# fixture configuration');
    const snapshot = await f.freeze();
    if (mode === 'java-bytes') await fs.appendFile(snapshot.java.path, 'changed');
    if (mode === 'java-path') { const other = path.join(f.root, 'other JDK'); await write(path.join(other, 'bin/java.exe'), 'fixture Java binary; never executed'); envValue(f.environment, 'JAVA_HOME', other); }
    if (mode === 'powershell') await fs.appendFile(f.powershell, 'changed');
    if (mode === 'node-path') snapshot.node.path = snapshot.java.path;
    if (mode === 'add-jar') await write(path.join(f.library, 'new.JAR'), 'another dependency');
    if (mode === 'remove-jar') await fs.unlink(path.join(f.library, 'dependency.JAR'));
    if (mode === 'jar-bytes') await fs.appendFile(path.join(f.library, 'dependency.JAR'), 'changed');
    if (mode === 'add-config') await write(config, '# added after freeze');
    if (mode === 'remove-config') await fs.unlink(config);
    if (mode === 'config-bytes') await fs.appendFile(config, '\n# changed');
    await assert.rejects(checkRuntime(snapshot, f.environment));
  });
});

test('nonempty JAVA_HOME never falls back and runtime selection rejects ambiguous relative or duplicate environment names', async t => {
  const f = await setup(t);
  await fs.unlink(path.join(f.jdk, 'bin/java.exe')); await assert.rejects(f.freeze(), /ENOENT/);
  envValue(f.environment, 'JAVA_HOME', 'relative-jdk'); await assert.rejects(f.freeze(), /absolute JAVA_HOME/);
  envValue(f.environment, 'JAVA_HOME', undefined); envValue(f.environment, 'Path', '.;' + f.root);
  await assert.rejects(f.freeze(), /Relative PATH/);
  envValue(f.environment, 'JAVA_HOME', f.jdk); f.environment.java_home = path.join(f.root, 'different');
  await assert.rejects(f.freeze(), /conflicting case-insensitive/);
});

test('requires explicit PowerShell, an installed launcher and a nonempty classpath', async t => {
  const f = await setup(t);
  await assert.rejects(freezeRuntime(f.project, {}, f.environment), /powershellPath/);
  await fs.unlink(path.join(f.cli, 'bin/maestro.bat')); await assert.rejects(f.freeze(), /ENOENT/);
  await write(path.join(f.cli, 'bin/maestro.bat'), 'fixture');
  for (const name of await fs.readdir(f.library)) await fs.unlink(path.join(f.library, name));
  await assert.rejects(f.freeze(), /classpath is empty/);
});

test('historical runtime verification reads no current tool files and ignores classpath listing order', async t => {
  const f = await setup(t), snapshot = await f.freeze(), record = control(snapshot);
  record.runtime.classpath.reverse();
  await fs.unlink(snapshot.java.path); await fs.unlink(f.powershell);
  await fs.appendFile(path.join(f.library, 'dependency.JAR'), 'changed after the run');
  await write(path.join(f.project, 'config.local.ps1'), '# a later configuration');
  assert.deepEqual(verifyControlRuntime(snapshot, record), { verified: true, status: 'verified', reason: null });
  await assert.rejects(checkRuntime(snapshot, f.environment));
});

test('old controls without actual classpath metadata stay unverified', async t => {
  const f = await setup(t), snapshot = await f.freeze();
  const result = verifyControlRuntime(snapshot, { executable: snapshot.java.path, argumentsSha256: 'a'.repeat(64), process: { executable: snapshot.java.path } });
  assert.equal(result.verified, false); assert.equal(result.status, 'unverified'); assert.match(result.reason, /does not record/);
});

test('a changed PowerShell is rejected before the PATH resolver can execute it', async t => {
  const f = await setup(t), snapshot = await f.freeze();
  // With JAVA_HOME removed, an old check would attempt to launch this changed
  // file and fail as a process, rather than refusing its new bytes first.
  await fs.appendFile(f.powershell, ' changed resolver bytes');
  envValue(f.environment, 'JAVA_HOME', undefined); envValue(f.environment, 'Path', path.join(f.jdk, 'bin'));
  await assert.rejects(checkRuntime(snapshot, f.environment), /powershell changed before Java path resolution/);
});

test('executed runtime cannot substitute Java, PowerShell, classpath, config or another CLI directory', async t => {
  const f = await setup(t), snapshot = await f.freeze();
  for (const mode of ['java-path', 'java-hash', 'actual-process', 'launcher-path', 'powershell', 'cli', 'classpath-arg', 'missing-jar',
    'duplicate-jar', 'jar-hash', 'foreign-jar', 'config-present', 'config-hash', 'schema']) await t.test(mode, () => {
    const value = control(snapshot);
    if (mode === 'java-path') value.runtime.java.path = path.join(f.root, 'different-java.exe');
    if (mode === 'java-hash') value.runtime.java.sha256 = '0'.repeat(64);
    if (mode === 'actual-process') value.process.executable = path.join(f.root, 'different-java.exe');
    if (mode === 'launcher-path') value.executable = path.join(f.root, 'different-java.exe');
    if (mode === 'powershell') value.runtime.powershell.sha256 = '0'.repeat(64);
    if (mode === 'cli') value.runtime.cliHome = f.root;
    if (mode === 'classpath-arg') value.runtime.classpathArgument = path.join(f.root, '*');
    if (mode === 'missing-jar') value.runtime.classpath.pop();
    if (mode === 'duplicate-jar') value.runtime.classpath[1] = { ...value.runtime.classpath[0] };
    if (mode === 'jar-hash') value.runtime.classpath[0].sha256 = '0'.repeat(64);
    if (mode === 'foreign-jar') value.runtime.classpath[0].path = path.join(f.root, 'foreign.jar');
    if (mode === 'config-present') value.runtime.configuration.present = true;
    if (mode === 'config-hash') value.runtime.configuration.sha256 = '0'.repeat(64);
    if (mode === 'schema') value.runtime.schemaVersion = 2;
    assert.throws(() => verifyControlRuntime(snapshot, value));
  });
});

test('typed snapshot hashes and unique direct JAR paths are checked before comparison', async t => {
  const f = await setup(t), snapshot = await f.freeze();
  for (const mutate of [value => { value.java.sha256 = [value.java.sha256]; }, value => { value.classpath[1] = value.classpath[0]; },
    value => { value.configuration.bytes = 0; }, value => { value.classpath[0].path = path.join(f.root, 'outside.jar'); }]) {
    const altered = structuredClone(snapshot); mutate(altered); assert.throws(() => verifyControlRuntime(altered, control(snapshot)));
  }
});

test('native PowerShell PATH fallback follows Application and PATHEXT order without executing fake Java', async t => {
  const f = await setup(t);
  const powershell = execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const binaries = path.join(f.root, 'path-bin'); await write(path.join(binaries, 'Java.cmd'), 'exit /b 99');
  await write(path.join(binaries, 'java.exe'), 'not executable');
  const environment = { ...process.env }; envValue(environment, 'JAVA_HOME', undefined); envValue(environment, 'Path', binaries); envValue(environment, 'PATHEXT', '.CMD;.EXE');
  const selected = await freezeRuntime(f.project, { powershellPath: powershell }, environment);
  assert.equal(path.basename(selected.java.path).toLowerCase(), 'java.cmd');
  envValue(environment, 'PATHEXT', '.EXE;.CMD');
  await assert.rejects(checkRuntime(selected, environment), /java changed/);
  const second = await freezeRuntime(f.project, { powershellPath: powershell }, environment);
  assert.equal(path.basename(second.java.path).toLowerCase(), 'java.exe');
});

test('junctions in runtime roots and classpath entries are rejected', async t => {
  const f = await setup(t), alias = path.join(f.root, 'linked-jdk'); await fs.symlink(f.jdk, alias, 'junction');
  envValue(f.environment, 'JAVA_HOME', alias); await assert.rejects(f.freeze(), /link/); await fs.unlink(alias);
  envValue(f.environment, 'JAVA_HOME', f.jdk);
  const linked = path.join(f.library, 'linked.jar'); await fs.symlink(f.jdk, linked, 'junction');
  await assert.rejects(f.freeze(), /link/); await fs.unlink(linked);
});
