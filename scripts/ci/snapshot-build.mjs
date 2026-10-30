import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicJson, hash, hashFile, noLinks, readBytes, requireValue, samePath } from '../validation/io.mjs';

const execute = promisify(execFile);
export const coreRoles = ['maestro-cli', 'maestro-client', 'maestro-orchestra', 'maestro-orchestra-models'];

export async function readMetadata(file) {
  const bytes = await readBytes(file, 4 * 1024 * 1024), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text), containers = [];
  // Scan already validated JSON tokens to reject duplicate decoded object keys.
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === '{' || char === '[') { containers.push(char === '{' ? new Set() : null); requireValue(containers.length <= 64, 'Metadata is too deeply nested.'); }
    else if (char === '}' || char === ']') containers.pop();
    else if (char === '"') {
      const start = cursor++;
      while (text[cursor] !== '"') { if (text[cursor] === '\\') cursor++; cursor++; }
      let next = cursor + 1; while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, cursor + 1)), keys = containers.at(-1);
        requireValue(keys instanceof Set && !keys.has(key), 'Duplicate metadata JSON key.'); keys.add(key);
      }
    }
  }
  return { path: path.resolve(file), sha256: hash(bytes), value };
}

export async function coreFiles(projectRoot) {
  const directory = path.join(projectRoot, '.upstream/maestro/maestro-cli/build/install/maestro/lib');
  await noLinks(directory);
  const names = await fs.readdir(directory), files = [];
  for (const role of coreRoles) {
    const matches = names.filter(name => new RegExp('^' + role + '(?:-[0-9][A-Za-z0-9.+_-]*)?\\.jar$').test(name));
    requireValue(matches.length === 1, 'Expected exactly one installed JAR for ' + role);
    const file = path.join(directory, matches[0]);
    files.push({ role, path: file, sha256: await hashFile(file), bytes: (await fs.stat(file)).size });
  }
  return files;
}

export async function gitIdentity(directory) {
  const git = async args => (await execute('git', ['-C', directory, ...args], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const top = await git(['rev-parse', '--show-toplevel']);
  requireValue(samePath(top, directory), 'Git identifies a parent repository, not this source root. Use the original isolated build manifest for archived sources.');
  const commit = await git(['rev-parse', 'HEAD']), status = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  requireValue(/^[0-9a-f]{40}$/.test(commit), 'Git HEAD is not a complete commit identity.');
  return { root: path.resolve(directory), commit, dirty: status !== '', statusSha256: hash(Buffer.from(status)) };
}

export async function snapshotBuild(projectRoot, outputPath) {
  projectRoot = path.resolve(projectRoot);
  const identity = await gitIdentity(projectRoot), lock = await readMetadata(path.join(projectRoot, 'upstream.lock.json'));
  const upstream = await gitIdentity(path.join(projectRoot, '.upstream/maestro'));
  requireValue(upstream.commit === lock.value.commit, 'Actual upstream HEAD differs from upstream.lock.json.');
  const patch = path.join(projectRoot, 'patches/maestro/0001-harmonyos-host.patch');
  const value = { protocol: 'maestro.harmonyos.build-snapshot', schemaVersion: 1, observedAt: new Date().toISOString(),
    provenance: 'observed-installed-files', sourceDirectory: projectRoot, projectCommit: identity.commit, sourceIdentity: identity,
    upstreamCommit: upstream.commit, upstreamIdentity: upstream, upstreamLockSha256: lock.sha256,
    patchSha256: await hashFile(patch), outputFiles: await coreFiles(projectRoot),
    buildExecuted: false, cleanBuildProven: false, sourceToBinaryCorrespondence: 'unverified', signedProvenance: false };
  const after = await gitIdentity(projectRoot);
  requireValue(after.commit === identity.commit && after.statusSha256 === identity.statusSha256, 'Source identity changed while recording the build snapshot.');
  for (const file of value.outputFiles) requireValue(await hashFile(file.path) === file.sha256, 'Installed JAR changed while recording its snapshot.');
  requireValue(await hashFile(patch) === value.patchSha256 && await hashFile(lock.path) === lock.sha256, 'Build metadata changed during observation.');
  await atomicJson(path.resolve(outputPath), value, true);
  return { path: path.resolve(outputPath), sha256: await hashFile(outputPath), provenance: value.provenance };
}

export async function verifyBuildReference(reference, base, projectRoot) {
  requireValue(typeof reference?.path === 'string' && typeof reference.sha256 === 'string' && /^[0-9a-f]{64}$/.test(reference.sha256), 'buildManifest requires path and SHA-256; create it with snapshot-build.mjs after building.');
  const document = await readMetadata(path.resolve(base, reference.path)), value = document.value;
  requireValue(document.sha256 === reference.sha256 && typeof value.sourceDirectory === 'string' && samePath(value.sourceDirectory, projectRoot), 'Build record hash or actual runner source directory differs.');
  const observation = value.protocol === 'maestro.harmonyos.build-snapshot';
  requireValue(observation ? value.schemaVersion === 1 && value.provenance === 'observed-installed-files' && value.buildExecuted === false &&
    value.sourceToBinaryCorrespondence === 'unverified' : value.status === 'passed' && value.cliBuildStatus === 'passed' && value.cliVersionStatus === 'passed', 'Unsupported or incomplete build record.');
  requireValue(typeof value.projectCommit === 'string' && /^[0-9a-f]{40}$/.test(value.projectCommit), 'Build source commit is missing.');
  const lock = await readMetadata(path.join(projectRoot, 'upstream.lock.json'));
  const patch = path.join(projectRoot, 'patches/maestro/0001-harmonyos-host.patch');
  requireValue(value.upstreamCommit === lock.value.commit && await hashFile(patch) === value.patchSha256, 'Pinned upstream or patch differs from the build record.');
  if (observation) {
    const actual = await gitIdentity(projectRoot), upstream = await gitIdentity(path.join(projectRoot, '.upstream/maestro'));
    requireValue(value.upstreamLockSha256 === lock.sha256 && value.sourceIdentity?.commit === actual.commit &&
      value.sourceIdentity.dirty === actual.dirty && value.sourceIdentity.statusSha256 === actual.statusSha256 &&
      value.upstreamIdentity?.commit === upstream.commit && value.upstreamIdentity.dirty === upstream.dirty &&
      value.upstreamIdentity.statusSha256 === upstream.statusSha256, 'Observed Git identity changed; create a new build snapshot.');
  }
  const installed = await coreFiles(projectRoot);
  requireValue(Array.isArray(value.outputFiles), 'Build record omits its outputs.');
  for (const file of installed) {
    const declared = value.outputFiles.filter(item => typeof item?.path === 'string' && samePath(item.path, file.path));
    requireValue(declared.length === 1 && declared[0].sha256 === file.sha256 && declared[0].bytes === file.bytes, 'Actual runner JAR differs from its build record: ' + file.role);
  }
  return { reference: { path: document.path, sha256: document.sha256 }, files: installed,
    projectCommit: value.projectCommit, upstreamCommit: value.upstreamCommit, patchSha256: value.patchSha256,
    provenance: observation ? 'observed-installed-files' : 'retained-build-record',
    sourceToBinaryCorrespondence: observation ? 'unverified' : 'reported-by-build-record', signedProvenance: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 3 || process.argv.length === 4, 'Usage: node scripts/ci/snapshot-build.mjs NEW_OUTPUT_JSON [PROJECT_ROOT]');
    const root = process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    console.log(JSON.stringify(await snapshotBuild(root, process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
