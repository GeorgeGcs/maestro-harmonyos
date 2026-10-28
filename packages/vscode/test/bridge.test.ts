import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { BridgeClient, BridgeError } from '../src/bridge';
import { RecorderSession } from '../src/session';
const fixture = path.resolve(__dirname, '../../test/fixtures/bridge.cjs');
function bridge(timeout = 3000) { return new BridgeClient({ executable: process.execPath, args: [fixture], cwd: process.cwd(), env: process.env }, () => {}, timeout); }
test('serializes requests and preserves UTF-8 split inside a code point', async () => {
  const client = bridge();
  try {
    const text = '熊猫 O\'Reilly "中文"\n${literal} 🐼';
    const results = await Promise.all([client.request('echo', { text }), client.request('echo', { text: 'second' })]);
    assert.deepEqual(results, [{ text }, { text: 'second' }]);
  } finally { await client.dispose(); }
});
test('a recoverable backend error preserves its code without killing the connection', async () => {
  const client = bridge();
  try { await assert.rejects(client.request('failure'), error => error instanceof BridgeError && error.code === 'STALE_SNAPSHOT'); assert.deepEqual(await client.request('echo', { ok: true }), { ok: true }); }
  finally { await client.dispose(); }
});
for (const method of ['invalid', 'mismatch', 'exit']) test(`protocol failure ${method} ends the session`, async () => {
  const client = bridge();
  try { await assert.rejects(client.request(method)); await assert.rejects(client.request('echo')); }
  finally { await client.dispose(); }
});
test('timeout and explicit stop reject requests without replaying them', async () => {
  const timed = bridge(120);
  try { await assert.rejects(timed.request('wait'), /执行结果不确定/); await assert.rejects(timed.request('echo')); }
  finally { await timed.dispose(); }
  const stopped = bridge();
  const request = stopped.request('wait');
  const rejected = assert.rejects(request);
  await stopped.dispose(); await rejected;
});
test('oversized requests are rejected before writing and do not poison the next request', async () => {
  const client = bridge();
  try { await assert.rejects(client.request('echo', { text: '熊'.repeat(23000) }), /64 KiB/); assert.deepEqual(await client.request('echo', { ok: true }), { ok: true }); }
  finally { await client.dispose(); }
});
test('a real bridge timeout clears session state, retains steps and permits direct reconnect', async () => {
  const client = bridge(400), replacement = bridge();
  const session = new RecorderSession(() => {});
  const connection = { deviceId: 'device', appId: 'org.example.app', abilityName: 'EntryAbility', artifactsDir: 'C:\\test-artifacts' };
  try {
    await session.connect(client, connection);
    await session.action({ type: 'back' });
    assert.ok(session.state.snapshot);
    await assert.rejects(client.request('failure'), BridgeError);
    assert.equal(session.state.connected, true, 'recoverable errors do not terminate a session');
    await assert.rejects(client.request('wait'), /超时/);
    assert.equal(session.state.connected, false);
    assert.equal(session.state.snapshot, null);
    assert.equal(session.state.busy, false);
    assert.deepEqual(session.state.steps, ['- back']);
    await session.connect(replacement, connection);
    assert.equal(session.state.connected, true);
    assert.ok(session.state.snapshot);
    assert.deepEqual(session.state.steps, ['- back']);
  } finally { await session.stop(); await client.dispose(); await replacement.dispose(); }
});
