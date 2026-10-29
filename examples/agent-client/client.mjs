import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

const errorKinds = new Set(['assertion', 'environment', 'unsupported', 'timeout', 'cancelled', 'invalid_input', 'transport', 'internal']);
const expectedKinds = {
  'agent.describe': 'capabilities', 'agent.preflight': 'preflight',
  'agent.connect': 'session', 'agent.session': 'session', 'agent.release': 'session', 'agent.recover': 'recoveryReport',
  'agent.snapshot': 'snapshot', 'agent.action': 'runResult', 'agent.result': 'runResult',
  'agent.cancel': 'cancelAck', 'agent.evidence': 'evidenceIndex',
};

export class RequestTimeoutError extends Error {
  constructor(method, id) {
    super(`${method} response timed out (request ${id}); execution may still be active. Query the original attempt; do not resend its action.`);
    this.name = 'RequestTimeoutError'; this.method = method; this.requestId = id;
  }
}

export class RemoteError extends Error {
  constructor(error) {
    super(`${error.code}: ${error.message}`);
    this.name = 'RemoteError'; this.code = error.code; this.kind = error.kind; this.details = error.details;
  }
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function validateDocument(value, kind, versions = [1, 2]) {
  if (!object(value) || value.protocol !== 'maestro.harmonyos.agent' || !versions.includes(value.schemaVersion) ||
      value.kind !== kind || !Number.isSafeInteger(value.revision) || value.revision < 0 || !object(value.data)) {
    throw new Error(`Invalid ${kind} protocol document.`);
  }
  const stamp = value.observedAt;
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(stamp) ||
      !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString().slice(0, 19) !== stamp.slice(0, 19)) {
    throw new Error('Invalid UTC observation timestamp.');
  }
  return value;
}

function stateKey(document) {
  const { kind, data } = document;
  if (kind === 'session') return `session:${data.sessionId}`;
  if (kind === 'runResult' || kind === 'evidenceIndex') return `${kind}:${data.runId}:${data.attemptId}`;
  return undefined;
}

/** Local JSONL transport. Request timeouts never cause an action to be sent twice. */
export class AgentClient {
  constructor(child, { requestTimeoutMs = 30_000, maxResponseBytes = 32 * 1024 * 1024, diagnostics } = {}) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.pending = new Map();
    this.abandoned = new Set();
    this.revisions = new Map();
    this.nextId = 0;
    this.failure = null;
    this.ended = false;
    this.parts = []; this.lineBytes = 0;
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    child.stdout.on('data', chunk => this.read(chunk));
    child.stdout.on('end', () => {
      if (this.lineBytes) this.fail(new Error('Bridge stdout ended in a truncated JSONL response.'));
    });
    child.stderr.on('data', chunk => diagnostics?.write(chunk));
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.on('close', (code, signal) => {
      this.ended = true;
      if (!this.failure && this.pending.size) this.fail(new Error(`Bridge exited before replying (code ${code}, signal ${signal ?? 'none'}).`), false);
      this.resolveExit({ code, signal, forced: this.forced === true });
    });
  }

  static spawn(executable, args, options = {}) {
    const { cwd, env, ...transport } = options;
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return new AgentClient(child, transport);
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended || this.child.stdin.writableEnded) return Promise.reject(new Error('Bridge is closed.'));
    if (!(method in expectedKinds) || !object(params)) return Promise.reject(new Error('Unknown agent method or invalid parameters.'));
    const id = ++this.nextId;
    if (!Number.isSafeInteger(id)) return Promise.reject(new Error('Request identifiers exhausted.'));
    let line;
    try { line = Buffer.from(JSON.stringify({ id, method, params }) + '\n'); }
    catch (error) { return Promise.reject(error); }
    if (line.length - 1 > 64 * 1024) return Promise.reject(new Error('Request exceeds the bridge 64 KiB limit.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); this.abandoned.add(id);
        reject(new RequestTimeoutError(method, id));
      }, timeoutMs);
      const version = method === 'agent.describe' ? (params.schemaVersion ?? this.schemaVersion ?? 1) : (this.schemaVersion ?? 1);
      this.pending.set(id, { method, version, resolve, reject, timer });
      this.child.stdin.write(line, error => { if (error) this.fail(error); });
    });
  }

  read(chunk) {
    if (this.failure) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        this.parts.push(part); this.lineBytes += part.length;
        if (this.lineBytes > this.maxResponseBytes) throw new Error('Bridge response exceeded its byte limit.');
        if (end < 0) break;
        const bytes = Buffer.concat(this.parts, this.lineBytes);
        this.parts = []; this.lineBytes = 0;
        const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        this.receive(response);
        start = end + 1;
      }
    } catch (error) { this.fail(error); }
  }

  receive(response) {
    if (!object(response) || !Number.isSafeInteger(response.id) || response.id < 1 ||
        Object.keys(response).some(key => !['id', 'result', 'error'].includes(key)) ||
        Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) throw new Error('Malformed bridge response envelope.');
    const pending = this.pending.get(response.id);
    if (!pending) {
      if (this.abandoned.delete(response.id)) return; // A late response is not a reason to execute again.
      throw new Error('Unsolicited or duplicate bridge response.');
    }
    if (Object.hasOwn(response, 'error')) {
      const error = response.error;
      if (!object(error) || !errorKinds.has(error.kind) || typeof error.code !== 'string' ||
          !/^[A-Z][A-Z0-9_]*$/.test(error.code) || typeof error.message !== 'string') throw new Error('Malformed agent error.');
      this.pending.delete(response.id); clearTimeout(pending.timer); pending.reject(new RemoteError(error));
      return;
    }
    const result = validateDocument(response.result, expectedKinds[pending.method], [pending.version]);
    if (pending.method === 'agent.describe') this.schemaVersion = result.schemaVersion;
    const key = stateKey(result);
    if (key) {
      const previous = this.revisions.get(key);
      if (previous !== undefined && result.revision < previous) throw new Error('Agent state revision moved backwards.');
      this.revisions.set(key, result.revision);
    }
    this.pending.delete(response.id); clearTimeout(pending.timer); pending.resolve(result);
  }

  fail(error, terminate = true) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    if (terminate && !this.ended) this.child.kill(); // Only this client's child, never HDC or another session.
  }

  async close(timeoutMs = 5_000) {
    if (!this.ended) this.child.stdin.end();
    let timer;
    const exited = await Promise.race([this.exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    clearTimeout(timer);
    if (exited) return exited;
    this.forced = true;
    this.child.kill();
    return this.exit; // A killed bridge is not evidence of remote resource cleanup.
  }
}
