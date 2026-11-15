import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, hashFile, requireValue } from '../validation/io.mjs';

const [hapPath, expectedHash, outputPath, ...extra] = process.argv.slice(2);
requireValue(hapPath && expectedHash && outputPath && extra.length === 0,
  'Usage: node scripts/ci/prepare-component-smoke.mjs <app.hap> <expected SHA-256> <new suite-template.json>');
requireValue(/\.hap$/i.test(hapPath) && /^[0-9a-f]{64}$/i.test(expectedHash),
  'Supply a HAP path and its independently recorded SHA-256.');

const hap = path.resolve(hapPath);
const sha256 = expectedHash.toLowerCase();
requireValue(await hashFile(hap) === sha256, 'HAP SHA-256 differs from the fixed input.');

const sourceRoot = fileURLToPath(new URL('../../examples/component-collection', import.meta.url));
const flowPath = path.join(sourceRoot, 'ci-smoke.yaml');
const suiteName = 'component-collection-ci-smoke';
await atomicJson(path.resolve(outputPath), {
  schemaVersion: 2,
  suiteId: suiteName,
  flowPath,
  sourceRoot,
  expectedFlows: [{ path: flowPath, name: suiteName }],
  bundleId: 'ohos.samples.componentcollection',
  abilityName: 'MainAbility',
  moduleName: 'entry',
  applicationFile: { path: hap, sha256 },
}, true);
