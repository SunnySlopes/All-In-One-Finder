// Engine client for the regression harness: speaks the length-prefixed JSON
// protocol to `aio-engine --serve` (the same server the host runs via --engine),
// and exposes the add-on method names so native-regression.mjs can run unchanged.
import { spawn } from 'node:child_process';

const OPS = [
  'versions', 'features', 'weirdness', 'lowySupports', 'biomeAt', 'structures', 'structureBounds',
  'renderTile', 'renderTiles', 'slimeMask',
  'searchStart', 'searchPoll', 'searchStop',
  'slimeFarmStart', 'slimeFarmPoll', 'slimeFarmStop',
  'witchSearchStart', 'witchSearchPoll', 'witchSearchStop',
  'riverSearchStart', 'riverSearchPoll', 'riverSearchStop',
  'fortressSearchStart', 'fortressSearchPoll', 'fortressSearchStop',
  'multiMonumentSearchStart', 'multiMonumentSearchPoll', 'multiMonumentSearchStop',
  'doubleMonumentSearchStart', 'doubleMonumentSearchPoll', 'doubleMonumentSearchStop',
  'trialStart', 'trialPoll', 'trialStop',
  'geodeStart', 'geodePoll', 'geodeStop',
];

export async function createEngineClient({ exe, dll, timeoutMs = 180000 }) {
  const child = spawn(exe, ['--serve', '--dll', dll], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  function dispatch(frame) {
    let message;
    try { message = JSON.parse(frame); } catch { return; }
    if (message.ready) { readyResolve(); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (!message.ok) item.reject(new Error(message.error || 'engine-error'));
    else if (typeof message.bin === 'string') item.resolve(Buffer.from(message.bin, 'base64'));
    else item.resolve(message.result);
  }

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const frame = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      dispatch(frame);
    }
  });
  child.on('error', (error) => readyReject(error));
  child.on('exit', (code) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`engine exited (${code})`));
    }
    pending.clear();
  });

  function send(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
  }

  function request(op, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`engine timeout: ${op}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send(args === undefined ? { id, op } : { id, op, args });
    });
  }

  await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('engine did not become ready')), 15000)),
  ]);

  const proxy = {};
  for (const op of OPS) proxy[op] = (args) => request(op, args);

  return {
    proxy,
    request,
    async close() {
      child.stdin.end();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
    },
  };
}
