import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyEvidence } from '../ci/verify-state.mjs';
import { artifact, digestPattern, hash, hashFile, key, readBytes, readJson, requireValue, samePath, uuid } from './io.mjs';

/** Replays observations only; it never executes or retries a command. */
export function verifyTrace(summary, events, evidenceSteps, frozenSourceHashes) {
  requireValue(summary.protocol === 'maestro.harmonyos.retry-trace' && [1, 2].includes(summary.schemaVersion) && summary.state === 'complete' &&
    summary.traceCompleted === true && uuid.test(summary.flowExecutionId), 'Retry summary is incomplete or unsupported.');
  const [header, ...records] = events;
  requireValue(header?.event === 'traceStarted' && ['protocol', 'schemaVersion', 'runId', 'attemptId', 'flowExecutionId', 'flowPath', 'flowSha256']
    .every(field => header[field] === summary[field]), 'Retry header belongs to another execution.');
  const steps = new Map(), ids = new Set(), blocks = new Map(), counts = {}, coverage = {};
  let lastTime = -1, retryUsed = false, optionalRetryUsed = false, ended = null;
  function frames(value) {
    requireValue(Array.isArray(value), 'Missing retry context.');
    const used = new Set();
    value.forEach((frame, index) => {
      const block = blocks.get(frame.retryInvocationId);
      requireValue(block && !used.has(frame.retryInvocationId) && !block.ended && block.active === frame.tryNo &&
        block.stepId === frame.retryCommandStepId && isDeepStrictEqual(block.parents, value.slice(0, index)), 'Retry frame does not identify the active attempt.');
      used.add(frame.retryInvocationId);
    });
  }
  for (const [sequence, event] of records.entries()) {
    requireValue(event.sequence === sequence && event.flowExecutionId === summary.flowExecutionId &&
      Number.isSafeInteger(event.elapsedNanos) && event.elapsedNanos >= lastTime, 'Retry event order is missing, duplicated, or invalid.');
    lastTime = event.elapsedNanos;
    requireValue(!ended || event.event === 'traceCompleted', 'An execution event appears after Flow completion.');
    if (event.event === 'stepStarted') {
      requireValue(event.executionSequence === steps.size && uuid.test(event.stepId) && !ids.has(event.stepId), 'Step identity or execution order is duplicated.');
      const entry = evidenceSteps.get(event.stepId);
      requireValue(entry && (event.parentExecutionSequence === null || steps.get(event.parentExecutionSequence)?.ended === false), 'Step has no evidence or active parent.');
      frames(event.retryContext);
      requireValue(Array.isArray(event.optionalAncestorSequences) && typeof event.commandOptional === 'boolean' && typeof event.selectorOptional === 'boolean', 'Step optional context is missing.');
      for (const ancestor of event.optionalAncestorSequences) {
        const value = steps.get(ancestor);
        requireValue(value?.ended === false && (value.event.commandOptional || value.event.selectorOptional), 'Optional ancestor is not an active optional command.');
      }
      if (event.sourcePath === null) requireValue(entry.source === null && event.sourceOrigin === 'generated', 'Generated step source differs.');
      else requireValue(entry.source?.flow === event.sourcePath && entry.source.commandIndex === event.commandIndex &&
        entry.source.commandName === event.commandName && digestPattern.test(event.sourceSha256) && frozenSourceHashes.has(event.sourceSha256), 'Step source differs from the frozen sources or v1 evidence.');
      if (summary.schemaVersion === 2) requireValue(Object.hasOwn(event, 'sourceIdentity') &&
        (event.sourcePath === null ? event.sourceIdentity === null : event.sourceOrigin === 'yaml' &&
          typeof event.sourceIdentity === 'string' && path.isAbsolute(event.sourceIdentity)), 'Version 2 step source identity is missing or invalid.');
      steps.set(event.executionSequence, { event, ended: false, outcome: null }); ids.add(event.stepId);
    } else if (['stepFinished', 'stepInterrupted'].includes(event.event)) {
      const step = steps.get(event.executionSequence);
      requireValue(step && !step.ended && step.event.stepId === event.stepId, 'Step terminal event has no matching start.');
      for (const field of ['sourcePath', 'sourceSha256', 'commandIndex', 'commandName', 'sourceOffset', 'sourceOrigin', 'retryContext',
        'parentExecutionSequence', 'flowScopeOwner', 'phase', 'commandOptional', 'selectorOptional', 'optionalAncestorSequences',
        ...(summary.schemaVersion === 2 ? ['sourceIdentity'] : [])]) {
        requireValue(isDeepStrictEqual(step.event[field], event[field]), 'Step context changed during execution.');
      }
      frames(event.retryContext);
      const outcome = event.event === 'stepInterrupted' ? 'Interrupted' : event.outcome;
      requireValue(['Completed', 'Warned', 'Skipped', 'Failed', 'Interrupted'].includes(outcome) &&
        (outcome !== 'Interrupted' || event.outcome === null), 'Unknown raw command outcome.');
      const status = evidenceSteps.get(event.stepId).status;
      requireValue(outcome === 'Completed' ? status === 'passed' : ['Warned', 'Skipped'].includes(outcome) ? status === 'skipped' :
        ['failed', 'blocked', 'cancelled', 'unknown'].includes(status), 'Raw command outcome and v1 step disagree.');
      step.ended = true; step.outcome = outcome;
      counts[outcome] = (counts[outcome] ?? 0) + 1; (coverage[outcome] ??= []).push(event.executionSequence);
    } else if (event.event.startsWith('retry')) {
      const owner = steps.get(event.executionSequence);
      requireValue(owner && !owner.ended && owner.event.stepId === event.retryCommandStepId &&
        owner.event.commandName === 'RetryCommand' && owner.event.commandOptional === event.optional &&
        isDeepStrictEqual(owner.event.retryContext, event.retryContext), 'Retry owner differs from its actual command.');
      frames(event.retryContext);
      requireValue(uuid.test(event.retryInvocationId) && Number.isInteger(event.maxRetries) && event.maxRetries >= 0 && event.maxRetries <= 3 &&
        typeof event.optional === 'boolean', 'Invalid retry block declaration.');
      requireValue(event.parentRetryInvocationId === (event.retryContext.at(-1)?.retryInvocationId ?? null) &&
        event.parentTryNo === (event.retryContext.at(-1)?.tryNo ?? null), 'Retry parent differs.');
      if (event.event === 'retryBlockStarted') {
        requireValue(!blocks.has(event.retryInvocationId), 'Retry invocation was reused.');
        blocks.set(event.retryInvocationId, { stepId: owner.event.stepId, parents: event.retryContext,
          optional: event.optional, maxRetries: event.maxRetries, last: 0, active: null, ended: false });
      } else {
        const block = blocks.get(event.retryInvocationId);
        requireValue(block && !block.ended && block.stepId === owner.event.stepId && block.optional === event.optional &&
          block.maxRetries === event.maxRetries, 'Retry event does not match its block.');
        if (event.event === 'retryTryStarted') {
          requireValue(block.active === null && event.tryNo === block.last + 1 && event.tryNo <= block.maxRetries + 1, 'Retry attempt order differs.');
          block.last = event.tryNo; block.active = event.tryNo;
          if (event.tryNo > 1) { retryUsed = true; optionalRetryUsed ||= block.optional; }
        } else if (event.event === 'retryTryFinished') {
          requireValue(block.active !== null && block.active === event.tryNo && ['completed', 'failed', 'interrupted'].includes(event.outcome), 'Retry attempt completion differs.');
          requireValue([...steps.values()].every(step => step.ended || !step.event.retryContext.some(frame => frame.retryInvocationId === event.retryInvocationId)), 'Retry ended with unfinished steps.');
          block.active = null;
        } else if (event.event === 'retryScheduled') {
          requireValue(block.active === null && event.tryNo === block.last + 1 && event.tryNo <= block.maxRetries + 1, 'Retry schedule differs.');
        } else if (event.event === 'retryBlockFinished') {
          requireValue(block.active === null && ['completed', 'failed', 'interrupted'].includes(event.outcome), 'Retry block ended while active.'); block.ended = true;
        } else throw new Error('Unknown retry event.');
      }
    } else if (event.event === 'flowFinished') {
      requireValue(ended === null && (event.success === null || typeof event.success === 'boolean') &&
        event.lastExecutionSequence === steps.size - 1 && event.expectedEventCount === records.length &&
        [...steps.values()].every(step => step.ended) && [...blocks.values()].every(block => block.ended), 'Flow ended with missing execution records.');
      ended = event;
    } else if (event.event === 'traceCompleted') {
      requireValue(ended && sequence === records.length - 1 && event.expectedEventCount === records.length, 'Invalid completion marker.');
    } else throw new Error('Unknown trace event.');
  }
  requireValue(ended && records.at(-1)?.event === 'traceCompleted' && summary.eventCount === records.length &&
    summary.expectedEventCount === records.length && summary.stepCount === steps.size && summary.retryUsed === retryUsed &&
    summary.optionalRetryUsed === optionalRetryUsed && isDeepStrictEqual(summary.outcomeCounts, counts) &&
    isDeepStrictEqual(summary.coverageIndex, coverage), 'Retry summary does not match its raw events.');
  const firstPassStatus = ended.success === true && !retryUsed ? 'passed' : 'not_passed';
  requireValue(summary.firstPassStatus === firstPassStatus, 'Retry first-pass summary differs from actual attempts.');
  return { steps: [...steps.values()], stepIds: [...ids], success: ended.success, retryUsed, optionalRetryUsed, firstPassStatus };
}

export async function verifyAttemptInput(result, index, agentRoot, unit, profile) {
  const evidence = await verifyEvidence(result, index, agentRoot), data = result.data;
  const base = path.join(agentRoot, 'runs', data.runId, data.attemptId);
  const inputFile = await artifact(base, data.input.path), input = (await readJson(inputFile)).value;
  requireValue(input.kind === 'flow' && input.deviceId === data.deviceId && input.request, 'Registered input is not this device Flow invocation.');
  const registered = input.request;
  const registeredSources = new Map();
  const frozen = new Map(unit.sources.map(file => [key(file.path), file.sha256]));
  function register(source) {
    requireValue(typeof source.path === 'string' && typeof source.content === 'string' && typeof source.sha256 === 'string' &&
      digestPattern.test(source.sha256) && hash(Buffer.from(source.content, 'utf8')) === source.sha256, 'Registered Flow content differs from its hash.');
    const identity = key(source.path);
    requireValue(frozen.get(identity) === source.sha256, 'Executed input was not present in the frozen sources.');
    requireValue(!registeredSources.has(identity) || registeredSources.get(identity) === source.sha256, 'Registered source identity has conflicting bytes.');
    registeredSources.set(identity, source.sha256);
  }
  for (const source of registered.sources ?? []) for (const file of source.files ?? []) {
    register(file);
    for (const dependency of file.dependencies ?? []) register(dependency);
  }
  for (const flow of unit.requiredTopLevelFlows) requireValue(registeredSources.get(key(flow.path)) === flow.sha256, 'Required Flow was not registered for this attempt.');
  const configuration = registered.configuration;
  requireValue(configuration?.ability === profile.abilityName && (configuration.module ?? null) === profile.moduleName &&
    configuration.environment?.APP_ID === profile.bundleId, 'Registered application profile differs.');
  for (const [name, digest] of Object.entries(profile.environmentHashes)) {
    requireValue(typeof configuration.environment[name] === 'string' && hash(Buffer.from(configuration.environment[name])) === digest, 'Registered parameter differs from the frozen value.');
  }
  return { evidence, base, data, registeredSources };
}

export async function inspectAttempt(result, index, agentRoot, unit, profile, verified = null) {
  const { evidence, base, data, registeredSources } = verified ?? await verifyAttemptInput(result, index, agentRoot, unit, profile);
  const stepEntries = new Map(index.data.entries.filter(entry => entry.stepId !== null).map(entry => [entry.stepId, entry]));
  const references = new Map();
  for (const entry of index.data.entries) for (const item of entry.evidence) if (item.state === 'available') {
    const previous = references.get(item.path);
    requireValue(!previous || previous.sha256 === item.sha256, 'Evidence references disagree on a file hash.');
    references.set(item.path, item);
  }
  const summaries = [...references.values()].filter(item => item.kind === 'log' && path.posix.basename(item.path) === 'retry-summary.json');
  requireValue(summaries.length > 0, 'No retained retry summaries were found in this attempt evidence.');
  const observedFlows = [], allStepIds = new Set(), flowIds = new Set();
  const sourceHashes = new Set(registeredSources.values()), identitiesByHash = new Map();
  for (const [identity, digest] of registeredSources) {
    if (!identitiesByHash.has(digest)) identitiesByHash.set(digest, []);
    identitiesByHash.get(digest).push(identity);
  }
  let coverageComplete = true, retryUsed = false;
  for (const reference of summaries) {
    const summaryPath = await artifact(base, reference.path), summary = (await readJson(summaryPath)).value;
    requireValue(summary.runId === data.runId && summary.attemptId === data.attemptId && !flowIds.has(summary.flowExecutionId), 'Retry summary belongs to another or duplicate execution.');
    flowIds.add(summary.flowExecutionId);
    const expected = unit.requiredTopLevelFlows.find(flow => samePath(flow.path, summary.flowPath) && flow.sha256 === summary.flowSha256);
    requireValue(expected && !observedFlows.some(flow => samePath(flow.path, expected.path)), 'Unexpected or duplicate top-level Flow execution.');
    requireValue(summary.tracePath === 'retry-trace.jsonl', 'Unexpected retry trace name.');
    const relativeTrace = path.posix.join(path.posix.dirname(reference.path), summary.tracePath);
    const retainedTrace = references.get(relativeTrace);
    requireValue(retainedTrace?.kind === 'log' && retainedTrace.sha256 === summary.traceSha256, 'Retry trace is not bound to the v1 evidence index.');
    const traceFile = await artifact(base, relativeTrace), bytes = await readBytes(traceFile, 64 * 1024 * 1024);
    requireValue(hash(bytes) === summary.traceSha256, 'Retry trace hash differs.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    requireValue(text.endsWith('\n'), 'Retry trace is truncated.');
    const parsed = text.trimEnd().split('\n').map(line => JSON.parse(line));
    const checked = verifyTrace(summary, parsed, stepEntries, sourceHashes);
    const sourceIdentities = new Map();
    for (const step of checked.steps) if (step.event.sourcePath !== null) {
      requireValue(await hashFile(await artifact(base, step.event.sourcePath)) === step.event.sourceSha256, 'Archived step source differs.');
      if (summary.schemaVersion === 2) {
        const identity = key(step.event.sourceIdentity);
        requireValue(registeredSources.get(identity) === step.event.sourceSha256, 'Step source identity differs from the registered frozen source.');
        sourceIdentities.set(step.event.executionSequence, identity);
      } else {
        // Version 1 archives are content-addressed. Equal bytes from two registered
        // paths cannot establish which source actually supplied this command.
        const identities = identitiesByHash.get(step.event.sourceSha256);
        if (identities?.length === 1) sourceIdentities.set(step.event.executionSequence, identities[0]);
      }
    }
    for (const id of checked.stepIds) { requireValue(!allStepIds.has(id), 'An evidence step is shared by distinct Flow executions.'); allStepIds.add(id); }
    const covered = expected.requiredSteps.every(required => checked.steps.some(step => step.outcome === 'Completed' &&
      sourceIdentities.get(step.event.executionSequence) === key(required.sourcePath) &&
      step.event.sourceSha256 === required.sourceSha256 && step.event.commandIndex === required.commandIndex &&
      step.event.commandOptional === false && step.event.selectorOptional === false && step.event.optionalAncestorSequences.length === 0 &&
      (required.role !== 'assertion' || /^Assert/.test(step.event.commandName))));
    coverageComplete &&= covered; retryUsed ||= checked.retryUsed;
    observedFlows.push({ path: expected.path, sha256: expected.sha256, flowExecutionId: summary.flowExecutionId,
      success: checked.success, covered, retryUsed: checked.retryUsed, summaryPath: reference.path,
      summarySha256: reference.sha256, tracePath: relativeTrace, traceSha256: summary.traceSha256 });
  }
  requireValue(allStepIds.size === stepEntries.size, 'Retry records do not account for every v1 step.');
  if (data.status === 'passed') requireValue(observedFlows.length === unit.requiredTopLevelFlows.length && observedFlows.every(flow => flow.success === true), 'Passed result has missing or unsuccessful required Flow executions.');
  coverageComplete &&= observedFlows.length === unit.requiredTopLevelFlows.length;
  return { evidence, coverageComplete, retryComplete: true, retryUsed, flows: observedFlows,
    videos: [...references.values()].filter(item => item.kind === 'video').map(item => ({ path: item.path, sha256: item.sha256 })) };
}
