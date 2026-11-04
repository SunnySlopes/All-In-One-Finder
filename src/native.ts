import { runLockOwner, setRunLockOwner } from './run-lock';
import type { SearcherId } from './searchers';

export interface McVersion {
  id: number;
  name: string;
}

export interface FeatureInfo {
  id: number;
  key: string;
  dim: number;
}

export interface Placed {
  type: number;
  x: number;
  z: number;
  variant?: number;
  /** Nether fortress full bounds and every generated piece (only for fortresses). */
  large?: Bounds3;
  pieces?: Bounds3[];
}

export interface Bounds3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface StructureBoundsData {
  large: Bounds3;
  start?: Bounds3;
  small?: Bounds3;
  pieces?: Bounds3[];
}

export interface SearchHit {
  seed: string;
  x: number;
  z: number;
  total: number;
  cave: number;
  river: number;
  ratio: number;
}

export interface SearchStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  phase: number;
  current: number;
  total: number;
  seedIndex: number;
  seedCount: number;
  /** AFK / shell-centre Y resolved for this run (also the /tp height). */
  afkY: number;
  /** Display denominator: full shell cell count of the sampled window. */
  fullArea: number;
  /** "gpu" while the OpenCL coarse backend evaluated the phase-1 noise. */
  scanBackend: string;
  /** Why the GPU path was skipped ("no-opencl", "no-device", ...); empty otherwise. */
  gpuReason: string;
  /** OpenCL device name when the GPU scan ran. */
  gpuDevice: string;
  error: string;
  hits: SearchHit[];
}

export interface SlimeHit {
  seed: string;
  x: number;
  z: number;
  area: number;
  areaEquiv: number;
  chunks: number;
}

export interface SlimeStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  stage: number;
  current: number;
  total: number;
  tilesDone: number;
  tilesTotal: number;
  seedIndex: number;
  seedCount: number;
  error: string;
  hits: SlimeHit[];
}

export interface WitchHit {
  seed: string;
  x: number;
  z: number;
  /** avg_y：footprint 平均高度，也是结果里的 Y。 */
  y: number;
  dir: number;
  sizeX: number;
  sizeZ: number;
  wet: number;
  flooded: number;
  reject: number;
}

export interface WitchStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  current: number;
  total: number;
  seedIndex: number;
  seedCount: number;
  error: string;
  hits: WitchHit[];
}

export interface FlowerHit {
  seed: string;
  x: number;
  z: number;
  sideX: number;
  sideZ: number;
  flowerArea: number;
  paleArea: number;
  swampArea: number;
  flowerX: number;
  flowerY: number;
  flowerZ: number;
  paleX: number;
  paleZ: number;
  swampX: number;
  swampZ: number;
  /** 'X', 'Z' or '' for a square window. */
  orient: string;
  nether: string;
  bonus: string;
}

export interface FlowerStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  /** 0 = prepare, 1 = climate screen, 2 = merge tail, 3 = verify. */
  phase: number;
  current: number;
  total: number;
  phaseCurrent: number;
  phaseTotal: number;
  overallCurrent: number;
  overallTotal: number;
  seedIndex: number;
  seedCount: number;
  error: string;
  hits: FlowerHit[];
}

export interface TrialHit {
  seed: string;
  x: number;
  z: number;
  /** Number of trial chambers that contributed spawners. */
  structures: number;
  /** Total spawners inside the statistics area (fast + slow). */
  spawners: number;
  fastSpawners: number;
  slowSpawners: number;
  /** fast + slow * conversionRatio, rounded to one decimal by the host. */
  converted: number;
}

/** One host room that contains at least one trial cage; already padded by one block. */
export interface TrialFrame extends Bounds3 {
  spawners: number;
  slowSpawners: number;
}

/** One trial spawner cage; `slow` marks the slow-spawner pool. */
export interface TrialSpawner {
  x: number;
  y: number;
  z: number;
  slow: boolean;
}

/** Per-chamber map overlay data returned by the `trialChambers` op. */
export interface TrialChamberInfo {
  x: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  exists: boolean;
  pieces: number;
  /** Outermost extent of every piece, already padded by one block. */
  bounds: Bounds3;
  frames: TrialFrame[];
  spawners: TrialSpawner[];
}

export interface TrialStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  /** Pause requested; waiting for the in-flight shard to finish. */
  pausing: boolean;
  /** 0 = prepare, 1 = shard scan/cluster, 2 = finished. */
  phase: number;
  current: number;
  total: number;
  candidates: number;
  layouts: number;
  pruned: number;
  found: number;
  chunks: number;
  elapsedMs: number;
  seedIndex: number;
  seedCount: number;
  truncated: boolean;
  /** Pause/stop asked the engine to save a checkpoint and that write failed. */
  checkpointFailed: boolean;
  error: string;
  hits: TrialHit[];
}

export interface GeodeChunkInfo {
  exists: boolean;
  budding: number;
}

export interface GeodeHit {
  seed: string;
  x: number;
  z: number;
  /** 预计活跃母岩数（主排序键；复核后为复核值）。 */
  budding: number;
  /** 活跃晶洞数（仅展示）。 */
  geodes: number;
  /** 该点已用 evaluate() 逐块重算。 */
  verified: boolean;
  /** 复核前的榜单值；与复核值一致时为 -1。 */
  listedBudding: number;
  listedGeodes: number;
}

export interface GeodeStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  /** 暂停请求已发出，等待当前工作单元到检查点。 */
  pausing: boolean;
  stopping: boolean;
  /** 本次运行被用户停止；结果已清空，全图断点仍保留。 */
  stopped: boolean;
  truncated: boolean;
  /** 'scan' | 'simulate' | 'rank' | 'verify' | 'done' */
  phase: string;
  phaseIndex: number;
  /** 3 = 无复核；4 = 单种子近似候选带复核。 */
  phaseCount: number;
  current: number;
  total: number;
  verifyDone: number;
  verifyTotal: number;
  verified: number;
  verifyMismatch: number;
  seedIndex: number;
  seedCount: number;
  autoBudget: boolean;
  /** 实际传给引擎的候选预算；0 = 完整候选。 */
  prefilter: number;
  /** 本次是否从区域断点恢复（全图）。 */
  resumed: boolean;
  /** 当前阶段预计剩余秒数；-1 = 计算中。 */
  etaSeconds: number;
  scanBackend: string;
  /** Why the GPU scan was skipped ("no-opencl" | "no-device"); empty when it ran. */
  gpuReason: string;
  /** OpenCL device name when the GPU scan ran. */
  gpuDevice: string;
  approximate: boolean;
  backend: string;
  elapsedMs: number;
  error: string;
  hits: GeodeHit[];
}

export interface RiverHit {
  seed: string;
  x: number;
  z: number;
  /** 地图跳转高度：采样窗口（yMin..yMax）的中线。 */
  sampleY: number;
  /** 等效河流面积 = 河流面积 + 溶洞面积 / 折算系数（层均口径）。 */
  river: number;
  /** 等效溶洞面积 = 溶洞面积 + 折算系数 × 河流面积（层均口径）。 */
  cave: number;
  /** 河流面积：区域内河流群系格数 ÷ 统计层数（不折算）。 */
  rawRiver: number;
  /** 溶洞面积：区域内溶洞群系格数 ÷ 统计层数（不折算）。 */
  rawCave: number;
  /** 实际统计层数（挂机Y±24 裁剪后）。 */
  layers: number;
  score: number;
  /** 是否统计溶洞：只看搜索条件（采样最低 Y < 60 且挂机Y < 85），与该点实际有无溶洞无关。
   * 为 true 时 cave/rawCave 是统计值（可能为 0）；为 false 时保持 0。
   * 前端四个面积项始终输出。 */
  hasCave: boolean;
  /** 本次搜索的折算系数（默认 4880/7011），供结果卡统一口径使用。 */
  caveConversion?: number;
}

/** 引擎 validate() 的提示码，前端按 code 取文案。 */
export const RIVER_WARN_SPAN_GT_24 = 1;
export const RIVER_WARN_YMIN_GT_NEG58 = 2;
export const RIVER_WARN_AREA_OVER_100 = 3;

export interface RiverWarning {
  code: number;
  text: string;
}

export interface RiverStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  stage: number;
  current: number;
  total: number;
  seedIndex: number;
  seedCount: number;
  error: string;
  hits: RiverHit[];
  /** 动态分母：本配置（已按挂机Y±24 裁剪）下的球壳层均格数。 */
  fullArea: number;
  warnings: RiverWarning[];
  /** 本次搜索是否为纯河流模式（决定结果卡第一行显示哪个等效面积）。 */
  pureRiver?: boolean;
  /** 本次搜索使用的折算系数（默认 4880/7011）。 */
  caveConversion?: number;
}

export interface RiverVersion {
  label: string;
  mc: number;
}

export interface MonumentHit {
  seed: string;
  x: number;
  z: number;
  dx: number;
  dz: number;
  count: number;
  area: number;
  lowEfficiency: number;
  oceanType: number;
  /** 4 个检查点出现的海洋温度位掩码：1 冰冻 / 2 冷水 / 4 普通 / 8 温水 / 16 暖水。 */
  oceanTypes: number;
  x2: number;
  z2: number;
  singleX: number;
  singleZ: number;
  singleArea: number;
  areaMax: number;
  areaMaxX: number;
  areaMaxZ: number;
  dual: number;
  mode: number;
}

export interface MonumentStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  current: number;
  total: number;
  seedIndex: number;
  seedCount: number;
  error: string;
  hits: MonumentHit[];
}

export interface FortressHit {
  seed: string;
  x: number;
  y: number;
  z: number;
  crossings: number;
  spanX: number;
  spanY: number;
  spanZ: number;
  area: number;
}

export interface FortressStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  current: number;
  total: number;
  seedIndex: number;
  seedCount: number;
  error: string;
  hits: FortressHit[];
}

function seedText(value: bigint | number | string): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

const HIT_POLL_OPS = new Set([
  'searchPoll',
  'slimeFarmPoll',
  'witchSearchPoll',
  'riverSearchPoll',
  'flowerFarmPoll',
  'trialPoll',
  'geodePoll',
  'fortressSearchPoll',
  'multiMonumentSearchPoll',
  'doubleMonumentSearchPoll',
]);

/** start RPC → 该搜索器在全局占用里的 id。 */
const START_OWNER: Record<string, (args: Record<string, unknown> | undefined) => SearcherId> = {
  searchStart: (args) => (args?.page === 'lowy-fast' ? 'LowYPitDripstoneCave' : 'LowYDripstoneCave'),
  slimeFarmStart: () => 'SlimeChunk',
  witchSearchStart: () => 'LowYSwampHut',
  riverSearchStart: () => 'River',
  flowerFarmStart: () => 'FlowerFarm',
  trialStart: () => 'TrialSpawner',
  geodeStart: () => 'BuddingAmethyst',
  fortressSearchStart: (args) => (Number(args?.mode) === 1 ? 'NetherFortressOverall' : 'NetherFortressCross'),
  doubleMonumentSearchStart: () => 'DoubleMonument',
  multiMonumentSearchStart: () => 'MultiMonument',
};

/** poll RPC → 归属该 poll 的搜索器（两个低Y tab / 两个堡垒 tab 共用一个 poll）。 */
const POLL_OWNERS: Record<string, SearcherId[]> = {
  searchPoll: ['LowYDripstoneCave', 'LowYPitDripstoneCave'],
  slimeFarmPoll: ['SlimeChunk'],
  witchSearchPoll: ['LowYSwampHut'],
  riverSearchPoll: ['River'],
  flowerFarmPoll: ['FlowerFarm'],
  trialPoll: ['TrialSpawner'],
  geodePoll: ['BuddingAmethyst'],
  fortressSearchPoll: ['NetherFortressCross', 'NetherFortressOverall'],
  multiMonumentSearchPoll: ['MultiMonument'],
  doubleMonumentSearchPoll: ['DoubleMonument'],
};

function releaseRunLockForPoll(op: string): void {
  const owners = POLL_OWNERS[op];
  if (!owners) return;
  const current = runLockOwner();
  if (current && owners.includes(current)) setRunLockOwner(null);
}

function normalize(op: string, value: unknown): unknown {
  if (!HIT_POLL_OPS.has(op) || !value || typeof value !== 'object') return value;
  const status = value as { hits: Array<{ seed: bigint | number | string }> };
  status.hits = status.hits.map((hit) => ({ ...hit, seed: seedText(hit.seed) }));
  return status;
}

declare global {
  interface Window {
    /**
     * Injected by the desktop shell (native/host/web/bridge.js). Routes an op to
     * the engine and resolves with its JSON result (binary ops resolve to a
     * Uint8Array). Undefined when the page runs in a plain browser.
     */
    __AIO_RPC__?: (op: string, args?: unknown) => Promise<unknown>;
  }
}

export function call<T>(op: string, args?: unknown): Promise<T> {
  const rpc = window.__AIO_RPC__;
  if (typeof rpc !== 'function') {
    return Promise.reject(new Error('native-host-unavailable'));
  }
  const startOwner = START_OWNER[op];
  const isPoll = POLL_OWNERS[op] !== undefined;
  return rpc(op, args).then(
    (value) => {
      const normalized = normalize(op, value);
      if (startOwner) {
        // start 成功才占用；native 的 busy 拒绝不会走到这里。
        setRunLockOwner(startOwner(args as Record<string, unknown> | undefined));
      } else if (isPoll) {
        const status = normalized as { done?: boolean; running?: boolean; paused?: boolean } | null;
        // 暂停中的搜索同样占用：只有真正结束（done）或引擎已退出（非暂停的 running=false）
        // 才释放，否则 trial 这类“暂停即结束工作线程”的搜索会让第二个搜索乘虚而入。
        if (!status || status.done === true || (status.running === false && status.paused !== true)) {
          releaseRunLockForPoll(op);
        }
      }
      return normalized as T;
    },
    (error: unknown) => {
      // poll 失败通常意味着引擎已经不在了：释放占用，避免所有 Start 永久锁死。
      if (isPoll) releaseRunLockForPoll(op);
      throw error;
    },
  );
}

