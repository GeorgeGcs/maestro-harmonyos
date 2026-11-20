import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('source fork verification detects drift and preserves a dirty caller index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-fork-test-'));
  const run = (file, args) => spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  function git(...args) {
    const r = run('git', args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  try {
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(root, 'app.txt'), 'original\n');
    git('add', 'app.txt');
    git('commit', '-m', 'baseline');
    const upstream = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(root, 'app.txt'), 'adapted\n');
    const patch = git('diff', '--binary') + '\n';
    git('add', 'app.txt');
    git('commit', '-m', 'fork');
    const fork = git('rev-parse', 'HEAD');
    await fs.mkdir(path.join(root, 'patches/maestro'), { recursive: true });
    const patchPath = path.join(root, 'patches/maestro/0001-harmonyos-host.patch');
    await fs.writeFile(patchPath, patch);
    await fs.writeFile(path.join(root, 'upstream.lock.json'), JSON.stringify({ commit: upstream }));
    const lock = path.join(root, 'source-fork.lock.json');
    await fs.writeFile(lock, JSON.stringify({ commit: fork }));
    await fs.writeFile(path.join(root, 'app.txt'), 'local staged edit\n');
    git('add', 'app.txt');
    const staged = git('write-tree');
    const verifier = fileURLToPath(new URL('../verify-source-fork.mjs', import.meta.url));
    const verify = () => run(process.execPath, [verifier, '--repository', root, '--project-root', root]);
    assert.equal(verify().status, 0);
    assert.equal(git('write-tree'), staged);
    assert.equal(await fs.readFile(path.join(root, 'app.txt'), 'utf8'), 'local staged edit\n');
    await fs.writeFile(lock, JSON.stringify({ commit: upstream }));
    assert.notEqual(verify().status, 0);
    await fs.writeFile(lock, JSON.stringify({ commit: fork }));
    await fs.writeFile(patchPath, patch.replace('+adapted', '+different'));
    assert.notEqual(verify().status, 0);
    assert.equal(git('write-tree'), staged);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

