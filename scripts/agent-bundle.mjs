import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hashFile, noLinks, requireValue } from './validation/io.mjs';
import { readMetadata } from './ci/snapshot-build.mjs';

export const execute = promisify(execFile);
export const sha256 = /^[0-9a-f]{64}$/;
export const commitPattern = /^[0-9a-f]{40}$/;
export const zipHelper = fileURLToPath(new URL('./agent-bundle-zip.ps1', import.meta.url));
export function relativePath(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 1000 &&
    !/[\\:<>"|?*\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && value.split('/').every(part =>
      part && !['.', '..'].includes(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe package member path.');
  return value;
}
export function safeSource(value) {
  relativePath(value);
  requireValue(!/(?:^|\/)(?:\.git|\.local|\.upstream|node_modules|artifacts|\.env(?:\..+)?|device\.local\.json|config\.local\.[^/]+)(?:\/|$)/i.test(value) &&
    !/\.(?:hap|p12|pfx|jks|keystore|pem|key|cer|p7b|mp4|h264)$/i.test(value), 'Source commit contains local or device material: ' + value);
}
export function safeCli(value) {
  relativePath(value);
  requireValue(/^bin\/[^/]+$/.test(value) || /^lib\/[^/]+\.jar$/.test(value), 'Unexpected CLI distribution member: ' + value);
  requireValue(!/(?:^|\/)(?:hdc(?:\.exe)?|sdk)(?:\/|$)/i.test(value), 'HDC and SDK must be installed separately.');
}
export function validateRecords(records, validatePath = relativePath) {
  requireValue(Array.isArray(records) && records.length > 0 && records.length <= 50000, 'Expected a nonempty bounded file list.');
  const names = new Set(); let total = 0;
  for (const item of records) {
    requireValue(item && Object.keys(item).sort().join(',') === 'bytes,path,sha256', 'Unexpected file record fields.');
    validatePath(item.path);
    requireValue(!names.has(item.path.toLowerCase()), 'Duplicate file record.'); names.add(item.path.toLowerCase());
    requireValue(Number.isSafeInteger(item.bytes) && item.bytes >= 0 && sha256.test(item.sha256), 'Invalid file size or SHA-256.');
    total += item.bytes; requireValue(total <= 2 * 1024 * 1024 * 1024, 'Bundle file inventory exceeds 2 GiB.');
  }
  return records;
}
export async function filesUnder(root) {
  await noLinks(root);
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      requireValue(!entry.isSymbolicLink(), 'Package contains a link.');
      if (entry.isDirectory()) await visit(file);
      else {
        requireValue(entry.isFile(), 'Package contains a special file.');
        const relative = path.relative(root, file).split(path.sep).join('/'); relativePath(relative);
        result.push({ path: relative, bytes: (await fs.stat(file)).size, sha256: await hashFile(file) });
      }
    }
  }
  await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export function sameFiles(actual, expected, label) {
  validateRecords(actual); validateRecords(expected);
  const records = new Map(expected.map(item => [item.path, item]));
  requireValue(actual.length === expected.length && actual.every(item => {
    const other = records.get(item.path);
    return other && other.sha256 === item.sha256 && other.bytes === item.bytes;
  }), label + ' file set or fingerprint differs.');
}
export async function newDirectory(directory) {
  await noLinks(directory);
  await fs.mkdir(directory); // Deliberately fails for an existing destination.
}
export async function zip(mode, archive, directory, pwsh = 'pwsh') {
  await execute(pwsh, ['-NoProfile', '-NonInteractive', '-File', zipHelper, '-Mode', mode, '-Archive', path.resolve(archive), '-Directory', path.resolve(directory)],
    { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 });
}
export async function gitBlob(file) {
  const bytes = await fs.readFile(file);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
export async function verifyDirectory(directory) {
  const read = await readMetadata(path.join(directory, 'manifest.json')), value = read.value;
  const keys = ['protocol','schemaVersion','sourceCommit','upstreamCommit','patchSha256','sourceArchiveSha256','build','files'];
  requireValue(value && Object.keys(value).sort().join(',') === keys.sort().join(',') && value.protocol === 'maestro.harmonyos.agent-bundle' && value.schemaVersion === 1,
    'Unsupported bundle manifest.');
  requireValue(commitPattern.test(value.sourceCommit) && commitPattern.test(value.upstreamCommit) && sha256.test(value.patchSha256) && sha256.test(value.sourceArchiveSha256), 'Invalid bundle source identity.');
  const build = value.build;
  requireValue(build && Object.keys(build).sort().join(',') === ['manifestSha256','trust','status','cliBuildStatus','cliVersionStatus','sourceToBinaryCorrespondence','signedProvenance'].sort().join(',') &&
    sha256.test(build.manifestSha256) && ['caller-supplied-sha256','explicit-local-record'].includes(build.trust) && build.status === 'passed' &&
    build.cliBuildStatus === 'passed' && build.cliVersionStatus === 'passed' && build.sourceToBinaryCorrespondence === 'reported-by-build-record' && build.signedProvenance === false,
    'Incomplete bundle build provenance.');
  validateRecords(value.files, member => {
    relativePath(member);
    if (member.startsWith('source/')) safeSource(member.slice(7));
    else if (member.startsWith('cli/')) safeCli(member.slice(4));
    else requireValue(/^licenses\/upstream\/(?:LICENSE|NOTICE)$/.test(member), 'Unexpected bundle member.');
  });
  const actual = (await filesUnder(directory)).filter(item => item.path !== 'manifest.json');
  sameFiles(actual, value.files, 'Bundle');
  const names = new Set(actual.map(item => item.path));
  for (const required of ['source/upstream.lock.json','source/patches/maestro/0001-harmonyos-host.patch','source/LICENSE','source/examples/agent-client/run.mjs','licenses/upstream/LICENSE']) {
    requireValue(names.has(required), 'Missing required bundle member: ' + required);
  }
  requireValue(actual.some(item => /^cli\/bin\//.test(item.path)) && actual.some(item => /^cli\/lib\//.test(item.path)), 'CLI distribution is incomplete.');
  const lock = await readMetadata(path.join(directory, 'source/upstream.lock.json'));
  requireValue(lock.value.commit === value.upstreamCommit && await hashFile(path.join(directory, 'source/patches/maestro/0001-harmonyos-host.patch')) === value.patchSha256,
    'Source lock or patch differs from bundle identity.');
  return { manifest: value, manifestSha256: read.sha256, files: actual.length };
}
