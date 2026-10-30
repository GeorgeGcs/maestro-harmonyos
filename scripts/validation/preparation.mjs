import path from 'node:path';
import { canonical, digestPattern, hash, hashFile, key, readBytes, requireValue, samePath, uuid } from './io.mjs';

const protocol = 'maestro.harmonyos.validation-preparation';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const decimal = /^(?:0|[1-9][0-9]*)$/;
const devicePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const id = value => typeof value === 'string' && identifier.test(value);
const deviceId = value => typeof value === 'string' && devicePattern.test(value);
const fail = (condition, message) => requireValue(condition, 'Preparation: ' + message);
function fields(value, names, label) {
  fail(value && typeof value === 'object' && !Array.isArray(value) &&
    canonical(Object.keys(value).sort()) === canonical([...names].sort()), `${label} has missing or unsupported fields.`);
}
function time(value, label) {
  fail(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp.`);
  return Date.parse(value);
}
function version(value, label) {
  fail(typeof value.versionCode === 'string' && decimal.test(value.versionCode) && text(value.versionName), `${label} needs decimal versionCode and nonempty versionName.`);
}
function ref(value, base) {
  fields(value, ['path', 'sha256'], 'file reference');
  fail(text(value.path) && digestPattern.test(value.sha256), 'File reference needs a path and SHA-256.');
  return { path: path.resolve(base, value.path), sha256: value.sha256 };
}
async function verifyFile(reference, checked) {
  const identity = key(reference.path);
  if (!checked.has(identity)) checked.set(identity, await hashFile(reference.path));
  fail(checked.get(identity) === reference.sha256, `File hash differs: ${reference.path}`);
}
function unknown(planId, profileId, deviceId) {
  return { planId, profileId, deviceId, preparationId: null, state: 'unknown', reference: null,
    application: null, installation: null, packageObservation: null, preparation: null, files: [] };
}

async function load(reference, checked = new Map()) {
  const bytes = await readBytes(reference.path, 256 * 1024);
  fail(hash(bytes) === reference.sha256, 'Preparation record hash differs.');
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  fields(record, ['protocol', 'schemaVersion', 'preparationId', 'planId', 'profileId', 'deviceId',
    'application', 'installation', 'packageObservation', 'preparation'], 'record');
  fail(record.protocol === protocol && record.schemaVersion === 1 && uuid.test(record.preparationId) &&
    id(record.planId) && id(record.profileId) && deviceId(record.deviceId), 'Record identity or version is invalid.');
  const base = path.dirname(reference.path);
  const app = record.application;
  fields(app, ['bundleId', 'moduleName', 'abilityName', 'versionCode', 'versionName', 'hap'], 'application');
  fail(text(app.bundleId) && text(app.abilityName) && (app.moduleName === null || text(app.moduleName)), 'Application identity is invalid.');
  version(app, 'Application');
  const application = { ...app, hap: ref(app.hap, base) };
  fail(/\.hap$/i.test(application.hap.path), 'Application must identify the actual HAP file.');
  const install = record.installation, observed = record.packageObservation, prepared = record.preparation;
  fields(install, ['basis', 'installedAt', 'record'], 'installation');
  fields(observed, ['basis', 'observedAt', 'bundleId', 'versionCode', 'versionName', 'record'], 'package observation');
  fields(prepared, ['basis', 'completedAt', 'procedureSha256', 'record'], 'run preparation');
  // This reader verifies references and operator declarations; it performs no device observation.
  fail([install, observed, prepared].every(value => value.basis === 'operator_attested'),
    'Only operator_attested records are supported; device_observed is not inferred or accepted.');
  version(observed, 'Package observation');
  fail(observed.bundleId === app.bundleId && observed.versionCode === app.versionCode && observed.versionName === app.versionName,
    'Observed package identity/version differs from the installed application declaration.');
  const installedAt = time(install.installedAt, 'installedAt'), observedAt = time(observed.observedAt, 'observedAt');
  const completedAt = time(prepared.completedAt, 'completedAt');
  fail(installedAt <= observedAt && observedAt <= completedAt && completedAt <= Date.now() + 30_000,
    'Installation, package observation and preparation times are not ordered or are in the future.');
  fail(digestPattern.test(prepared.procedureSha256), 'Preparation procedure hash is missing.');
  const installation = { ...install, record: ref(install.record, base) };
  const packageObservation = { ...observed, record: ref(observed.record, base) };
  const preparation = { ...prepared, record: ref(prepared.record, base) };
  const files = [application.hap, installation.record, packageObservation.record, preparation.record];
  fail(new Set([reference, ...files].map(item => key(item.path))).size === files.length + 1,
    'Preparation, HAP and the three supporting records must be distinct files.');
  for (const file of files) await verifyFile(file, checked);
  fail(await hashFile(reference.path) === reference.sha256, 'Preparation record changed while its references were read.');
  return { planId: record.planId, profileId: record.profileId, deviceId: record.deviceId,
    preparationId: record.preparationId, state: 'ready', reference, application, installation, packageObservation, preparation, files };
}

function uniqueEntries(entries) {
  const pairs = new Set(), ids = new Set(), references = new Set(), records = new Set(), haps = new Set();
  for (const entry of entries) {
    const pair = JSON.stringify([entry.profileId, entry.deviceId]);
    fail(!pairs.has(pair), 'A profile/device pair has multiple preparation records.'); pairs.add(pair);
    if (entry.state !== 'ready') continue;
    haps.add(key(entry.application.hap.path));
    fail(!ids.has(entry.preparationId), 'preparationId is reused.'); ids.add(entry.preparationId);
    fail(!references.has(key(entry.reference.path)), 'Preparation reference is reused.'); references.add(key(entry.reference.path));
    for (const item of [entry.installation.record, entry.packageObservation.record, entry.preparation.record]) {
      fail(!records.has(key(item.path)), 'Supporting installation/package/preparation records cannot be reused across identities.');
      records.add(key(item.path));
    }
  }
  fail([...references].every(value => !records.has(value)), 'A preparation document cannot also be a supporting record.');
  fail([...haps].every(value => !records.has(value) && !references.has(value)), 'HAP files cannot also serve as preparation evidence.');
}

/** Freeze explicit operator records. Missing development records remain unknown. */
export async function freezePreparations({ references = [], base, planId, profiles, devices, units,
  applicationFiles, preparationProcedure, purpose }) {
  fail(Array.isArray(references) && Array.isArray(devices) && Array.isArray(units) && Array.isArray(applicationFiles), 'Expected preparation references and planned identities.');
  fail(['development', 'formal'].includes(purpose) && id(planId) && text(preparationProcedure), 'Plan identity, purpose or procedure is invalid.');
  const usedProfiles = [...new Set(units.map(unit => unit.profile))];
  fail(usedProfiles.every(id => profiles[id]), 'Unit profile is missing.');
  const expected = usedProfiles.flatMap(profileId => devices.map(device => unknown(planId, profileId, device.deviceId)));
  const checked = new Map(), supplied = [];
  for (const source of references) {
    const entry = await load(ref(source, base), checked);
    const planned = expected.find(item => item.profileId === entry.profileId && item.deviceId === entry.deviceId);
    fail(planned && entry.planId === planId, 'Record belongs to a different plan, profile or device.');
    const profile = profiles[entry.profileId], app = entry.application;
    fail(profile.bundleId === app.bundleId && (profile.moduleName ?? null) === app.moduleName && profile.abilityName === app.abilityName,
      'Record application does not match its profile.');
    fail(profile.applicationVersion && profile.applicationVersion.versionCode === app.versionCode &&
      profile.applicationVersion.versionName === app.versionName, 'Record version does not match the planned applicationVersion.');
    fail(applicationFiles.some(item => samePath(item.path, app.hap.path) && item.sha256 === app.hap.sha256),
      'HAP must exactly match a frozen applicationFiles entry.');
    fail(entry.preparation.procedureSha256 === hash(Buffer.from(preparationProcedure, 'utf8')), 'Preparation procedure differs from the plan.');
    supplied.push(entry);
  }
  uniqueEntries(supplied);
  const entries = expected.map(item => supplied.find(value => value.profileId === item.profileId && value.deviceId === item.deviceId) ?? item);
  uniqueEntries(entries);
  fail(purpose !== 'formal' || entries.length > 0 && entries.every(entry => entry.state === 'ready'),
    'A formal plan requires installation and preparation records for every used profile/device pair.');
  return entries;
}

/** Recheck the frozen source document and every original reference, without device commands. */
export async function checkPreparations(entries) {
  fail(Array.isArray(entries), 'Frozen preparation entries are missing.');
  uniqueEntries(entries);
  const checked = new Map();
  for (const entry of entries) {
    fail(id(entry.planId) && id(entry.profileId) && deviceId(entry.deviceId), 'Frozen identity is invalid.');
    if (entry.state === 'unknown') {
      fail(canonical(entry) === canonical(unknown(entry.planId, entry.profileId, entry.deviceId)), 'Unknown preparation contains unsupported claims.');
    } else {
      fail(entry.state === 'ready' && entry.reference && path.isAbsolute(entry.reference.path), 'Frozen preparation state or reference is invalid.');
      const observed = await load(ref(entry.reference, path.dirname(entry.reference.path)), checked);
      fail(canonical(observed) === canonical(entry), 'Frozen preparation metadata differs from its original record.');
    }
  }
}

/** Reset review state without reading files or changing the original execution result. */
export function unknownPreparationReview(entry = null) {
  return { state: 'unknown', preparationId: entry?.preparationId ?? null,
    preparationSha256: entry?.reference?.sha256 ?? null, reviewedAt: null, basis: entry?.state === 'ready' ? 'operator_attested' : null,
    installationUnchanged: null, preparationUnchanged: null, reason: entry?.state === 'ready' ? 'review_missing' : 'preparation_missing' };
}

/** An explicit per-slot review is separate from manualIntervention and original execution status. */
export async function reviewPreparation({ entry, review, observedAt }) {
  const result = unknownPreparationReview(entry);
  if (review === undefined || review === null) return result;
  if (!entry || entry.state === 'unknown') {
    fail(review === undefined || review === null, 'A review cannot supply a preparation that was absent at freeze.');
    return result;
  }
  await checkPreparations([entry]);
  fields(review, ['preparationSha256', 'installationUnchanged', 'preparationUnchanged'], 'slot preparation review');
  fail(review.preparationSha256 === entry.reference.sha256 && typeof review.installationUnchanged === 'boolean' &&
    typeof review.preparationUnchanged === 'boolean', 'Review must bind the frozen preparation hash and explicit unchanged declarations.');
  const reviewedAt = time(observedAt, 'review observedAt');
  fail(reviewedAt >= time(entry.preparation.completedAt, 'completedAt') && reviewedAt <= Date.now() + 30_000, 'Review predates preparation or is in the future.');
  const confirmed = review.installationUnchanged && review.preparationUnchanged;
  return { ...result, state: confirmed ? 'confirmed' : 'changed', reviewedAt: observedAt,
    installationUnchanged: review.installationUnchanged, preparationUnchanged: review.preparationUnchanged,
    reason: confirmed ? null : 'installation_or_preparation_changed' };
}
