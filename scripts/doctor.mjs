import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { AgentClient } from '../examples/agent-client/client.mjs';

const exec = promisify(execFile);
const defaultCli = fileURLToPath(new URL('../.upstream/maestro/maestro-cli/build/install/maestro', import.meta.url));
const help = `Usage: node scripts/doctor.mjs --cli-dir <distribution> [--device <id> --app <bundle>]
  --java <executable>   Java launcher (default: JAVA_HOME or PATH)
  --hdc <executable>    HDC launcher (default: MAESTRO_HARMONYOS_HDC or PATH)
  --ability <name>      Optional explicit launch Ability
  --module <name>       Optional launch module
  --command <name>      Repeatable; defaults to launchApp, tapOn and assertVisible
  --json                Print structured results
Without --device, only the host tools and CLI are checked.
Exit status: 0 ready for the requested scope, 1 blocked, 2 unknown.
`;

async function inspect(options) {
  const checks = [];
  const add = (name, status, code, message) => checks.push({ name, required: true, status, code, message });
  const java = options.java ?? (process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  const hdc = options.hdc ?? (process.env.MAESTRO_HARMONYOS_HDC || 'hdc');
  const library = path.resolve(options['cli-dir'] ?? defaultCli, 'lib');
  const env = { ...process.env, MAESTRO_HARMONYOS_HDC: hdc, MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' };
  const run = (tool, args) => exec(tool, args, { env, timeout: 8_000, maxBuffer: 128 * 1024, windowsHide: true });

  const versions = await Promise.allSettled([run(java, ['-version']), run(hdc, ['-v']), readdir(library)]);
  const [javaProbe, hdcProbe, cliFiles] = versions;
  const javaVersion = javaProbe.status === 'fulfilled'
    ? /version\s+"(?:1\.)?(\d+)/.exec(javaProbe.value.stdout + javaProbe.value.stderr) : null;
  if (javaVersion && Number(javaVersion[1]) >= 17) add('java', 'passed', 'JAVA_READY', `Java ${javaVersion[1]}.`);
  else add('java', 'failed', 'JAVA_REQUIRED', 'Set JAVA_HOME or --java to a working Java 17+ launcher.');

  if (hdcProbe.status === 'fulfilled') add('hdc', 'passed', 'HDC_READY', (hdcProbe.value.stdout || hdcProbe.value.stderr).trim());
  else add('hdc', 'failed', 'HDC_REQUIRED', 'Set --hdc to the native HDC executable in DevEco SDK toolchains.');

  if (cliFiles.status !== 'fulfilled' || !cliFiles.value.some(file => file.endsWith('.jar'))) {
    add('cli', 'failed', 'CLI_REQUIRED', 'Set --cli-dir to the extracted HarmonyOS CLI directory containing lib/.');
  } else if (javaVersion && Number(javaVersion[1]) >= 17) {
    const client = AgentClient.spawn(java, ['--enable-native-access=ALL-UNNAMED', '-Dfile.encoding=UTF-8',
      '-classpath', path.join(library, '*'), 'maestro.cli.AppKt', '--platform', 'harmonyos', 'harmonyos-bridge'],
    { env, requestTimeoutMs: 20_000 });
    let bridgeConfirmed = false;
    try {
      const capabilities = await client.request('agent.describe');
      if (!capabilities.data.methods?.includes('agent.preflight')) throw new Error('CLI does not expose agent.preflight.');
      bridgeConfirmed = true;
      add('cli', 'passed', 'CLI_READY', 'HarmonyOS agent bridge replied.');
      if (options.device && hdcProbe.status === 'fulfilled') {
        const { data } = await client.request('agent.preflight', {
          deviceId: options.device, appId: options.app, abilityName: options.ability, moduleName: options.module,
          commands: options.command ?? ['launchApp', 'tapOn', 'assertVisible'],
        });
        if (!Array.isArray(data.checks) || !data.checks.some(check => check.required === true) ||
            data.checks.some(check => !['passed', 'failed', 'unknown'].includes(check.status) ||
              typeof check.name !== 'string' || typeof check.code !== 'string' ||
              typeof check.message !== 'string' || typeof check.required !== 'boolean')) throw new Error('Invalid preflight checks.');
        checks.push(...data.checks);
      }
    } catch (error) {
      add(bridgeConfirmed ? 'preflight' : 'cli', 'unknown', bridgeConfirmed ? 'PREFLIGHT_UNCONFIRMED' : 'CLI_UNCONFIRMED',
        `${error.message} Check the CLI version and local tool configuration.`);
    } finally { await client.close(); }
  }
  const readiness = checks.some(check => check.required && check.status === 'failed') ? 'blocked'
    : checks.some(check => check.required && check.status === 'unknown') ? 'unknown' : 'ready';
  return { schemaVersion: 1, scope: options.device ? 'device' : 'host', readiness, checks };
}

try {
  const { values } = parseArgs({ options: {
    'cli-dir': { type: 'string' }, java: { type: 'string' }, hdc: { type: 'string' }, device: { type: 'string' },
    app: { type: 'string' }, ability: { type: 'string' }, module: { type: 'string' },
    command: { type: 'string', multiple: true }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) process.stdout.write(help);
  else {
    if ((values.app || values.ability || values.module || values.command) && !values.device) {
      throw new Error('--app, --ability, --module and --command require --device.');
    }
    const result = await inspect(values);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.scope}: ${result.readiness}`);
      for (const check of result.checks) console.log(`[${check.status}] ${check.name} (${check.code}) ${check.message}`);
    }
    process.exitCode = { ready: 0, blocked: 1, unknown: 2 }[result.readiness];
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
