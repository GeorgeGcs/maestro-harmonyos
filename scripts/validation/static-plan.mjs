import path from 'node:path';
import { canonical, digestPattern, hashFile, key, requireValue, samePath } from './io.mjs';
import { readMetadata } from '../ci/snapshot-build.mjs';

// An in-memory assessment is never taken from a caller's claimed status field.
const assessments = new WeakMap();
export const hasRuntimeContract = plan => [2, 3].includes(plan.schemaVersion);
export const hasStaticContract = plan => plan.schemaVersion === 3;
export const staticInspectionComplete = (plan, unit) => assessments.get(plan)?.has(unit.unitId) === true;

export async function checkStaticInspection(plan) {
  const verified = new Set(); assessments.set(plan, verified);
  if (!hasStaticContract(plan)) return;
  for (const unit of plan.units) {
    const inspection = unit.staticInspection;
    const helper = plan.toolFiles.find(file => samePath(file.path, path.join(plan.projectRoot, 'scripts/ci/InspectFlows.java')));
    requireValue(inspection && inspection.scriptsExecuted === false && helper &&
      samePath(inspection.javaPath, plan.runtime.java.path) &&
      samePath(inspection.libraryDirectory, path.join(plan.runtime.cliHome, 'lib')), 'Static inspection does not identify the frozen runtime and helper.');
    const identities = values => values.map(file => ({ path: key(file.path), sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    requireValue(Array.isArray(inspection.classpath) && canonical(inspection.classpath.map(key).sort()) ===
      canonical(plan.runtime.classpath.map(file => key(file.path)).sort()), 'Static inspection classpath differs from the frozen runtime.');
    const expectedImplementation = [plan.runtime.java, helper, ...plan.runtime.classpath];
    requireValue(Array.isArray(inspection.implementationFiles) &&
      canonical(identities(inspection.implementationFiles)) === canonical(identities(expectedImplementation)), 'Static inspection implementation fingerprints differ.');
    const names = ['static-request.json', 'static-flows.json', 'static-parser.stdout.log', 'static-parser.stderr.log'];
    const references = inspection.evidenceFiles;
    requireValue(Array.isArray(references) && references.length === names.length && references.every(reference =>
      typeof reference.path === 'string' && path.isAbsolute(reference.path) && typeof reference.sha256 === 'string' && digestPattern.test(reference.sha256)), 'Static inspection evidence references are invalid.');
    const directory = path.dirname(references[0].path);
    requireValue(names.every(name => references.filter(reference => samePath(reference.path, path.join(directory, name))).length === 1), 'Static inspection evidence set is incomplete or duplicated.');
    for (const reference of references) requireValue(await hashFile(reference.path) === reference.sha256, 'Static inspection evidence changed.');
    const request = (await readMetadata(path.join(directory, names[0]))).value;
    const response = (await readMetadata(path.join(directory, names[1]))).value;
    const flows = unit.requiredTopLevelFlows.map(({ path, name }) => ({ path, name }));
    requireValue(request.schemaVersion === 1 && samePath(request.sourceRoot, unit.sourceRoot) &&
      canonical(request.flows) === canonical(flows) && canonical(request.sources) === canonical(unit.sources), 'Static request differs from frozen Flow inputs.');
    requireValue(response.protocol === 'maestro.harmonyos.ci-static-flows' && response.schemaVersion === 1 &&
      canonical(response.flows) === canonical(flows) && Array.isArray(response.dependencies) && response.dependencies.length > 0 &&
      canonical(response.dependencies) === canonical(inspection.dependencies), 'Static parser response differs from the frozen inspection.');
    const sourceMap = new Map(unit.sources.map(file => [key(file.path), file.sha256]));
    const seen = new Set();
    for (const dependency of response.dependencies) {
      requireValue(typeof dependency.path === 'string' && path.isAbsolute(dependency.path) &&
        typeof dependency.sha256 === 'string' && digestPattern.test(dependency.sha256) &&
        sourceMap.get(key(dependency.path)) === dependency.sha256 && !seen.has(key(dependency.path)) &&
        (dependency.kind === 'yaml' ? /\.ya?ml$/i.test(dependency.path) : dependency.kind === 'script' && /\.js$/i.test(dependency.path)), 'Static dependency is not a unique frozen YAML/JS source.');
      seen.add(key(dependency.path));
    }
    requireValue(flows.every(flow => seen.has(key(flow.path))), 'Static inspection omitted a top-level Flow.');
    for (const reference of references) requireValue(await hashFile(reference.path) === reference.sha256, 'Static inspection evidence changed during verification.');
    verified.add(unit.unitId);
  }
}
