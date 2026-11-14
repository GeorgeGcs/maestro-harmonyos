import { Action, Connection, Snapshot, Transport, composeFlow, object, parseSnapshot, validateAction } from './protocol';
import { ReplayFailure } from './replay-evidence';

export interface SessionState {
  connected: boolean; busy: boolean; snapshot: Snapshot | null; steps: string[];
  appId: string; message: string; artifactsDir: string | null;
  replayFailure?: ReplayFailure;
}
export class OperationStopped extends Error { constructor() { super('任务已停止。'); this.name = 'OperationStopped'; } }
interface Operation { signal: AbortSignal; current(): boolean; check(): void }

export class RecorderSession {
  readonly state: SessionState = { connected: false, busy: false, snapshot: null, steps: [], appId: '', message: '连接手机后开始录制。', artifactsDir: null };
  connection: Connection | undefined;
  private transport: Transport | undefined;
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  private cancellation: AbortController | undefined;
  constructor(private readonly changed: (state: SessionState) => void) {}

  async connect(transport: Transport, connection: Connection): Promise<void> {
    await this.perform(async operation => {
      if (this.state.connected) throw new Error('请先断开当前设备。');
      if (this.state.steps.length && this.state.appId !== connection.appId) throw new Error('切换应用前请先保存并新建流程。');
      this.unsubscribe?.();
      this.transport = transport;
      this.unsubscribe = transport.onTerminated?.(error => this.terminated(transport, error));
      operation.check();
      const result = await transport.request('connect', connection);
      operation.check();
      if (!object(result) || result.deviceId !== connection.deviceId || result.appId !== connection.appId) throw new Error('连接结果与所选应用或设备不一致。');
      this.connection = connection;
      this.state.connected = true;
      this.state.appId = connection.appId;
      this.state.artifactsDir = connection.artifactsDir;
      this.state.message = '设备已连接。请启动应用或选择控件。';
      await this.refreshAfterSuccess('设备已连接', operation);
    });
  }

  async refresh(): Promise<void> {
    await this.perform(async operation => {
      this.ensureConnected();
      this.state.snapshot = null;
      const result = await this.transport!.request('snapshot');
      operation.check();
      this.state.snapshot = parseSnapshot(result);
      this.state.message = '画面已刷新。点击画面选择控件。';
    });
  }

  async action(value: unknown): Promise<void> {
    await this.perform(async operation => {
      this.ensureConnected();
      const action: Action = validateAction(value, this.state.snapshot);
      this.state.snapshot = null;
      const result = await this.transport!.request('action', action);
      operation.check();
      if (!object(result) || typeof result.yaml !== 'string' || result.yaml.length > 65536 || !result.yaml.trimStart().startsWith('- ')) {
        throw new Error('操作已返回，但 YAML 格式无效。请检查手机；不要直接重复操作。');
      }
      this.state.steps.push(result.yaml.trimEnd());
      this.state.message = `已完成并记录第 ${this.state.steps.length} 步。`;
      this.changed(this.state);
      await this.refreshAfterSuccess('操作已完成并记入 YAML', operation);
    });
  }

  async disconnect(): Promise<void> { await this.perform(operation => this.disconnectInside(operation)); }

  async replay(run: (connection: Connection, yaml: string, signal: AbortSignal) => Promise<ReplayFailure & { exitCode: number }>): Promise<void> {
    await this.perform(async operation => {
      if (!this.connection || !this.state.steps.length) throw new Error('请先录制至少一个步骤。');
      const yaml = this.yaml(), connection = this.connection;
      this.state.replayFailure = undefined;
      await this.disconnectInside(operation);
      operation.check();
      this.state.message = '正在回放。录制会话已断开。';
      this.changed(this.state);
      const result = await run(connection, yaml, operation.signal);
      operation.check();
      this.state.artifactsDir = result.artifactsDir;
      if (result.exitCode !== 0) this.state.replayFailure = { artifactsDir: result.artifactsDir, attemptDir: result.attemptDir };
      this.state.message = result.exitCode === 0 ? '回放通过。可重新连接继续录制。' : `回放失败（退出码 ${result.exitCode}），请查看运行日志和产物。`;
    });
  }

  private async disconnectInside(operation: Operation): Promise<void> {
    if (this.state.connected && this.transport) {
      this.state.snapshot = null;
      const result = await this.transport.request('disconnect');
      operation.check();
      if (!object(result) || result.disconnected !== true) throw new Error('设备会话未确认释放，不能开始回放。');
    }
    operation.check();
    this.unsubscribe?.(); this.unsubscribe = undefined; this.transport = undefined;
    this.state.connected = false;
    this.state.snapshot = null;
    this.state.message = '设备已断开；录制步骤仍保留。';
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.cancellation?.abort(new OperationStopped());
    this.cancellation = undefined;
    const transport = this.transport;
    this.unsubscribe?.(); this.unsubscribe = undefined; this.transport = undefined;
    this.state.connected = false; this.state.busy = false; this.state.snapshot = null;
    this.state.message = '任务已停止，录制步骤已保留。未返回结果的操作需检查手机确认。';
    this.changed(this.state);
    await transport?.dispose();
  }

  private terminated(transport: Transport, error: Error): void {
    if (this.transport !== transport) return;
    ++this.generation;
    this.cancellation?.abort(error); this.cancellation = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined; this.transport = undefined;
    this.state.connected = false; this.state.busy = false; this.state.snapshot = null;
    this.state.message = `${errorMessage(error)} 已断开，可检查手机后重新连接；录制步骤仍保留。`;
    this.changed(this.state);
  }

  clear(): void {
    if (this.state.busy) throw new Error('当前任务尚未结束。');
    this.state.steps = [];
    this.state.replayFailure = undefined;
    this.state.message = '已新建空流程。';
    this.changed(this.state);
  }
  yaml(): string { return this.state.appId ? composeFlow(this.state.appId, this.state.steps) : ''; }
  private ensureConnected(): void { if (!this.state.connected || !this.transport) throw new Error('请先连接设备。'); }
  private async refreshAfterSuccess(prefix: string, operation: Operation): Promise<void> {
    try {
      const result = await this.transport!.request('snapshot');
      operation.check();
      this.state.snapshot = parseSnapshot(result);
    } catch (error) {
      operation.check();
      this.state.snapshot = null; this.state.message = `${prefix}，但画面刷新失败。请手动刷新，不要重复该操作。${errorMessage(error)}`;
    }
  }
  private async perform(action: (operation: Operation) => Promise<void>): Promise<void> {
    if (this.state.busy) throw new Error('请等待当前操作完成。');
    const generation = ++this.generation;
    const cancellation = new AbortController(); this.cancellation = cancellation;
    const operation: Operation = { signal: cancellation.signal, current: () => generation === this.generation && !cancellation.signal.aborted,
      check: () => { if (!operation.current()) throw new OperationStopped(); } };
    this.state.busy = true; this.changed(this.state);
    try { await action(operation); }
    catch (error) { operation.check(); this.state.message = errorMessage(error); throw error; }
    finally { if (operation.current()) { this.cancellation = undefined; this.state.busy = false; this.changed(this.state); } }
  }
}
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
