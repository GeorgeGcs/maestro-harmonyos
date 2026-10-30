import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { freezePreparations, checkPreparations, reviewPreparation, unknownPreparationReview } from '../validation/preparation.mjs';
import { hash, hashFile } from '../validation/io.mjs';

const testRoot = path.resolve('artifacts/validation-preparation-unit-tests');
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'case-'));
  t.after(async () => { assert.equal(path.dirname(root), testRoot); await fs.rm(root, { recursive: true, force: true }); });
  const procedure = 'Unlock and authorize the fixture; reset the app to its initial screen.';
  const file = path.join(root, 'preparation.json');
  const files = {};
  for (const [name, suffix] of [['hap', '.hap'], ['installation', '.txt'], ['package', '.txt'], ['preparation', '.txt']]) {
    const p = path.join(root, name + suffix);
    await fs.writeFile(p, `Synthetic host fixture ${name}; never installed and never device-observed.`);
    files[name] = { path: p, sha256: await hashFile(p) };
  }
  const record = { protocol: 'maestro.harmonyos.validation-preparation', schemaVersion: 1,
    preparationId: randomUUID(), planId: 'fixture-plan', profileId: 'app', deviceId: 'fixture-device',
    application: { bundleId: 'org.example.fixture', moduleName: 'entry', abilityName: 'EntryAbility',
      versionCode: '12', versionName: '1.2', hap: { ...files.hap, path: path.basename(files.hap.path) } },
    installation: { basis: 'operator_attested', installedAt: '2020-01-01T00:00:00Z', record: { ...files.installation, path: path.basename(files.installation.path) } },
    packageObservation: { basis: 'operator_attested', observedAt: '2020-01-01T00:01:00Z', bundleId: 'org.example.fixture',
      versionCode: '12', versionName: '1.2', record: { ...files.package, path: path.basename(files.package.path) } },
    preparation: { basis: 'operator_attested', completedAt: '2020-01-01T00:02:00Z', procedureSha256: hash(Buffer.from(procedure)),
      record: { ...files.preparation, path: path.basename(files.preparation.path) } } };
  const context = { references: [], base: root, planId: record.planId, purpose: 'formal', preparationProcedure: procedure,
    profiles: { app: { bundleId: record.application.bundleId, moduleName: 'entry', abilityName: 'EntryAbility',
      applicationVersion: { versionCode: '12', versionName: '1.2' } } },
    devices: [{ deviceId: record.deviceId }], units: [{ unitId: 'one', profile: 'app' }], applicationFiles: [files.hap] };
  async function save() {
    await json(file, record);
    context.references = [{ path: path.basename(file), sha256: await hashFile(file) }];
  }
  await save();
  return { root, file, files, record, context, save };
}
const review = entry => ({ preparationSha256: entry.reference.sha256, installationUnchanged: true, preparationUnchanged: true });

test('formal preparation binds the real file references but remains operator attested', async t => {
  const f = await fixture(t), before = await hashFile(f.file);
  const [entry] = await freezePreparations(f.context);
  assert.equal(entry.state, 'ready'); assert.equal(entry.preparationId, f.record.preparationId);
  assert.deepEqual(entry.reference, { path: f.file, sha256: before });
  assert.equal(entry.application.hap.path, f.files.hap.path);
  assert.equal(entry.files.length, 4); assert.ok(entry.files.every(item => path.isAbsolute(item.path)));
  assert.equal(entry.packageObservation.basis, 'operator_attested');
  await checkPreparations([entry]);
  assert.equal(await hashFile(f.file), before);
});

test('development without records stays unknown and formal freeze refuses it', async t => {
  const f = await fixture(t); f.context.references = [];
  await assert.rejects(freezePreparations(f.context), /every used profile\/device/);
  f.context.purpose = 'development';
  const [entry] = await freezePreparations(f.context);
  assert.equal(entry.state, 'unknown'); assert.equal(entry.reference, null); assert.deepEqual(entry.files, []);
  await checkPreparations([entry]);
  const checked = await reviewPreparation({ entry, review: null, observedAt: new Date().toISOString() });
  assert.equal(checked.state, 'unknown'); assert.equal(checked.reason, 'preparation_missing');
  await assert.rejects(reviewPreparation({ entry, review: { preparationSha256: 'a'.repeat(64), installationUnchanged: true, preparationUnchanged: true }, observedAt: new Date().toISOString() }), /absent at freeze/);
});

for (const [label, change] of [
  ['plan', f => { f.record.planId = 'other-plan'; }],
  ['profile', f => { f.record.profileId = 'other-profile'; }],
  ['device', f => { f.record.deviceId = 'other-device'; }],
  ['bundle', f => { f.record.application.bundleId = f.record.packageObservation.bundleId = 'org.example.other'; }],
  ['module', f => { f.record.application.moduleName = 'other'; }],
  ['ability', f => { f.record.application.abilityName = 'OtherAbility'; }],
  ['planned version', f => { f.context.profiles.app.applicationVersion.versionCode = '13'; }],
  ['observed version', f => { f.record.packageObservation.versionCode = '13'; }],
  ['numeric version instead of string', f => { f.record.application.versionCode = 12; }],
  ['leading zero version', f => { f.record.application.versionCode = f.record.packageObservation.versionCode = '012'; f.context.profiles.app.applicationVersion.versionCode = '012'; }],
  ['empty version name', f => { f.record.application.versionName = ''; }],
  ['missing application version', f => { delete f.context.profiles.app.applicationVersion; }],
  ['procedure', f => { f.record.preparation.procedureSha256 = 'a'.repeat(64); }],
  ['missing installation reference', f => { delete f.record.installation.record; }],
  ['installation observation order', f => { f.record.installation.installedAt = '2020-01-02T00:00:00Z'; }],
  ['preparation observation order', f => { f.record.preparation.completedAt = '2019-01-01T00:00:00Z'; }],
  ['future preparation', f => { f.record.preparation.completedAt = '2999-01-01T00:00:00Z'; }],
]) test(`rejects mismatched or invalid ${label}`, async t => {
  const f = await fixture(t); change(f); await f.save();
  await assert.rejects(freezePreparations(f.context));
});

for (const part of ['installation', 'packageObservation', 'preparation']) {
  test(`does not upgrade ${part} claims to device observations`, async t => {
    const f = await fixture(t); f.record[part].basis = 'device_observed'; await f.save();
    await assert.rejects(freezePreparations(f.context), /Only operator_attested/);
  });
}

test('matching HAP content at an undeclared path is not the frozen application file', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other.hap');
  await fs.copyFile(f.files.hap.path, other);
  f.record.application.hap.path = other; await f.save();
  await assert.rejects(freezePreparations(f.context), /exactly match/);
});

test('every used profile and device needs exactly one record', async t => {
  const f = await fixture(t); f.context.devices.push({ deviceId: 'second-device' });
  await assert.rejects(freezePreparations(f.context), /every used profile\/device/);
  f.context.purpose = 'development';
  const entries = await freezePreparations(f.context);
  assert.deepEqual(entries.map(item => item.state), ['ready', 'unknown']);
  f.context.references.push({ ...f.context.references[0] });
  await assert.rejects(freezePreparations(f.context), /multiple preparation/);
});

test('separate device records can share the same declared HAP but not preparation evidence', async t => {
  const f = await fixture(t), firstReference = f.context.references[0];
  const second = structuredClone(f.record);
  second.preparationId = randomUUID(); second.deviceId = 'second-device';
  const secondFile = path.join(f.root, 'second.json'); await json(secondFile, second);
  f.context.devices.push({ deviceId: second.deviceId });
  f.context.references.push({ path: secondFile, sha256: await hashFile(secondFile) });
  await assert.rejects(freezePreparations(f.context), /cannot be reused across identities/);
  for (const part of ['installation', 'packageObservation', 'preparation']) {
    const file = path.join(f.root, `second-${part}.txt`); await fs.writeFile(file, `Synthetic second device ${part}`);
    second[part].record = { path: file, sha256: await hashFile(file) };
  }
  await json(secondFile, second);
  f.context.references = [firstReference, { path: secondFile, sha256: await hashFile(secondFile) }];
  const entries = await freezePreparations(f.context);
  assert.deepEqual(entries.map(item => item.state), ['ready', 'ready']);
  await checkPreparations(entries);
});

for (const target of ['preparation-document', 'hap', 'installation', 'package', 'preparation']) {
  test(`dispatch and slot review recheck the original ${target} hash`, async t => {
    const f = await fixture(t), [entry] = await freezePreparations(f.context);
    await fs.appendFile(target === 'preparation-document' ? f.file : f.files[target].path, '\nchanged');
    await assert.rejects(checkPreparations([entry]), /hash differs/i);
    await assert.rejects(reviewPreparation({ entry, review: review(entry), observedAt: new Date().toISOString() }), /hash differs/i);
  });
}

test('missing referenced preparation record prevents dispatch and review', async t => {
  const f = await fixture(t), [entry] = await freezePreparations(f.context);
  await fs.unlink(f.files.installation.path);
  await assert.rejects(checkPreparations([entry]));
  await assert.rejects(reviewPreparation({ entry, review: review(entry), observedAt: new Date().toISOString() }));
});

test('frozen normalized fields cannot differ from the original JSON', async t => {
  const f = await fixture(t), [entry] = await freezePreparations(f.context);
  entry.application.versionName = 'silently changed';
  await assert.rejects(checkPreparations([entry]), /metadata differs/);
});

test('per-slot review needs the exact preparation and explicit unchanged declarations', async t => {
  const f = await fixture(t), [entry] = await freezePreparations(f.context), observedAt = new Date().toISOString();
  const missing = await reviewPreparation({ entry, observedAt });
  assert.equal(missing.state, 'unknown'); assert.equal(missing.reason, 'review_missing');
  const checked = await reviewPreparation({ entry, observedAt, review: review(entry) });
  assert.equal(checked.state, 'confirmed'); assert.equal(checked.basis, 'operator_attested'); assert.equal(checked.reason, null);
  assert.equal(checked.preparationSha256, entry.reference.sha256);
  for (const field of ['installationUnchanged', 'preparationUnchanged']) {
    const value = review(entry); value[field] = false;
    const changed = await reviewPreparation({ entry, observedAt, review: value });
    assert.equal(changed.state, 'changed'); assert.equal(changed.reason, 'installation_or_preparation_changed');
    delete value[field]; await assert.rejects(reviewPreparation({ entry, observedAt, review: value }));
  }
  await assert.rejects(reviewPreparation({ entry, observedAt, review: { ...review(entry), preparationSha256: 'a'.repeat(64) } }), /bind the frozen/);
  await assert.rejects(reviewPreparation({ entry, observedAt, review: { manualIntervention: 'none' } }), /missing or unsupported/);
  await assert.rejects(reviewPreparation({ entry, observedAt: '2019-01-01T00:00:00Z', review: review(entry) }), /predates/);
});

test('supporting files cannot be reused for another role in one record', async t => {
  const f = await fixture(t); f.record.preparation.record = { ...f.record.installation.record }; await f.save();
  await assert.rejects(freezePreparations(f.context), /distinct files/);
});

test('unknown reset performs no IO and changed preparation cannot rewrite a passed execution', async t => {
  const f = await fixture(t), [entry] = await freezePreparations(f.context);
  const original = path.join(f.root, 'original-result.json');
  await json(original, { status: 'passed', cleanup: { state: 'complete' } });
  const before = await hashFile(original);
  await fs.unlink(f.file);
  const reset = unknownPreparationReview(entry);
  assert.equal(reset.state, 'unknown'); assert.equal(reset.preparationSha256, entry.reference.sha256);
  assert.deepEqual(await reviewPreparation({ entry, review: null }), reset);
  assert.equal(unknownPreparationReview(null).reason, 'preparation_missing');
  await assert.rejects(reviewPreparation({ entry, review: review(entry), observedAt: new Date().toISOString() }));
  assert.equal(await hashFile(original), before);
  assert.equal(JSON.parse(await fs.readFile(original, 'utf8')).status, 'passed');
});
