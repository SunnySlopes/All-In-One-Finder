import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const addonPath = path.resolve(arg('--addon', path.join(root, 'native', 'build', 'allinone.node')));
const outPath = path.resolve(arg('--out', path.join(root, 'native-regression-result.json')));
const timeoutMs = Number(arg('--timeout', '180000'));
const addon = require(addonPath);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canon(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

function normalize(status) {
  const hits = (status.hits || []).map(canon);
  hits.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    done: !!status.done,
    error: status.error || '',
    seedCount: status.seedCount,
    hits,
  };
}

async function runSearch(start, poll, stop) {
  try {
    start();
  } catch (error) {
    return { startError: error && error.message ? error.message : String(error) };
  }
  const started = Date.now();
  let status = null;
  while (Date.now() - started < timeoutMs) {
    status = poll();
    if (status.done || status.error) break;
    await sleep(50);
  }
  if (!status || (!status.done && !status.error)) {
    try { stop(); } catch {}
    await sleep(300);
    return { timeout: true, last: status ? normalize(status) : null };
  }
  try { stop(); } catch {}
  return normalize(status);
}

/** Trial results are ranked, so keep hit order; include deterministic counters as a baseline.
 * `pruned` is thread-scheduling dependent (global ranking merge order) and is intentionally
 * excluded; hits are expected to stay identical. */
function normalizeTrial(status) {
  return {
    done: !!status.done,
    error: status.error || '',
    seedCount: status.seedCount,
    total: status.total,
    candidates: status.candidates,
    layouts: status.layouts,
    chunks: status.chunks,
    hits: (status.hits || []).map(canon),
  };
}

async function runTrial(start, poll, stop) {
  try {
    start();
  } catch (error) {
    return { startError: error && error.message ? error.message : String(error) };
  }
  const started = Date.now();
  let status = null;
  while (Date.now() - started < timeoutMs) {
    status = poll();
    if (status.done || status.error) break;
    await sleep(50);
  }
  if (!status || (!status.done && !status.error)) {
    try { stop(); } catch {}
    await sleep(300);
    return { timeout: true, last: status ? normalizeTrial(status) : null };
  }
  try { stop(); } catch {}
  return normalizeTrial(status);
}

/** Geode results keep the v3 ranking order; verification flags are part of the baseline. */
function normalizeGeode(status) {
  return {
    done: !!status.done,
    error: status.error || '',
    seedCount: status.seedCount,
    prefilter: status.prefilter,
    approximate: !!status.approximate,
    phaseCount: status.phaseCount,
    verified: status.verified,
    verifyMismatch: status.verifyMismatch,
    hits: (status.hits || []).map(canon),
  };
}

async function runGeode(start, poll, stop) {
  try {
    start();
  } catch (error) {
    return { startError: error && error.message ? error.message : String(error) };
  }
  const started = Date.now();
  let status = null;
  while (Date.now() - started < timeoutMs) {
    status = poll();
    if (status.done || status.error) break;
    await sleep(50);
  }
  if (!status || (!status.done && !status.error)) {
    try { stop(); } catch {}
    await sleep(300);
    return { timeout: true, last: status ? normalizeGeode(status) : null };
  }
  try { stop(); } catch {}
  return normalizeGeode(status);
}

const versions = addon.versions();
const features = addon.features();
const mc = (versions.find((item) => item.name === '26.3') || versions[versions.length - 1]).id;
const newest = versions[versions.length - 1].id;
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const cases = {};
cases.basic = {
  versions: canon(versions),
  features: canon(features),
  biome: canon(addon.biomeAt({ mc, seed: '123', dim: 0, largeBiomes: false, x: 0, y: 64, z: 0 })),
  weird: addon.weirdness('12345'),
  structuresOverworld: canon(addon.structures({
    mc, seed: '123', dim: 0, largeBiomes: false, x0: -1024, z0: -1024, x1: 1024, z1: 1024,
    types: features.filter((item) => item.dim === 0).map((item) => item.id),
  })),
  structuresEnd: canon(addon.structures({
    mc, seed: '123', dim: 1, largeBiomes: false, x0: -512, z0: -512, x1: 512, z1: 512,
    types: features.filter((item) => item.dim === 1).map((item) => item.id),
  })),
  tile16: hash(addon.renderTile({
    mc, seed: '123', dim: 0, largeBiomes: false, scale: 16, x: -256, z: -256, sx: 32, sz: 32, y: 64,
  })),
  tile1: hash(addon.renderTile({
    mc, seed: '123', dim: 0, largeBiomes: false, scale: 1, x: -64, z: -64, sx: 64, sz: 64, y: 64,
  })),
};

cases.lowySingle = await runSearch(
  () => addon.searchStart({
    page: 'lowy-single', mc, threads: 4, minX: -4096, maxX: 4096, minZ: -4096, maxZ: 4096,
    fastMode: true, ratio: 90, riverWeight: 0.75, seed: '12345',
  }),
  () => addon.searchPoll(), () => addon.searchStop(),
);

cases.slimeRule2 = await runSearch(
  () => addon.slimeFarmStart({
    mc: newest, versionRule: 2, threads: 4, minSlimeArea: 9000,
    minX: -2048, maxX: 2048, minZ: -2048, maxZ: 2048, convert: true,
    seeds: ['0', '12345'],
  }),
  () => addon.slimeFarmPoll(), () => addon.slimeFarmStop(),
);

cases.slimeRule1 = await runSearch(
  () => addon.slimeFarmStart({
    mc: newest, versionRule: 1, threads: 4, minSlimeArea: 9000,
    minX: -2048, maxX: 2048, minZ: -2048, maxZ: 2048, convert: true,
    seeds: ['0'],
  }),
  () => addon.slimeFarmPoll(), () => addon.slimeFarmStop(),
);

cases.witch = await runSearch(
  () => addon.witchSearchStart({
    versionGroup: 2, largeBiomes: false, singleBiome: false, threads: 4, maxY: -40,
    minX: 14848, maxX: 15359, minZ: -3072, maxZ: -2561,
    seeds: ['-143551518615525778', '0'],
  }),
  () => addon.witchSearchPoll(), () => addon.witchSearchStop(),
);

cases.riverNoCave = await runSearch(
  () => addon.riverSearchStart({
    mc, threads: 4, minScore: 24831, y: -64, calcCave: false,
    minX: -1024, maxX: 1023, minZ: -1024, maxZ: 1023, seeds: ['0', '12345'],
  }),
  () => addon.riverSearchPoll(), () => addon.riverSearchStop(),
);

cases.riverCave = await runSearch(
  () => addon.riverSearchStart({
    mc, threads: 4, minScore: 24831, y: -64, calcCave: true,
    minX: -1024, maxX: 1023, minZ: -1024, maxZ: 1023, seeds: ['0'],
  }),
  () => addon.riverSearchPoll(), () => addon.riverSearchStop(),
);

cases.fortressCross = await runSearch(
  () => addon.fortressSearchStart({
    mc: newest, threads: 4, mode: 0, crossFilter: 2, minLong: 0, minShort: 0, minHeight: 16,
    minX: -8192, maxX: 8192, minZ: -8192, maxZ: 8192,
    seeds: ['0', '12345', '-987654321'],
  }),
  () => addon.fortressSearchPoll(), () => addon.fortressSearchStop(),
);

cases.fortressSpan = await runSearch(
  () => addon.fortressSearchStart({
    mc: newest, threads: 4, mode: 1, crossFilter: 2, minLong: 0, minShort: 0, minHeight: 16,
    minX: -32768, maxX: 32768, minZ: -32768, maxZ: 32768,
    seeds: ['0', '12345'],
  }),
  () => addon.fortressSearchPoll(), () => addon.fortressSearchStop(),
);

for (const level of [3, 4]) {
  cases[`multi${level}`] = await runSearch(
    () => addon.multiMonumentSearchStart({
      mc: newest, threads: 8, level, biomeCheck: false, minGroupArea: 6728,
      minX: -1048576, maxX: 1048576, minZ: -1048576, maxZ: 1048576,
      seeds: ['0'],
    }),
    () => addon.multiMonumentSearchPoll(), () => addon.multiMonumentSearchStop(),
  );
}

cases.doubleMonument = await runSearch(
  () => addon.doubleMonumentSearchStart({
    mc: newest, threads: 4,
    minX: -32768, maxX: 32767, minZ: -32768, maxZ: 32767,
    seeds: ['0', '12345', '-987654321'],
  }),
  () => addon.doubleMonumentSearchPoll(), () => addon.doubleMonumentSearchStop(),
);

// Trial engine: three generation tiers plus a larger area case. Bounds are exact
// inclusive min/max; the square-side UI is only a shortcut that fills these four values.
for (const [name, generation] of [['trial263', 3], ['trialGen1', 1], ['trialGen2', 2]]) {
  cases[name] = await runTrial(
    () => addon.trialStart({
      generation, threads: 4, minX: -1000, maxX: 999, minZ: -1000, maxZ: 999, fullWorld: false,
      clusterCircle: false, clusterRadius: 160, clusterLongSide: 320, clusterShortSide: 320,
      minStructures: 2, minSpawners: 20, limit: 100,
      conversionRatio: 1 / 6, seeds: ['0'],
    }),
    () => addon.trialPoll(), () => addon.trialStop(),
  );
}

cases.trialRect = await runTrial(
  () => addon.trialStart({
    generation: 3, threads: 8, minX: -12000, maxX: 15000, minZ: -8000, maxZ: 6000, fullWorld: false,
    clusterCircle: false, clusterRadius: 160, clusterLongSide: 320, clusterShortSide: 320,
    minStructures: 2, minSpawners: 20, limit: 100,
    conversionRatio: 1 / 6, seeds: ['0'],
  }),
  () => addon.trialPoll(), () => addon.trialStop(),
);

cases.trialCircleWindow = await runTrial(
  () => addon.trialStart({
    generation: 3, threads: 4, minX: -1000, maxX: 999, minZ: -1000, maxZ: 999, fullWorld: false,
    clusterCircle: true, clusterRadius: 160, clusterLongSide: 320, clusterShortSide: 320,
    minStructures: 2, minSpawners: 20, limit: 100,
    conversionRatio: 1 / 6, seeds: ['0'],
  }),
  () => addon.trialPoll(), () => addon.trialStop(),
);

cases.trialRectWindow = await runTrial(
  () => addon.trialStart({
    generation: 3, threads: 4, minX: -3000, maxX: 2999, minZ: -3000, maxZ: 2999, fullWorld: false,
    // The app caps the window at 512×512 (side ≤512); keep this case rectangular but legal.
    clusterCircle: false, clusterRadius: 256, clusterLongSide: 512, clusterShortSide: 256,
    minStructures: 2, minSpawners: 20, limit: 100,
    conversionRatio: 1 / 6, seeds: ['0'],
  }),
  () => addon.trialPoll(), () => addon.trialStop(),
);

cases.trialLarge = await runTrial(
  () => addon.trialStart({
    generation: 3, threads: 8, minX: -100000, maxX: 99999, minZ: -100000, maxZ: 99999, fullWorld: false,
    clusterCircle: false, clusterRadius: 160, clusterLongSide: 320, clusterShortSide: 320,
    minStructures: 2, minSpawners: 20, limit: 100,
    conversionRatio: 1 / 6, seeds: ['12345'],
  }),
  () => addon.trialPoll(), () => addon.trialStop(),
);

cases.trialList = await runTrial(
  () => addon.trialStart({
    generation: 3, threads: 4, minX: -1000, maxX: 999, minZ: -1000, maxZ: 999, fullWorld: false,
    clusterCircle: false, clusterRadius: 160, clusterLongSide: 320, clusterShortSide: 320,
    minStructures: 2, minSpawners: 20, limit: 100,
    conversionRatio: 1, seeds: ['0', '12345'],
  }),
  () => addon.trialPoll(), () => addon.trialStop(),
);

// Geode engine: exact rectangle, 1.18/1.19 version paths, approximate + verification and list mode.
const geodeBase = {
  threads: 8, model: 'terrain', tickRadius: 128, simulationDistance: 10,
  minGeodes: 1, minBudding: 1, allowGpu: true, resume: true,
};
cases.geodeRect = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '26.3', minX: -3000, maxX: 1000, minZ: -1500, maxZ: 2500,
    autoBudget: false, budget: 0, verifyTop: 0, seeds: ['0'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

cases.geode118 = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '1.18.2', minX: -2048, maxX: 2047, minZ: -2048, maxZ: 2047,
    autoBudget: false, budget: 0, verifyTop: 0, seeds: ['0'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

cases.geode119 = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '1.19.2', minX: -2048, maxX: 2047, minZ: -2048, maxZ: 2047,
    autoBudget: false, budget: 0, verifyTop: 0, seeds: ['0'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

cases.geode1214 = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '1.21.4', minX: -2048, maxX: 2047, minZ: -2048, maxZ: 2047,
    autoBudget: false, budget: 0, verifyTop: 0, seeds: ['0'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

cases.geode1215 = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '1.21.5', minX: -2048, maxX: 2047, minZ: -2048, maxZ: 2047,
    autoBudget: false, budget: 0, verifyTop: 0, seeds: ['0'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

cases.geodeApproxVerify = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '26.3', minX: -16384, maxX: 16383, minZ: -16384, maxZ: 16383,
    autoBudget: false, budget: 5000, verifyTop: 20, seeds: ['0'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

cases.geodeList = await runGeode(
  () => addon.geodeStart({
    ...geodeBase, version: '26.3', minX: -2000, maxX: 1999, minZ: -2000, maxZ: 1999,
    autoBudget: false, budget: 0, verifyTop: 0, seeds: ['0', '12345'],
  }),
  () => addon.geodePoll(), () => addon.geodeStop(),
);

// Slowest case goes last so a timeout cannot leave later cases "busy".
cases.lowyList = await runSearch(
  () => addon.searchStart({
    page: 'lowy-list', mc, threads: 4, minX: -2048, maxX: 2048, minZ: -2048, maxZ: 2048,
    fastMode: true, ratio: 90, riverWeight: 0.75, seeds: ['0', '12345', '-987654321'],
  }),
  () => addon.searchPoll(), () => addon.searchStop(),
);

const payload = {
  addon: addonPath,
  addonBytes: fs.statSync(addonPath).size,
  addonSha256: crypto.createHash('sha256').update(fs.readFileSync(addonPath)).digest('hex'),
  cases,
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({
  addon: addonPath,
  addonBytes: payload.addonBytes,
  out: outPath,
  cases: Object.fromEntries(Object.entries(cases).map(([key, value]) => [key,
    value && value.hits ? { done: value.done, error: value.error, hits: value.hits.length }
      : value && value.startError ? { startError: value.startError }
        : value && value.timeout ? { timeout: true } : 'basic'])),
}, null, 2));

const failed = Object.entries(cases).some(([key, value]) => key !== 'basic' &&
  (!value || value.timeout || value.startError || value.error || !value.done));
process.exit(failed ? 1 : 0);
