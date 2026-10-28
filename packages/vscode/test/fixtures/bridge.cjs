'use strict';
const readline = require('node:readline');
let busy = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'wait') return;
  if (request.method === 'invalid') return process.stdout.write('not-json\n');
  if (request.method === 'mismatch') return process.stdout.write(JSON.stringify({ id: request.id + 1, result: {} }) + '\n');
  if (request.method === 'failure') return process.stdout.write(JSON.stringify({ id: request.id, error: { code: 'STALE_SNAPSHOT', message: 'Refresh required' } }) + '\n');
  if (request.method === 'exit') return process.exit(9);
  if (request.method === 'snapshot') return process.stdout.write(JSON.stringify({ id: request.id, result: require('../../dist/test/snapshot.js').snapshot }) + '\n');
  if (request.method === 'action') return process.stdout.write(JSON.stringify({ id: request.id, result: { yaml: '- back' } }) + '\n');
  if (busy) return process.exit(10);
  busy = true;
  setTimeout(() => {
    const bytes = Buffer.from(JSON.stringify({ id: request.id, result: request.params }) + '\n', 'utf8');
    const position = bytes.indexOf(Buffer.from('熊')) + 1;
    process.stdout.write(bytes.subarray(0, position));
    setImmediate(() => { process.stdout.write(bytes.subarray(position)); busy = false; });
  }, 10);
});
