import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const output = new URL('./dist/evidence-report/', import.meta.url);

// Keep the layout used by the CLI entry point and package the same verifier.
for (const relative of ['scripts/export-run-evidence.mjs', 'scripts/agent-bundle-zip.ps1',
  'examples/agent-client/client.mjs', 'examples/agent-client/evidence.mjs']) {
  const target = new URL(relative, output);
  await mkdir(new URL('./', target), { recursive: true });
  await copyFile(new URL(relative, root), target);
}
