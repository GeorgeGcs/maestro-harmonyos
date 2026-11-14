import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { object } from './protocol';
import { boundedRead, localFile } from './replay-evidence';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;

export interface StepSource { identity: string; snapshot: string; sha256: string; offset: number }
export interface LiveStep {
  id: string; sequence: number; command: string; source?: StepSource;
  state: string; child?: string; tryNo?: number; parent?: number; depth: number;
}
interface Flow {
  id: string; name: string; state: string; nextEvent: number;
  steps: Map<number, LiveStep>;
}
export interface RunProgress {
  flows: { name: string; state: string; subflows: LiveStep[] }[];
  current?: LiveStep;
  steps: LiveStep[];
}

export class LiveTrace {
  private readonly files = new Map<string, { offset: number; flow?: Flow }>();
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly attempt: string) {}

  failureStep(reported: string): string {
    for (const flow of this.flows.values()) {
      const steps = [...flow.steps.values()];
      const owner = steps.find(step => step.id === reported);
      if (!owner) continue;
      for (const step of steps.filter(step => step.state === '失败' && step.source).reverse()) {
        let ancestor = step.parent;
        while (ancestor !== undefined && ancestor < step.sequence) {
          if (ancestor === owner.sequence) return step.id;
          const parent = flow.steps.get(ancestor)?.parent;
          ancestor = parent !== undefined && parent < ancestor ? parent : undefined;
        }
      }
    }
    return reported;
  }

  async read(): Promise<RunProgress> {
    for (const file of await this.findTraces(path.join(this.attempt, 'flows'), 0)) {
      const cursor = this.files.get(file) ?? { offset: 0 };
      this.files.set(file, cursor);
      const handle = await fs.open(file, 'r');
      try {
        // CLI flushes complete JSON lines while the Flow runs. Leave a partial line for the next read.
        const bytes = Buffer.alloc(256 * 1024);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, cursor.offset);
        const end = bytes.subarray(0, bytesRead).lastIndexOf(10);
        if (end < 0) continue;
        cursor.offset += end + 1;
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
          try {
            const event: unknown = JSON.parse(line);
            if (!object(event)) continue;
            if (event.event === 'traceStarted' && !cursor.flow) {
              const id = event.flowExecutionId;
              if (event.protocol !== 'maestro.harmonyos.retry-trace' || event.schemaVersion !== 2 ||
                  event.attemptId !== path.basename(this.attempt) || event.runId !== path.basename(path.dirname(this.attempt)) ||
                  typeof id !== 'string' || !uuid.test(id) || this.flows.has(id) || typeof event.flowPath !== 'string') continue;
              cursor.flow = { id, name: path.basename(event.flowPath), state: '运行中', nextEvent: 0, steps: new Map() };
              this.flows.set(id, cursor.flow);
            } else if (cursor.flow && event.flowExecutionId === cursor.flow.id && event.sequence === cursor.flow.nextEvent) {
              cursor.flow.nextEvent++;
              this.event(cursor.flow, event);
            }
          } catch { /* Ignore malformed data, including the trailing empty line. */ }
        }
      } finally { await handle.close(); }
    }
    const flows = [...this.flows.values()];
    const steps = flows.flatMap(flow => [...flow.steps.values()].map(step => ({ ...step })));
    const recent = steps.slice(-16).reverse();
    return {
      flows: flows.map(flow => ({ name: flow.name, state: flow.state,
        subflows: [...flow.steps.values()].filter(step => step.command === 'RunFlowCommand').slice(-12).map(step => ({ ...step })) })).slice(-8),
      current: [...steps].reverse().find(step => step.state === '运行中' && step.source),
      steps: recent,
    };
  }

  private event(flow: Flow, event: Record<string, unknown>): void {
    if (event.event === 'flowFinished') {
      flow.state = event.success === true ? '通过' : event.success === false ? '失败' : '已结束';
      return;
    }
    const sequence = event.executionSequence;
    const id = event.stepId;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0 ||
        typeof id !== 'string' || !uuid.test(id)) return;
    if (event.event === 'stepStarted' && typeof event.commandName === 'string') {
      const parent = typeof event.parentExecutionSequence === 'number' ? flow.steps.get(event.parentExecutionSequence) : undefined;
      const frames = Array.isArray(event.retryContext) ? event.retryContext : [];
      const retry = frames.at(-1);
      const source = this.source(event);
      const step: LiveStep = { id, sequence, command: event.commandName, source, state: '运行中',
        tryNo: object(retry) && typeof retry.tryNo === 'number' ? retry.tryNo : undefined,
        parent: parent?.sequence, depth: parent ? parent.depth + 1 : 0 };
      const owner = typeof event.flowScopeOwner === 'number' ? flow.steps.get(event.flowScopeOwner) : undefined;
      if (owner?.command === 'RunFlowCommand' && source && source.identity !== owner.source?.identity) {
        owner.child ??= path.basename(source.identity);
      }
      flow.steps.set(sequence, step);
    } else {
      const step = flow.steps.get(sequence);
      if (step?.id !== id) return;
      if (event.event === 'stepInterrupted') step.state = '已中断';
      if (event.event === 'stepFinished') {
        step.state = event.outcome === 'Failed' ? '失败' : event.outcome === 'Completed' ? '通过' : '跳过';
      }
    }
  }

  private source(event: Record<string, unknown>): StepSource | undefined {
    const { sourceIdentity, sourcePath, sourceSha256, sourceOffset } = event;
    if (typeof sourceIdentity === 'string' && path.isAbsolute(sourceIdentity) &&
        typeof sourceSha256 === 'string' && sha.test(sourceSha256) && sourcePath === `sources/${sourceSha256}.yaml` &&
        typeof sourceOffset === 'number' && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0) {
      return { identity: sourceIdentity, snapshot: sourcePath, sha256: sourceSha256, offset: sourceOffset };
    }
  }

  private async findTraces(directory: string, depth: number): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const traces = entries.filter(entry => entry.isFile() && entry.name === 'retry-trace.jsonl').map(entry => path.join(directory, entry.name));
    if (depth >= 3) return traces;
    for (const entry of entries) {
      if (entry.isDirectory()) traces.push(...await this.findTraces(path.join(directory, entry.name), depth + 1));
    }
    return traces;
  }
}

export async function sourceSnapshot(attempt: string, source: StepSource): Promise<string | undefined> {
  return localFile(attempt, source.snapshot);
}

export async function readPreview(directory: string, attemptId: string): Promise<string | undefined> {
  const file = await localFile(directory, `${attemptId}.png`);
  if (!file) return;
  const bytes = await boundedRead(file, 4 * 1024 * 1024);
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return bytes.toString('base64');
}
