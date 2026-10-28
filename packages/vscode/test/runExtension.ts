import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
async function main(): Promise<void> {
  const executable = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executable) throw new Error('Set VSCODE_EXECUTABLE_PATH to your installed Code executable. This test does not download an editor.');
  const root = path.resolve(__dirname, '../..');
  const isolated = path.join(root, 'dist', 'extension-host');
  await fs.mkdir(path.join(isolated, 'workspace'), { recursive: true });
  await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'extensionHost.js'),
    launchArgs: [path.join(isolated, 'workspace'), '--user-data-dir', path.join(isolated, 'user-data'), '--extensions-dir', path.join(isolated, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--disable-updates'] });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
