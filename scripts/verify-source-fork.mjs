import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  repository: { type: 'string' }, output: { type: 'string' }, 'project-root': { type: 'string' },
} });
const project = path.resolve(values['project-root'] ?? fileURLToPath(new URL('..', import.meta.url)));
const repository = path.resolve(values.repository ?? path.join(project, '.upstream/maestro'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-fork-check-'));
try {
  const upstream = JSON.parse(await fs.readFile(path.join(project, 'upstream.lock.json'), 'utf8'));
  const fork = JSON.parse(await fs.readFile(path.join(project, 'source-fork.lock.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(upstream.commit) || !/^[0-9a-f]{40}$/.test(fork.commit)) {
    throw new Error('Upstream and source fork must be locked to full commits.');
  }
  const patchPath = path.join(project, 'patches/maestro/0001-harmonyos-host.patch');
  const patch = await fs.readFile(patchPath);
  function git(args, environment = process.env) {
    const result = spawnSync('git', ['-C', repository, ...args], {
      env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    if (result.error || result.status !== 0) {
      throw new Error('Source fork verification failed in git ' + args[0] + ': ' + (result.error?.message ?? result.stderr.trim()));
    }
    return result.stdout.trim();
  }
  // A separate index preserves HEAD, staged work and all working files.
  const environment = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  git(['read-tree', upstream.commit], environment);
  git(['apply', '--cached', '--whitespace=error', patchPath], environment);
  const expectedTree = git(['write-tree'], environment);
  const actualTree = git(['rev-parse', fork.commit + '^{tree}']);
  if (actualTree !== expectedTree) throw new Error('Source fork differs from the pinned upstream and patch: expected ' + expectedTree + ', got ' + actualTree);
  const result = {
    schemaVersion: 1, status: 'passed', upstreamCommit: upstream.commit, forkCommit: fork.commit,
    patchSha256: createHash('sha256').update(patch).digest('hex'), sourceTree: actualTree,
  };
  if (values.output) {
    await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
    await fs.writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

