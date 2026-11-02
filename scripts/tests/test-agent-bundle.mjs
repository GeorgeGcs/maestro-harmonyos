import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageBundle } from '../package-agent-bundle.mjs';
import { verifyBundle, selfTestPlan } from '../verify-agent-bundle.mjs';
import { execute, filesUnder, relativePath, zip } from '../agent-bundle.mjs';
import { hashFile } from '../validation/io.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const git = process.env.AGENT_BUNDLE_GIT ?? 'git', pwsh = process.env.AGENT_BUNDLE_PWSH ?? 'pwsh';
const runGit = (directory, args) => execute(git, ['-C', directory, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
async function write(root, relative, content) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
async function commit(directory) {
  await runGit(directory, ['add', '--all']);
  await runGit(directory, ['-c','user.name=Bundle Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture']);
  return (await runGit(directory, ['rev-parse','HEAD'])).stdout.trim();
}
async function maliciousZip(file, members, symlink = false) {
  const script = "$zip = [IO.Compression.ZipFile]::Open($env:BUNDLE_TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create); try { foreach ($name in ($env:BUNDLE_TEST_MEMBERS | ConvertFrom-Json)) { $entry = $zip.CreateEntry($name); if ($env:BUNDLE_TEST_SYMLINK -eq 'true') { $entry.ExternalAttributes = -1581514752 }; $stream = $entry.Open(); try { $stream.WriteByte(65) } finally { $stream.Dispose() } } } finally { $zip.Dispose() }";
  await execute(pwsh, ['-NoProfile','-NonInteractive','-Command', script], { windowsHide: true, env: { ...process.env, BUNDLE_TEST_ZIP: file, BUNDLE_TEST_MEMBERS: JSON.stringify(members), BUNDLE_TEST_SYMLINK: String(symlink) } });
}

test('portable bundle binds committed source, full CLI distribution and safe ZIP extraction', async t => {
  // Missing declared tools fail this suite. No optional skip and no real Java/HDC launch.
  await execute(git, ['--version'], { windowsHide: true });
  await execute(pwsh, ['-NoProfile','-Command','if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }'], { windowsHide: true });
  await fs.mkdir(path.join(repository, 'artifacts'), { recursive: true });
  const root = await fs.mkdtemp(path.join(repository, 'artifacts/agent-bundle-test-'));
  const source = path.join(root, 'repo'), upstream = path.join(root, 'upstream'), cli = path.join(root, 'cli');
  await fs.mkdir(source); await fs.mkdir(upstream); await fs.mkdir(cli);
  await runGit(upstream, ['init']); await write(upstream, 'LICENSE', 'Upstream fixture license\n'); await write(upstream, 'NOTICE', 'Upstream fixture notice\n');
  const upstreamCommit = await commit(upstream);
  await runGit(source, ['init']);
  await write(source, '.gitattributes', '* text=auto eol=lf\n');
  await write(source, 'LICENSE', 'Project fixture license\n');
  await write(source, 'upstream.lock.json', JSON.stringify({ commit: upstreamCommit }));
  await write(source, 'patches/maestro/0001-harmonyos-host.patch', 'fixture patch\n');
  await write(source, 'examples/agent-client/run.mjs', '// fixture, never executed\n');
  await write(source, 'examples/flows/smoke.yaml', 'appId: ${APP_ID}\n---\n- assertVisible: ${START_TEXT}\n');
  const sourceCommit = await commit(source);
  await write(source, '.local/private-device.json', 'DO NOT EXPORT\n');
  await write(source, 'config.local.ps1', 'DO NOT EXPORT\n');
  await write(source, 'LICENSE', 'dirty working tree must not leak\n');
  await write(cli, 'bin/maestro', '# fixture\n'); await write(cli, 'bin/maestro.bat', '@rem fixture\n');
  await write(cli, 'lib/maestro-cli-0.0.0.jar', 'fixture jar\n'); await write(cli, 'lib/dependency.jar', 'fixture dependency\n');
  await write(cli, 'lib/js-community-24.2.0.pom', '<project>fixture metadata</project>\n');
  const archive = path.join(root, 'input.zip');
  await runGit(source, ['archive','--format=zip','--output',archive,sourceCommit]);
  const originalPatch = path.join(source, 'patches/maestro/0001-harmonyos-host.patch');
  const record = { schemaVersion: 1, status: 'passed', cliBuildStatus: 'passed', cliVersionStatus: 'passed', projectCommit: sourceCommit, upstreamCommit,
    patchSha256: await hashFile(originalPatch), projectArchive: { bytes: (await fs.stat(archive)).size, sha256: await hashFile(archive) },
    cliDirectory: cli, cliFiles: await filesUnder(cli), stages: [{ status: 'passed', exitCode: 0, arguments: [':maestro-cli:installDist'] }] };
  const build = path.join(root, 'build.json'); await fs.writeFile(build, JSON.stringify(record));
  let sequence = 0;
  const options = () => { const id = ++sequence; return { repository: source, commit: sourceCommit, cliDirectory: cli, upstreamDirectory: upstream,
    buildManifest: build, output: path.join(root, `out-${id}.zip`), workDirectory: path.join(root, `work-${id}`), git, pwsh }; };
  const successful = options(); let result;
  await t.test('complete committed-source bundle; ignores untracked and dirty working files', async () => {
    result = await packageBundle({ ...successful, buildSha256: await hashFile(build) });
    assert.equal(result.status, 'passed'); assert.equal(result.deviceCommands, 0);
    const destination = path.join(root, 'verified');
    const verification = await verifyBundle({ archive: successful.output, extractTo: destination, expectedSha256: result.archiveSha256, pwsh });
    assert.equal(verification.selfTest, 'not-requested');
    assert.equal(await fs.readFile(path.join(destination, 'source/LICENSE'), 'utf8'), 'Project fixture license\n');
    assert.equal(await fs.readFile(path.join(destination, 'licenses/upstream/NOTICE'), 'utf8'), 'Upstream fixture notice\n');
    assert.equal(await fs.readFile(path.join(destination, 'cli/lib/js-community-24.2.0.pom'), 'utf8'), '<project>fixture metadata</project>\n');
    const manifest = await fs.readFile(path.join(destination, 'manifest.json'), 'utf8');
    assert.ok(!manifest.includes(root) && !manifest.includes('DO NOT EXPORT'));
    const value = JSON.parse(manifest);
    assert.ok(value.files.every(item => !item.path.includes('.local') && !item.path.includes('config.local')));
  });
  await t.test('expected archive digest checked before extraction', async () => {
    const destination = path.join(root, 'wrong-sha');
    await assert.rejects(verifyBundle({ archive: successful.output, extractTo: destination, expectedSha256: '0'.repeat(64), pwsh }), /expected SHA/);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  });
  await t.test('reject missing/extra/modified CLI files against build inventory', async () => {
    await write(cli, 'lib/extra.jar', 'unexpected'); await assert.rejects(packageBundle(options()), /file set/); await fs.unlink(path.join(cli,'lib/extra.jar'));
    await fs.rename(path.join(cli,'lib/dependency.jar'),path.join(root,'dependency.saved')); await assert.rejects(packageBundle(options()), /file set/);
    await fs.rename(path.join(root,'dependency.saved'),path.join(cli,'lib/dependency.jar'));
    await write(cli,'lib/dependency.jar','changed'); await assert.rejects(packageBundle(options()), /file set/); await write(cli,'lib/dependency.jar','fixture dependency\n');
  });
  await t.test('reject mismatched and incomplete build records', async () => {
    for (const changed of [{ projectCommit: '0'.repeat(40) }, { cliBuildStatus: 'failed' }, { cliFiles: undefined }, { stages: [] },
      { patchSha256: '0'.repeat(64) }, { projectArchive: { bytes: record.projectArchive.bytes, sha256: '0'.repeat(64) } }]) {
      await fs.writeFile(build, JSON.stringify({ ...record, ...changed })); await assert.rejects(packageBundle(options()));
    }
    await fs.writeFile(build, JSON.stringify(record));
    await assert.rejects(packageBundle({ ...options(), buildSha256: '0'.repeat(64) }), /trusted SHA/);
  });
  await t.test('reject mutated, missing, extra members and duplicate metadata keys', async () => {
    const destination = path.join(root,'verified');
    await write(destination,'cli/lib/dependency.jar','bad bytes'); await assert.rejects(verifyBundle({ directory: destination }), /fingerprint/);
    await write(destination,'cli/lib/dependency.jar','fixture dependency\n');
    await write(destination,'extra.txt','extra'); await assert.rejects(verifyBundle({ directory: destination }), /file set/); await fs.unlink(path.join(destination,'extra.txt'));
    const file = path.join(destination,'manifest.json'), saved = await fs.readFile(file,'utf8');
    await fs.writeFile(file, saved.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'));
    await assert.rejects(verifyBundle({ directory: destination }), /Duplicate metadata/); await fs.writeFile(file,saved);
  });
  await t.test('reject traversal, absolute, ADS, case duplicate and file-parent ZIP entries before writes', async () => {
    for (const members of [['../escape'],['/absolute'],['C:/absolute'],['source/name:stream'],['source/a','source/A'],['source/a','source/a/b'],['source\\bad'],['source/NUL.txt'],['source/invalid?.txt']]) {
      const id = ++sequence, file = path.join(root,`evil-${id}.zip`), destination = path.join(root,`evil-${id}`);
      await maliciousZip(file,members); await assert.rejects(zip('Extract',file,destination,pwsh));
      await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    }
    const file = path.join(root,'symlink.zip'), destination = path.join(root,'symlink');
    await maliciousZip(file,['source/link'],true); await assert.rejects(zip('Extract',file,destination,pwsh));
    await assert.rejects(fs.stat(destination), { code:'ENOENT' });
  });
  await t.test('reject existing extraction destinations and inappropriate self-test switches', async () => {
    await assert.rejects(verifyBundle({ archive: successful.output, extractTo: path.join(root,'verified'), pwsh }));
    await assert.rejects(verifyBundle({ directory: path.join(root,'verified'), java: 'java' }), /require --self-test/);
    await assert.rejects(verifyBundle({ directory: path.join(root,'verified'), selfTest: true }), /requires a new/);
    const overlapping = options(); overlapping.output = path.join(overlapping.workDirectory, 'package/self.zip');
    await assert.rejects(packageBundle(overlapping), /separate from staging/);
  });
  await t.test('self-test plan sends only describe and check-only with placeholder parameters', () => {
    const plan = selfTestPlan(path.join(root,'verified'),'java',path.join(root,'self-test'));
    assert.deepEqual(plan.map(item => item.name), ['version','describe','check-only']);
    assert.deepEqual(JSON.parse(plan[1].stdin),{ id:1, method:'agent.describe', params:{ schemaVersion:2 } });
    assert.ok(plan[2].args.includes('--check-only')); assert.ok(plan[2].args.includes('org.example.bundle'));
    assert.ok(plan.every(item => !item.args.includes('--device') && !item.args.includes('hdc')));
    for (const name of ['../bad','C:/bad','source/a:b','source/NUL','/absolute']) assert.throws(() => relativePath(name));
  });
  // Retain isolated fixtures under ignored artifacts for inspecting any failed assertion.
});
