import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashFile, inside, requireValue } from './validation/io.mjs';
import { newDirectory, sha256, verifyDirectory, zip } from './agent-bundle.mjs';

export function selfTestPlan(directory, java, artifacts) {
  const cli = path.join(directory, 'cli'), source = path.join(directory, 'source');
  const args = ['--enable-native-access=ALL-UNNAMED', '-Dfile.encoding=UTF-8', '-Duser.home=' + path.join(artifacts, 'home'), '-classpath', path.join(cli, 'lib/*'), 'maestro.cli.AppKt'];
  return [
    { name: 'version', executable: java, args: [...args, '--version'] },
    { name: 'describe', executable: java, args: [...args, '--platform', 'harmonyos', 'harmonyos-bridge'],
      stdin: JSON.stringify({ id: 1, method: 'agent.describe', params: { schemaVersion: 2 } }) + '\n' },
    { name: 'check-only', executable: process.execPath, args: [path.join(source, 'examples/agent-client/run.mjs'), '--check-only', '--app', 'org.example.bundle',
      '--cli-dir', cli, '--java', java, '--handoff-flow', path.join(source, 'examples/flows/smoke.yaml'), '--flow-root', path.join(source, 'examples/flows'),
      '--env', 'START_TEXT=Ready', '--env', 'BUTTON_ID=example.button', '--env', 'RESULT_TEXT=Done', '--artifacts', path.join(artifacts, 'handoff')] },
  ];
}
async function runCommand(command, env, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd: directory, env, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
    const output = [], errors = []; let bytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    const collect = target => chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { timedOut = true; child.kill(); } else target.push(chunk); };
    child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') }); });
    child.stdin.end(command.stdin ?? '');
  });
}
export async function selfTest(directory, java, artifacts) {
  requireValue(typeof java === 'string' && java.trim() && !/\.(?:cmd|bat)$/i.test(java), 'Self-test requires a native --java executable.');
  requireValue(!inside(directory, artifacts) && path.resolve(directory) !== path.resolve(artifacts) && !inside(artifacts, directory), 'Self-test artifacts must be separate from the bundle.');
  await newDirectory(artifacts);
  const env = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_HARMONYOS_HDC: path.join(artifacts, 'never-hdc.exe'), MAESTRO_HARMONYOS_RECORDING: 'off' };
  for (const name of ['JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS','MAESTRO_HARMONYOS_DEVICE']) delete env[name];
  const outcomes = [];
  for (const command of selfTestPlan(directory, java, artifacts)) {
    const result = await runCommand(command, env, artifacts);
    await fs.writeFile(path.join(artifacts, command.name + '.stdout.log'), result.stdout, { flag: 'wx' });
    await fs.writeFile(path.join(artifacts, command.name + '.stderr.log'), result.stderr, { flag: 'wx' });
    requireValue(result.code === 0 && !result.timedOut, command.name + ' self-test failed; inspect its saved logs.');
    if (command.name === 'version') requireValue(result.stdout.trim().length > 0, 'CLI version is empty.');
    if (command.name === 'describe') {
      const lines = result.stdout.trim().split(/\r?\n/);
      requireValue(lines.length === 1, 'Bridge must return exactly one JSONL response.');
      const response = JSON.parse(lines[0]);
      requireValue(response.id === 1 && !response.error && response.result?.protocol === 'maestro.harmonyos.agent' && response.result.schemaVersion === 2 &&
        response.result.kind === 'capabilities', 'Bridge describe returned an invalid v2 capability response.');
    }
    if (command.name === 'check-only') requireValue(result.stdout.includes('no bridge or device commands started'), 'Client did not confirm check-only completion.');
    outcomes.push({ name: command.name, status: 'passed' });
  }
  return outcomes;
}
export async function verifyBundle({ archive, extractTo, directory, expectedSha256, pwsh = 'pwsh', selfTest: shouldTest = false, java, artifacts }) {
  requireValue(Boolean(directory) !== Boolean(archive), 'Choose --archive with new --extract-to, or --directory.');
  if (expectedSha256 !== undefined) requireValue(archive && sha256.test(expectedSha256), '--expected-sha256 requires an archive and a SHA-256 digest.');
  if (archive) {
    requireValue(extractTo, '--archive requires a new --extract-to directory.');
    if (expectedSha256) requireValue(await hashFile(archive) === expectedSha256, 'Archive differs from expected SHA-256.');
    await zip('Extract', archive, extractTo, pwsh); directory = extractTo;
  } else requireValue(!extractTo, '--extract-to requires --archive.');
  directory = path.resolve(directory);
  const before = await verifyDirectory(directory);
  let tests;
  if (shouldTest) {
    requireValue(artifacts, '--self-test requires a new --artifacts directory.');
    tests = await selfTest(directory, java, path.resolve(artifacts));
    requireValue((await verifyDirectory(directory)).manifestSha256 === before.manifestSha256, 'Bundle changed during self-test.');
  } else requireValue(!java && !artifacts, '--java/--artifacts require --self-test; tests are never silently skipped.');
  return { protocol: 'maestro.harmonyos.agent-bundle-verification', schemaVersion: 1, status: 'passed', sourceCommit: before.manifest.sourceCommit,
    manifestSha256: before.manifestSha256, archiveTrust: expectedSha256 ? 'caller-supplied-sha256' : 'not-independently-pinned', files: before.files,
    selfTest: tests ?? 'not-requested', deviceCommands: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { ...Object.fromEntries(['archive','extract-to','directory','expected-sha256','pwsh','java','artifacts'].map(name => [name, { type: 'string' }])), 'self-test': { type: 'boolean' } } });
    console.log(JSON.stringify(await verifyBundle({ archive: values.archive, extractTo: values['extract-to'], directory: values.directory, expectedSha256: values['expected-sha256'], pwsh: values.pwsh,
      selfTest: values['self-test'], java: values.java, artifacts: values.artifacts })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
