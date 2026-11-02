import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AgentClient, validateDocument } from './client.mjs';
import { verifyEvidence } from './evidence.mjs';
import { runWorkflow, saveJson } from './workflow.mjs';
import { flowEnvironment, prepareHandoff, verifyHandoff } from './handoff.mjs';

const help = `Usage:
  node examples/agent-client/run.mjs --device <hdc-target> --app <bundle-id>
    --ability <ability> --artifacts <stable-local-directory> --assert-text <visible-text>

Options:
  --module <name>          Optional application module.
  --launch                 Explicitly launch the selected application first.
  --allow-unknown          Permit unknown preflight checks after reviewing them; failed checks still block.
  --cancel-after-ms <n>     Cancel the assertion n milliseconds after it starts; does not retry it.
  --handoff-flow <file>     Run this YAML only after confirmed release/recovery. Ctrl+C never starts it.
  --flow-root <dir>         Root containing the Flow and all static YAML/JS dependencies (default: Flow parent).
  --handoff-asset <file>    Repeatable extra data file, relative to --flow-root; copied for script file access.
  --env, -e NAME=value      Repeatable YAML parameters. APP_ID defaults to --app and must match it.
  --check-only             Check and snapshot the handoff Flow without starting a bridge or using a device.
  --no-recover              Leave unknown cleanup for manual inspection.
  --recovery-root <dir>     Explicit trusted root for recovery audit files (default: ~/.maestro/harmonyos-sessions).
  --cli-dir <dir>           Built Maestro installDist directory.
  --java <executable>       Native Java launcher (default: JAVA_HOME/bin/java or java).
  --timeout-ms <n>          Caller operation budget, default 90000.
  --help                   Show this help.

Protocol v2 is required. Device identifiers, input text, logs and evidence remain in --artifacts.
The default workflow asserts the current screen and takes a screenshot; it does not tap or submit forms.
`;

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    device: { type: 'string' }, app: { type: 'string' }, ability: { type: 'string' }, module: { type: 'string' },
    artifacts: { type: 'string' }, 'assert-text': { type: 'string' }, launch: { type: 'boolean' },
    'allow-unknown': { type: 'boolean' }, 'cancel-after-ms': { type: 'string' }, 'handoff-flow': { type: 'string' },
    'flow-root': { type: 'string' }, 'handoff-asset': { type: 'string', multiple: true },
    env: { type: 'string', short: 'e', multiple: true }, 'check-only': { type: 'boolean' },
    'no-recover': { type: 'boolean' }, 'recovery-root': { type: 'string' }, 'cli-dir': { type: 'string' },
    java: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  for (const required of values['check-only'] ? ['app', 'artifacts', 'handoff-flow'] : ['device', 'app', 'ability', 'artifacts', 'assert-text']) {
    if (!values[required]?.trim()) throw new Error(`Missing --${required}. Use --help for the complete example.`);
  }
  const integer = (name, fallback) => {
    if (values[name] === undefined) return fallback;
    if (!/^\d+$/.test(values[name]) || !Number.isSafeInteger(Number(values[name]))) throw new Error(`--${name} must be a nonnegative integer.`);
    return Number(values[name]);
  };
  const timeoutMs = integer('timeout-ms', 90_000);
  if (timeoutMs < 100 || timeoutMs > 3_600_000) throw new Error('--timeout-ms must be between 100 and 3600000.');
  const cancelAfterMs = integer('cancel-after-ms', undefined);
  if (!values['handoff-flow'] && (values.env?.length || values['flow-root'] || values['handoff-asset']?.length)) throw new Error('--env, --flow-root and --handoff-asset require --handoff-flow.');
  const flowEnv = flowEnvironment(values.app, values.env);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const cliDirectory = path.resolve(values['cli-dir'] ?? path.join(repo, '.upstream/maestro/maestro-cli/build/install/maestro'));
  const library = path.join(cliDirectory, 'lib');
  if (!(await fsp.readdir(library)).some(file => file.endsWith('.jar'))) throw new Error('Build :maestro-cli:installDist before running the example.');
  const java = values.java ?? (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  if (/\.(?:cmd|bat)$/i.test(java)) throw new Error('--java must identify the native launcher, not a shell script.');
  const env = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_HARMONYOS_ABILITY: values.ability, MAESTRO_HARMONYOS_RECORDING: 'off' };
  if (values.module) env.MAESTRO_HARMONYOS_MODULE = values.module;
  const args = ['--enable-native-access=ALL-UNNAMED', '-Dfile.encoding=UTF-8', '-classpath', path.join(library, '*'), 'maestro.cli.AppKt', '--platform', 'harmonyos'];
  const artifactsRoot = path.resolve(values.artifacts);
  const invocationId = randomUUID();
  const directory = path.join(artifactsRoot, 'client', invocationId);
  await fsp.mkdir(directory, { recursive: true });
  const handoffPlan = values['handoff-flow'] ? await prepareHandoff({ flow: values['handoff-flow'], sourceRoot: values['flow-root'],
    assets: values['handoff-asset'],
    java, cliDirectory, environment: flowEnv, processEnvironment: env, directory: path.join(directory, 'handoff-input'),
    timeoutMs: Math.min(timeoutMs, 60000) }) : undefined;
  if (values['check-only']) {
    process.stdout.write(`Handoff inputs checked; no bridge or device commands started.\nPlan: ${path.join(directory, 'handoff-input/plan.json')}\n`);
    return;
  }
  const diagnostics = fs.createWriteStream(path.join(directory, 'bridge.stderr.log'), { flags: 'wx' });
  await new Promise((resolve, reject) => { diagnostics.once('open', resolve); diagnostics.once('error', reject); });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const client = AgentClient.spawn(java, [...args, 'harmonyos-bridge'], { env, diagnostics, requestTimeoutMs: Math.min(timeoutMs, 30_000) });
  const handoff = handoffPlan ? async ({ deviceId, signal }) => {
    await verifyHandoff(handoffPlan);
    const flow = handoffPlan.flow;
    const source = await fsp.readFile(flow);
    const root = path.join(artifactsRoot, 'cli');
    const runId = randomUUID(), attemptId = randomUUID();
    await saveJson(path.join(directory, 'handoff.request.json'), { runId, attemptId, attemptNo: 1, deviceId, flow,
      sha256: createHash('sha256').update(source).digest('hex'), env: handoffPlan.env,
      inputPlan: path.join(directory, 'handoff-input/plan.json') });
    if (signal?.aborted) return { exitCode: null, reason: 'Caller stopped before CLI startup.' };
    const child = spawn(java, [...args, '--device', deviceId, 'test', '--harmonyos-agent-output', root,
      '--harmonyos-run-id', runId, '--harmonyos-attempt-id', attemptId, '--harmonyos-attempt-no', '1', ...handoffPlan.envArgs, flow],
    { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(directory, 'handoff.log'), { flags: 'wx' });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    let terminated = false;
    const terminate = () => { terminated = true; child.kill(); };
    signal?.addEventListener('abort', terminate);
    const timer = setTimeout(terminate, timeoutMs);
    let exitCode;
    try { exitCode = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', terminate); log.end(); await finished(log); }
    const result = { exitCode, terminated, runId, attemptId, result: null, verification: null, confirmed: false };
    try {
      const base = path.join(root, 'runs', runId, attemptId);
      result.result = validateDocument(JSON.parse(await fsp.readFile(path.join(base, 'result.json'), 'utf8')), 'runResult');
      const evidence = JSON.parse(await fsp.readFile(path.join(base, 'evidence-index.json'), 'utf8'));
      result.verification = await verifyEvidence(result.result, evidence, root);
      result.confirmed = !terminated && exitCode === 0 && result.result.data.cleanup.state === 'complete' && result.result.data.status === 'passed';
    } catch (error) { result.reason = error.message; }
    await saveJson(path.join(directory, 'handoff.result.json'), result);
    return result;
  } : undefined;
  try {
    const summary = await runWorkflow({ client, deviceId: values.device, appId: values.app, abilityName: values.ability,
      moduleName: values.module, artifactsRoot, assertText: values['assert-text'], launch: values.launch,
      allowUnknown: values['allow-unknown'], cancelAfterMs, signal: abort.signal, recover: !values['no-recover'],
      recoveryRoot: values['recovery-root'], invocationId, timeoutMs, onHandoff: handoff,
      onEvent: value => process.stdout.write(JSON.stringify(value) + '\n') });
    process.stdout.write(`Result: ${summary.status}\nSummary: ${path.join(directory, 'summary.json')}\n`);
    process.exitCode = summary.status === 'passed' || (summary.status === 'cancelled' && cancelAfterMs !== undefined && summary.session?.data.handoffReady) ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await client.close(); diagnostics.end(); await finished(diagnostics);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
