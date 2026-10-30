import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { parseObservation, readObservation, restarted, sameBoot } from '../recovery/windows-boot.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expected = {
  powershell: { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', sha256: 'a'.repeat(64), bytes: 100, version: '5.1.26100.1' },
  script: { path: 'D:\\checkout\\scripts\\recovery\\observe-windows-boot.ps1', sha256: 'b'.repeat(64), bytes: 200 }
};
function observation(overrides = {}) {
  return { protocol: 'maestro.harmonyos.host-boot-observation', schemaVersion: 1,
    provider: { name: 'windows-gettickcount64-cim', version: 1 }, observedAt: '2026-10-30T01:00:00.000Z',
    uptimeMilliseconds: '9007199254740993', lastBootUpTime: '2026-10-20T00:00:00.000Z',
    machineIdSha256: 'c'.repeat(64), tools: structuredClone(expected), ...overrides };
}
function later(overrides = {}) { return observation({ observedAt: '2026-10-30T02:00:00.000Z', ...overrides }); }

test('parses UInt64 exactly, including values above Number.MAX_SAFE_INTEGER and the maximum', () => {
  for (const tick of ['0', '9007199254740993', '18446744073709551615']) {
    assert.equal(parseObservation(observation({ uptimeMilliseconds: tick }), expected).uptimeMilliseconds, tick);
  }
  const value = observation(); const parsed = parseObservation(value, expected);
  value.tools.script.sha256 = 'd'.repeat(64); assert.equal(parsed.tools.script.sha256, expected.script.sha256);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.tools.script));
});

test('invalid uptime encodings and overflow fail closed', async t => {
  for (const tick of [0, 9007199254740992, '', '00', '01', '-1', '+1', '1.0', '1e3', ' 1', '1 ',
    '18446744073709551616', '9'.repeat(100), null]) await t.test(String(tick), () => {
    assert.throws(() => parseObservation(observation({ uptimeMilliseconds: tick }), expected), /unsigned 64-bit/);
  });
});

test('requires the trusted tool freeze at every public parsing and comparison entry', () => {
  assert.throws(() => parseObservation(observation()), /expectedTools/);
  assert.throws(() => restarted(observation(), later()), /expectedTools/);
  assert.throws(() => sameBoot(observation(), later()), /expectedTools/);
  for (const key of ['path', 'sha256', 'bytes', 'version']) {
    const value = observation(); value.tools.powershell[key] = key === 'bytes' ? 101 :
      key === 'version' ? '7.5.0' : key === 'path' ? 'C:\\other\\pwsh.exe' : 'd'.repeat(64);
    assert.throws(() => parseObservation(value, expected), /expectedTools/);
    assert.throws(() => restarted(value, { ...value, observedAt: later().observedAt }, expected), /expectedTools/);
  }
  const changedScript = observation(); changedScript.tools.script.sha256 = 'd'.repeat(64);
  assert.throws(() => parseObservation(changedScript, expected), /expectedTools/);
});

test('strict fields, provider, dates, host hash and fingerprint shapes are checked', async t => {
  const mutations = {
    missing: v => { delete v.observedAt; }, extra: v => { v.handoffReady = true; },
    protocol: v => { v.protocol = 'other'; }, version: v => { v.schemaVersion = 2; },
    provider: v => { v.provider.version = 2; }, providerExtra: v => { v.provider.extra = true; },
    date: v => { v.observedAt = '2026-02-30T00:00:00.000Z'; }, localDate: v => { v.observedAt = '2026-10-30T01:00:00+00:00'; },
    boot: v => { v.lastBootUpTime = null; }, hash: v => { v.machineIdSha256 = 'C'.repeat(64); },
    emptyHash: v => { v.machineIdSha256 = ''; }, toolsExtra: v => { v.tools.extra = {}; },
    relativePath: v => { v.tools.script.path = 'relative.ps1'; }, rootedPath: v => { v.tools.script.path = '\\rooted.ps1'; },
    byteOverflow: v => { v.tools.script.bytes = Number.MAX_SAFE_INTEGER + 1; }, zeroBytes: v => { v.tools.script.bytes = 0; },
    toolHash: v => { v.tools.script.sha256 = 'wrong'; }, psVersion: v => { v.tools.powershell.version = ''; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const value = observation(); mutate(value); assert.throws(() => parseObservation(value, expected));
  });
});

test('restart requires both boot-time change and exact UInt64 decrease', () => {
  const before = observation();
  assert.deepEqual(restarted(before, later({ uptimeMilliseconds: '9007199254740992', lastBootUpTime: '2026-10-30T01:30:00.000Z' }), expected), { confirmed: true, reason: null });
  assert.deepEqual(restarted(before, later({ uptimeMilliseconds: '1' }), expected), { confirmed: false, reason: 'boot_time_unchanged' });
  for (const tick of [before.uptimeMilliseconds, '9007199254740994']) {
    assert.deepEqual(restarted(before, later({ uptimeMilliseconds: tick, lastBootUpTime: '2026-10-30T01:30:00.000Z' }), expected),
      { confirmed: false, reason: 'uptime_did_not_decrease' });
  }
});

test('same-boot accepts equal/increasing exact ticks but rejects decrease or changed boot time', () => {
  const before = observation();
  for (const tick of [before.uptimeMilliseconds, '9007199254740994'])
    assert.deepEqual(sameBoot(before, later({ uptimeMilliseconds: tick }), expected), { confirmed: true, reason: null });
  assert.equal(sameBoot(before, later({ uptimeMilliseconds: '9007199254740992' }), expected).reason, 'uptime_decreased');
  assert.equal(sameBoot(before, later({ lastBootUpTime: '2026-10-30T01:30:00.000Z' }), expected).reason, 'boot_time_changed');
});

test('different host, reversed/reused observations and wall-clock rollback do not confirm either criterion', () => {
  for (const compare of [restarted, sameBoot]) {
    assert.equal(compare(observation(), later({ machineIdSha256: 'd'.repeat(64) }), expected).reason, 'machine_mismatch');
    assert.equal(compare(observation(), observation(), expected).reason, 'observation_order_not_confirmed');
    assert.equal(compare(later(), observation(), expected).reason, 'observation_order_not_confirmed');
  }
});

test('bounded reader returns the original byte hash and rejects malformed, oversize and directory inputs', async t => {
  const root = path.join(repo, 'artifacts/windows-boot-tests', randomUUID());
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'observation.json'), bytes = Buffer.from(JSON.stringify(observation()) + '\n');
  await fs.writeFile(file, bytes);
  const result = await readObservation(file, expected);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.observation.uptimeMilliseconds, observation().uptimeMilliseconds);
  await assert.rejects(readObservation(file), /expectedTools/);
  await fs.writeFile(file, Buffer.from([0xff])); await assert.rejects(readObservation(file, expected));
  await fs.writeFile(file, '{}'); await assert.rejects(readObservation(file, expected), /missing/);
  await fs.writeFile(file, ' '.repeat(65537)); await assert.rejects(readObservation(file, expected), /64 KiB/);
  await assert.rejects(readObservation(root, expected));
});
