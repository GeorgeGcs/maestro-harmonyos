import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { LiveTrace } from '../src/live-trace';

test('live trace waits for a complete line and keeps repeated child calls separate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = randomUUID(), attemptId = randomUUID(), flowExecutionId = randomUUID();
  const attemptDir = path.join(root, runId, attemptId);
  const directory = path.join(attemptDir, 'flows', 'dated', 'main');
  await fs.mkdir(directory, { recursive: true });
  const tracePath = path.join(directory, 'retry-trace.jsonl');
  const header = { protocol: 'maestro.harmonyos.retry-trace', schemaVersion: 2, runId, attemptId, flowExecutionId,
    event: 'traceStarted', flowPath: path.join(root, 'main.yaml') };
  await fs.writeFile(tracePath, JSON.stringify(header) + '\n');
  const trace = new LiveTrace(attemptDir);
  let number = 0;
  const line = (data: object) => JSON.stringify({ ...data, sequence: number++, flowExecutionId });
  async function append(...events: string[]) { await fs.appendFile(tracePath, events.join('\n') + '\n'); }
  const sha = '0'.repeat(64);
  const start = (stepId: string, executionSequence: number, file: string, parent?: number) =>
    line({ event: 'stepStarted', stepId, executionSequence, commandName: parent === undefined ? 'RunFlowCommand' : 'TapOnElementCommand',
      parentExecutionSequence: parent, flowScopeOwner: parent, sourcePath: `sources/${sha}.yaml`, sourceSha256: sha,
      sourceIdentity: path.join(root, file), sourceOffset: 3 });
  const finish = (stepId: string, executionSequence: number, outcome: string) =>
    line({ event: 'stepFinished', stepId, executionSequence, outcome });
  const callA = randomUUID(), stepA = randomUUID(), callB = randomUUID(), stepB = randomUUID();
  await append(start(callA, 0, 'main.yaml'));
  const complete = start(stepA, 1, '子.yaml', 0);
  const bytes = Buffer.from(complete);
  const cut = bytes.indexOf(Buffer.from('子')) + 1;
  await fs.appendFile(tracePath, bytes.subarray(0, cut));
  assert.equal((await trace.read()).current?.id, callA);
  await fs.appendFile(tracePath, Buffer.concat([bytes.subarray(cut), Buffer.from('\n')]));
  const during = await trace.read();
  assert.equal(during.current?.id, stepA);
  assert.equal(during.flows[0].subflows[0].child, '子.yaml');
  await append(finish(stepA, 1, 'Completed'), finish(callA, 0, 'Completed'),
    start(callB, 2, 'main.yaml'), start(stepB, 3, '子.yaml', 2), finish(stepB, 3, 'Failed'), finish(callB, 2, 'Failed'),
    line({ event: 'flowFinished', success: false }));
  const after = await trace.read();
  assert.deepEqual(after.flows[0].subflows.map(step => [step.id, step.state]), [[callA, '通过'], [callB, '失败']]);
  assert.equal(during.current.state, '运行中');
  assert.equal(after.current, undefined);
  assert.equal(trace.failureStep(callB), stepB);
});
