import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { object } from './protocol';

export interface ReplayFailure {
  artifactsDir: string;
  attemptDir?: string;
}

export interface ReplayEvidenceLink {
  label: string;
  file: string;
  offset?: number;
  sha256?: string;
  screenshotPhase?: 'before' | 'after' | 'failure';
}

interface ElementWait { condition: 'visible' | 'notVisible'; budgetMs: number; elapsedMs: number; satisfied: boolean }
export interface ReplayStepEvidence {
  links: ReplayEvidenceLink[];
  reason?: string;
  elapsedMs?: number;
  elementWaits?: ElementWait[];
  faultSummaries?: string[];
}

export function replayFileHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifiedYamlLine(bytes: Buffer, editorText: string, sourceOffset: number, sha256: string): number | undefined {
  if (replayFileHash(bytes) !== sha256) return;
  const source = bytes.toString('utf8');
  // VS Code normalizes mixed newlines and may omit the BOM from its text model.
  const normalize = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceOffset >= source.length ||
      normalize(source) !== normalize(editorText)) return;
  return normalize(source.slice(0, sourceOffset)).split('\n').length - 1;
}

export async function localFile(root: string, relative: unknown): Promise<string | undefined> {
  if (typeof relative !== 'string' || /[\\:\x00-\x1f]/.test(relative)) return;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))) return;
  let file = root;
  try {
    for (const part of parts) {
      file = path.join(file, part);
      if ((await fs.lstat(file)).isSymbolicLink()) return;
    }
    if ((await fs.stat(file)).isFile()) return file;
  } catch { /* A capture can be missing or already removed. */ }
}

export async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size > limit) throw new Error('回放产物超过读取上限。');
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size) throw new Error('回放产物正在变化。');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

export async function logTail(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const offset = Math.max(0, size - 16384);
    const bytes = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    const lines = bytes.subarray(0, bytesRead).toString('utf8').trimEnd().split(/\r?\n/);
    if (offset && lines.length > 1) lines.shift();
    return lines.slice(-12).join('\n').slice(-6000);
  } finally { await handle.close(); }
}

export async function record(root: string, name: string, kind: string) {
  const file = await localFile(root, name);
  if (!file) return;
  const doc: unknown = JSON.parse((await boundedRead(file, 16 * 1024 * 1024)).toString('utf8'));
  if (object(doc) && doc.protocol === 'maestro.harmonyos.agent' &&
      doc.schemaVersion === 1 && doc.kind === kind && object(doc.data)) return doc.data;
}

export async function replayEvidence(failure: ReplayFailure, stepId?: string, includeFlowFaults = stepId === undefined): Promise<ReplayStepEvidence> {
  const links: ReplayEvidenceLink[] = [];
  const details: ReplayStepEvidence = { links };
  const consoleLog = await localFile(failure.artifactsDir, 'cli.log');
  if (consoleLog) links.push({ label: '回放控制台日志', file: consoleLog });
  const root = failure.attemptDir;
  if (!root) return details;
  try {
    const result = await record(root, 'result.json', 'runResult');
    const index = await record(root, 'evidence-index.json', 'evidenceIndex');
    if (!result || !index || result.runId !== path.basename(path.dirname(root)) ||
        result.attemptId !== path.basename(root) || result.runId !== index.runId ||
        result.attemptId !== index.attemptId ||
        !Array.isArray(index.entries)) return details;
    const target = stepId ?? result.failedStepId;
    const flowEvidence = index.entries.filter(entry => object(entry) && entry.stepId === null && Array.isArray(entry.evidence))
      .flatMap(entry => entry.evidence as unknown[]);
    const faults = await faultEvidence(root, result, flowEvidence, typeof target === 'string' ? target : undefined, includeFlowFaults);
    details.faultSummaries = faults.summaries;
    links.push(...faults.links);
    if (typeof target !== 'string') return details;
    const entries = index.entries.filter(entry => object(entry) && entry.stepId === target);
    if (entries.length !== 1 || !Array.isArray(entries[0].evidence)) return details;
    const evidence: unknown[] = entries[0].evidence;
    if (object(entries[0].error) && typeof entries[0].error.message === 'string') {
      details.reason = entries[0].error.message.slice(0, 8000);
    }
    for (const item of evidence) {
      if (!object(item) || item.state !== 'available' || typeof item.path !== 'string') continue;
      if (item.kind !== 'screenshot' && item.kind !== 'log') continue;
      const file = await localFile(root, item.path);
      if (!file) continue;
      const name = path.basename(file);
      if (item.kind === 'screenshot' && /\.(png|jpe?g)$/i.test(name)) {
        const screenshotPhase = item.phase === 'before' || item.phase === 'failure' ? item.phase : 'after';
        const sha256 = typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) ? item.sha256 : undefined;
        links.push({ label: `步骤截图（${screenshotPhase === 'failure' ? '失败时' : screenshotPhase === 'before' ? '执行前' : '执行后'}）`,
          file, screenshotPhase, sha256 });
      } else if (item.kind === 'log' && /\.(log|txt)$/i.test(name) && name !== 'retry-trace.jsonl') {
        links.push({ label: `日志 · ${name}`, file });
      }
    }
    const traces = [...evidence, ...flowEvidence].filter(item => object(item) && item.kind === 'log' && item.state === 'available' &&
      typeof item.path === 'string' && path.posix.basename(item.path) === 'retry-trace.jsonl');
    const checkedTraces = new Set<string>();
    for (const trace of traces) {
      if (!object(trace) || typeof trace.sha256 !== 'string') continue;
      const file = await localFile(root, trace.path);
      if (!file) continue;
      const key = `${file}:${trace.sha256}`;
      if (checkedTraces.has(key)) continue;
      checkedTraces.add(key);
      const bytes = await boundedRead(file, 16 * 1024 * 1024).catch(() => undefined);
      if (!bytes || replayFileHash(bytes) !== trace.sha256) continue;
      let records: unknown[];
      try { records = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as unknown); }
      catch { continue; }
      const [header, ...events] = records;
      if (!object(header) || header.event !== 'traceStarted' || header.protocol !== 'maestro.harmonyos.retry-trace' ||
          header.schemaVersion !== 2 || header.runId !== result.runId || header.attemptId !== result.attemptId) continue;
      const matches = events.filter(event => object(event) && (event.event === 'stepFinished' || event.event === 'stepInterrupted') &&
        event.flowExecutionId === header.flowExecutionId && event.stepId === target);
      if (matches.length !== 1) continue;
      const step = matches[0];
      if (object(step) && Array.isArray(step.elementWaits) && step.elementWaits.length <= 2) {
        details.elementWaits = (step.elementWaits as unknown[]).filter((wait): wait is ElementWait =>
          object(wait) && (wait.condition === 'visible' || wait.condition === 'notVisible') &&
          typeof wait.budgetMs === 'number' && Number.isSafeInteger(wait.budgetMs) && wait.budgetMs >= 0 &&
          typeof wait.elapsedMs === 'number' && Number.isSafeInteger(wait.elapsedMs) && wait.elapsedMs >= 0 &&
          typeof wait.satisfied === 'boolean');
      }
      const starts = events.filter(event => object(event) && event.event === 'stepStarted' &&
        event.flowExecutionId === header.flowExecutionId && event.stepId === target);
      if (object(step) && starts.length === 1 && object(starts[0]) && starts[0].executionSequence === step.executionSequence &&
          typeof starts[0].elapsedNanos === 'number' && typeof step.elapsedNanos === 'number' &&
          Number.isSafeInteger(starts[0].elapsedNanos) && Number.isSafeInteger(step.elapsedNanos) &&
          starts[0].elapsedNanos >= 0 && step.elapsedNanos >= starts[0].elapsedNanos) {
        details.elapsedMs = Math.round((step.elapsedNanos - starts[0].elapsedNanos) / 1000000);
      }
      if (!object(step) || typeof step.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(step.sourceSha256) ||
          typeof step.sourceOffset !== 'number' || !Number.isSafeInteger(step.sourceOffset) || step.sourceOffset < 0 ||
          step.sourcePath !== `sources/${step.sourceSha256}.yaml`) continue;
      // The replay's source snapshot lives with its evidence, even if a saved copy was edited later.
      const source = await localFile(root, step.sourcePath);
      if (!source) continue;
      const yaml = await boundedRead(source, 4 * 1024 * 1024);
      if (replayFileHash(yaml) !== step.sourceSha256 || step.sourceOffset >= yaml.toString('utf8').length) continue;
      const line = yaml.toString('utf8').slice(0, step.sourceOffset).split(/\r\n?|\n/).length;
      const label = step.outcome === 'Failed' ? '跳到失败 YAML' : '跳到执行 YAML';
      links.unshift({ label: `${label}（第 ${line} 行）`, file: source, offset: step.sourceOffset, sha256: step.sourceSha256 });
      break;
    }
  } catch { /* Keep the console and any independently resolved evidence on partial output. */ }
  return details;
}

async function faultEvidence(root: string, result: Record<string, unknown>, items: unknown[], stepId: string | undefined, includeFlow: boolean) {
  const summaries: string[] = [];
  const links: ReplayEvidenceLink[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!object(item) || item.state !== 'available' || item.kind !== 'log' || typeof item.path !== 'string' ||
        path.posix.basename(item.path) !== 'harmonyos-faults.json' || seen.has(item.path) ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) continue;
    seen.add(item.path);
    try {
      const file = await localFile(root, item.path);
      if (!file) continue;
      const bytes = await boundedRead(file, 4 * 1024 * 1024);
      if (replayFileHash(bytes) !== item.sha256) continue;
      const report: unknown = JSON.parse(bytes.toString('utf8'));
      if (!object(report) || report.protocol !== 'maestro.harmonyos.fault-report' || report.schemaVersion !== 1 ||
          report.runId !== result.runId || report.attemptId !== result.attemptId ||
          typeof report.appId !== 'string' || typeof report.flowPath !== 'string' || !Array.isArray(report.events)) continue;
      const flowName = report.flowPath.split(/[\\/]/).at(-1);
      const label = `${flowName} · ${report.appId}`;
      const group = [];
      if (report.state === 'complete') {
        for (const fault of report.events) {
          if (!object(fault) || typeof fault.event !== 'string' || typeof fault.reason !== 'string') continue;
          const association = typeof stepId === 'string' && fault.stepId === stepId ? '步骤执行期间' :
            includeFlow && fault.stepId === null ? 'Flow 期间，步骤未确认' :
            includeFlow ? 'Flow 期间，见报告中的步骤' : undefined;
          if (association) group.push(`${association} · ${fault.event}${fault.reason ? ' · ' + fault.reason.split(/\r?\n/, 1)[0].slice(0, 300) : ''}`);
        }
        if (includeFlow && report.events.length === 0) group.push('系统故障查询完成，未返回对应事件');
      } else if (includeFlow && (report.state === 'timedOut' || report.state === 'unavailable')) {
        group.push(report.state === 'timedOut' ? '系统故障查询超时' : '系统故障信息不可用');
      }
      if (group.length) {
        summaries.push(...group.map(message => `${label} · ${message}`));
        links.push({ label: `系统故障报告 · ${label}`, file, sha256: item.sha256 });
      }
    } catch { /* Fault details can be unavailable while the step evidence remains usable. */ }
  }
  return { summaries, links };
}

export async function evidenceImage(link: ReplayEvidenceLink): Promise<{ label: string; image: string } | undefined> {
  const bytes = await boundedRead(link.file, 4 * 1024 * 1024);
  if (link.sha256 && replayFileHash(bytes) !== link.sha256) return;
  const prefix = bytes.subarray(0, 8).toString('hex');
  const mime = prefix === '89504e470d0a1a0a' ? 'png' : prefix.startsWith('ffd8ff') ? 'jpeg' : undefined;
  if (mime) return { label: link.label, image: `data:image/${mime};base64,${bytes.toString('base64')}` };
}
