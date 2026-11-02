import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { flowEnvironment, prepareHandoff, verifyHandoff } from '../handoff.mjs';

const execute = promisify(execFile);
const java = process.env.MAESTRO_TEST_JAVA, cliDirectory = process.env.MAESTRO_TEST_CLI;
const enabled = Boolean(java && cliDirectory);
const appId = 'org.example.handoff';
async function fixture(t) {
  const parent = path.resolve('artifacts/agent-handoff-tests'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-')), sourceRoot = path.join(root, 'source');
  await fs.mkdir(sourceRoot); const flow = path.join(sourceRoot, 'main.yaml');
  t.diagnostic('Host-only handoff evidence: ' + root);
  return { root, sourceRoot, flow, async write(text) { await fs.writeFile(flow, text); },
    prepare(extra = {}) { return prepareHandoff({ flow, sourceRoot, java, cliDirectory,
      environment: flowEnvironment(appId), directory: path.join(root, 'inspection'), ...extra }); } };
}

test('handoff parameters preserve values without shell parsing and bind APP_ID', () => {
  const env = flowEnvironment(appId, ['TEXT=中文 "quote" = value', 'EMPTY=']);
  assert.deepEqual(env.args, ['-e', 'TEXT=中文 "quote" = value', '-e', 'EMPTY=', '-e', 'APP_ID=' + appId]);
  for (const entries of [['A'], ['=v'], ['X=1','X=2'], ['APP_ID=foreign'], ['MAESTRO_SHARD_ID=2']]) assert.throws(() => flowEnvironment(appId, entries));
});

test('native handoff parser snapshots child dependencies without evaluating JavaScript', { skip: !enabled }, async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.sourceRoot, 'common'));
  await fs.writeFile(path.join(f.sourceRoot, 'common/child.yaml'), 'appId: ${APP_ID}\n---\n- assertVisible: ${TEXT}\n');
  await fs.writeFile(path.join(f.sourceRoot, 'common/helper.js'), 'throw new Error("Never evaluate during inspection");\n');
  await f.write('appId: ${APP_ID}\n---\n- runFlow:\n    file: common/child.yaml\n    env:\n      TEXT: Ready\n- runScript: common/helper.js\n');
  const plan = await f.prepare(); assert.equal(plan.sources.length, 3); assert.equal(plan.scriptsExecuted, false);
  assert.equal(plan.env.APP_ID, appId); await verifyHandoff(plan);
  await fs.appendFile(f.flow, '\n# original changed after preparation\n'); await verifyHandoff(plan);
  await fs.appendFile(plan.sources[0].path, '\n# frozen input changed\n'); await assert.rejects(verifyHandoff(plan), /changed/);
});

test('handoff preserves explicitly listed script data paths and rejects escaping assets', { skip: !enabled }, async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.sourceRoot, 'data'));
  await fs.writeFile(path.join(f.sourceRoot,'data/payload.txt'), '中文 payload');
  await f.write('appId: ${APP_ID}\n---\n- assertVisible: Ready\n');
  const plan = await f.prepare({assets:['data/payload.txt']});
  assert.equal(await fs.readFile(path.join(path.dirname(plan.flow),'data/payload.txt'),'utf8'), '中文 payload');
  assert.equal(plan.sources.find(item => item.kind === 'asset').relative, path.join('data','payload.txt'));
  await assert.rejects(f.prepare({directory:path.join(f.root,'escape'),assets:['../private.txt']}), /escapes/);
});

test('native Flow environment is defined before configuration and hooks', { skip: !enabled }, async t => {
  const f = await fixture(t);
  await f.write('appId: ${BUNDLE_ID}\nenv:\n  BUNDLE_ID: org.example.local\n  LABEL: Ready\nonFlowStart:\n  - assertVisible: ${LABEL}\n---\n- assertVisible: ${LABEL}\n');
  const plan = await f.prepare(); assert.equal(plan.sources.length, 1);
});

test('built-in Maestro names and inline script locals are not missing external parameters', { skip: !enabled }, async t => {
  const f = await fixture(t);
  await f.write('appId: ${APP_ID}\n---\n- assertVisible: ${MAESTRO_FILENAME}\n- assertVisible: ${MAESTRO_DEVICE_UDID}\n- assertVisible: ${MAESTRO_SHARD_ID}\n- assertVisible: ${MAESTRO_SHARD_INDEX}\n- evalScript: |\n    ${const localName = "Ready"; output.label = `${localName}`;}\n');
  const plan = await f.prepare(); assert.equal(plan.scriptsExecuted, false);
});

test('escaped Maestro expressions remain literal text', { skip: !enabled }, async t => {
  const f = await fixture(t);
  await f.write("appId: ${APP_ID}\n---\n- assertVisible: '\\${LITERAL}'\n");
  const plan = await f.prepare(); assert.equal(plan.sources.length, 1);
});

test('runFlow configuration cannot borrow a variable defined only inside the child', { skip: !enabled }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sourceRoot,'child.yaml'), 'appId: ${CHILD_APP}\nenv:\n  CHILD_APP: org.example.child\n---\n- assertVisible: Ready\n');
  await f.write('appId: ${APP_ID}\n---\n- runFlow: child.yaml\n');
  await assert.rejects(f.prepare(), /Missing handoff parameters.*CHILD_APP/);
});

for (const kind of ['runFlow', 'runScript']) {
  test(`handoff rejects absolute ${kind} paths that would bypass the saved copy`, { skip: !enabled }, async t => {
    const f = await fixture(t), dependency = path.join(f.sourceRoot, kind === 'runFlow' ? 'child.yaml' : 'helper.js');
    await fs.writeFile(dependency, kind === 'runFlow' ? 'appId: org.example.child\n---\n- assertVisible: Ready\n' : 'output.label = "Ready";');
    await f.write('appId: ${APP_ID}\n---\n- ' + kind + ': ' + JSON.stringify(dependency.replaceAll('\\','/')) + '\n');
    await assert.rejects(f.prepare(), /paths must be static and relative/);
  });
}

for (const mode of ['missing-parameter', 'invalid-yaml', 'missing-child', 'outside-child', 'dynamic-child']) {
  test(`handoff rejects ${mode} before bridge startup`, { skip: !enabled }, async t => {
    const f = await fixture(t);
    if (mode === 'missing-parameter') await f.write('appId: ${APP_ID}\n---\n- assertVisible: ${UNSET}\n');
    if (mode === 'invalid-yaml') await f.write('appId: [broken\n---\n- tapOn: x\n');
    if (mode === 'missing-child') await f.write('appId: ${APP_ID}\n---\n- runFlow: absent.yaml\n');
    if (mode === 'outside-child') { await fs.writeFile(path.join(f.root,'outside.yaml'),'appId: x\n---\n[]\n'); await f.write('appId: ${APP_ID}\n---\n- runFlow: ../outside.yaml\n'); }
    if (mode === 'dynamic-child') { await fs.writeFile(path.join(f.sourceRoot,'${CHILD}.yaml'),'appId: x\n---\n[]\n'); await f.write('appId: ${APP_ID}\n---\n- runFlow: ${CHILD}.yaml\n'); }
    await assert.rejects(f.prepare(), /before connecting/);
    await assert.rejects(fs.access(path.join(f.root,'inspection/plan.json')), { code: 'ENOENT' });
  });
}

test('public check-only command accepts parameters without a device or HDC', { skip: !enabled }, async t => {
  const f = await fixture(t); await f.write('appId: ${APP_ID}\n---\n- assertVisible: ${TEXT}\n');
  const {stdout} = await execute(process.execPath, ['examples/agent-client/run.mjs', '--check-only', '--java', java,
    '--cli-dir', cliDirectory, '--app', appId, '--artifacts', path.join(f.root,'output'), '--handoff-flow', f.flow, '-e', 'TEXT=Ready'],
  { windowsHide: true, timeout: 60000, env: {...process.env, MAESTRO_HARMONYOS_HDC:path.join(f.root,'never-run-hdc.exe')} });
  assert.match(stdout, /no bridge or device commands/);
  const invocations=await fs.readdir(path.join(f.root,'output/client')); assert.equal(invocations.length,1);
  await assert.rejects(fs.access(path.join(f.root,'output/client',invocations[0],'bridge.stderr.log')), {code:'ENOENT'});
});

test('normal handoff rejects a missing Flow before opening the bridge', { skip: !enabled }, async t => {
  const f = await fixture(t);
  await assert.rejects(execute(process.execPath, ['examples/agent-client/run.mjs', '--java', java,
    '--cli-dir', cliDirectory, '--device', 'unused-device', '--app', appId, '--ability', 'EntryAbility',
    '--assert-text', 'Ready', '--artifacts', path.join(f.root,'output'), '--handoff-flow', f.flow],
  { windowsHide: true, timeout: 60000, env: {...process.env, MAESTRO_HARMONYOS_HDC:path.join(f.root,'never-run-hdc.exe')} }), /ENOENT/);
  const invocations=await fs.readdir(path.join(f.root,'output/client')); assert.equal(invocations.length,1);
  await assert.rejects(fs.access(path.join(f.root,'output/client',invocations[0],'bridge.stderr.log')), {code:'ENOENT'});
});
