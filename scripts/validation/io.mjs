import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
export const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const digestPattern = /^[0-9a-f]{64}$/;
export function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { requireValue(!(await fs.lstat(current)).isSymbolicLink(), `Path follows a link: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
export async function readBytes(file, limit = 32 * 1024 * 1024) {
  await noLinks(file);
  const stat = await fs.stat(file);
  requireValue(stat.isFile() && stat.size <= limit, 'Expected a bounded regular metadata file.');
  const bytes = await fs.readFile(file);
  requireValue(bytes.length <= limit, 'Metadata grew beyond its limit.');
  return bytes;
}
export async function readJson(file) {
  const bytes = await readBytes(file);
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sha256: hash(bytes), path: path.resolve(file) };
}
export async function hashFile(file) {
  await noLinks(file);
  requireValue((await fs.stat(file)).isFile(), 'Expected a regular fingerprint file.');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
export function inside(root, target) {
  const relative = path.relative(key(root), key(target));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export async function artifact(base, relative) {
  requireValue(typeof relative === 'string' && relative && !/[\\:\x00-\x1f\x7f]/.test(relative) &&
    !relative.startsWith('/') && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'Invalid artifact reference.');
  const file = path.resolve(base, ...relative.split('/'));
  await noLinks(file);
  requireValue(inside(realpathSync(base), realpathSync(file)) && (await fs.stat(file)).isFile(), 'Artifact escapes its declared directory.');
  return file;
}
export async function atomicJson(file, value, createOnly = false) {
  await noLinks(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (createOnly) {
    // A fresh plan is never read or dispatched until this handle is flushed and closed.
    // A crash leaves an unusable snapshot that cannot be reused by another invocation.
    const handle = await fs.open(file, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    return;
  }
  const temporary = file + '.' + randomUUID() + '.pending';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
}
export async function sourceFiles(root) {
  const files = [];
  async function visit(directory) {
    await noLinks(directory);
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      requireValue(!item.isSymbolicLink(), 'Source directories must not contain links.');
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else if (/\.(?:ya?ml|js)$/i.test(item.name)) files.push({ path: path.resolve(file), sha256: await hashFile(file) });
    }
  }
  await visit(root);
  return files.sort((a, b) => key(a.path).localeCompare(key(b.path)));
}
