import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashFile, inside, noLinks, requireValue, samePath } from './validation/io.mjs';
import { readMetadata } from './ci/snapshot-build.mjs';
import { commitPattern, execute, filesUnder, gitBlob, newDirectory, safeCli, safeSource, sameFiles, sha256, validateRecords, verifyDirectory, zip } from './agent-bundle.mjs';

export async function packageBundle(options) {
  const { repository, commit, cliDirectory, upstreamDirectory, buildManifest, buildSha256, output, workDirectory, git = 'git', pwsh = 'pwsh' } = options;
  requireValue([repository, cliDirectory, upstreamDirectory, buildManifest, output, workDirectory].every(value => typeof value === 'string' && value.trim()) && commitPattern.test(commit),
    'Provide repository, full 40-character commit, CLI, upstream, build manifest, new ZIP output and new work directory.');
  if (buildSha256 !== undefined) requireValue(sha256.test(buildSha256), 'Invalid trusted build SHA-256.');
  requireValue(!inside(workDirectory, output) && !samePath(workDirectory, output) && !inside(cliDirectory, output) && !samePath(cliDirectory, output) &&
    !inside(cliDirectory, workDirectory) && !inside(workDirectory, cliDirectory) && !samePath(cliDirectory, workDirectory), 'Output and work paths must be separate from staging and CLI input.');
  const gitRun = (root, args, extra = {}) => execute(git, ['-C', path.resolve(root), ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...extra });
  requireValue(samePath((await gitRun(repository, ['rev-parse', '--show-toplevel'])).stdout.trim(), repository), 'Repository is not a Git root.');
  requireValue((await gitRun(repository, ['rev-parse', '--verify', `${commit}^{commit}`])).stdout.trim() === commit, 'Source commit was not found.');
  const build = await readMetadata(buildManifest), record = build.value;
  requireValue(!buildSha256 || build.sha256 === buildSha256, 'Build manifest differs from its trusted SHA-256.');
  requireValue(!record.protocol && record.schemaVersion === 1 && record.status === 'passed' && record.cliBuildStatus === 'passed' && record.cliVersionStatus === 'passed' &&
    record.projectCommit === commit && typeof record.cliDirectory === 'string', 'A successful retained build record for the requested commit is required.');
  validateRecords(record.cliFiles, safeCli);
  const cli = await filesUnder(cliDirectory); cli.forEach(item => safeCli(item.path));
  sameFiles(cli, record.cliFiles, 'CLI build');
  // A saved observation of arbitrary installed JARs is deliberately insufficient.
  requireValue(Array.isArray(record.stages) && record.stages.some(stage => stage.status === 'passed' && stage.exitCode === 0 &&
    Array.isArray(stage.arguments) && stage.arguments.some(argument => argument === ':maestro-cli:installDist')), 'Build record has no successful installDist stage.');
  const tree = (await gitRun(repository, ['ls-tree', '-r', '-z', commit])).stdout.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
    requireValue(match, 'Source tree contains a submodule, link or unsupported object.');
    safeSource(match[3]); return { path: match[3], blob: match[2] };
  });
  requireValue(tree.length > 0, 'Source tree is empty.');
  await noLinks(output);
  try { await fs.lstat(output); throw new Error('Output archive already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await newDirectory(workDirectory);
  const sourceArchive = path.resolve(workDirectory, 'source.zip'), staging = path.resolve(workDirectory, 'package');
  await newDirectory(staging);
  await gitRun(repository, ['archive', '--format=zip', '--output', sourceArchive, commit]);
  const archiveHash = await hashFile(sourceArchive);
  requireValue(record.projectArchive?.sha256 === archiveHash && record.projectArchive?.bytes === (await fs.stat(sourceArchive)).size, 'Committed source archive differs from the original build input.');
  await zip('Extract', sourceArchive, path.join(staging, 'source'), pwsh);
  const extracted = await filesUnder(path.join(staging, 'source'));
  requireValue(extracted.length === tree.length, 'git archive omitted tracked files (for example export-ignore).');
  const names = new Set(extracted.map(item => item.path));
  for (const item of tree) requireValue(names.has(item.path) && await gitBlob(path.join(staging, 'source', item.path)) === item.blob, 'Archived source differs from the committed tree.');
  const lock = await readMetadata(path.join(staging, 'source/upstream.lock.json'));
  const patchHash = await hashFile(path.join(staging, 'source/patches/maestro/0001-harmonyos-host.patch'));
  requireValue(lock.value.commit === record.upstreamCommit && commitPattern.test(record.upstreamCommit) && patchHash === record.patchSha256, 'Build upstream or patch differs from the requested commit.');
  requireValue(samePath((await gitRun(upstreamDirectory, ['rev-parse', '--show-toplevel'])).stdout.trim(), upstreamDirectory), 'Upstream is not a Git root.');
  const upstreamNames = (await gitRun(upstreamDirectory, ['ls-tree', '--name-only', record.upstreamCommit])).stdout.trim().split(/\r?\n/);
  requireValue(upstreamNames.includes('LICENSE'), 'Pinned upstream has no root LICENSE.');
  const licenses = path.join(staging, 'licenses/upstream'); await fs.mkdir(licenses, { recursive: true });
  for (const name of ['LICENSE', 'NOTICE'].filter(name => upstreamNames.includes(name))) {
    const bytes = (await gitRun(upstreamDirectory, ['show', `${record.upstreamCommit}:${name}`], { encoding: 'buffer' })).stdout;
    await fs.writeFile(path.join(licenses, name), bytes, { flag: 'wx' });
  }
  await fs.mkdir(path.join(staging, 'cli'));
  for (const item of cli) {
    const destination = path.join(staging, 'cli', item.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(cliDirectory, item.path), destination, fs.constants.COPYFILE_EXCL);
  }
  sameFiles(await filesUnder(path.join(staging, 'cli')), record.cliFiles, 'Copied CLI');
  requireValue((await readMetadata(buildManifest)).sha256 === build.sha256, 'Build record changed during packaging.');
  const manifest = { protocol: 'maestro.harmonyos.agent-bundle', schemaVersion: 1, sourceCommit: commit, upstreamCommit: record.upstreamCommit,
    patchSha256: patchHash, sourceArchiveSha256: archiveHash,
    build: { manifestSha256: build.sha256, trust: buildSha256 ? 'caller-supplied-sha256' : 'explicit-local-record', status: 'passed', cliBuildStatus: 'passed', cliVersionStatus: 'passed',
      sourceToBinaryCorrespondence: 'reported-by-build-record', signedProvenance: false }, files: await filesUnder(staging) };
  await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const verification = await verifyDirectory(staging);
  await zip('Pack', output, staging, pwsh);
  return { protocol: 'maestro.harmonyos.agent-bundle-package', schemaVersion: 1, status: 'passed', sourceCommit: commit,
    files: verification.files, archiveSha256: await hashFile(output), manifestSha256: verification.manifestSha256, deviceCommands: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['repository','commit','cli-directory','upstream-directory','build-manifest','build-sha256','output','work-directory','git','pwsh'].map(name => [name, { type: 'string' }])) });
    console.log(JSON.stringify(await packageBundle({ repository: values.repository, commit: values.commit, cliDirectory: values['cli-directory'], upstreamDirectory: values['upstream-directory'],
      buildManifest: values['build-manifest'], buildSha256: values['build-sha256'], output: values.output, workDirectory: values['work-directory'], git: values.git, pwsh: values.pwsh })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
