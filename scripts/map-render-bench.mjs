/**
 * Benchmark biome tile render cost under cubiomes-viewer-style scales.
 *
 * Usage:
 *   node scripts/map-render-bench.mjs
 *   node scripts/map-render-bench.mjs --workers 8 --workers 16
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineClient } from './engine-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const all = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(Number(args[++i]));
  }
  return out;
};

const enginePath = path.resolve(arg('--engine', path.join(root, 'native', 'build-engine', 'aio-engine.exe')));
const dllPath = path.resolve(arg('--dll', path.join(root, 'native', 'build-engine', 'allinone.dll')));
const seed = arg('--seed', '12345');
const mc = Number(arg('--mc', '30')); // MC_1_21_6
const sx = 128;
const sz = 128;
const repeats = Math.max(1, Number(arg('--repeats', '3')));

const hw = Number(arg('--hw', '32')); // logical CPUs for reporting defaults
const defaultWorkers = [...new Set([Math.max(1, Math.floor(hw / 2)), Math.min(16, hw), 8, 4].filter((n) => n > 0))].sort(
  (a, b) => a - b,
);
const workerList = all('--workers');
const workersToTry = workerList.length ? workerList : defaultWorkers;

/** Typical CSS viewport (~1400x900) tile counts at viewer-style active scales. */
function viewportTiles(scale, widthPx = 1400, heightPx = 900, ppb) {
  // ppb mid of the band where this scale is active under qual=2.
  const pixelsPerBlock = ppb ?? 1.5 / scale;
  const worldW = widthPx / pixelsPerBlock;
  const worldH = heightPx / pixelsPerBlock;
  const tileBlocks = sx * scale;
  const nx = Math.ceil(worldW / tileBlocks) + 1;
  const nz = Math.ceil(worldH / tileBlocks) + 1;
  return { nx, nz, count: nx * nz, pixelsPerBlock };
}

function makeTiles(scale, count) {
  const tiles = [];
  const side = Math.ceil(Math.sqrt(count));
  for (let z = 0; z < side && tiles.length < count; z++) {
    for (let x = 0; x < side && tiles.length < count; x++) {
      tiles.push({ scale, x: x * sx, z: z * sz });
    }
  }
  return tiles;
}

async function timeRender(addon, workers, scale, tileCount) {
  const tiles = makeTiles(scale, tileCount);
  // Warmup so generator / TLS / thread-pool cold start is outside the sample.
  await addon.renderTiles({
    mc,
    seed,
    dim: 0,
    largeBiomes: false,
    y: 256,
    sx,
    sz,
    workers,
    tiles: tiles.slice(0, Math.min(2, tiles.length)),
  });
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    const buffer = await addon.renderTiles({
      mc,
      seed,
      dim: 0,
      largeBiomes: false,
      y: 256,
      sx,
      sz,
      workers,
      tiles,
    });
    const ms = performance.now() - t0;
    const bytes = buffer?.byteLength ?? buffer?.length ?? 0;
    if (bytes < tiles.length * sx * sz * 4) throw new Error(`short buffer @ scale ${scale} workers ${workers}`);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  return { median, samples, tiles: tiles.length };
}

const scenarios = [
  { scale: 1, label: '1:1 near' },
  { scale: 4, label: '1:4' },
  { scale: 16, label: '1:16 mid' },
  { scale: 64, label: '1:64 far' },
  { scale: 256, label: '1:256 very far' },
  { scale: 1024, label: '1:1024 extreme' },
];

const client = await createEngineClient({ exe: enginePath, dll: dllPath, timeoutMs: 300000 });
try {
  console.log(`engine=${enginePath}`);
  console.log(`dll=${dllPath}`);
  console.log(`mc=${mc} seed=${seed} tile=${sx}x${sz} repeats=${repeats}`);
  console.log(`workers under test: ${workersToTry.join(', ')} (default map path uses hw/2)`);
  console.log('');

  for (const scenario of scenarios) {
    const view = viewportTiles(scenario.scale);
    // Also request one underlay batch size like the UI (active + next coarser).
    const underlay = scenario.scale < 1024 ? viewportTiles(scenario.scale * 4) : null;
    const primaryCount = Math.min(48, Math.max(4, view.count));
    console.log(
      `## ${scenario.label}  scale=${scenario.scale}  ~viewport tiles=${view.count} (bench ${primaryCount})  ppb≈${view.pixelsPerBlock.toFixed(4)}`,
    );
    for (const workers of workersToTry) {
      const result = await timeRender(client.proxy, workers, scenario.scale, primaryCount);
      const perTile = result.median / result.tiles;
      console.log(
        `  workers=${String(workers).padStart(2)}  median=${result.median.toFixed(1).padStart(7)} ms  (${perTile.toFixed(1)} ms/tile)  samples=[${result.samples.map((v) => v.toFixed(0)).join(', ')}]`,
      );
    }
    if (underlay) {
      const underCount = Math.min(24, Math.max(2, underlay.count));
      const half = Math.max(1, Math.floor(hw / 2));
      const result = await timeRender(client.proxy, half, scenario.scale * 4, underCount);
      console.log(
        `  underlay scale=${scenario.scale * 4} workers=${half}  median=${result.median.toFixed(1)} ms for ${result.tiles} tiles`,
      );
    }
    console.log('');
  }

  // Full first-paint estimate at a mid zoom where the new qual=2 path is finer than before.
  // Old app at ppb=0.05 → scale 64; new app → scale 16 (~4× more tiles).
  const old = viewportTiles(64, 1400, 900, 0.05);
  const neu = viewportTiles(16, 1400, 900, 0.05);
  const half = Math.max(1, Math.floor(hw / 2));
  const oldRun = await timeRender(client.proxy, half, 64, Math.min(48, Math.max(4, old.count)));
  const newRun = await timeRender(client.proxy, half, 16, Math.min(48, Math.max(4, neu.count)));
  const oldEst = (oldRun.median / oldRun.tiles) * old.count;
  const newEst = (newRun.median / newRun.tiles) * neu.count;
  console.log('## First-paint estimate @ ppb=0.05 (1400×900), half cores');
  console.log(
    `  old-style scale 64: ~${old.count} tiles → est ${oldEst.toFixed(0)} ms (bench ${oldRun.tiles} @ ${oldRun.median.toFixed(0)} ms)`,
  );
  console.log(
    `  new-style scale 16: ~${neu.count} tiles → est ${newEst.toFixed(0)} ms (bench ${newRun.tiles} @ ${newRun.median.toFixed(0)} ms)`,
  );
  console.log(`  ratio new/old ≈ ${(newEst / Math.max(1, oldEst)).toFixed(2)}x`);
} finally {
  await client.close?.();
  process.exit(0);
}
