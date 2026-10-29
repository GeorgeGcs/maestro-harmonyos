import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateDocument } from './client.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const terminal = new Set(['passed', 'failed', 'blocked', 'cancelled', 'unknown']);

function contained(base, target) {
  const relative = path.relative(base, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function confinedFile(base, relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00-\x1f\x7f]/.test(relative) ||
      relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid relative artifact path.');
  }
  const root = await fs.realpath(base);
  const target = await fs.realpath(path.resolve(root, ...relative.split('/')));
  if (!contained(root, target)) throw new Error('Artifact escapes its attempt directory.');
  const file = await fs.open(target, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Artifact is not a regular file.');
    return await file.readFile();
  } finally { await file.close(); }
}

/** Validates concrete references, not just JSON shape. Uses only this attempt's declared output root. */
export async function verifyEvidence(result, index, artifactsRoot) {
  validateDocument(result, 'runResult'); validateDocument(index, 'evidenceIndex');
  const data = result.data;
  if (!uuid.test(data.runId) || !uuid.test(data.attemptId) || !terminal.has(data.status) ||
      index.data.runId !== data.runId || index.data.attemptId !== data.attemptId || !Array.isArray(index.data.entries)) {
    throw new Error('Result and evidence do not identify the same terminal attempt.');
  }
  const expected = path.resolve(artifactsRoot, 'runs', data.runId, data.attemptId);
  const actual = path.resolve(data.artifacts.baseDir);
  if (path.relative(expected, actual) !== '') throw new Error('Result belongs to an unexpected attempt directory.');
  const root = await fs.realpath(artifactsRoot);
  const base = await fs.realpath(expected);
  if (!contained(root, base)) throw new Error('Attempt directory escapes the configured output root.');
  let checkedFiles = 0;
  async function check(reference) {
    if (!reference || !hash.test(reference.sha256)) throw new Error('Invalid artifact hash.');
    const bytes = await confinedFile(base, reference.path);
    if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error(`Artifact hash differs: ${reference.path}`);
    checkedFiles++;
  }
  await check(data.input);
  if (data.flow !== null) await check(data.flow);
  const steps = new Set();
  let unavailable = 0;
  for (const entry of index.data.entries) {
    if (entry.stepId !== null) {
      if (!uuid.test(entry.stepId) || steps.has(entry.stepId)) throw new Error('Invalid or duplicate evidence step identity.');
      steps.add(entry.stepId);
    }
    if (!Array.isArray(entry.evidence)) throw new Error('Step evidence must be an array.');
    for (const item of entry.evidence) {
      if (item.state === 'available') await check(item);
      else if (item.state === 'missing' || item.state === 'capture_failed') {
        if (item.path !== null || item.sha256 !== null) throw new Error('Unavailable evidence claims a file.');
        unavailable++;
      } else throw new Error('Unknown evidence availability.');
    }
  }
  if (data.failedStepId !== null && !steps.has(data.failedStepId)) throw new Error('Failed step is absent from the evidence index.');
  if (!Array.isArray(data.artifacts.manifestPaths)) throw new Error('Missing manifest references.');
  for (const reference of data.artifacts.manifestPaths) await confinedFile(base, reference);
  if (data.artifacts.junitPath !== null) await confinedFile(base, data.artifacts.junitPath);
  await confinedFile(base, data.artifacts.evidenceIndexPath);
  return { checkedFiles, unavailable, steps: steps.size };
}

export async function verifyRecoveryReport(document, recoveryRoot) {
  validateDocument(document, 'recoveryReport', [2]);
  const { reportPath, reportSha256 } = document.data;
  if (typeof reportPath !== 'string' || !path.isAbsolute(reportPath) || !hash.test(reportSha256)) throw new Error('Invalid recovery report reference.');
  const root = await fs.realpath(recoveryRoot);
  const file = await fs.realpath(reportPath);
  if (!contained(root, file)) throw new Error('Recovery report escapes the explicitly trusted recovery root.');
  const bytes = await confinedFile(root, path.relative(root, file).split(path.sep).join('/'));
  if (createHash('sha256').update(bytes).digest('hex') !== reportSha256) throw new Error('Recovery report hash differs.');
  const audit = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!audit || typeof audit !== 'object' || Array.isArray(audit) || audit.schemaVersion !== 1 ||
      !Array.isArray(audit.issues)) throw new Error('Invalid recovery audit document.');
  for (const key of ['deviceId', 'sessionId', 'state', 'operations', 'pendingOperations', 'temporaryFiles']) {
    if (audit[key] !== document.data[key]) throw new Error(`Recovery audit does not match the response: ${key}`);
  }
  if (audit.state === 'complete' && audit.issues.length !== 0) throw new Error('Complete recovery audit still lists issues.');
  return { checkedFiles: 1 };
}
