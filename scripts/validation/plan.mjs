import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, canonical, digestPattern, hash, hashFile, inside, key, noLinks, readJson, requireValue, samePath, sourceFiles } from './io.mjs';
import { freezeRuntime, checkRuntime } from './runtime.mjs';
import { inspectFlows } from './static-flows.mjs';
import { hasRuntimeContract, hasStaticContract, checkStaticInspection, staticInspectionComplete } from './static-plan.mjs';
import { freezePreparations, checkPreparations, unknownPreparationReview } from './preparation.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const array = (value, label) => { requireValue(Array.isArray(value), `${label} must be an array.`); return value; };
const unique = (values, label) => requireValue(new Set(values).size === values.length, `${label} must be unique.`);

export function minimumCount(rate, count) {
  requireValue(typeof rate === 'string' && /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(rate), 'minimumRate must be a decimal string between zero and one.');
  const decimals = rate.split('.')[1]?.length ?? 0;
  const denominator = 10n ** BigInt(decimals);
  const numerator = BigInt(rate.replace('.', ''));
  return Number((BigInt(count) * numerator + denominator - 1n) / denominator);
}

async function fingerprintFiles(value, base, required) {
  const files = array(value?.files ?? [], 'fingerprint files');
  requireValue(!required || files.length > 0, 'A formal plan needs concrete build and application fingerprint files.');
  const result = [];
  for (const item of files) {
    requireValue(typeof item.path === 'string' && digestPattern.test(item.sha256), 'Fingerprint requires a path and SHA-256.');
    const file = path.resolve(base, item.path);
    requireValue(await hashFile(file) === item.sha256, 'Declared fingerprint does not match its file.');
    result.push({ path: file, sha256: item.sha256 });
  }
  unique(result.map(item => key(item.path)), 'fingerprint paths');
  return result;
}

export async function freezePlan(planPath, outputDirectory, projectRoot, environment = process.env, options = {}) {
  const input = await readJson(planPath), plan = input.value, base = path.dirname(input.path);
  requireValue([1, 2].includes(plan.schemaVersion) && identifier.test(plan.planId) && plan.status === 'frozen', 'Plan must have schemaVersion=1 or 2, a stable planId, and status=frozen.');
  requireValue(['development', 'formal'].includes(plan.purpose) && ['per-flow', 'suite'].includes(plan.measurementMode), 'Specify purpose and measurementMode.');
  requireValue(Number.isSafeInteger(plan.repeat) && plan.repeat >= 1 && plan.repeat <= 1000, 'repeat must be between 1 and 1000.');
  requireValue(Number.isSafeInteger(plan.runTimeoutSeconds) && plan.runTimeoutSeconds >= 1 && plan.runTimeoutSeconds <= 86400, 'A bounded runTimeoutSeconds is required.');
  requireValue(['firstPass', 'finalPass'].includes(plan.thresholdPolicy?.metric), 'Choose firstPass or finalPass threshold metric.');
  minimumCount(plan.thresholdPolicy.minimumRate, plan.repeat);
  requireValue(typeof plan.preparationProcedure === 'string' && plan.preparationProcedure.trim() &&
    typeof plan.retryPolicy === 'string' && plan.retryPolicy.trim(), 'Describe preparation and retry policy.');
  requireValue(plan.manualInterventionPolicy === 'review-required' && typeof plan.evidencePolicy?.requireVideo === 'boolean', 'Use review-required intervention policy and explicit requireVideo.');
  let confirmation = null;
  if (plan.purpose === 'formal') {
    requireValue(plan.schemaVersion === 2, 'New formal execution requires a v2 plan with installation and preparation evidence.');
    requireValue(plan.confirmation?.status === 'confirmed' && typeof plan.confirmation.path === 'string' &&
      digestPattern.test(plan.confirmation.sha256), 'A formal plan needs a previously confirmed scope reference.');
    confirmation = { path: path.resolve(base, plan.confirmation.path), sha256: plan.confirmation.sha256 };
    requireValue(await hashFile(confirmation.path) === confirmation.sha256, 'Confirmation reference differs.');
  }
  requireValue(plan.profiles && typeof plan.profiles === 'object' && !Array.isArray(plan.profiles), 'profiles must be an object.');
  const profiles = {};
  for (const [id, profile] of Object.entries(plan.profiles)) {
    requireValue(identifier.test(id) && typeof profile.bundleId === 'string' && profile.bundleId &&
      typeof profile.abilityName === 'string' && profile.abilityName, 'Profile requires an ID, bundleId and abilityName.');
    const names = array(profile.environmentNames ?? [], 'environmentNames');
    unique(names, 'environment names');
    requireValue(names.every(name => variable.test(name) && name.toUpperCase() !== 'APP_ID' && typeof environment[name] === 'string'), 'A profile environment variable is invalid or missing.');
    const moduleName = profile.moduleName ?? environment.MAESTRO_HARMONYOS_MODULE ?? null;
    requireValue(moduleName === null || typeof moduleName === 'string' && moduleName.trim(), 'moduleName must be a nonempty string when supplied.');
    profiles[id] = { bundleId: profile.bundleId, abilityName: profile.abilityName, moduleName,
      environmentNames: [...names].sort(), environmentHashes: Object.fromEntries(names.map(name => [name, hash(Buffer.from(environment[name]))])) };
    if (profile.applicationVersion !== undefined) {
      requireValue(/^(?:0|[1-9][0-9]*)$/.test(profile.applicationVersion?.versionCode) && typeof profile.applicationVersion.versionCode === 'string' &&
        typeof profile.applicationVersion.versionName === 'string' && profile.applicationVersion.versionName.trim(), 'applicationVersion requires a decimal-string versionCode and a nonempty versionName.');
      profiles[id].applicationVersion = { versionCode: profile.applicationVersion.versionCode, versionName: profile.applicationVersion.versionName };
    }
    requireValue(plan.purpose !== 'formal' || profiles[id].applicationVersion, 'Every formal profile requires applicationVersion.');
  }
  const devices = array(plan.devices, 'devices');
  requireValue(devices.length > 0 && devices.every(device => typeof device.deviceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(device.deviceId)), 'Provide explicit device identities.');
  unique(devices.map(device => device.deviceId), 'device identities');
  const units = [];
  for (const unit of array(plan.units, 'units')) {
    requireValue(identifier.test(unit.unitId) && profiles[unit.profile] && typeof unit.entry === 'string' && typeof unit.sourceRoot === 'string', 'Unit requires unitId, profile, entry and sourceRoot.');
    const entry = path.resolve(base, unit.entry), sourceRoot = path.resolve(base, unit.sourceRoot);
    await noLinks(entry); await noLinks(sourceRoot);
    requireValue(!samePath(sourceRoot, outputDirectory) && !inside(sourceRoot, outputDirectory), 'Output must be outside every frozen sourceRoot.');
    requireValue(samePath(sourceRoot, entry) || inside(sourceRoot, entry), 'Unit entry must be inside sourceRoot.');
    const stat = await fs.stat(entry);
    requireValue(plan.measurementMode === 'suite' ? stat.isDirectory() : stat.isFile() && /\.ya?ml$/i.test(entry), 'Unit entry type differs from measurementMode.');
    const sources = await sourceFiles(sourceRoot), sourceMap = new Map(sources.map(item => [key(item.path), item.sha256]));
    if (plan.measurementMode === 'suite') requireValue(!sources.some(file => samePath(path.dirname(file.path), entry) &&
      /^config\.ya?ml$/i.test(path.basename(file.path))), 'Validation suites with a workspace config are not supported; use explicit per-flow units or a suite without config.yaml/config.yml.');
    const requiredFlows = [];
    for (const flow of array(unit.requiredTopLevelFlows, 'requiredTopLevelFlows')) {
      const file = path.resolve(base, flow.path);
      requireValue(sourceMap.has(key(file)) && typeof flow.name === 'string' && flow.name.trim(), 'Required Flow must be a frozen source with a unique name.');
      requireValue(plan.measurementMode === 'per-flow' ? samePath(file, entry) : samePath(path.dirname(file), entry), 'Required Flow is not a top-level member of this unit.');
      const requiredSteps = [];
      for (const step of array(flow.requiredSteps ?? [], 'requiredSteps')) {
        const source = path.resolve(base, step.path);
        requireValue(sourceMap.has(key(source)) && Number.isSafeInteger(step.commandIndex) && step.commandIndex >= 0 &&
          ['action', 'assertion'].includes(step.role), 'Required step must identify a frozen source and command index.');
        requiredSteps.push({ sourcePath: source, sourceSha256: sourceMap.get(key(source)), commandIndex: step.commandIndex, role: step.role });
      }
      requireValue(requiredSteps.some(step => step.role === 'assertion'), 'Each required Flow needs a required assertion step.');
      requiredFlows.push({ path: file, sha256: sourceMap.get(key(file)), name: flow.name, requiredSteps });
    }
    requireValue(requiredFlows.length > 0 && (plan.measurementMode !== 'per-flow' || requiredFlows.length === 1), 'Required Flow list is empty or ambiguous.');
    unique(requiredFlows.map(flow => key(flow.path)), 'required Flow paths'); unique(requiredFlows.map(flow => flow.name), 'Flow names');
    if (plan.measurementMode === 'suite') {
      const actual = sources.filter(file => samePath(path.dirname(file.path), entry) && /\.ya?ml$/i.test(file.path)).map(file => key(file.path)).sort();
      requireValue(canonical(actual) === canonical(requiredFlows.map(flow => key(flow.path)).sort()), 'The suite member list must exactly match its top-level YAML files.');
    }
    units.push({ unitId: unit.unitId, profile: unit.profile, entry, sourceRoot, sources, requiredTopLevelFlows: requiredFlows });
  }
  requireValue(units.length > 0, 'Provide at least one unit.'); unique(units.map(unit => unit.unitId), 'unit IDs');
  requireValue(units.length * devices.length * plan.repeat <= 10000, 'A plan may contain at most 10000 slots.');
  const buildFiles = await fingerprintFiles(plan.buildFingerprint, base, plan.purpose === 'formal');
  const applicationFiles = await fingerprintFiles(plan.applicationFingerprint, base, plan.purpose === 'formal');
  const toolFiles = [];
  for (const name of ['scripts/run-harmonyos.ps1', 'scripts/test-device-matrix.ps1', 'scripts/test-validation-plan.ps1',
    'scripts/test-stop-control.ps1', 'scripts/stop-test-run.ps1',
    'scripts/validation/main.mjs', 'scripts/validation/plan.mjs', 'scripts/validation/io.mjs', 'scripts/validation/retry-evidence.mjs',
    'scripts/validation/runtime.mjs', 'scripts/validation/preparation.mjs', 'scripts/validation/static-flows.mjs',
    'scripts/validation/static-plan.mjs', 'scripts/ci/snapshot-build.mjs', 'scripts/ci/InspectFlows.java',
    'scripts/ci/verify-state.mjs', 'scripts/ci/device-reservation.ps1', 'examples/agent-client/client.mjs', 'examples/agent-client/evidence.mjs',
    'scripts/recovery/verify-maintenance.mjs', 'scripts/recovery/windows-boot.mjs',
    'scripts/recovery/verify-cleanup-fence.mjs', 'scripts/recovery/cleanup-fence-scripts.mjs',
    'config.local.ps1', 'upstream.lock.json', 'patches/maestro/0001-harmonyos-host.patch']) {
    const file = path.resolve(projectRoot, name);
    try { toolFiles.push({ path: file, sha256: await hashFile(file) }); } catch (error) { if (error.code !== 'ENOENT' || ['scripts/validation/static-flows.mjs', 'scripts/validation/static-plan.mjs', 'scripts/ci/snapshot-build.mjs', 'scripts/ci/InspectFlows.java', 'scripts/recovery/verify-maintenance.mjs', 'scripts/recovery/windows-boot.mjs', 'scripts/recovery/verify-cleanup-fence.mjs', 'scripts/recovery/cleanup-fence-scripts.mjs'].includes(name)) throw error; }
  }
  const runtime = await freezeRuntime(projectRoot, options, environment);
  for (const unit of units) {
    const inspectionDirectory = path.join(outputDirectory, 'static', unit.unitId);
    await fs.mkdir(inspectionDirectory, { recursive: true });
    unit.staticInspection = await inspectFlows(path.resolve(projectRoot), unit.sourceRoot, unit.requiredTopLevelFlows, unit.sources, inspectionDirectory, environment);
  }
  const preparations = await freezePreparations({ references: plan.preparations ?? [], base, planId: plan.planId,
    profiles, devices, units, applicationFiles, preparationProcedure: plan.preparationProcedure, purpose: plan.purpose });
  const frozen = { protocol: 'maestro.harmonyos.validation-plan', schemaVersion: 3, planId: plan.planId, purpose: plan.purpose,
    status: 'frozen', frozenAt: new Date().toISOString(), sourcePlan: { path: input.path, sha256: input.sha256 },
    projectRoot: path.resolve(projectRoot), measurementMode: plan.measurementMode, repeat: plan.repeat, runTimeoutSeconds: plan.runTimeoutSeconds,
    thresholdPolicy: plan.thresholdPolicy, profiles, devices, units, confirmation, buildFiles, applicationFiles, toolFiles, runtime, preparations,
    environmentFingerprint: plan.environmentFingerprint ?? null, preparationProcedure: plan.preparationProcedure,
    retryPolicy: plan.retryPolicy, evidencePolicy: plan.evidencePolicy, manualInterventionPolicy: plan.manualInterventionPolicy };
  const batches = units.flatMap(unit => devices.map(device => ({ batchId: randomUUID(), unitId: unit.unitId, deviceId: device.deviceId })));
  frozen.batches = batches;
  const slots = batches.flatMap(batch => Array.from({ length: plan.repeat }, (_, index) => ({ ...batch, slotId: batch.batchId + ':' + (index + 1),
    round: index + 1, status: 'pending', firstPassStatus: 'not_run', finalPass: false, manualIntervention: 'unknown',
    cleanup: null, evidenceComplete: false, coverageComplete: false, retryComplete: false, videoComplete: !plan.evidencePolicy.requireVideo,
    runtimeVerification: { state: 'unknown', reason: 'No executed runtime record.' },
    preparationVerification: unknownPreparationReview(preparations.find(entry => entry.deviceId === batch.deviceId &&
      entry.profileId === units.find(unit => unit.unitId === batch.unitId).profile)),
    runId: null, attemptId: null, reason: null })));
  await fs.mkdir(outputDirectory, { recursive: true });
  await checkFrozen(frozen, environment);
  const snapshotPath = path.join(outputDirectory, 'plan.json');
  await atomicJson(snapshotPath, frozen, true);
  const state = { protocol: 'maestro.harmonyos.validation-summary', schemaVersion: 3, planId: plan.planId,
    planPath: path.resolve(snapshotPath), planSha256: await hashFile(snapshotPath), status: 'running', createdAt: frozen.frozenAt,
    batches: batches.map(batch => ({ ...batch, status: 'pending', matrixExitCode: null, stopDevice: false, releaseConfirmed: false })), slots };
  await saveSummary(path.join(outputDirectory, 'validation-summary.json'), state, frozen);
  return { snapshotPath, summaryPath: path.join(outputDirectory, 'validation-summary.json'), batches };
}

export async function checkFrozen(plan, environment = process.env, { executionPreparation = true } = {}) {
  // CI reuses source checks with its own inputs v1. Validation v2/v3 retain the runtime contract.
  if (executionPreparation && plan.protocol === 'maestro.harmonyos.validation-plan' && hasRuntimeContract(plan)) {
    await checkRuntime(plan.runtime, environment);
    await checkPreparations(plan.preparations);
  }
  if (executionPreparation && plan.protocol === 'maestro.harmonyos.validation-plan') await checkStaticInspection(plan);
  for (const unit of plan.units) requireValue(canonical(await sourceFiles(unit.sourceRoot)) === canonical(unit.sources), 'Frozen Flow sources changed; create a new plan.');
  const executionFiles = executionPreparation || !hasRuntimeContract(plan) ? [...plan.buildFiles, ...plan.applicationFiles] : [];
  for (const file of [...executionFiles, ...plan.toolFiles, ...(plan.confirmation ? [plan.confirmation] : [])]) {
    requireValue(await hashFile(file.path) === file.sha256, 'Frozen implementation, application or confirmation changed.');
  }
  for (const profile of Object.values(plan.profiles)) for (const [name, digest] of Object.entries(profile.environmentHashes)) {
    requireValue(typeof environment[name] === 'string' && hash(Buffer.from(environment[name])) === digest, 'A frozen environment value changed.');
  }
}

export function aggregate(state, plan) {
  return plan.units.flatMap(unit => plan.devices.map(device => {
    const slots = state.slots.filter(slot => slot.unitId === unit.unitId && slot.deviceId === device.deviceId);
    const count = status => slots.filter(slot => slot.status === status).length;
    const first = slots.filter(slot => slot.firstPassStatus === 'passed').length;
    const final = slots.filter(slot => slot.finalPass).length;
    const minimum = minimumCount(plan.thresholdPolicy.minimumRate, slots.length);
    const unattended = slots.filter(slot => slot.manualIntervention === 'none' && slot.coverageComplete && slot.evidenceComplete &&
      slot.retryComplete && slot.videoComplete && slot.cleanup?.state === 'complete' &&
      (plan.thresholdPolicy.metric === 'firstPass' ? slot.firstPassStatus === 'passed' : slot.finalPass)).length;
    const handoffComplete = state.batches.filter(batch => batch.unitId === unit.unitId && batch.deviceId === device.deviceId)
      .every(batch => batch.releaseConfirmed === true);
    const staticComplete = staticInspectionComplete(plan, unit);
    const complete = (!hasStaticContract(plan) || staticComplete) && handoffComplete && slots.length > 0 && slots.some(slot => slot.coverageComplete) && slots.every(slot => ['passed', 'failed'].includes(slot.status) &&
      slot.cleanup?.state === 'complete' && slot.evidenceComplete && slot.retryComplete && slot.videoComplete && slot.manualIntervention !== 'unknown');
    const qualified = complete && unattended >= minimum;
    const runtimeComplete = slots.length > 0 && slots.every(slot => slot.runtimeVerification?.state === 'verified');
    const preparationComplete = slots.length > 0 && slots.every(slot => slot.preparationVerification?.state === 'confirmed');
    const formalEligible = hasRuntimeContract(plan) && (!hasStaticContract(plan) || staticComplete) && plan.purpose === 'formal' && Boolean(plan.confirmation) && runtimeComplete && preparationComplete;
    return { unitId: unit.unitId, deviceId: device.deviceId, planned: slots.length, firstPassCount: first, finalPassCount: final,
      firstPassRate: first / slots.length, finalPassRate: final / slots.length, minimumPassCount: minimum,
      thresholdMet: (plan.thresholdPolicy.metric === 'firstPass' ? first : final) >= minimum,
      unattendedPassCount: unattended, complete, qualified,
      ...(hasRuntimeContract(plan) ? { runtimeComplete, preparationComplete, formalEligible, formalQualified: formalEligible && qualified } : {}),
      ...(hasStaticContract(plan) ? { staticInspectionComplete: staticComplete } : {}),
      failed: count('failed'), cancelled: count('cancelled'), blocked: count('blocked'), unknown: count('unknown'), notRun: count('not-run') + count('pending') };
  }));
}

export async function saveSummary(file, state, plan) {
  if (hasStaticContract(plan)) {
    try { await checkStaticInspection(plan); state.staticInspectionError = null; }
    catch (error) { state.staticInspectionError = error.message; }
  }
  state.groups = aggregate(state, plan);
  if (hasStaticContract(plan)) state.staticInspectionComplete = state.groups.every(group => group.staticInspectionComplete);
  state.updatedAt = new Date().toISOString();
  state.qualified = state.groups.every(group => group.qualified);
  if (hasRuntimeContract(plan)) {
    state.formalEligible = state.groups.every(group => group.formalEligible);
    state.formalQualified = state.groups.every(group => group.formalQualified);
  }
  await atomicJson(file, state);
  const escape = value => String(value).replace(/[|\r\n]/g, ' ');
  const rows = state.groups.map(group => `| ${escape(group.unitId)} | ${escape(group.deviceId)} | ${group.planned} | ${group.firstPassCount}/${group.planned} | ${group.finalPassCount}/${group.planned} | ${group.unknown} | ${group.notRun} | ${group.qualified} |`);
  const text = ['# Validation plan results', '', `Plan: ${escape(state.planId)}. State: ${state.status}.`, '',
    `Formal qualification: ${hasRuntimeContract(plan) && state.formalQualified === true}. Legacy v1 and development plans cannot qualify for formal acceptance.`, '',
    'First pass means no actual extra retry. Planned slots remain in the denominator. Execution, evidence, cleanup and manual review are separate.', '',
    '| Unit | Device | Planned | First pass | Final pass | Unknown | Not run | Qualified |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |', ...rows, '',
    'A matrix exit code is preserved even when a numerical threshold is met. See validation-summary.json for every slot and original evidence references.', ''].join('\n');
  await fs.writeFile(file.replace(/\.json$/, '.md'), text);
}
