import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative } from './build-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitForPort(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > 30000) reject(new Error('vite did not start'));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

await buildNative();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const vite = spawn('npm', ['exec', 'vite', '--', '--port', '5173', '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env,
});
await waitForPort(5173);
const electron = spawn('npm', ['exec', 'electron', '--', '.'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...env, MCSEEDMAP_DEV_SERVER: 'http://127.0.0.1:5173', AIO_DEV: '1' },
});
electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
