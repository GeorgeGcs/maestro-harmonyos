import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runFlow, ReplayAttempt, ReplayInput, ToolSettings } from './launcher';
import { Connection } from './protocol';
import { LiveTrace, readPreview, RunProgress } from './live-trace';
import { localFile, record } from './replay-evidence';

export interface RunRequest { root: string; tools: ToolSettings; connection: Connection; input: ReplayInput }
export type RunStatus = '正在启动' | '正在执行' | '正在停止' | '通过' | '失败' | '已停止' | '结果未确认';

export class InteractiveRun {
  status: RunStatus = '正在启动';
  progress: RunProgress = { flows: [], steps: [] };
  canStop = false;
  releaseConfirmed = false;
  previewEnabled = false;
  frame?: string;
  failure?: string;
  attempt?: ReplayAttempt;
  private frameVersion?: number;
  private trace?: LiveTrace;
  private stopping = false;
  private monitor?: Promise<void>;
  private previewControl: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private readonly startup = new AbortController();

  constructor(readonly request: RunRequest, private readonly change: () => void,
    private readonly log: (text: string) => void, private readonly visible: () => boolean) {}

  get active(): boolean { return this.status === '正在启动' || this.status === '正在执行' || this.status === '正在停止'; }

  async execute(): Promise<void> {
    try {
      const { root, tools, connection, input } = this.request;
      const result = await runFlow(root, tools, connection, input, this.log, process => {
        if (process && !this.stopping) this.status = '正在执行';
        this.change();
      }, this.startup.signal, async attempt => {
        this.attempt = attempt;
        this.trace = new LiveTrace(attempt.attemptDir);
        this.timer = setInterval(() => { void this.poll(); }, 300);
        await this.syncPreview();
      });
      if (this.timer) clearInterval(this.timer);
      await this.monitor;
      await this.poll();
      const attempt = this.attempt!;
      const data = await record(attempt.attemptDir, 'result.json', 'runResult');
      const matching = data?.runId === path.basename(path.dirname(attempt.attemptDir)) &&
        data?.attemptId === attempt.attemptId && data?.deviceId === connection.deviceId;
      this.releaseConfirmed = matching && !!await localFile(attempt.agent, `${attempt.attemptId}.released`);
      this.failure = matching && typeof data.failedStepId === 'string' ? this.trace!.failureStep(data.failedStepId) : undefined;
      if (!matching) this.status = '结果未确认';
      else if (data.status === 'cancelled') this.status = '已停止';
      else if (data.status === 'passed' && result.exitCode === 0) this.status = '通过';
      else if (data.status === 'failed' || data.status === 'blocked') this.status = '失败';
      else this.status = '结果未确认';
    } catch (error) {
      this.status = this.startup.signal.aborted ? '已停止' : '结果未确认';
      this.releaseConfirmed = this.startup.signal.aborted;
      this.log(`${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (this.timer) clearInterval(this.timer);
      this.canStop = false;
      await this.syncPreview().catch(() => undefined);
      this.change();
    }
  }

  async stop(): Promise<void> {
    if (!this.active || this.stopping) return;
    if (this.status !== '正在启动' && !this.canStop) return;
    if (this.status === '正在启动') this.startup.abort();
    else if (this.attempt) await this.createControl('stop');
    if (!this.active) return;
    this.stopping = true;
    this.status = '正在停止';
    this.change();
  }

  async syncPreview(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    const update = this.previewControl.then(async () => {
      if (this.active && !this.stopping && this.previewEnabled && this.visible()) await this.createControl('preview');
      else await fs.unlink(path.join(attempt.agent, `${attempt.attemptId}.preview`)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    this.previewControl = update.catch(() => undefined);
    await update;
  }

  private async createControl(type: 'stop' | 'preview'): Promise<void> {
    const attempt = this.attempt!;
    await fs.writeFile(path.join(attempt.agent, `${attempt.attemptId}.${type}`), '', { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }

  private poll(): Promise<void> {
    if (this.monitor) return this.monitor;
    this.monitor = this.readProgress().catch(error => {
      this.log(`读取运行进度失败：${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => { this.monitor = undefined; });
    return this.monitor;
  }

  private async readProgress(): Promise<void> {
    const attempt = this.attempt!;
    const progress = await this.trace!.read();
    const available = this.active && !!await localFile(attempt.agent, `${attempt.attemptId}.interactive`);
    const changed = available !== this.canStop || JSON.stringify(this.progress) !== JSON.stringify(progress);
    this.progress = progress;
    this.canStop = available;
    if (this.previewEnabled && this.visible()) {
      const info = await fs.stat(path.join(attempt.agent, `${attempt.attemptId}.png`)).catch(() => undefined);
      if (info && info.mtimeMs !== this.frameVersion) {
        this.frame = await readPreview(attempt.agent, attempt.attemptId);
        this.frameVersion = info.mtimeMs;
        this.change();
        return;
      }
    }
    if (changed) this.change();
  }
}
