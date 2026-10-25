const fs = require('node:fs');
const path = require('node:path');

/**
 * Trim Electron runtime files that All-In-One Finder does not use.
 * This runs after electron-builder has produced win-unpacked and before the
 * portable 7z archive is created, so the files never enter the installer.
 *
 * Canvas 2D only (no WebGL/WebGPU), so Dawn's DXIL compiler and the Vulkan
 * software fallback are not needed. Keep d3dcompiler_47.dll (ANGLE D3D11).
 *
 * If a GPU-less machine (RDP/VM) shows a blank window, set
 * AIO_KEEP_GPU_DLLS=1 to keep all three DLLs without editing this file.
 */
module.exports = async function afterPack(context) {
  if (process.env.AIO_KEEP_GPU_DLLS === '1') {
    console.log('[after-pack] AIO_KEEP_GPU_DLLS=1, keeping Electron GPU DLLs');
    return;
  }
  const dir = context.appOutDir;
  for (const name of ['dxcompiler.dll', 'vk_swiftshader.dll', 'vulkan-1.dll']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      console.log(`[after-pack] removed ${name}`);
    } else {
      console.log(`[after-pack] not present: ${name}`);
    }
  }
};
