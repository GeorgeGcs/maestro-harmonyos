import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildEvidenceReport, exportRunEvidence } from '../export-run-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, foreignTrace = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-evidence-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runId = randomUUID(), attemptId = randomUUID(), flowExecutionId = randomUUID();
  const attempt = path.join(directory, 'runs', runId, attemptId);
  const ids = [randomUUID(), randomUUID()];
  const identity = { runId, attemptId };
  const json = (kind, data) => JSON.stringify({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1,
    revision: 1, observedAt: '2026-11-21T07:00:00Z', kind, data: { ...identity, ...data } });
  async function write(relative, bytes) {
    const file = path.join(attempt, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return { path: relative, sha256: hash(bytes) };
  }
  const yaml = 'appId: demo.test\n---\n- assertVisible: missing\n';
  const source = await write(`sources/${hash(yaml)}.yaml`, yaml);
  const trace = await write('retry-trace.jsonl', [
    { protocol: 'maestro.harmonyos.retry-trace', schemaVersion: 2, event: 'traceStarted', runId,
      attemptId: foreignTrace ? randomUUID() : attemptId, flowExecutionId },
    ...ids.map((stepId, index) => ({ event: 'stepFinished', stepId, flowExecutionId, executionSequence: index + 3,
      retryContext: [{ tryNo: index + 1 }], sourcePath: source.path, sourceSha256: source.sha256,
      sourceOffset: yaml.indexOf('- assertVisible') })),
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  const entries = [];
  for (const [i, stepId] of ids.entries()) {
    const log = await write(`step-${i + 1}.log`, `log for ${stepId}`);
    entries.push({ stepId, status: 'failed', source: { flow: source.path, commandName: 'AssertConditionCommand' },
      error: { message: '<script>bad()</script>' },
      evidence: [log, trace].map(link => ({ ...link, kind: 'log', state: 'available', phase: 'failure' })) });
  }
  const index = await write('evidence-index.json', json('evidenceIndex', { entries }));
  const result = await write('result.json', json('runResult', { status: 'failed', cleanup: { state: 'unknown', errors: [] },
    failedStepId: ids[1], artifacts: { baseDir: 'unavailable-on-this-host', evidenceIndexPath: index.path } }));
  await write('agent-manifest.json', JSON.stringify({ schemaVersion: 1, ...identity, files: [index, result] }));
  return { attempt, ids };
}

test('renders each retry with its own evidence and keeps unknown cleanup visible', async t => {
  const { attempt, ids } = await fixture(t);
  const report = await buildEvidenceReport(attempt);
  assert.match(report, /设备清理 <strong>unknown<\/strong>/);
  assert.match(report, /YAML 第 3 行/);
  assert.match(report, /尝试 1/);
  assert.match(report, /尝试 2/);
  assert.match(report, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.ok(!report.includes('<script>'));
  const starts = ids.map(id => report.indexOf(`id="${id}"`));
  for (const [i, id] of ids.entries()) {
    assert.ok(starts[i] >= 0);
    const step = report.slice(starts[i], starts[i + 1]);
    assert.ok(step.includes(`log for ${id}`));
    assert.ok(!step.includes(`log for ${ids[1 - i]}`));
  }
});

test('rejects altered attachment and foreign trace even when copied into the attempt', async t => {
  const { attempt } = await fixture(t);
  await fs.writeFile(path.join(attempt, 'step-2.log'), 'foreign log');
  await assert.rejects(buildEvidenceReport(attempt), /Evidence hash differs/);
  const foreign = await fixture(t, true);
  await assert.rejects(buildEvidenceReport(foreign.attempt), /trace is not a version 2 trace for this attempt/);
});

test('exporting from the recorder writes a new offline report and preserves an existing destination', async t => {
  const { attempt } = await fixture(t);
  const directory = path.dirname(attempt);
  const output = path.join(directory, 'review.html');
  assert.equal(await exportRunEvidence(attempt, output), output);
  assert.equal(await fs.readFile(output, 'utf8'), await buildEvidenceReport(attempt));
  await fs.writeFile(output, 'existing report');
  await assert.rejects(exportRunEvidence(attempt, output), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output, 'utf8'), 'existing report');
  assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.maestro-run-report-')));
});
