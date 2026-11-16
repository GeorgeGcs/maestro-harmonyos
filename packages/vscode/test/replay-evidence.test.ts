import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { evidenceImage, replayEvidence, replayFileHash, verifiedYamlLine } from '../src/replay-evidence';

test('jumps by the archived UTF-16 offset after VS Code normalizes mixed line endings', () => {
  const source = '\uFEFFappId: demo.target\r\n---\r\n- inputText: "🙂"\n- tapOn: "OK"\r\n';
  const bytes = Buffer.from(source);
  const editor = source.slice(1).replace(/\r\n/g, '\n');
  const offset = source.indexOf('tapOn');
  assert.equal(verifiedYamlLine(bytes, editor, offset, replayFileHash(bytes)), 3);
  assert.equal(verifiedYamlLine(bytes, editor.replace('OK', 'changed'), offset, replayFileHash(bytes)), undefined);
});

test('opens evidence for the reported retry instance and positions its archived YAML', async t => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harmony-replay-'));
  t.after(() => fs.rm(artifactsDir, { recursive: true, force: true }));
  const runId = 'run', attemptId = 'attempt', flowExecutionId = 'flow';
  const attemptDir = path.join(artifactsDir, runId, attemptId);
  await fs.mkdir(path.join(attemptDir, 'sources'), { recursive: true });
  const yaml = Buffer.from('appId: org.example.app\n---\n- inputText: "测试🙂"\n- assertVisible: "欢迎"\n');
  const sourceSha256 = replayFileHash(yaml);
  const sourcePath = `sources/${sourceSha256}.yaml`;
  const sourceOffset = yaml.toString().indexOf('assertVisible');
  const trace = Buffer.from([
    { event: 'traceStarted', protocol: 'maestro.harmonyos.retry-trace', schemaVersion: 2, runId, attemptId, flowExecutionId },
    ...['first', 'second'].flatMap((stepId, index) => [
      { event: 'stepStarted', flowExecutionId, stepId, executionSequence: index, elapsedNanos: index * 2000000000 },
      { event: 'stepFinished', flowExecutionId, stepId, executionSequence: index, elapsedNanos: index * 2000000000 + 650000000,
        outcome: index === 0 ? 'Completed' : 'Failed', sourcePath, sourceSha256, sourceOffset, retryContext: [{ tryNo: index + 1 }],
        elementWaits: index === 0 ? [] : [{ condition: 'visible', budgetMs: 400, elapsedMs: 550, satisfied: false }] }
    ])
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const writeDoc = (file: string, kind: string, data: object) => fs.writeFile(path.join(attemptDir, file),
    JSON.stringify({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, data: { runId, attemptId, ...data } }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await Promise.all([
    fs.writeFile(path.join(artifactsDir, 'cli.log'), 'console'),
    fs.writeFile(path.join(attemptDir, 'retry-trace.jsonl'), trace),
    fs.writeFile(path.join(attemptDir, sourcePath), yaml),
    fs.writeFile(path.join(attemptDir, 'first.png'), 'first screenshot'),
    fs.writeFile(path.join(attemptDir, 'before.png'), png),
    fs.writeFile(path.join(attemptDir, 'second.png'), 'second screenshot'),
    writeDoc('result.json', 'runResult', { failedStepId: 'second' }),
    writeDoc('evidence-index.json', 'evidenceIndex', { entries: [
      { stepId: null, evidence: [{ kind: 'log', state: 'available', path: 'retry-trace.jsonl', sha256: replayFileHash(trace) }] },
      { stepId: 'first', evidence: [{ kind: 'screenshot', state: 'available', phase: 'after', path: 'first.png' }] },
      { stepId: 'second', error: { message: 'No matching widget' }, evidence: [
        { kind: 'screenshot', state: 'available', phase: 'before', path: 'before.png', sha256: replayFileHash(png) },
        { kind: 'screenshot', state: 'available', phase: 'failure', path: 'second.png' },
        { kind: 'log', state: 'available', path: 'retry-trace.jsonl', sha256: replayFileHash(trace) },
        { kind: 'log', state: 'available', path: '../../cli.log' }
      ] }
    ] })
  ]);
  const { links, elapsedMs, reason, elementWaits } = await replayEvidence({ artifactsDir, attemptDir });
  assert.deepEqual(links.map(link => path.basename(link.file)), [path.basename(sourcePath), 'cli.log', 'before.png', 'second.png']);
  assert.equal(links[0].offset, sourceOffset);
  assert.match(links[0].label, /第 4 行/);
  assert.equal(reason, 'No matching widget');
  assert.equal(elapsedMs, 650);
  assert.deepEqual(elementWaits, [{ condition: 'visible', budgetMs: 400, elapsedMs: 550, satisfied: false }]);
  assert.equal(links[2].screenshotPhase, 'before');
  assert.equal(links[3].screenshotPhase, 'failure');
  assert.match((await evidenceImage(links[2]))!.image, /^data:image\/png;base64,/);
  await fs.appendFile(links[2].file, 'modified');
  assert.equal(await evidenceImage(links[2]), undefined);
  const completed = await replayEvidence({ artifactsDir, attemptDir }, 'first');
  assert.match(completed.links[0].label, /跳到执行 YAML/);
  assert.deepEqual(completed.links.map(link => path.basename(link.file)), [path.basename(sourcePath), 'cli.log', 'first.png']);
  await fs.appendFile(path.join(attemptDir, sourcePath), '# changed\n');
  assert.deepEqual((await replayEvidence({ artifactsDir, attemptDir })).links.map(link => path.basename(link.file)), ['cli.log', 'before.png', 'second.png']);
});

test('uses one verified fault report without attaching events to the wrong retry', async t => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harmony-fault-'));
  t.after(() => fs.rm(artifactsDir, { recursive: true, force: true }));
  const attemptDir = path.join(artifactsDir, 'run', 'attempt');
  await fs.mkdir(attemptDir, { recursive: true });
  const identity = { runId: 'run', attemptId: 'attempt' };
  const writeDoc = (file: string, kind: string, data: object) => fs.writeFile(path.join(attemptDir, file),
    JSON.stringify({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, data: { ...identity, ...data } }));
  const file = path.join(attemptDir, 'harmonyos-faults.json');
  const faults = Buffer.from(JSON.stringify({
    protocol: 'maestro.harmonyos.fault-report', schemaVersion: 1, ...identity, appId: 'demo.target',
    flowPath: 'C:\\flows\\main.yaml', state: 'complete', events: [
      { event: 'JS_ERROR', stepId: 'first', reason: 'exception\nstacktrace' },
      { event: 'APP_FREEZE', stepId: null, reason: 'event time uncertain' },
    ],
  }));
  await Promise.all([
    fs.writeFile(file, faults),
    writeDoc('result.json', 'runResult', { failedStepId: 'second' }),
    writeDoc('evidence-index.json', 'evidenceIndex', { entries: [
      { stepId: null, evidence: [{ kind: 'log', state: 'available', path: 'harmonyos-faults.json', sha256: replayFileHash(faults) }] },
      { stepId: 'first', evidence: [] }, { stepId: 'second', evidence: [] },
    ] }),
  ]);
  const replay = { artifactsDir, attemptDir };
  const first = await replayEvidence(replay, 'first');
  assert.deepEqual(first.links.map(link => link.file), [file]);
  assert.deepEqual(first.faultSummaries, ['main.yaml · demo.target · 步骤执行期间 · JS_ERROR · exception']);
  assert.deepEqual((await replayEvidence(replay, 'second')).faultSummaries, []);
  assert.match((await replayEvidence(replay)).faultSummaries?.[1] ?? '', /步骤未确认 · APP_FREEZE/);
  await fs.appendFile(file, '\n');
  assert.deepEqual((await replayEvidence(replay, 'first')).faultSummaries, []);
});
