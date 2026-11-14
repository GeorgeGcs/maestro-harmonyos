import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Connection } from './protocol';
import { Launch } from './bridge';
import { ReplayFailure } from './replay-evidence';

export interface ToolSettings { cliDirectory: string; javaPath: string; hdcPath: string }
export async function javaLaunch(root: string, settings: ToolSettings, args: string[], connection?: Connection): Promise<Launch> {
  const distribution = settings.cliDirectory ? path.resolve(root, settings.cliDirectory) : path.join(root, '.upstream', 'maestro', 'maestro-cli', 'build', 'install', 'maestro');
  const libraries = await fs.readdir(path.join(distribution, 'lib')).catch(() => { throw new Error('找不到 Maestro CLI 的 lib 目录。请先构建 installDist，或设置 harmonyosRecorder.cliDirectory。'); });
  if (!libraries.some(name => name.endsWith('.jar'))) throw new Error('CLI 目录没有 JAR，请先完成 installDist 构建。');
  const java = settings.javaPath || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
  if (/\.(cmd|bat)$/i.test(java) || java.includes('\0')) throw new Error('javaPath 必须是原生 Java 可执行文件。');
  const env: NodeJS.ProcessEnv = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' };
  delete env.MAESTRO_HARMONYOS_INTERACTIVE;
  if (settings.hdcPath) env.MAESTRO_HARMONYOS_HDC = settings.hdcPath;
  if (connection) {
    env.MAESTRO_HARMONYOS_ABILITY = connection.abilityName;
    if (connection.moduleName) env.MAESTRO_HARMONYOS_MODULE = connection.moduleName;
    else delete env.MAESTRO_HARMONYOS_MODULE;
  }
  return { executable: java, cwd: root, env, args: ['--enable-native-access=ALL-UNNAMED', '-Dfile.encoding=UTF-8', '-classpath', path.join(distribution, 'lib', '*'), 'maestro.cli.AppKt', '--platform', 'harmonyos', ...args] };
}

export async function createRunDirectory(root: string, kind: string): Promise<string> {
  const directory = path.join(root, 'artifacts', 'recorder', `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

export async function checkFlowSyntax(root: string, settings: ToolSettings, file: string):
  Promise<{ valid: boolean; output: string }> {
  const launch = await javaLaunch(root, settings, ['check-syntax', '--', file]);
  return new Promise((resolve, reject) => {
    execFile(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, windowsHide: true,
      timeout: 30000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) { reject(error); return; }
      resolve({ valid: !error, output: [stdout, stderr].map(value => value.trim()).filter(Boolean).join('\n') });
    });
  });
}

export interface ReplayInput { yaml?: string; flowPath?: string; env?: readonly string[] }
export interface ReplayAttempt { artifactsDir: string; attemptDir: string; agent: string; attemptId: string }

export async function replayFlow(root: string, settings: ToolSettings, connection: Connection, yaml: string,
  log: (text: string) => void, onProcess: (process: ChildProcess | null) => void, signal?: AbortSignal): Promise<ReplayFailure & { exitCode: number }> {
  return runFlow(root, settings, connection, { yaml }, log, onProcess, signal);
}

export async function runFlow(root: string, settings: ToolSettings, connection: Connection, input: ReplayInput,
  log: (text: string) => void, onProcess: (process: ChildProcess | null) => void, signal?: AbortSignal,
  onAttempt?: (attempt: ReplayAttempt) => Promise<void>): Promise<ReplayFailure & { exitCode: number }> {
  const check = () => { if (signal?.aborted) throw new Error('任务已停止，未启动新的回放。'); };
  check();
  const artifactsDir = await createRunDirectory(root, 'replay');
  check();
  const flow = input.flowPath ?? path.join(artifactsDir, 'recorded-flow.yaml');
  if (!input.flowPath) await fs.writeFile(flow, input.yaml ?? '', 'utf8');
  check();
  const agent = path.join(artifactsDir, 'agent');
  const runId = randomUUID(), attemptId = randomUUID();
  const attemptDir = path.join(agent, 'runs', runId, attemptId);
  const launch = await javaLaunch(root, settings, ['--device', connection.deviceId, 'test',
    '--test-output-dir', artifactsDir, '--harmonyos-agent-output', agent,
    '--harmonyos-run-id', runId, '--harmonyos-attempt-id', attemptId,
    ...(input.env ?? []).flatMap(entry => ['-e', entry]), '--', flow], connection);
  if (onAttempt) {
    launch.env.MAESTRO_HARMONYOS_INTERACTIVE = '1';
    await fs.mkdir(agent);
    await onAttempt({ artifactsDir, attemptDir, agent, attemptId });
  }
  check();
  log(`回放产物：${artifactsDir}\n`);
  const output = createWriteStream(path.join(artifactsDir, 'cli.log'), { flags: 'wx' });
  const child = spawn(launch.executable, launch.args, { cwd: root, env: launch.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const abort = () => { void stopOwnProcess(child); };
  signal?.addEventListener('abort', abort, { once: true });
  onProcess(child);
  if (signal?.aborted) abort();
  return new Promise<ReplayFailure & { exitCode: number }>((resolve, reject) => {
    let error: Error | undefined;
    output.on('error', failure => { error = failure; child.kill(); });
    child.on('error', failure => { error = failure; });
    for (const source of [child.stdout, child.stderr]) source.on('data', (bytes: Buffer) => { output.write(bytes); log(bytes.toString('utf8')); });
    child.once('close', (code, signal) => {
      onProcess(null);
      output.end(() => error ? reject(error) : resolve({ exitCode: code ?? (signal ? 130 : 1), artifactsDir, attemptDir }));
    });
  }).finally(() => signal?.removeEventListener('abort', abort));
}

export async function stopOwnProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return; }
  await new Promise<void>(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 3000);
    killer.once('error', () => { clearTimeout(timeout); child.kill(); resolve(); });
    killer.once('close', code => { clearTimeout(timeout); if (code !== 0) child.kill(); resolve(); });
  });
}
