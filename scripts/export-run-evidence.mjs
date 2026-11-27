import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { validateDocument } from '../examples/agent-client/client.mjs';
import { confinedFile } from '../examples/agent-client/evidence.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const maxFile = 16 * 1024 * 1024;
const maxReport = 64 * 1024 * 1024;
const packScript = fileURLToPath(new URL('./agent-bundle-zip.ps1', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const escape = value => String(value ?? '').replace(/[&<>"']/g, token => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[token]);

export async function buildEvidenceReport(attempt) {
  const root = path.resolve(attempt);
  const manifest = JSON.parse(await confinedFile(root, 'agent-manifest.json', maxFile));
  if (manifest.schemaVersion !== 1 || !uuid.test(manifest.runId) || !uuid.test(manifest.attemptId) ||
      manifest.attemptId !== path.basename(root) || manifest.runId !== path.basename(path.dirname(root)) ||
      !Array.isArray(manifest.files) || manifest.files.length > 16384) throw new Error('Invalid attempt manifest or directory identity.');
  const manifestRefs = new Map();
  for (const { path: name, sha256 } of manifest.files) {
    if (typeof name !== 'string' || !sha.test(sha256) || manifestRefs.has(name)) throw new Error('Invalid manifest reference.');
    manifestRefs.set(name, sha256);
  }

  const inputs = new Map();
  let budget = maxReport;
  async function read(name, sha256) {
    if (!sha.test(sha256)) throw new Error(`Missing SHA-256: ${name}`);
    const previous = inputs.get(name);
    if (previous) {
      if (previous.sha256 !== sha256) throw new Error(`Conflicting SHA-256: ${name}`);
      return previous.bytes;
    }
    if (inputs.size >= 1024) throw new Error('Report file limit exceeded.');
    const bytes = await confinedFile(root, name, Math.min(maxFile, budget));
    if (hash(bytes) !== sha256) throw new Error(`Evidence hash differs: ${name}`);
    inputs.set(name, { sha256, bytes });
    budget -= bytes.length;
    return bytes;
  }
  const document = async (name, kind) => validateDocument(
    JSON.parse(await read(name, manifestRefs.get(name))), kind, [1]).data;
  const result = await document('result.json', 'runResult');
  const index = await document(result.artifacts?.evidenceIndexPath, 'evidenceIndex');
  for (const record of [result, index]) {
    if (record.runId !== manifest.runId || record.attemptId !== manifest.attemptId) throw new Error('Evidence is from another attempt.');
  }
  if (!['passed', 'failed', 'cancelled', 'blocked', 'unknown'].includes(result.status) ||
      !['not_started', 'in_progress', 'complete', 'failed', 'unknown'].includes(result.cleanup?.state) ||
      !Array.isArray(result.cleanup.errors) || !Array.isArray(index.entries) || index.entries.length > 4096) {
    throw new Error('Expected a terminal run result with cleanup and step evidence.');
  }

  const entries = new Map();
  const traces = new Map();
  for (const entry of index.entries) {
    if (!Array.isArray(entry.evidence) || entry.evidence.length > 128) throw new Error('Invalid step evidence.');
    if (entry.stepId !== null) {
      if (!uuid.test(entry.stepId) || entries.has(entry.stepId)) throw new Error('Invalid or duplicate step identity.');
      entries.set(entry.stepId, entry);
    }
    for (const item of entry.evidence) {
      if (item.state !== 'available' || item.kind !== 'log' || typeof item.path !== 'string' ||
          path.posix.basename(item.path) !== 'retry-trace.jsonl') continue;
      const previous = traces.get(item.path);
      if (previous && previous !== item.sha256) throw new Error('Conflicting step trace references.');
      traces.set(item.path, item.sha256);
    }
  }
  if (result.failedStepId !== null && !entries.has(result.failedStepId)) throw new Error('Missing reported failure step.');
  const stepEvents = new Map();
  for (const [name, sha256] of traces) {
    const [header, ...lines] = (await read(name, sha256)).toString('utf8').trimEnd().split('\n');
    const trace = JSON.parse(header);
    if (trace.protocol !== 'maestro.harmonyos.retry-trace' || trace.schemaVersion !== 2 || trace.event !== 'traceStarted' ||
        trace.runId !== result.runId || trace.attemptId !== result.attemptId || !uuid.test(trace.flowExecutionId)) {
      throw new Error('Step trace is not a version 2 trace for this attempt.');
    }
    for (const line of lines) {
      const event = JSON.parse(line);
      if (!entries.has(event.stepId) || !['stepFinished', 'stepInterrupted'].includes(event.event)) continue;
      if (event.flowExecutionId !== trace.flowExecutionId || stepEvents.has(event.stepId)) throw new Error('Ambiguous step trace.');
      stepEvents.set(event.stepId, event);
    }
  }

  async function section(entry, position) {
    const event = stepEvents.get(entry.stepId);
    let source = '';
    if (entry.source?.flow) {
      const sourceHash = /^sources\/([a-f0-9]{64})\.yaml$/.exec(entry.source.flow)?.[1];
      const yaml = (await read(entry.source.flow, sourceHash)).toString('utf8');
      const offset = event?.sourceOffset;
      if (event?.sourcePath === entry.source.flow && event.sourceSha256 === sourceHash &&
          Number.isSafeInteger(offset) && offset >= 0 && offset < yaml.length) {
        const line = yaml.slice(0, offset).split(/\r\n?|\n/).length;
        const lines = yaml.split(/\r\n?|\n/);
        const start = Math.max(0, line - 3);
        source = `<h3>YAML 第 ${line} 行</h3><pre>${lines.slice(start, line + 2)
          .map((text, i) => escape(`${start + i + 1 === line ? '>' : ' '} ${start + i + 1}  ${text}`)).join('\n')}</pre>`;
      } else {
        source = '<p>已核对源码快照，未取得可定位的行号。</p>';
      }
    }
    const attachments = [];
    const shown = new Set();
    for (const item of entry.evidence) {
      if (item.kind !== 'screenshot' && item.kind !== 'log') continue;
      if (item.state !== 'available') {
        attachments.push(`<p>${escape(item.kind)} · ${escape(item.phase)} · ${escape(item.state)}</p>`);
        continue;
      }
      const name = path.posix.basename(item.path);
      if (name === 'retry-trace.jsonl' || shown.has(item.path)) continue;
      shown.add(item.path);
      if (item.kind === 'screenshot') {
        const bytes = await read(item.path, item.sha256);
        const mime = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png'
          : bytes.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : null;
        if (!mime) throw new Error('Unexpected screenshot format.');
        attachments.push(`<figure><figcaption>${escape(item.phase ?? name)}</figcaption>
          <img loading="lazy" alt="步骤截图" src="data:${mime};base64,${bytes.toString('base64')}"></figure>`);
      } else if (/\.(?:log|txt)$/.test(name) || name === 'harmonyos-faults.json') {
        const bytes = await read(item.path, item.sha256);
        attachments.push(`<details><summary>${escape(name)}（末尾）</summary><pre>${escape(bytes.subarray(-6000))}</pre></details>`);
      }
    }
    const retry = Array.isArray(event?.retryContext) ? event.retryContext.map(frame => frame?.tryNo)
      .filter(attempt => Number.isSafeInteger(attempt) && attempt >= 1) : [];
    const identity = entry.stepId ?? `flow-${position}`;
    const isFailure = entry.status === 'failed' || entry.stepId === result.failedStepId && entry.stepId !== null;
    const title = [event?.executionSequence != null ? `#${event.executionSequence}` : null,
      entry.source?.commandName ?? (entry.stepId ? '步骤' : 'Flow 产物'),
      retry.length ? `尝试 ${retry.join(' / ')}` : null, entry.stepId ? entry.status : null].filter(Boolean).join(' · ');
    const waits = Array.isArray(event?.elementWaits) ? event.elementWaits.slice(0, 2).filter(wait =>
      ['visible', 'notVisible'].includes(wait?.condition) && Number.isSafeInteger(wait.elapsedMs) &&
      Number.isSafeInteger(wait.budgetMs) && typeof wait.satisfied === 'boolean') : [];
    const waitDetails = waits.map(wait => `<p>等待${wait.condition === 'visible' ? '可见' : '不可见'} ·
      ${wait.satisfied ? '满足条件' : '未满足条件'} · 耗时 ${wait.elapsedMs} ms / 预算 ${wait.budgetMs} ms</p>`).join('');
    return `<details class="step" id="${identity}"${isFailure ? ' open' : ''}><summary>${escape(title)}</summary>
      <p class="id">${escape(entry.stepId)}</p><p>${escape(entry.error?.message)}</p>
      ${waitDetails}${source}<div class="attachments">${attachments.join('')}</div></details>`;
  }
  const parts = [];
  let renderedBytes = 0;
  // Read and render one step at a time so repeated attachments count towards the output limit.
  for (const [position, entry] of index.entries.entries()) {
    const html = await section(entry, position);
    renderedBytes += Buffer.byteLength(html);
    if (renderedBytes > maxReport) throw new Error('Report size limit exceeded.');
    parts.push(html);
  }
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'">
  <title>Maestro HarmonyOS 运行证据</title><style>
  body{font:16px system-ui,sans-serif;background:#f6f8fb;color:#192536;margin:32px auto;padding:0 20px;max-width:1100px}
  header,.step{background:white;border:1px solid #dce2eb;border-radius:9px;margin:0 0 14px;padding:16px}
  h1,h2{margin:0 0 12px} summary{cursor:pointer;font-weight:600} .id{color:#526175;overflow-wrap:anywhere}
  .state{display:flex;gap:24px;flex-wrap:wrap} pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f7;padding:12px}
  img{max-width:100%;max-height:480px} figure{display:inline-block;vertical-align:top;margin:0 16px 16px 0}
  .attachments details{margin:10px 0} a{color:#a62335}</style>
  <header><h1>Maestro HarmonyOS 运行证据</h1>
  <div class="state"><p>执行结果 <strong>${escape(result.status)}</strong></p>
  <p>设备清理 <strong>${escape(result.cleanup.state)}</strong></p></div>
  <p class="id">运行 ${result.runId} · 尝试 ${result.attemptId}</p>
  <p>${escape(result.message ?? result.error?.message)}</p>
  ${result.failedStepId ? `<a href="#${result.failedStepId}">跳到报告的失败步骤</a>` : ''}
  <p>归档时的只读记录。分享前请核对 YAML 片段、日志和截图中的测试数据。</p></header>
  <main><h2>步骤与证据</h2>${parts.join('') || '<p>本次运行没有步骤证据。</p>'}</main></html>`;
}

export async function exportRunEvidence(attempt, destination) {
  if (!attempt || !destination || !/\.(?:html|zip)$/i.test(destination)) {
    throw new Error('Choose an attempt and a new output ending in .html or .zip.');
  }
  const output = path.resolve(destination);
  const html = await buildEvidenceReport(attempt);
  const folder = await fs.mkdtemp(path.join(path.dirname(output), '.maestro-run-report-'));
  try {
    const content = path.join(folder, 'content');
    await fs.mkdir(content);
    const page = path.join(content, 'index.html');
    await fs.writeFile(page, html, { flag: 'wx' });
    let prepared = page;
    if (output.toLowerCase().endsWith('.zip')) {
      prepared = path.join(folder, 'report.zip');
      await promisify(execFile)('pwsh', ['-NoProfile', '-File', packScript, '-Mode', 'Pack', '-Archive', prepared,
        '-Directory', content], { windowsHide: true, timeout: 60_000 });
    }
    await fs.copyFile(prepared, output, constants.COPYFILE_EXCL);
  } finally {
    // Delete only the fresh scratch tree allocated by mkdtemp above.
    await fs.rm(folder, { recursive: true, force: true });
  }
  return output;
}

async function main() {
  const { values } = parseArgs({ options: { attempt: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) return console.log('Usage: node scripts/export-run-evidence.mjs --attempt <runs/runId/attemptId> --output <report.html|report.zip>');
  console.log(await exportRunEvidence(values.attempt, values.output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
