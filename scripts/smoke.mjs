import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative } from './build-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
buildNative();
const env = { ...process.env, AIO_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync('npm', ['exec', 'electron', '--', '--no-sandbox', '.'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env,
});
process.exit(run.status ?? 1);
