import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { object, Transport } from './protocol';
import { stopOwnProcess } from './launcher';

export interface Launch { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BridgeError'; }
}
interface Pending { id: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** One request at a time. Timeouts stop the process; side effects are never retried. */
export class BridgeClient implements Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder('utf8');
  private readonly diagnosticDecoder = new StringDecoder('utf8');
  private buffer = '';
  private nextId = 1;
  private pending: Pending | undefined;
  private failed: Error | undefined;
  private closed = false;
  private readonly exited: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly terminalListeners = new Set<(error: Error) => void>();

  constructor(launch: Launch, private readonly log: (message: string) => void, private readonly timeoutMs = 90000) {
    this.child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true, stdio: 'pipe' });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (data: Buffer) => this.accept(this.decoder.write(data)));
    this.child.stderr.on('data', (data: Buffer) => this.log(this.diagnosticDecoder.write(data)));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('close', code => this.fail(new Error(`本地会话已退出（${code ?? '终止'}）。请重新连接设备。`)));
  }

  request(method: string, params: object = {}): Promise<unknown> {
    const run = this.queue.then(() => this.send(method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  onTerminated(listener: (error: Error) => void): () => void {
    this.terminalListeners.add(listener);
    if (this.failed) listener(this.failed);
    return () => this.terminalListeners.delete(listener);
  }

  private send(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('本地会话已关闭。'));
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) return Promise.reject(new Error('操作参数超过 64 KiB。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('设备操作超时，执行结果不确定。已结束会话；请检查手机后重新连接，勿直接重复操作。'));
        void stopOwnProcess(this.child);
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(line, 'utf8', error => { if (error) this.fail(error); });
    });
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > 32 * 1024 * 1024) {
      this.fail(new Error('桥接响应超过 32 MiB，已结束会话。')); void stopOwnProcess(this.child); return;
    }
    for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response: unknown;
      try { response = JSON.parse(line); } catch { this.fail(new Error('桥接输出不是有效 JSON，已结束会话。')); void stopOwnProcess(this.child); return; }
      if (!object(response) || !this.pending || response.id !== this.pending.id ||
          ('result' in response) === ('error' in response)) {
        this.fail(new Error('桥接响应标识或结构不匹配，已结束会话。')); void stopOwnProcess(this.child); return;
      }
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      if ('error' in response) {
        const error = response.error;
        pending.reject(object(error) && typeof error.code === 'string' && typeof error.message === 'string'
          ? new BridgeError(error.code, error.message) : new Error('桥接返回了无效错误。'));
      } else pending.resolve(response.result);
    }
  }

  private fail(error: Error): void {
    const firstFailure = !this.failed;
    this.failed ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    if (firstFailure) for (const listener of this.terminalListeners) listener(error);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('会话已停止；未返回结果的操作可能已在设备执行，请检查手机。'));
    this.child.stdin.end();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); })]);
    if (timeout) clearTimeout(timeout);
    if (this.child.exitCode === null) await stopOwnProcess(this.child);
  }
}
