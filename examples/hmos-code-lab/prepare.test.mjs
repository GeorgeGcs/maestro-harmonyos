import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSample } from './prepare.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function git(directory, ...args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd: directory, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Fixture Git failed: ${args[0]}`);
  return result.stdout.trim();
}

function fixture(t, { unsafeSigning = false, signingFile = false } = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = mkdtempSync(path.join(temporaryRoot, 'maestro-hmos-setup-'));
  t.after(() => {
    // Only remove this test's freshly allocated child directory.
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.match(path.basename(directory), /^maestro-hmos-setup-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source');
  const sample = path.join(directory, 'example');
  mkdirSync(source);
  mkdirSync(sample);
  mkdirSync(path.join(sample, 'patches'));
  git(source, 'init', '--quiet', '--template=');
  git(source, 'config', 'user.name', 'Setup fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'config', 'commit.gpgsign', 'false');
  const license = 'Apache License, Version 2.0\nFixture only.\n';
  writeFileSync(path.join(source, 'LICENSE'), license);
  writeFileSync(path.join(source, 'build-profile.json5'), JSON.stringify({ app: { signingConfigs: unsafeSigning ? [{ material: 'fixture' }] : [] } }));
  writeFileSync(path.join(source, 'EntryAbility.ets'), 'foreground = false;\n');
  if (signingFile) writeFileSync(path.join(source, 'local-signing.p12'), 'fixture, not a key');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Fixture source');
  const commit = git(source, 'rev-parse', 'HEAD');
  writeFileSync(path.join(source, 'EntryAbility.ets'), 'foreground = true;\n');
  const patch = `${git(source, 'diff', '--no-ext-diff', '--', 'EntryAbility.ets')}\n`;
  writeFileSync(path.join(sample, 'patches', 'keep-awake.patch'), patch);
  writeFileSync(path.join(source, 'EntryAbility.ets'), 'foreground = false;\n');
  const spec = {
    schemaVersion: 1,
    repository: 'https://gitcode.com/HarmonyOS_Samples/sample_in_harmonyos.git',
    commit,
    license: 'Apache-2.0', licenseFile: 'LICENSE', licenseSha256: hash(license),
    patch: { file: 'patches/keep-awake.patch', sha256: hash(patch), target: 'EntryAbility.ets' },
  };
  writeFileSync(path.join(sample, 'source.json'), JSON.stringify(spec));
  return { source, sample, spec, app: path.join(sample, 'app') };
}

test('prepares the pinned Git objects, excludes dirty signing settings, and allows later IDE signing during read-only check', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.source, 'later-revision.txt'), 'Do not include this newer commit.');
  git(f.source, 'add', '.');
  git(f.source, 'commit', '--quiet', '-m', 'Newer source revision');
  assert.notEqual(git(f.source, 'rev-parse', 'HEAD'), f.spec.commit);
  writeFileSync(path.join(f.source, 'build-profile.json5'), JSON.stringify({ app: { signingConfigs: [{ developerLocal: true }] } }));
  writeFileSync(path.join(f.source, 'developer-local.p12'), 'fixture, not a key');
  const result = prepareSample({ sampleDirectory: f.sample, localSource: f.source });
  assert.equal(result.commit, f.spec.commit);
  assert.equal(readFileSync(path.join(f.app, 'EntryAbility.ets'), 'utf8'), 'foreground = true;\n');
  assert.equal(existsSync(path.join(f.app, 'developer-local.p12')), false);
  assert.equal(existsSync(path.join(f.app, 'later-revision.txt')), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.app, 'build-profile.json5'), 'utf8')).app.signingConfigs, []);
  writeFileSync(path.join(f.app, 'build-profile.json5'), JSON.stringify({ app: { signingConfigs: [{ developerLocal: true }] } }));
  const recordBefore = readFileSync(path.join(f.app, '.maestro-source.json'));
  const gitIndexBefore = readFileSync(path.join(f.app, '.git', 'index'));
  const check = prepareSample({ sampleDirectory: f.sample, checkOnly: true });
  assert.equal(check.checkedOnly, true);
  assert.deepEqual(readFileSync(path.join(f.app, '.maestro-source.json')), recordBefore);
  assert.deepEqual(readFileSync(path.join(f.app, '.git', 'index')), gitIndexBefore);
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, localSource: f.source }), /already exists/);
  assert.deepEqual(readFileSync(path.join(f.app, '.maestro-source.json')), recordBefore);
});

test('refuses an existing directory even when it is empty', (t) => {
  const f = fixture(t);
  mkdirSync(f.app);
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, localSource: f.source }), /already exists/);
  assert.equal(existsSync(path.join(f.app, '.git')), false);
});

test('refuses a local source without the pinned revision before creating app', (t) => {
  const f = fixture(t);
  f.spec.commit = 'a'.repeat(40);
  writeFileSync(path.join(f.sample, 'source.json'), JSON.stringify(f.spec));
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, localSource: f.source }), /Git rev-parse failed|pinned commit/);
  assert.equal(existsSync(f.app), false);
});

for (const variant of [{ unsafeSigning: true }, { signingFile: true }]) {
  test(`refuses committed signing data before checkout: ${Object.keys(variant)[0]}`, (t) => {
    const f = fixture(t, variant);
    assert.throws(() => prepareSample({ sampleDirectory: f.sample, localSource: f.source }), /signing/);
    assert.equal(existsSync(path.join(f.app, 'EntryAbility.ets')), false);
    assert.equal(existsSync(path.join(f.app, '.maestro-source.json')), false);
  });
}

test('detects changes to the controlled patch and to its prepared target', (t) => {
  const f = fixture(t);
  prepareSample({ sampleDirectory: f.sample, localSource: f.source });
  writeFileSync(path.join(f.app, 'EntryAbility.ets'), 'foreground = false;\n');
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, checkOnly: true }), /EntryAbility changed/);
  writeFileSync(path.join(f.sample, 'patches', 'keep-awake.patch'), 'changed');
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, checkOnly: true }), /SHA-256/);
});

test('check-only refuses missing app without creating it or fetching', (t) => {
  const f = fixture(t);
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, checkOnly: true }), /does not exist/);
  assert.equal(existsSync(f.app), false);
});

test('refuses a patch that changes files outside the declared EntryAbility', (t) => {
  const f = fixture(t);
  const patchPath = path.join(f.sample, 'patches', 'keep-awake.patch');
  const patch = readFileSync(patchPath, 'utf8') +
    'diff --git a/extra.txt b/extra.txt\nnew file mode 100644\n--- /dev/null\n+++ b/extra.txt\n@@ -0,0 +1 @@\n+Unexpected file\n';
  writeFileSync(patchPath, patch);
  f.spec.patch.sha256 = hash(patch);
  writeFileSync(path.join(f.sample, 'source.json'), JSON.stringify(f.spec));
  assert.throws(() => prepareSample({ sampleDirectory: f.sample, localSource: f.source }), /only change the declared EntryAbility/);
  assert.equal(existsSync(path.join(f.app, 'extra.txt')), false);
  assert.equal(readFileSync(path.join(f.app, 'EntryAbility.ets'), 'utf8'), 'foreground = false;\n');
});
