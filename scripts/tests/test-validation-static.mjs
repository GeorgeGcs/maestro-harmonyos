import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { freezePlan } from '../validation/plan.mjs';
import { startBatch } from '../validation/main.mjs';
import { hashFile, readJson } from '../validation/io.mjs';
import { fixturePlan, json } from './validation-fixture.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.join(repo, 'artifacts/validation-static-tests');
const options = { powershellPath: process.env.TEST_POWERSHELL_PATH };

async function fixture(t, edit = async () => {}) {
  assert.ok(options.powershellPath, 'Set TEST_POWERSHELL_PATH to the actual host PowerShell.');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  t.diagnostic('Retained host-only parser evidence: ' + root);
  const source = await fixturePlan(root, { repeat: 1 });
  await edit(source.plan, root); await json(source.file, source.plan);
  return { root, source, output: path.join(root, 'frozen'),
    freeze: () => freezePlan(source.file, path.join(root, 'frozen'), repo, process.env, options) };
}

function launch(frozen, root) {
  return { summaryPath: frozen.summaryPath, batchId: frozen.batches[0].batchId,
    outputDirectory: path.join(root, 'never-dispatched'), pointerPath: path.join(root, 'pointer.json'),
    controlIndexPath: path.join(root, 'control-index.json') };
}

test('real Maestro freeze checks common dependencies and retained evidence before preparing a batch', async t => {
  let child, script;
  const f = await fixture(t, async plan => {
    const unit = plan.units[0]; await fs.mkdir(path.join(unit.sourceRoot, 'common'));
    child = path.join(unit.sourceRoot, 'common/child.yaml'); script = path.join(unit.sourceRoot, 'common/helper.js');
    await fs.writeFile(child, 'appId: org.example.fixture\n---\n- assertTrue: true\n');
    await fs.writeFile(script, 'throw new Error("Static parsing must never execute this script");\n');
    await fs.writeFile(unit.entry, 'appId: org.example.fixture\nname: fixture-0\n---\n- runFlow: common/child.yaml\n- runScript: common/helper.js\n');
    unit.requiredTopLevelFlows[0].requiredSteps = [{ path: child, commandIndex: 0, role: 'assertion' }];
  });
  const frozen = await f.freeze(), plan = (await readJson(frozen.snapshotPath)).value;
  const inspection = plan.units[0].staticInspection;
  assert.equal(plan.schemaVersion, 3); assert.equal(inspection.scriptsExecuted, false);
  assert.ok(inspection.dependencies.some(file => file.path === script && file.kind === 'script'));
  assert.ok(inspection.dependencies.some(file => file.path === child && file.kind === 'yaml'));
  assert.equal((await readJson(frozen.summaryPath)).value.staticInspectionComplete, true);
  for (const file of [script, ...inspection.evidenceFiles.map(file => file.path)]) {
    const bytes = await fs.readFile(file), before = await hashFile(file);
    try {
      await fs.appendFile(file, '\nchanged after freeze\n');
      await assert.rejects(startBatch(launch(frozen, f.root)), /changed|differs|invalid|JSON/i);
      assert.equal((await readJson(frozen.summaryPath)).value.batches[0].status, 'pending');
    } finally { await fs.writeFile(file, bytes); assert.equal(await hashFile(file), before); }
  }
  const prepared = await startBatch(launch(frozen, f.root));
  assert.equal(prepared.batch.status, 'running');
  // startBatch only prepares metadata. No matrix/runner, JS, driver or HDC is dispatched here.
  await assert.rejects(fs.stat(path.join(f.root, 'control-index.json')), { code: 'ENOENT' });
});

test('real Maestro rejects unfrozen dependencies and invalid declared members during freeze', async t => {
  for (const mode of ['outside-script', 'outside-flow', 'dynamic-script-literal', 'dynamic-flow-literal', 'wrong-name', 'missing-suite-member']) {
    await t.test(mode, async t => {
      const f = await fixture(t, async (plan, root) => {
        const unit = plan.units[0]; let command = '- assertTrue: true\n';
        if (mode === 'outside-script') { await fs.writeFile(path.join(path.dirname(unit.sourceRoot), 'outside.js'), 'throw new Error("never execute");'); command = '- runScript: ../outside.js\n'; }
        if (mode === 'outside-flow') { await fs.writeFile(path.join(path.dirname(unit.sourceRoot), 'outside.yaml'), 'appId: org.example.fixture\n---\n- assertTrue: true\n'); command = '- runFlow: ../outside.yaml\n'; }
        if (mode === 'dynamic-script-literal') { await fs.writeFile(path.join(unit.sourceRoot, '${SCRIPT}.js'), 'throw new Error("never execute");'); command = '- runScript: ${SCRIPT}.js\n'; }
        if (mode === 'dynamic-flow-literal') { await fs.writeFile(path.join(unit.sourceRoot, '${FLOW}.yaml'), 'appId: org.example.fixture\n---\n[]\n'); command = '- runFlow: ${FLOW}.yaml\n'; }
        await fs.writeFile(unit.entry, 'appId: org.example.fixture\nname: fixture-0\n---\n' + command);
        if (mode === 'wrong-name') unit.requiredTopLevelFlows[0].name = 'not-the-native-name';
        if (mode === 'missing-suite-member') { plan.measurementMode = 'suite'; unit.entry = unit.sourceRoot; await fs.writeFile(path.join(unit.sourceRoot, 'extra.yaml'), 'appId: org.example.fixture\n---\n[]\n'); }
      });
      await assert.rejects(f.freeze(), /Static Maestro parsing failed|suite member list/i);
      await assert.rejects(fs.stat(path.join(f.output, 'plan.json')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(f.output, 'validation-summary.json')), { code: 'ENOENT' });
    });
  }
});
