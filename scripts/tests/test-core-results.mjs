import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('core JUnit verification rejects missing suites, failures and unexpected skips', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-core-results-'));
  const required = {
    'maestro-client': ['maestro.harmonyos.driver.HarmonyOSDriverTest', 'maestro.harmonyos.driver.HdcHarmonyOSDeviceTest', 'maestro.harmonyos.driver.HarmonyOSWindowStateTest'],
    'maestro-orchestra': ['maestro.orchestra.debug.OrchestraListenerDispatchTest', 'maestro.orchestra.debug.ScreenRecordingOutputTest', 'maestro.orchestra.debug.ArtifactsGeneratorTest'],
  };
  const report = (name, failures = 0, body = '') => `<testsuite name="${name}" tests="1" failures="${failures}" errors="0"><testcase classname="${name}" name="fixture">${body}</testcase></testsuite>`;
  try {
    for (const [module, names] of Object.entries(required)) {
      const dir = path.join(root, module, 'build/test-results/test');
      await fs.mkdir(dir, { recursive: true });
      for (const name of names) await fs.writeFile(path.join(dir, `TEST-${name}.xml`), report(name));
    }
    const output = path.join(root, 'result.json');
    const script = fileURLToPath(new URL('../ci/verify-core-tests.ps1', import.meta.url));
    const verify = () => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-UpstreamDirectory', root, '-Output', output], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(verify().status, 0);
    assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).modules[0].passed, 3);
    const name = required['maestro-client'][0];
    const file = path.join(root, 'maestro-client/build/test-results/test', `TEST-${name}.xml`);
    await fs.writeFile(file, report(name, 1));
    assert.notEqual(verify().status, 0, 'JUnit failures must fail the job');
    await fs.writeFile(file, report(name, 0, '<skipped/>'));
    assert.notEqual(verify().status, 0, 'Missing test dependencies must fail the job');
    await fs.unlink(file);
    assert.notEqual(verify().status, 0, 'Driver suite must not be omitted');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
