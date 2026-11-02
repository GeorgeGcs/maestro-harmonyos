import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { noLinks, readBytes, hashFile, inside, samePath } from '../../scripts/validation/io.mjs';

const execute = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export function flowEnvironment(appId, entries = []) {
  const values = Object.create(null);
  for (const entry of entries) {
    const at = entry.indexOf('='), name = entry.slice(0, at);
    requireValue(at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !entry.includes('\0'), 'Use --env NAME=value.');
    requireValue(!['MAESTRO_SHARD_ID', 'MAESTRO_SHARD_INDEX'].includes(name), 'Internal Maestro parameters cannot be overridden.');
    requireValue(!Object.hasOwn(values, name), `Duplicate handoff parameter: ${name}`);
    values[name] = entry.slice(at + 1);
  }
  requireValue(!Object.hasOwn(values, 'APP_ID') || values.APP_ID === appId, 'APP_ID must match --app.');
  values.APP_ID = appId;
  return { values, args: Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]) };
}

/** Parse and copy the exact static dependency set before creating any device session. */
export async function prepareHandoff({ flow, sourceRoot = path.dirname(path.resolve(flow)), java, cliDirectory, environment,
  directory, assets = [], processEnvironment = process.env, timeoutMs = 20000 }) {
  flow = path.resolve(flow); sourceRoot = path.resolve(sourceRoot); directory = path.resolve(directory);
  requireValue(inside(sourceRoot, flow), 'Handoff Flow must be below --flow-root.');
  await noLinks(sourceRoot); await readBytes(flow, 4 * 1024 * 1024);
  const helper = fileURLToPath(new URL('./InspectHandoff.java', import.meta.url));
  const library = path.join(cliDirectory, 'lib');
  const jars = (await fs.readdir(library)).filter(name => name.endsWith('.jar')).sort();
  requireValue(jars.length > 0, 'A complete CLI distribution is required.');
  const tools = await Promise.all([helper, ...jars.map(name => path.join(library, name))].map(async file => ({ path: file, sha256: await hashFile(file) })));
  await fs.mkdir(directory, { recursive: true });
  const requestPath = path.join(directory, 'request.json'), responsePath = path.join(directory, 'response.json');
  const names = [...new Set([...Object.keys(environment.values), ...Object.keys(processEnvironment)
    .filter(name => name.startsWith('MAESTRO_') && processEnvironment[name] && !['MAESTRO_SHARD_ID', 'MAESTRO_SHARD_INDEX'].includes(name))])];
  await fs.writeFile(requestPath, JSON.stringify({ flow, sourceRoot, environmentNames: names }), { flag: 'wx' });
  let failed, stdout = '', stderr = '';
  try { ({ stdout, stderr } = await execute(java, ['-Dfile.encoding=UTF-8', '--class-path', path.join(library, '*'), helper, requestPath, responsePath],
    { env: processEnvironment, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 })); }
  catch (error) { failed = error; stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; }
  await fs.writeFile(path.join(directory, 'parser.stdout.log'), stdout, { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'parser.stderr.log'), stderr, { flag: 'wx' });
  requireValue(!failed, `Handoff check failed before connecting: ${stderr.trim() || failed?.message || ''}`);
  const inspection = JSON.parse((await readBytes(responsePath, 4 * 1024 * 1024)).toString('utf8'));
  requireValue(inspection.protocol === 'maestro.harmonyos.handoff-inspection' && inspection.schemaVersion === 1 &&
    samePath(inspection.flow, flow) && inspection.scriptsExecuted === false && Array.isArray(inspection.dependencies) &&
    inspection.dependencies.length > 0 && inspection.dependencies.length <= 512, 'Invalid handoff inspection.');
  const frozenRoot = path.join(directory, 'sources'), sources = [], seen = new Set(); let total = 0;
  requireValue(assets.length <= 128, 'Handoff asset count exceeds its budget.');
  const dependencies = [...inspection.dependencies];
  for (const asset of assets) {
    requireValue(typeof asset === 'string' && asset.length > 0 && !path.isAbsolute(asset), '--handoff-asset must be relative to --flow-root.');
    const file = path.resolve(sourceRoot, asset);
    requireValue(inside(sourceRoot, file), 'Handoff asset escapes the selected Flow root.');
    const bytes = await readBytes(file, 4 * 1024 * 1024);
    dependencies.push({ path: file, sha256: hash(bytes), kind: 'asset' });
  }
  for (const entry of dependencies) {
    requireValue(typeof entry.path === 'string' && inside(sourceRoot, entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256) &&
      ['yaml', 'script', 'asset'].includes(entry.kind), 'Dependency escapes the selected Flow root.');
    const relative = path.relative(sourceRoot, entry.path), key = relative.toLowerCase();
    requireValue(!seen.has(key), 'Duplicate handoff dependency.'); seen.add(key);
    const bytes = await readBytes(entry.path, 4 * 1024 * 1024); total += bytes.length;
    requireValue(total <= 32 * 1024 * 1024 && hash(bytes) === entry.sha256, 'Handoff source changed or exceeds its budget.');
    const target = path.join(frozenRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' }); sources.push({ path: target, relative, sha256: entry.sha256, kind: entry.kind });
  }
  requireValue(sources.some(item => samePath(item.path, path.join(frozenRoot, path.relative(sourceRoot, flow)))), 'Inspection omitted the selected Flow.');
  const plan = { schemaVersion: 1, originalFlow: flow, flow: path.join(frozenRoot, path.relative(sourceRoot, flow)),
    sources, tools, env: environment.values, envArgs: environment.args, scriptsExecuted: false, variableCheck: inspection.variableCheck };
  await verifyHandoff(plan);
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

export async function verifyHandoff(plan) {
  for (const entry of [...plan.tools, ...plan.sources]) requireValue(await hashFile(entry.path) === entry.sha256,
    'Frozen handoff input or parser changed; no CLI handoff was started.');
}
