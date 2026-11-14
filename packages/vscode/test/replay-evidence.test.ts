import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { replayEvidence, replayFileHash } from '../src/replay-evidence';

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
    ...['first', 'second'].map((stepId, index) => ({
      event: 'stepFinished', flowExecutionId, stepId, outcome: 'Failed',
      sourcePath, sourceSha256, sourceOffset, retryContext: [{ tryNo: index + 1 }]
    }))
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const writeDoc = (file: string, kind: string, data: object) => fs.writeFile(path.join(attemptDir, file),
    JSON.stringify({ protocol: 'maestro.harmonyos.agent', schemaVersion: 1, kind, data: { runId, attemptId, ...data } }));
  await Promise.all([
    fs.writeFile(path.join(artifactsDir, 'cli.log'), 'console'),
    fs.writeFile(path.join(attemptDir, 'retry-trace.jsonl'), trace),
    fs.writeFile(path.join(attemptDir, sourcePath), yaml),
    fs.writeFile(path.join(attemptDir, 'first.png'), 'first screenshot'),
    fs.writeFile(path.join(attemptDir, 'second.png'), 'second screenshot'),
    writeDoc('result.json', 'runResult', { failedStepId: 'second' }),
    writeDoc('evidence-index.json', 'evidenceIndex', { entries: [
      { stepId: 'first', evidence: [{ kind: 'screenshot', state: 'available', path: 'first.png' }] },
      { stepId: 'second', evidence: [
        { kind: 'screenshot', state: 'available', phase: 'failure', path: 'second.png' },
        { kind: 'log', state: 'available', path: 'retry-trace.jsonl', sha256: replayFileHash(trace) },
        { kind: 'log', state: 'available', path: '../../cli.log' }
      ] }
    ] })
  ]);
  const links = await replayEvidence({ artifactsDir, attemptDir });
  assert.deepEqual(links.map(link => path.basename(link.file)), [path.basename(sourcePath), 'cli.log', 'second.png']);
  assert.equal(links[0].offset, sourceOffset);
  assert.match(links[0].label, /第 4 行/);
  await fs.appendFile(path.join(attemptDir, sourcePath), '# changed\n');
  assert.deepEqual((await replayEvidence({ artifactsDir, attemptDir })).map(link => path.basename(link.file)), ['cli.log', 'second.png']);
});
