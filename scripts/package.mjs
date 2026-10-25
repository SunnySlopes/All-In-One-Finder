import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNative, ensureElectronBinary } from './build-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AIO_SMOKE;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * portable.nsi 是 electron-builder 内置模板，默认以
 *   ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0"
 * 启动内层应用。部分 Windows 环境（受限沙箱 / 安全软件）会让 Chromium 沙箱在
 * 启动阶段崩溃，双击时表现为“没有任何窗口”。这里给内层应用固定补上
 * --no-sandbox，保证双击 portable exe 能启动。
 *
 * 模板属于 node_modules，npm install 后会被还原，所以每次打包前重新 patch。
 */
function patchPortableNsi() {
  const file = path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'portable.nsi');
  if (!fs.existsSync(file)) {
    throw new Error(`portable.nsi not found: ${file}`);
  }
  const original = 'ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME} $R0" $0';
  const patched = 'ExecWait "$INSTDIR\\${APP_EXECUTABLE_FILENAME} --no-sandbox $R0" $0';
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes(patched)) return;
  if (!text.includes(original)) {
    throw new Error('portable.nsi layout changed; cannot inject --no-sandbox');
  }
  text = text.replace(original, patched);
  fs.writeFileSync(file, text, 'utf8');
}

// Electron 42+: binary is not fetched on npm install; packaging needs dist/.
ensureElectronBinary();
buildNative();
run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
patchPortableNsi();
run(process.execPath, [
  path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--win', 'portable',
  '--config', 'electron-builder.yml',
]);

// 默认不打签名，避免自签证书污染本机信任库、并在别的机器上仍然报警。
// 如需正式签名，直接使用 electron-builder 官方环境变量：
//   CSC_LINK / CSC_KEY_PASSWORD
