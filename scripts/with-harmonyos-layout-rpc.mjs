
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { AgentClient } from '../examples/agent-client/client.mjs';

const usage = [
  'node scripts/with-harmonyos-layout-rpc.mjs --cli-dir <installDist> --device <HDC target>',
  'Add [--agent-sha256 <verified hash>] [--require-layout-rpc] -- <command> [arguments] to run a test with UITest RPC.',
].join('\n');

const separator = process.argv.indexOf('--', 2);
const { values } = parseArgs({
  args: process.argv.slice(2, separator < 0 ? undefined : separator),
  options: {
    'cli-dir': { type: 'string' }, device: { type: 'string' }, 'agent-sha256': { type: 'string' },
    'require-layout-rpc': { type: 'boolean' }, help: { type: 'boolean' },
  },
});
const command = separator < 0 ? [] : process.argv.slice(separator + 1);

try {
  if (values.help) console.log(usage);
  else process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function main() {
  const deviceId = values.device;
  if (!values['cli-dir'] || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(deviceId ?? '')) throw new Error(usage);
  const library = path.join(path.resolve(values['cli-dir']), 'lib');
  if (!(await stat(library)).isDirectory()) throw new Error('CLI installation must contain a lib directory.');
  const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
  const hdc = process.env.MAESTRO_HARMONYOS_HDC || 'hdc';
  const env = { ...process.env, MAESTRO_HARMONYOS_LAYOUT_RPC_AUTO: 'true',
    MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' };
  delete env.MAESTRO_HARMONYOS_LAYOUT_RPC_PORT;
  delete env.MAESTRO_HARMONYOS_LAYOUT_RPC_DEVICE;
  if (values['require-layout-rpc']) env.MAESTRO_HARMONYOS_LAYOUT_RPC_REQUIRED = 'true';

  async function preflight() {
    const client = AgentClient.spawn(java, ['-Dfile.encoding=UTF-8', '-classpath', path.join(library, '*'),
      'maestro.cli.AppKt', '--platform', 'harmonyos', 'harmonyos-bridge'], { env, requestTimeoutMs: 15_000 });
    try {
      return (await client.request('agent.preflight', { deviceId, commands: ['tapOn'] })).data;
    } finally {
      await client.close();
    }
  }

  function hdcOutput(args) {
    const result = spawnSync(hdc, args, { encoding: 'utf8', windowsHide: true, timeout: 7_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`HDC ${args[0] === '-t' ? args[2] : args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
    }
    return result.stdout;
  }
  const shell = (...args) => hdcOutput(['-t', deviceId, 'shell', ...args]);
  const forwards = () => hdcOutput(['fport', 'ls']).split(/\r?\n/).map(line => line.trim())
    .filter(line => line.split(/\s+/, 1)[0] === deviceId).sort().join('\n');
  const daemonRows = () => {
    const rows = shell('ps', '-A', '-o', 'PID,ARGS').trim().split(/\r?\n/);
    if (!/^PID\s+ARGS\s*$/.test(rows[0])) throw new Error('UITest process inventory could not be verified.');
    return rows.slice(1).map(line => line.trim().match(/^(\d+)\s+(?:\/system\/bin\/)?uitest\s+start-daemon(?:\s+(.*))?$/))
      .filter(Boolean).map(match => ({ pid: match[1], args: match[2] }));
  };
  const identityOf = pid => {
    const fields = shell('cat', `/proc/${pid}/stat`).trim().match(/^\d+ \(.*\) (.*)$/)?.[1].split(/\s+/);
    const started = fields?.[19];
    if (!/^\d+$/.test(started ?? '')) throw new Error('UITest process start time could not be verified.');
    return started;
  };
  const hasListener = () => {
    const lines = shell('cat', '/proc/net/unix').trim().split(/\r?\n/);
    if (!/^Num\s+RefCount\s+/.test(lines[0])) throw new Error('UITest socket inventory could not be verified.');
    return lines.slice(1).some(line => {
      const fields = line.trim().split(/\s+/);
      return fields.length === 8 && (parseInt(fields[3], 16) & 0x10000) !== 0
        && parseInt(fields[4], 16) === 1 && fields[7] === '@uitest_socket';
    });
  };

  const lock = data => data.checks.find(check => check.name === 'deviceLock')?.code;
  const runCommand = () => new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', exit => resolve(exit ?? 1));
  });

  if (command.length === 0 && separator < 0) {
    const status = await preflight();
    const listener = status.checks.find(check => check.name === 'layoutRpcListener');
    if (!listener) throw new Error('The CLI does not expose the layout RPC listener check.');
    console.log(JSON.stringify({ deviceId, listener, lock: status.checks.find(check => check.name === 'deviceLock') }, null, 2));
    return 0;
  }
  const sha = values['agent-sha256']?.toLowerCase();
  if (!command.length || (sha !== undefined && !/^[a-f0-9]{64}$/.test(sha))) throw new Error(usage);
  const lockKey = createHash('sha256').update(deviceId).digest('hex');
  const preparationPath = path.join(tmpdir(), `maestro-harmonyos-rpc-${lockKey}.lock`);
  const preparation = await open(preparationPath, 'wx', 0o600).catch(error => {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another RPC preparation is recorded for this device at ${preparationPath}.`);
  });
  try {
    const current = await preflight();
    const state = current.checks.find(check => check.name === 'layoutRpcListener')?.code;
    if (lock(current) !== 'DEVICE_LOCK_AVAILABLE') throw new Error('The device is unavailable for an RPC test.');
    if (state === 'UITEST_RPC_LISTENER_PRESENT') return await runCommand();
    if (state !== 'UITEST_RPC_LISTENER_MISSING') throw new Error('The UITest listener state could not be verified.');
    if (!sha) throw new Error('No UITest listener. Provide --agent-sha256 for the installed, verified test agent.');
    return await withPreparedAgent();
  } finally {
    await preparation.close();
    await unlink(preparationPath);
  }

  async function withPreparedAgent() {
    if (daemonRows().length || hasListener()) {
      throw new Error('Starting a test agent requires an available device with no existing UITest daemon or listener.');
    }
    if (shell('sha256sum', '/data/local/tmp/agent.so').trim().split(/\s+/, 1)[0] !== sha) {
      throw new Error('The installed UITest agent hash differs from the expected official agent hash.');
    }
    const originalForwards = forwards();
    let owned;
    let code = 1;
    let interrupted = false;
    const interrupt = () => { interrupted = true; };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      shell('/system/bin/uitest', 'start-daemon', 'singleness');
      for (let attempt = 0; attempt < 16; attempt++) {
        const rows = daemonRows();
        if (rows.length > 1) throw new Error('UITest daemon ownership is ambiguous.');
        if (rows.length === 1 && rows[0].args === 'singleness' && !owned) {
          owned = { ...rows[0], started: identityOf(rows[0].pid) };
        }
        if (owned && rows[0]?.pid === owned.pid && hasListener()) break;
        await pause(300);
      }
      if (!owned || !hasListener()) throw new Error('The test agent did not open an owned UITest listener.');
      if (!interrupted) code = await runCommand();
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      const stillOwned = () => owned && daemonRows().some(row => row.pid === owned.pid && row.args === owned.args)
        && identityOf(owned.pid) === owned.started;
      if (stillOwned()) {
        if (lock(await preflight()) !== 'DEVICE_LOCK_AVAILABLE') {
          throw new Error('The test session has no release confirmation. The UITest test daemon was preserved for recovery.');
        }
        shell('kill', '-TERM', owned.pid);
        await pause(500);
        if (stillOwned()) shell('kill', '-KILL', owned.pid);
        for (let attempt = 0; attempt < 12 && (stillOwned() || hasListener()); attempt++) await pause(250);
      }
      if (daemonRows().length || hasListener() || forwards() !== originalForwards) {
        throw new Error('The UITest daemon or HDC forward inventory did not return to its initial state.');
      }
      console.error('UITest test daemon and HDC forward cleanup confirmed.');
    }
    return interrupted ? 130 : code;
  }
}
