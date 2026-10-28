import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RecorderSession } from '../src/session';
import { Connection, Transport } from '../src/protocol';
import { snapshot } from './snapshot';

const connection: Connection = { deviceId: 'test-device', appId: 'org.example.app', abilityName: 'EntryAbility', artifactsDir: 'C:\test-artifacts' };
class FakeTransport implements Transport {
  calls: string[] = []; snapshots = 0; failRefresh = false; failAction = false; failDisconnect = false;
  async request(method: string): Promise<unknown> {
    this.calls.push(method);
    if (method === 'connect') return { deviceId: connection.deviceId, appId: connection.appId };
    if (method === 'snapshot') { if (this.failRefresh) throw new Error('capture failed'); return { ...snapshot, snapshotId: `frame-${++this.snapshots}` }; }
    if (method === 'action') { if (this.failAction) throw new Error('remote error'); return { yaml: '- back', artifactsDir: connection.artifactsDir }; }
    if (method === 'disconnect') { if (this.failDisconnect) throw new Error('release failed'); return { disconnected: true }; }
    throw new Error('Unexpected method');
  }
  async dispose(): Promise<void> { this.calls.push('dispose'); }
}
test('successful operation is retained when the following snapshot fails', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection);
  transport.failRefresh = true;
  await session.action({ type: 'back' });
  assert.deepEqual(session.state.steps, ['- back']);
  assert.equal(session.state.snapshot, null);
  assert.match(session.state.message, /操作已完成并记入 YAML.*刷新失败/);
  assert.equal(transport.calls.filter(method => method === 'action').length, 1);
});
test('failed actions never enter YAML and cannot reuse old screen coordinates', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection);
  transport.failAction = true;
  await assert.rejects(session.action({ type: 'back' }), /remote error/);
  assert.deepEqual(session.state.steps, []);
  assert.equal(session.state.snapshot, null);
  await assert.rejects(session.action({ type: 'tapOn', snapshotId: 'frame-1', nodeId: '0' }), /过期/);
  assert.equal(transport.calls.filter(method => method === 'action').length, 1);
});
test('replay waits for confirmed device release and preserves failed CLI result', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection); await session.action({ type: 'back' });
  await session.replay(async (config, yaml) => {
    assert.equal(transport.calls.at(-1), 'disconnect');
    assert.equal(session.state.connected, false);
    assert.equal(config.appId, connection.appId); assert.match(yaml, /- back/);
    return { exitCode: 7, artifactsDir: 'replay-output' };
  });
  assert.match(session.state.message, /退出码 7/);
  assert.deepEqual(session.state.steps, ['- back']);
  assert.equal(session.state.artifactsDir, 'replay-output');
});
test('failed disconnect prevents any playback process', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection); await session.action({ type: 'back' });
  transport.failDisconnect = true;
  let started = false;
  await assert.rejects(session.replay(async () => { started = true; return { exitCode: 0, artifactsDir: 'x' }; }), /release failed/);
  assert.equal(started, false);
});
test('pending operations reject competing clicks instead of queuing side effects', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection);
  let finish!: (result: unknown) => void;
  const original = transport.request.bind(transport);
  transport.request = method => method === 'action' ? new Promise(resolve => { finish = resolve; }) : original(method);
  const first = session.action({ type: 'back' });
  await assert.rejects(session.action({ type: 'back' }), /等待/);
  finish({ yaml: '- back' }); await first;
  assert.equal(session.state.steps.length, 1);
});

test('stop wins over an already resolved connect response and cannot revive the connection', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  const pending = session.connect(transport, connection);
  const rejected = assert.rejects(pending, /停止/);
  await session.stop();
  await rejected;
  assert.equal(session.state.connected, false);
  assert.equal(session.state.snapshot, null);
  assert.equal(transport.snapshots, 0);
  assert.equal(session.state.busy, false);
});

test('late action response after stop cannot append YAML or start a new refresh', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection);
  let finish!: (result: unknown) => void;
  const original = transport.request.bind(transport);
  transport.request = method => method === 'action' ? new Promise(resolve => { finish = resolve; }) : original(method);
  const pending = session.action({ type: 'back' });
  const rejected = assert.rejects(pending, /停止/);
  const snapshotsBeforeStop = transport.snapshots;
  await session.stop();
  finish({ yaml: '- back', artifactsDir: connection.artifactsDir });
  await rejected;
  assert.equal(session.state.connected, false);
  assert.equal(session.state.snapshot, null);
  assert.deepEqual(session.state.steps, []);
  assert.equal(transport.snapshots, snapshotsBeforeStop);
  assert.equal(session.state.busy, false);
});

test('late refresh response after stop cannot restore the old screenshot', async () => {
  const transport = new FakeTransport(), session = new RecorderSession(() => {});
  await session.connect(transport, connection);
  let finish!: (result: unknown) => void;
  const original = transport.request.bind(transport);
  transport.request = method => method === 'snapshot' ? new Promise(resolve => { finish = resolve; }) : original(method);
  const pending = session.refresh();
  const rejected = assert.rejects(pending, /停止/);
  await session.stop();
  finish({ ...snapshot, snapshotId: 'late-after-stop' });
  await rejected;
  assert.equal(session.state.connected, false);
  assert.equal(session.state.snapshot, null);
  assert.equal(session.state.busy, false);
});
