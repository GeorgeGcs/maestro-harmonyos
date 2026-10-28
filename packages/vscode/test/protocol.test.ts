import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { composeFlow, parseDevices, parseSnapshot, validateAction } from '../src/protocol';
import { snapshot } from './snapshot';
const geometry = require('../../media/geometry.js') as { pointInImage: (...args: unknown[]) => unknown; nodesAtPoint: (nodes: unknown[], point: unknown) => { nodeId: string }[] };
test('maps a scaled screenshot into physical pixels, retaining the system-bar offset', () => {
  assert.deepEqual(geometry.pointInImage(220, 310, { left: 10, top: 10, right: 430, bottom: 916.6666666666666 }, 1260, 2720), { x: 630, y: 900 });
  assert.equal(geometry.pointInImage(430, 310, { left: 10, top: 10, right: 430, bottom: 910 }, 1260, 2720), null);
  assert.equal(geometry.pointInImage(10, 10, { left: 10, top: 10, right: 10, bottom: 10 }, 1260, 2720), null);
  assert.equal(geometry.pointInImage(NaN, 10, { left: 0, top: 0, right: 10, bottom: 10 }, 1260, 2720), null);
});
test('chooses the smallest containing node and leaves explicit coordinate fallback available', () => {
  const root = { ...snapshot.nodes[0], nodeId: 'root', bounds: { left: 0, top: 0, right: 1260, bottom: 2720 } };
  assert.deepEqual(geometry.nodesAtPoint([root, snapshot.nodes[0]], { x: 150, y: 250 }).map(node => node.nodeId), ['0', 'root']);
  assert.deepEqual(geometry.nodesAtPoint(snapshot.nodes, { x: 700, y: 400 }), []);
});
test('rejects stale, unknown, out-of-screen and injected actions before transport', () => {
  assert.throws(() => validateAction({ type: 'tapOn', snapshotId: 'old', nodeId: '0' }, snapshot), /过期/);
  assert.throws(() => validateAction({ type: 'tapOn', snapshotId: 'frame-1', nodeId: 'missing' }, snapshot), /无效/);
  assert.throws(() => validateAction({ type: 'tapOn', snapshotId: 'frame-1', point: { x: 1260, y: 0 } }, snapshot), /无效/);
  assert.throws(() => validateAction({ type: 'back', shell: 'anything' }, snapshot), /无效/);
  assert.throws(() => validateAction({ type: 'takeScreenshot', name: '../outside' }, snapshot), /无效/);
  assert.throws(() => validateAction({ type: 'inputText', text: 'x\0y' }, snapshot), /无效/);
  assert.deepEqual(validateAction({ type: 'inputText', text: '熊猫 "测试"\n${literal} 🐼' }, snapshot), { type: 'inputText', text: '熊猫 "测试"\n${literal} 🐼' });
});
test('rejects malformed screenshots and duplicate node identities', () => {
  assert.deepEqual(parseSnapshot(snapshot), snapshot);
  assert.throws(() => parseSnapshot({ ...snapshot, width: -1 }), /格式无效/);
  assert.throws(() => parseSnapshot({ ...snapshot, screenshot: { mimeType: 'image/svg+xml', base64: '<script>' } }), /格式无效/);
  assert.throws(() => parseSnapshot({ ...snapshot, nodes: [snapshot.nodes[0], snapshot.nodes[0]] }), /格式无效/);
  assert.throws(() => parseDevices({ devices: [{ id: '--shell' }] }), /设备列表无效/);
});
test('keeps backend YAML literal and prevents application-header injection', () => {
  const yaml = '- inputText: "熊猫 \\\"测试\\\""';
  assert.equal(composeFlow('org.example.test', [yaml]), `appId: "org.example.test"\n---\n${yaml}\n`);
  assert.throws(() => composeFlow('app\n---\n- back', []), /无效/);
});
