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
  /** 0 = prepare, 1 = climate screen, 2 = verify. */
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
  /** 复核前榜单值；与复核值一致时为 -1。 */
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
  sampleY: number;
  river: number;
  cave: number;
  score: number;
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

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<number, Pending>();
let nextId = 1;
let portReady: Promise<MessagePort> | null = null;

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

function normalize(op: string, value: unknown): unknown {
  if (!HIT_POLL_OPS.has(op) || !value || typeof value !== 'object') return value;
  const status = value as { hits: Array<{ seed: bigint | number | string }> };
  status.hits = status.hits.map((hit) => ({ ...hit, seed: seedText(hit.seed) }));
  return status;
}

function connect(): Promise<MessagePort> {
  if (portReady) return portReady;
  portReady = new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      if (event.data !== 'aio-port' || !event.ports[0]) return;
      const port = event.ports[0];
      port.onmessage = (message) => {
        const body = message.data as { id: number; ok: boolean; result?: unknown; error?: string };
        const item = pending.get(body.id);
        if (!item) return;
        pending.delete(body.id);
        if (body.ok) item.resolve(body.result);
        else item.reject(new Error(body.error || 'native'));
      };
      port.start();
      resolve(port);
    });
  });
  return portReady;
}

export function call<T>(op: string, args?: unknown): Promise<T> {
  return connect().then((port) => new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve: (value) => resolve(normalize(op, value) as T),
      reject,
    });
    port.postMessage({ id, op, args });
  }));
}
