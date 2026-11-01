import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseMaintenanceJson } from './verify-maintenance.mjs';
import { noLinks, readBytes, requireValue } from '../validation/io.mjs';

// Diagnostics only. Never executes the referenced tools or changes a checkpoint or device gate.
export async function checkMaintenanceTools(checkpointPath) {
  const file = path.resolve(checkpointPath);
  const bytes = await readBytes(file, 32 * 1024 * 1024);
  const checkpoint = parseMaintenanceJson(bytes.toString('utf8'));
  requireValue([1, 2].includes(checkpoint.schemaVersion) && checkpoint.tools && typeof checkpoint.tools === 'object' &&
    !Array.isArray(checkpoint.tools), 'Expected a v1/v2 maintenance checkpoint with frozen tools.');
  const entries = Object.entries(checkpoint.tools);
  requireValue(entries.length > 0 && entries.length <= 1000, 'Invalid tool count.');
  for (const [name, tool] of entries) {
    requireValue(tool && typeof tool.path === 'string' && path.isAbsolute(tool.path) &&
      typeof tool.sha256 === 'string' && /^[0-9a-f]{64}$/.test(tool.sha256) &&
      Number.isSafeInteger(tool.bytes) && tool.bytes >= 0, `Invalid frozen tool: ${name}`);
  }
  const results = [];
  for (const [name, expected] of entries) {
    try {
      await noLinks(expected.path);
      const before = await fs.stat(expected.path);
      requireValue(before.isFile(), 'Expected a regular tool file.');
      const hash = createHash('sha256');
      const handle = await fs.open(expected.path, 'r');
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat();
        requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino,
          'Tool changed while reading.');
      } finally { await handle.close(); }
      const actual = { path: expected.path, bytes: before.size, sha256: hash.digest('hex') };
      results.push({ name, status: actual.bytes === expected.bytes && actual.sha256 === expected.sha256 ? 'unchanged' : 'changed', expected, actual });
    } catch (error) {
      results.push({ name, status: 'unreadable', expected, actual: null, error: error.message });
    }
  }
  requireValue(bytes.equals(await readBytes(file, 32 * 1024 * 1024)), 'Checkpoint changed during inspection.');
  return { protocol: 'maestro.harmonyos.maintenance-tool-check', schemaVersion: 1,
    checkpointPath: file, checkpointSha256: createHash('sha256').update(bytes).digest('hex'),
    status: results.every(tool => tool.status === 'unchanged') ? 'unchanged' : 'blocked',
    authorizesRelease: false, tools: results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length === 4 && process.argv[2] === '--checkpoint', 'Use --checkpoint ABSOLUTE_CHECKPOINT_PATH');
    const report = await checkMaintenanceTools(process.argv[3]);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.status === 'unchanged' ? 0 : 2;
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
