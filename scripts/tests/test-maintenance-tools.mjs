import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { checkMaintenanceTools } from '../recovery/check-maintenance-tools.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, 'powershell.fixture');
  await fs.writeFile(tool, 'original');
  const checkpoint = path.join(root, 'checkpoint.json');
  const document = { schemaVersion: 1, tools: { powershell: { path: tool, bytes: 8,
    sha256: createHash('sha256').update('original').digest('hex') } } };
  await fs.writeFile(checkpoint, JSON.stringify(document));
  return { root, tool, checkpoint, document };
}
test('matching tools do not authorize release', async t => {
  const f = await fixture(t), before = await fs.readFile(f.checkpoint);
  const report = await checkMaintenanceTools(f.checkpoint);
  assert.equal(report.status, 'unchanged'); assert.equal(report.authorizesRelease, false);
  assert.deepEqual(await fs.readFile(f.checkpoint), before);
});
test('same-size system tool replacement is reported without changing the baseline', async t => {
  const f = await fixture(t), before = await fs.readFile(f.checkpoint);
  await fs.writeFile(f.tool, 'replaced');
  const report = await checkMaintenanceTools(f.checkpoint);
  assert.equal(report.status, 'blocked'); assert.equal(report.tools[0].status, 'changed');
  assert.notEqual(report.tools[0].expected.sha256, report.tools[0].actual.sha256);
  assert.deepEqual(await fs.readFile(f.checkpoint), before);
});
test('missing tool is unreadable, never unchanged', async t => {
  const f = await fixture(t); await fs.unlink(f.tool);
  const report = await checkMaintenanceTools(f.checkpoint);
  assert.equal(report.status, 'blocked'); assert.equal(report.tools[0].status, 'unreadable');
});
test('duplicate checkpoint keys and relative tool paths are rejected', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.checkpoint, '{"schemaVersion":1,"schemaVersion":1,"tools":{}}');
  await assert.rejects(checkMaintenanceTools(f.checkpoint), /Duplicate/);
  f.document.tools.powershell.path = 'relative.exe';
  await fs.writeFile(f.checkpoint, JSON.stringify(f.document));
  await assert.rejects(checkMaintenanceTools(f.checkpoint), /Invalid frozen tool/);
});
