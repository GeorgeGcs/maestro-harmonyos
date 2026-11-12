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
}

export function replayFileHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function localFile(root: string, relative: unknown): Promise<string | undefined> {
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

async function boundedRead(file: string, limit: number): Promise<Buffer> {
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

async function record(root: string, name: string, kind: string) {
  const file = await localFile(root, name);
  if (!file) return;
  const doc: unknown = JSON.parse((await boundedRead(file, 16 * 1024 * 1024)).toString('utf8'));
  if (object(doc) && doc.protocol === 'maestro.harmonyos.agent' &&
      doc.schemaVersion === 1 && doc.kind === kind && object(doc.data)) return doc.data;
}

export async function replayEvidence(failure: ReplayFailure): Promise<ReplayEvidenceLink[]> {
  const links: ReplayEvidenceLink[] = [];
  const consoleLog = await localFile(failure.artifactsDir, 'cli.log');
  if (consoleLog) links.push({ label: '回放控制台日志', file: consoleLog });
  const root = failure.attemptDir;
  if (!root) return links;
  try {
    const result = await record(root, 'result.json', 'runResult');
    const index = await record(root, 'evidence-index.json', 'evidenceIndex');
    if (!result || !index || result.runId !== path.basename(path.dirname(root)) ||
        result.attemptId !== path.basename(root) || result.runId !== index.runId ||
        result.attemptId !== index.attemptId || typeof result.failedStepId !== 'string' ||
        !Array.isArray(index.entries)) return links;
    const entries = index.entries.filter(entry => object(entry) && entry.stepId === result.failedStepId);
    if (entries.length !== 1 || !Array.isArray(entries[0].evidence)) return links;
    const evidence: unknown[] = entries[0].evidence;
    for (const item of evidence) {
      if (!object(item) || item.state !== 'available' || typeof item.path !== 'string') continue;
      if (item.kind !== 'screenshot' && item.kind !== 'log') continue;
      const file = await localFile(root, item.path);
      if (!file) continue;
      const name = path.basename(file);
      if (item.kind === 'screenshot' && /\.(png|jpe?g)$/i.test(name)) {
        links.push({ label: `步骤截图（${item.phase === 'failure' ? '失败时' : item.phase === 'before' ? '执行前' : '执行后'}）`, file });
      } else if (item.kind === 'log' && /\.(log|txt)$/i.test(name) && name !== 'retry-trace.jsonl') {
        links.push({ label: `日志 · ${name}`, file });
      }
    }
    const traces = evidence.filter(item => object(item) && item.kind === 'log' && item.state === 'available' &&
      typeof item.path === 'string' && path.posix.basename(item.path) === 'retry-trace.jsonl');
    for (const trace of traces) {
      if (!object(trace)) continue;
      const file = await localFile(root, trace.path);
      if (!file) continue;
      const bytes = await boundedRead(file, 16 * 1024 * 1024);
      if (replayFileHash(bytes) !== trace.sha256) continue;
      const [header, ...events] = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as unknown);
      if (!object(header) || header.event !== 'traceStarted' || header.protocol !== 'maestro.harmonyos.retry-trace' ||
          header.schemaVersion !== 2 || header.runId !== result.runId || header.attemptId !== result.attemptId) continue;
      const matches = events.filter(event => object(event) && event.event === 'stepFinished' && event.outcome === 'Failed' &&
        event.flowExecutionId === header.flowExecutionId && event.stepId === result.failedStepId);
      if (matches.length !== 1) continue;
      const step = matches[0];
      if (!object(step) || typeof step.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(step.sourceSha256) ||
          typeof step.sourceOffset !== 'number' || !Number.isSafeInteger(step.sourceOffset) || step.sourceOffset < 0 ||
          step.sourcePath !== `sources/${step.sourceSha256}.yaml`) continue;
      // The replay's source snapshot lives with its evidence, even if a saved copy was edited later.
      const source = await localFile(root, step.sourcePath);
      if (!source) continue;
      const yaml = await boundedRead(source, 4 * 1024 * 1024);
      if (replayFileHash(yaml) !== step.sourceSha256 || step.sourceOffset >= yaml.toString('utf8').length) continue;
      const line = yaml.toString('utf8').slice(0, step.sourceOffset).split('\n').length;
      links.unshift({ label: `跳到失败 YAML（第 ${line} 行）`, file: source, offset: step.sourceOffset, sha256: step.sourceSha256 });
      break;
    }
  } catch { /* Keep the console and any independently resolved evidence on partial output. */ }
  return links;
}
