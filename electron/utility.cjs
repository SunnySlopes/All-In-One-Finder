'use strict';

const nativePath = process.env.AIO_NATIVE;
if (!nativePath) {
  console.error('AIO_NATIVE is not set');
  process.exit(1);
}

const native = require(nativePath);

process.parentPort.on('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  port.on('message', (message) => {
    const { id, op, args } = message.data;
    try {
      const fn = native[op];
      if (typeof fn !== 'function') throw new Error(`unknown-op:${op}`);
      const result = args === undefined ? fn() : fn(args);
      if (Buffer.isBuffer(result)) {
        const pixels = new Uint8Array(result.byteLength);
        pixels.set(result);
        port.postMessage({ id, ok: true, result: pixels });
      } else port.postMessage({ id, ok: true, result });
    } catch (error) {
      port.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
    }
  });
  port.start();
});

process.parentPort.postMessage({ ready: true });
