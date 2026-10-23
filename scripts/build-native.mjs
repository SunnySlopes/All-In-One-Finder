import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gccBin = 'C:\\msys64\\ucrt64\\bin';
const gcc = path.join(gccBin, 'gcc.exe');
const gxx = path.join(gccBin, 'g++.exe');

function readU16(data, offset) {
  return data.readUInt16LE(offset);
}
function readU32(data, offset) {
  return data.readUInt32LE(offset);
}

function peExportNames(file) {
  const data = fs.readFileSync(file);
  const pe = readU32(data, 0x3c);
  if (data.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const coff = pe + 4;
  const sections = readU16(data, coff + 2);
  const optSize = readU16(data, coff + 16);
  const opt = coff + 20;
  const magic = readU16(data, opt);
  const exportRva = magic === 0x20b ? readU32(data, opt + 112) : readU32(data, opt + 96);
  const sec = opt + optSize;
  const table = [];
  for (let i = 0; i < sections; i++) {
    const off = sec + i * 40;
    table.push({
      va: readU32(data, off + 12),
      rawSize: readU32(data, off + 16),
      raw: readU32(data, off + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const item of table) {
      if (rva >= item.va && rva < item.va + Math.max(item.rawSize, 1)) return item.raw + (rva - item.va);
    }
    throw new Error(`unmapped rva ${rva}`);
  };
  const exp = rvaToOff(exportRva);
  const nameCount = readU32(data, exp + 24);
  const names = rvaToOff(readU32(data, exp + 32));
  const out = [];
  for (let i = 0; i < nameCount; i++) {
    let cursor = rvaToOff(readU32(data, names + i * 4));
    const start = cursor;
    while (data[cursor] !== 0) cursor++;
    out.push(data.toString('ascii', start, cursor));
  }
  return out;
}

export function nativeNodePath() {
  return path.join(root, 'native', 'build', 'allinone.node');
}

export function electronExePath() {
  return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
}

/** Electron 42+ no longer downloads its binary in postinstall; ensure dist/ exists. */
export function ensureElectronBinary() {
  const electronExe = electronExePath();
  if (fs.existsSync(electronExe)) return electronExe;
  const installJs = path.join(root, 'node_modules', 'electron', 'install.js');
  if (!fs.existsSync(installJs)) {
    throw new Error('Electron package missing. Run npm install first.');
  }
  console.log('Electron binary missing; running install-electron...');
  const installed = spawnSync(process.execPath, [installJs], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (installed.status !== 0) {
    throw new Error(
      'Failed to download Electron binary. Run: npx --no-install install-electron',
    );
  }
  if (!fs.existsSync(electronExe)) {
    throw new Error(`Electron not found at ${electronExe} after install-electron`);
  }
  return electronExe;
}

function writeNapiProxy(buildDir, exports) {
  const text = exports.map((name) =>
    `.globl ${name}\n${name}:\n    jmp *aio_slot_${name}(%rip)\n`).join('\n');
  const data = exports.map((name) =>
    `.globl aio_slot_${name}\naio_slot_${name}:\n    .quad 0\n`).join('\n');
  const asmPath = path.join(buildDir, 'napi_proxy.S');
  fs.writeFileSync(asmPath, `.section .text\n${text}\n.section .data\n${data}\n`);
  const slots = exports.map((name) => `{"${name}", &aio_slot_${name}}`).join(',\n    ');
  const decls = exports.map((name) => `void* aio_slot_${name};`).join('\n');
  fs.writeFileSync(path.join(buildDir, 'napi_bind.cpp'), `#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

extern "C" {
${decls}
}

namespace {
void bindNapi() __attribute__((constructor(101)));
void bindNapi() {
  HMODULE mod = GetModuleHandleW(nullptr);
  struct Item { const char* name; void** slot; };
  const Item items[] = {
    ${slots}
  };
  for (const Item& item : items) {
    *item.slot = reinterpret_cast<void*>(GetProcAddress(mod, item.name));
    if (!*item.slot) {
      fprintf(stderr, "missing native symbol %s\\n", item.name);
      abort();
    }
  }
}
}
`);
  const objPath = path.join(buildDir, 'napi_proxy.o');
  const assembled = spawnSync(gcc, ['-c', asmPath, '-o', objPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gccBin};${process.env.PATH || ''}` },
  });
  if (assembled.status !== 0) throw new Error(assembled.stderr || assembled.stdout || 'napi proxy assemble failed');
}

export function buildNative() {
  const electronExe = ensureElectronBinary();
  if (!fs.existsSync(gxx)) throw new Error(`UCRT64 g++ not found at ${gxx}`);
  const buildDir = path.join(root, 'native', 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const exports = peExportNames(electronExe).filter((name) => name.startsWith('napi_'));
  if (exports.length < 20) throw new Error(`expected napi exports from electron.exe, found ${exports.length}`);
  writeNapiProxy(buildDir, exports);
  const env = { ...process.env, PATH: `${gccBin};${process.env.PATH || ''}` };
  const configure = spawnSync('cmake', [
    '-S', path.join(root, 'native'),
    '-B', buildDir,
    '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_C_COMPILER=${gcc}`,
    `-DCMAKE_CXX_COMPILER=${gxx}`,
    `-DNODE_ADDON_API_DIR=${path.join(root, 'node_modules', 'node-addon-api').replaceAll('\\', '/')}`,
    `-DNODE_API_HEADERS_DIR=${path.join(root, 'node_modules', 'node-api-headers', 'include').replaceAll('\\', '/')}`,
  ], { stdio: 'inherit', env, cwd: root });
  if (configure.status !== 0) process.exit(configure.status ?? 1);
  const built = spawnSync('cmake', ['--build', buildDir], { stdio: 'inherit', env, cwd: root });
  if (built.status !== 0) process.exit(built.status ?? 1);
  if (!fs.existsSync(nativeNodePath())) throw new Error('native build did not produce allinone.node');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) buildNative();
