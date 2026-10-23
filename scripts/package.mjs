import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative, ensureElectronBinary } from './build-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AIO_SMOKE;

// Electron 42+: binary is not fetched on npm install; packaging needs dist/.
ensureElectronBinary();
buildNative();
const web = spawnSync('npm', ['exec', 'vite', 'build'], { cwd: root, stdio: 'inherit', shell: true, env });
if (web.status !== 0) process.exit(web.status ?? 1);
const packed = spawnSync('npm', ['exec', 'electron-builder', '--', '--win', 'portable', '--config', 'electron-builder.yml'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env,
});
process.exit(packed.status ?? 1);
