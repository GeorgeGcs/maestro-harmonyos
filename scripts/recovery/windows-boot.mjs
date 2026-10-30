import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const protocol = 'maestro.harmonyos.host-boot-observation';
const uint64Max = 18446744073709551615n;
const sha256Pattern = /^[0-9a-f]{64}$/;
const limit = 64 * 1024;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function fields(value, names, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype, `${label} must be an object.`);
  requireValue(Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)),
    `${label} has missing or unexpected fields.`);
}
function utc(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `${label} must be canonical UTC.`);
}
function fingerprint(value, label, powershell = false) {
  fields(value, powershell ? ['path', 'sha256', 'bytes', 'version'] : ['path', 'sha256', 'bytes'], label);
  requireValue(typeof value.path === 'string' && value.path.length <= 32767 &&
    /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(value.path) &&
    !/[\x00-\x1f\x7f]/.test(value.path) && !value.path.startsWith('\\\\?\\') &&
    !value.path.startsWith('\\\\.\\') && path.win32.basename(value.path) !== '', `${label}.path must be an absolute Windows file path.`);
  requireValue(typeof value.sha256 === 'string' && sha256Pattern.test(value.sha256), `${label}.sha256 must be lowercase SHA-256.`);
  requireValue(Number.isSafeInteger(value.bytes) && value.bytes > 0, `${label}.bytes must be a positive safe integer.`);
  if (powershell) requireValue(typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value.version),
    `${label}.version must be a PowerShell version.`);
}
function tools(value, label) {
  fields(value, ['powershell', 'script'], label);
  fingerprint(value.powershell, `${label}.powershell`, true);
  fingerprint(value.script, `${label}.script`);
}
function sameFingerprint(a, b) {
  return path.win32.normalize(a.path).toLowerCase() === path.win32.normalize(b.path).toLowerCase() &&
    a.sha256 === b.sha256 && a.bytes === b.bytes && a.version === b.version;
}

// expectedTools must come from a trusted freeze, not from the observation being checked.
// No current tool files are loaded or executed by this parser.
export function parseObservation(value, expectedTools) {
  tools(expectedTools, 'expectedTools');
  fields(value, ['protocol', 'schemaVersion', 'provider', 'observedAt', 'uptimeMilliseconds',
    'lastBootUpTime', 'machineIdSha256', 'tools'], 'observation');
  requireValue(value.protocol === protocol && value.schemaVersion === 1, 'Unsupported host boot observation protocol/version.');
  fields(value.provider, ['name', 'version'], 'provider');
  requireValue(value.provider.name === 'windows-gettickcount64-cim' && value.provider.version === 1, 'Unsupported boot provider.');
  utc(value.observedAt, 'observedAt');
  utc(value.lastBootUpTime, 'lastBootUpTime');
  requireValue(typeof value.uptimeMilliseconds === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.uptimeMilliseconds) &&
    BigInt(value.uptimeMilliseconds) <= uint64Max, 'uptimeMilliseconds must be an unsigned 64-bit decimal string.');
  requireValue(typeof value.machineIdSha256 === 'string' && sha256Pattern.test(value.machineIdSha256), 'Invalid machineIdSha256.');
  tools(value.tools, 'tools');
  for (const name of ['powershell', 'script']) requireValue(sameFingerprint(value.tools[name], expectedTools[name]),
    `Observation ${name} does not match expectedTools.`);
  return Object.freeze({ ...value, provider: Object.freeze({ ...value.provider }), tools: Object.freeze({
    powershell: Object.freeze({ ...value.tools.powershell }), script: Object.freeze({ ...value.tools.script }) }) });
}

export async function readObservation(file, expectedTools) {
  tools(expectedTools, 'expectedTools');
  const absolute = path.resolve(file);
  for (let current = absolute; ; current = path.dirname(current)) {
    requireValue(!(await fs.lstat(current)).isSymbolicLink(), 'Observation path must not follow links.');
    if (path.dirname(current) === current) break;
  }
  const handle = await fs.open(absolute, 'r');
  try {
    const before = await handle.stat();
    requireValue(before.isFile() && before.size > 0 && before.size <= limit, 'Observation must be a regular file of at most 64 KiB.');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    requireValue(count === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
      'Observation changed while being read.');
    const original = bytes.subarray(0, count);
    const value = parseObservation(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original)), expectedTools);
    return { path: absolute, sha256: createHash('sha256').update(original).digest('hex'), observation: value };
  } finally { await handle.close(); }
}

function pair(before, after, expectedTools) {
  return [parseObservation(before, expectedTools), parseObservation(after, expectedTools)];
}
const result = (confirmed, reason) => ({ confirmed, reason });

// Only this host criterion is confirmed. The caller must bind observations to
// checkpoint phases; neither result proves device cleanup or permits gate release.
export function restarted(before, after, expectedTools) {
  const [old, current] = pair(before, after, expectedTools);
  if (old.machineIdSha256 !== current.machineIdSha256) return result(false, 'machine_mismatch');
  if (current.observedAt <= old.observedAt) return result(false, 'observation_order_not_confirmed');
  if (current.lastBootUpTime === old.lastBootUpTime) return result(false, 'boot_time_unchanged');
  if (BigInt(current.uptimeMilliseconds) >= BigInt(old.uptimeMilliseconds)) return result(false, 'uptime_did_not_decrease');
  return result(true, null);
}

export function sameBoot(resume, now, expectedTools) {
  const [old, current] = pair(resume, now, expectedTools);
  if (old.machineIdSha256 !== current.machineIdSha256) return result(false, 'machine_mismatch');
  if (current.observedAt <= old.observedAt) return result(false, 'observation_order_not_confirmed');
  if (current.lastBootUpTime !== old.lastBootUpTime) return result(false, 'boot_time_changed');
  if (BigInt(current.uptimeMilliseconds) < BigInt(old.uptimeMilliseconds)) return result(false, 'uptime_decreased');
  return result(true, null);
}
