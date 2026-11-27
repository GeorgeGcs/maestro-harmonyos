import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { replayFlow } from '../src/launcher';
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const processes = require('node:child_process') as typeof import('node:child_process');

for (const stage of ['mkdir', 'writeFile', 'readdir'] as const) test(`stop during replay preparation (${stage}) never starts Java`, async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-recorder-test-'));
  const distribution = path.join(root, 'cli');
  await fs.mkdir(path.join(distribution, 'lib'), { recursive: true });
  await fs.writeFile(path.join(distribution, 'lib', 'fixture.jar'), '');
  const cancellation = new AbortController();
  let spawns = 0, callbacks = 0;
  context.mock.method(processes, 'spawn', () => { spawns++; throw new Error('Cancelled playback must not spawn'); });
  const original = fs[stage] as (...args: unknown[]) => Promise<unknown>;
  context.mock.method(fs, stage, async (...args: unknown[]) => { const result = await original(...args); cancellation.abort(); return result; });
  try {
    await assert.rejects(replayFlow(root, { cliDirectory: distribution, javaPath: process.execPath, hdcPath: '' },
      { deviceId: 'device', appId: 'org.example.app', abilityName: 'EntryAbility', artifactsDir: root },
      'appId: org.example.app\n---\n- back\n', () => {}, () => { callbacks++; }, cancellation.signal), /停止/);
    assert.equal(spawns, 0); assert.equal(callbacks, 0);
  } finally {
    context.mock.restoreAll();
    assert.ok(path.basename(root).startsWith('maestro-recorder-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('host recording follows the CLI environment unless the user explicitly sets deduplication', async context => {
  const variable = 'MAESTRO_HARMONYOS_HOST_RECORDING_DEDUPLICATE_FRAMES';
  const original = process.env[variable];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-recorder-test-'));
  const distribution = path.join(root, 'cli');
  const spawn = processes.spawn;
  context.mock.method(processes, 'spawn', (_executable: string, _args: string[], options: import('node:child_process').SpawnOptions) =>
    spawn(process.execPath, ['-e', `process.stdout.write(process.env.${variable})`], options));
  try {
    await fs.mkdir(path.join(distribution, 'lib'), { recursive: true });
    await fs.writeFile(path.join(distribution, 'lib', 'fixture.jar'), '');
    for (const [inherited, setting, expected] of [['true', undefined, 'true'], ['true', false, 'false'], ['false', true, 'true']] as const) {
      process.env[variable] = inherited;
      let output = '';
      const result = await replayFlow(root, {
        cliDirectory: distribution, javaPath: process.execPath, hdcPath: '', hostRecordingDeduplicateFrames: setting,
      }, { deviceId: 'device', appId: 'org.example.app', abilityName: 'EntryAbility', artifactsDir: root },
        'appId: org.example.app\n---\n- back\n', text => { output += text; }, () => {});
      assert.equal(result.exitCode, 0);
      assert.equal(output.trimEnd().split('\n').at(-1), expected);
    }
  } finally {
    if (original === undefined) delete process.env[variable];
    else process.env[variable] = original;
    context.mock.restoreAll();
    await fs.rm(root, { recursive: true, force: true });
  }
});
