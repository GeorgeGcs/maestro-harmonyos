import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { artifact, atomicJson, hash, hashFile, inside, key, noLinks, readBytes, requireValue, samePath } from '../validation/io.mjs';
import { inspectAttempt, verifyAttemptInput, verifyTrace } from '../validation/retry-evidence.mjs';
import { readMetadata } from './snapshot-build.mjs';

const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const reportFields = ['protocol', 'schemaVersion', 'status', 'startedAt', 'endedAt', 'inputPath', 'inputSha256',
  'inputSha256After', 'bytes', 'decoderPath', 'decoderSha256', 'decoderVersion', 'timeoutSeconds', 'arguments',
  'exitCode', 'timedOut', 'frames', 'progressEnded', 'error', 'stdout', 'stderr'];
const decodeArguments = input => ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', input,
  '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-enc_time_base', '-1', '-progress', 'pipe:1', '-nostats', '-f', 'null', 'NUL'];

// The timeout targets only the process this invocation created. A second bounded
// wait prevents inherited output handles from holding the collector indefinitely.
async function run(executable, args, milliseconds) {
  return new Promise(resolve => {
    const stdout = [], stderr = []; let size = 0, failure = null, timedOut = false, done = false, fallback;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = code => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(fallback);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ exitCode: code, timedOut, error: failure, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = message => {
      if (failure) return; failure = message;
      try { child.kill(); } catch { }
      fallback = setTimeout(() => finish(null), 1000);
    };
    const timer = setTimeout(() => { timedOut = true; stop('Video verifier process exceeded its time budget.'); }, milliseconds);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk); else stop('Video verifier output exceeded 2 MiB.');
    });
    child.once('error', error => { failure = error.message; finish(null); });
    child.once('close', code => finish(code));
  });
}

/** Independent quality assessment; original execution and release are never changed. */
export async function verifyVideos({ snapshot, result, index, agentRoot, outputDirectory, verifiedInput = null }) {
  const output = path.resolve(outputDirectory), reportPath = path.join(output, 'ci-videos.json');
  await noLinks(output); requireValue((await fs.stat(output)).isDirectory(), 'Video output parent must already exist.');
  const base = path.resolve(agentRoot, 'runs', result.data.runId, result.data.attemptId);
  requireValue(!samePath(base, output) && !inside(base, output) && !inside(output, base), 'Video output overlaps the original attempt.');
  try { await fs.lstat(reportPath); throw new Error('Video quality report already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = { protocol: 'maestro.harmonyos.ci-videos', schemaVersion: 1, status: 'failed', error: null,
    startedAt: new Date().toISOString(), endedAt: null, runId: result?.data?.runId ?? null, attemptId: result?.data?.attemptId ?? null,
    requiredFlows: [], coverage: [], videos: [], issues: [], originalFiles: [], releaseAssessment: 'not_performed' };
  const observations = new Map(), started = performance.now(); let deadline = Infinity;
  const remaining = () => deadline - performance.now();
  const time = () => requireValue(remaining() > 0, 'Video quality total time budget exceeded.');
  const issue = message => { report.issues.push(String(message)); };
  async function boundedHash(file) {
    time(); await noLinks(file); const before = await fs.stat(file);
    requireValue(before.isFile(), 'Video quality requires a regular file.');
    const handle = await fs.open(file, 'r'), digest = createHash('sha256'); let bytes = 0;
    try {
      const buffer = Buffer.alloc(256 * 1024);
      while (true) {
        time(); const read = await handle.read(buffer, 0, buffer.length, null); time();
        if (!read.bytesRead) break;
        bytes += read.bytesRead; requireValue(bytes <= before.size, 'Video quality file grew while hashing.');
        digest.update(buffer.subarray(0, read.bytesRead));
      }
    } finally { await handle.close(); }
    await noLinks(file); const after = await fs.stat(file); time();
    requireValue(bytes === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino,
      'Video quality file changed while hashing.');
    return digest.digest('hex');
  }
  async function observe(file, expected) {
    const actual = await boundedHash(file);
    requireValue(actual === expected, 'Video quality file hash differs: ' + file);
    const previous = observations.get(key(file));
    requireValue(!previous || previous.sha256 === expected, 'Conflicting video quality file hashes.');
    observations.set(key(file), { path: path.resolve(file), sha256: expected });
  }
  try {
    const policy = snapshot.videoPolicy, unit = snapshot.units[0];
    requireValue(policy && Array.isArray(policy.requiredFlows) && policy.requiredFlows.length > 0 &&
      new Set(policy.requiredFlows.map(key)).size === policy.requiredFlows.length && policy.requiredFlows.every(file =>
        path.isAbsolute(file) && unit.requiredTopLevelFlows.some(flow => samePath(flow.path, file))), 'Video policy has invalid required Flow identities.');
    requireValue(Number.isSafeInteger(policy.timeoutSeconds) && policy.timeoutSeconds >= 1 && policy.timeoutSeconds <= 3600 &&
      Number.isSafeInteger(policy.maxVideos) && policy.maxVideos >= 1 && policy.maxVideos <= 100 &&
      Number.isSafeInteger(policy.budgetSeconds) && policy.budgetSeconds >= policy.maxVideos * (policy.timeoutSeconds + 20) + 10 && policy.budgetSeconds <= 86400 &&
      typeof policy.ffmpeg?.path === 'string' && path.isAbsolute(policy.ffmpeg.path) && digest(policy.ffmpeg.sha256), 'Invalid bounded video policy.');
    deadline = started + policy.budgetSeconds * 1000; time();
    report.requiredFlows = [...policy.requiredFlows];
    requireValue(typeof snapshot.powershellPath === 'string' && path.isAbsolute(snapshot.powershellPath), 'An absolute PowerShell executable is required.');
    const script = path.join(snapshot.projectRoot, 'scripts/verify-recording.ps1');
    for (const file of [snapshot.powershellPath, script]) {
      const frozen = snapshot.toolFiles.filter(item => samePath(item.path, file));
      requireValue(frozen.length === 1 && digest(frozen[0].sha256), 'Video verifier implementation is not uniquely frozen.');
      await observe(file, frozen[0].sha256);
    }
    await observe(policy.ffmpeg.path, policy.ffmpeg.sha256);
    const verified = verifiedInput ?? await verifyAttemptInput(result, index, agentRoot, unit, snapshot.profiles.suite);
    requireValue(samePath(verified.base, base) && verified.data.runId === result.data.runId && verified.data.attemptId === result.data.attemptId,
      'Verified input belongs to another attempt.');
    const inspected = await inspectAttempt(result, index, agentRoot, unit, snapshot.profiles.suite, verified); time();
    const entries = new Map(index.data.entries.filter(entry => entry.stepId !== null).map(entry => [entry.stepId, entry]));
    const ownerByStep = new Map();
    for (const flow of inspected.flows) {
      const summaryFile = await artifact(base, flow.summaryPath), traceFile = await artifact(base, flow.tracePath);
      await observe(summaryFile, flow.summarySha256); await observe(traceFile, flow.traceSha256);
      const summaryDocument = await readMetadata(summaryFile);
      requireValue(summaryDocument.sha256 === flow.summarySha256, 'Video attribution summary changed.');
      const summary = summaryDocument.value;
      const bytes = await readBytes(traceFile, 64 * 1024 * 1024);
      requireValue(hash(bytes) === flow.traceSha256, 'Video attribution trace changed.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      requireValue(text.endsWith('\n'), 'Video attribution trace is truncated.');
      const checked = verifyTrace(summary, text.trimEnd().split('\n').map(line => JSON.parse(line)), entries, new Set(verified.registeredSources.values()));
      for (const stepId of checked.stepIds) {
        requireValue(!ownerByStep.has(stepId), 'Video attribution step is shared by Flow executions.');
        ownerByStep.set(stepId, flow.path);
      }
    }
    const videos = new Map();
    for (const entry of index.data.entries) for (const item of entry.evidence) if (item.kind === 'video') {
      if (item.state !== 'available') {
        requireValue(['missing', 'capture_failed'].includes(item.state) && item.path === null && item.sha256 === null, 'Invalid unavailable video reference.');
        issue('A requested video is unavailable: ' + item.state); continue;
      }
      const file = await artifact(base, item.path), identity = key(file), owner = ownerByStep.get(entry.stepId);
      requireValue(owner, 'Available video has no trace-bound top-level Flow: ' + item.path);
      const previous = videos.get(identity);
      requireValue(!previous || previous.sha256 === item.sha256 && samePath(previous.flowPath, owner), 'Video path is shared ambiguously by different Flows.');
      if (!previous) videos.set(identity, { path: item.path, sourcePath: file, sha256: item.sha256, flowPath: owner,
        status: 'failed', error: null, pointer: null, verification: null, process: null });
    }
    report.videos = [...videos.values()];
    requireValue(report.videos.length <= policy.maxVideos, 'Available videos exceed maxVideos.');
    report.coverage = policy.requiredFlows.map(flowPath => ({ flowPath, videos: report.videos.filter(video => samePath(video.flowPath, flowPath)).map(video => video.path) }));
    for (const flow of report.coverage) if (!flow.videos.length) issue('Required Flow has no unique retained video: ' + flow.flowPath);
    const directory = path.join(output, 'video-checks-' + randomUUID()); await noLinks(directory); await fs.mkdir(directory);
    for (const [position, video] of report.videos.entries()) {
      try {
        // Leave version-probe and cleanup time to verify-recording itself; do not
        // launch a decoder whose complete bounded invocation cannot fit.
        requireValue(remaining() >= (policy.timeoutSeconds + 20) * 1000, 'Insufficient remaining budget to start another video verifier.');
        await observe(video.sourcePath, video.sha256); await observe(policy.ffmpeg.path, policy.ffmpeg.sha256);
        const videoDirectory = path.join(directory, String(position + 1).padStart(4, '0')); await fs.mkdir(videoDirectory);
        const pointerPath = path.join(videoDirectory, 'report-pointer.json');
        requireValue(remaining() >= (policy.timeoutSeconds + 20) * 1000, 'Insufficient remaining budget to start another video verifier.');
        const processResult = await run(snapshot.powershellPath, ['-NoProfile', '-File', script, '-InputPath', video.sourcePath,
          '-FfmpegPath', policy.ffmpeg.path, '-OutputDirectory', videoDirectory, '-TimeoutSeconds', String(policy.timeoutSeconds),
          '-ReportPointerPath', pointerPath], (policy.timeoutSeconds + 20) * 1000);
        const processOut = path.join(videoDirectory, 'verifier.stdout.log'), processErr = path.join(videoDirectory, 'verifier.stderr.log');
        await fs.writeFile(processOut, processResult.stdout, { flag: 'wx' }); await fs.writeFile(processErr, processResult.stderr, { flag: 'wx' });
        video.process = { exitCode: processResult.exitCode, timedOut: processResult.timedOut, error: processResult.error, descendantExitConfirmed: null,
          stdout: { path: processOut, sha256: hash(processResult.stdout) }, stderr: { path: processErr, sha256: hash(processResult.stderr) } };
        await observe(processOut, video.process.stdout.sha256); await observe(processErr, video.process.stderr.sha256);
        const pointer = await readMetadata(pointerPath), value = pointer.value;
        requireValue(exact(value, ['protocol', 'schemaVersion', 'reportPath', 'reportSha256']) &&
          value.protocol === 'maestro.harmonyos.recording-report-pointer' && value.schemaVersion === 1 &&
          typeof value.reportPath === 'string' && path.isAbsolute(value.reportPath) && digest(value.reportSha256) &&
          samePath(path.dirname(path.dirname(value.reportPath)), videoDirectory) && /^recording-[0-9a-f]{32}$/.test(path.basename(path.dirname(value.reportPath))) &&
          path.basename(value.reportPath) === 'verification.json', 'Invalid or foreign recording report pointer.');
        video.pointer = { path: pointer.path, sha256: pointer.sha256 }; await observe(pointer.path, pointer.sha256);
        const native = await readMetadata(value.reportPath), decoded = native.value;
        video.verification = { path: native.path, sha256: native.sha256, report: decoded };
        await observe(native.path, value.reportSha256);
        const versionPath = path.join(path.dirname(native.path), 'version.log');
        const versionPresent = await fs.lstat(versionPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (versionPresent) await observe(versionPath, await boundedHash(versionPath));
        const expectedArguments = decodeArguments(video.sourcePath);
        requireValue(exact(decoded, reportFields) && decoded.protocol === 'maestro.harmonyos.recording-verification' && decoded.schemaVersion === 1 &&
          samePath(decoded.inputPath, video.sourcePath) && decoded.inputSha256 === video.sha256 && decoded.inputSha256After === video.sha256 &&
          samePath(decoded.decoderPath, policy.ffmpeg.path) && decoded.decoderSha256 === policy.ffmpeg.sha256 &&
          decoded.bytes === (await fs.stat(video.sourcePath)).size && decoded.bytes > 0 && decoded.timeoutSeconds === policy.timeoutSeconds &&
          Array.isArray(decoded.arguments) && decoded.arguments.length === expectedArguments.length &&
          decoded.arguments.every((value, position) => position === 8 ? samePath(value, video.sourcePath) : value === expectedArguments[position]) &&
          typeof decoded.decoderVersion === 'string' && decoded.decoderVersion.startsWith('ffmpeg version ') &&
          Number.isFinite(Date.parse(decoded.startedAt)) && Number.isFinite(Date.parse(decoded.endedAt)) &&
          Date.parse(decoded.endedAt) >= Date.parse(decoded.startedAt) && decoded.stdout === 'decode.stdout.log' && decoded.stderr === 'decode.stderr.log',
        'Recording report does not identify this input, decoder and invocation.');
        await observe(video.sourcePath, video.sha256); await observe(policy.ffmpeg.path, policy.ffmpeg.sha256);
        if (!processResult.timedOut && !processResult.error && Number.isInteger(decoded.exitCode)) video.process.descendantExitConfirmed = true;
        const out = await artifact(path.dirname(native.path), decoded.stdout), err = await artifact(path.dirname(native.path), decoded.stderr);
        const stdout = await readBytes(out, 4 * 1024 * 1024), stderr = await readBytes(err, 4 * 1024 * 1024);
        await observe(out, hash(stdout)); await observe(err, hash(stderr));
        requireValue(new TextDecoder('utf-8', { fatal: true }).decode(stderr).trim() === '', 'Decoder diagnostics were not empty.');
        const progress = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
        let largestFrame = -1;
        for (const match of progress.matchAll(/^frame=\s*([0-9]+)\s*$/gm)) largestFrame = Math.max(largestFrame, Number(match[1]));
        requireValue(largestFrame === decoded.frames && /^progress=end\s*$/m.test(progress), 'Decoder progress does not confirm the reported frames and completion.');
        requireValue(!processResult.error && !processResult.timedOut && processResult.exitCode === 0 &&
          decoded.status === 'passed' && decoded.exitCode === 0 && decoded.error === null && decoded.timedOut === false &&
          Number.isSafeInteger(decoded.frames) && decoded.frames > 0 && decoded.progressEnded === true, 'Full video decoding did not pass.');
        video.status = 'passed';
      } catch (error) { video.error = error.message; issue(video.path + ': ' + error.message); }
    }
  } catch (error) { issue(error.message); }
  for (const observed of observations.values()) {
    try { observed.sha256After = await boundedHash(observed.path); requireValue(observed.sha256After === observed.sha256, 'Video quality evidence changed before finalization.'); }
    catch (error) { observed.sha256After ??= null; issue(error.message + ': ' + observed.path); }
    report.originalFiles.push(observed);
  }
  report.status = report.issues.length ? 'failed' : 'passed'; report.error = report.issues[0] ?? null;
  report.endedAt = new Date().toISOString();
  await atomicJson(reportPath, report, true);
  return { ...report, path: reportPath, sha256: await hashFile(reportPath) };
}
