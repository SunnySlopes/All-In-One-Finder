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
  /** avg_y锛歠ootprint 骞冲潎楂樺害锛屼篃鏄粨鏋滈噷鐨?Y銆?*/
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
  /** 棰勮娲昏穬姣嶅博鏁帮紙涓绘帓搴忛敭锛涘鏍稿悗涓哄鏍稿€硷級銆?*/
  budding: number;
  /** 娲昏穬鏅舵礊鏁帮紙浠呭睍绀猴級銆?*/
  geodes: number;
  /** 璇ョ偣宸茬敤 evaluate() 閫愬潡閲嶇畻銆?*/
  verified: boolean;
  /** 澶嶆牳鍓嶆鍗曞€硷紱涓庡鏍稿€间竴鑷存椂涓?-1銆?*/
  listedBudding: number;
  listedGeodes: number;
}

export interface GeodeStatus {
  running: boolean;
  done: boolean;
  paused: boolean;
  /** 鏆傚仠璇锋眰宸插彂鍑猴紝绛夊緟褰撳墠宸ヤ綔鍗曞厓鍒版鏌ョ偣銆?*/
  pausing: boolean;
  stopping: boolean;
  /** 鏈杩愯琚敤鎴峰仠姝紱缁撴灉宸叉竻绌猴紝鍏ㄥ浘鏂偣浠嶄繚鐣欍€?*/
  stopped: boolean;
  truncated: boolean;
  /** 'scan' | 'simulate' | 'rank' | 'verify' | 'done' */
  phase: string;
  phaseIndex: number;
  /** 3 = 鏃犲鏍革紱4 = 鍗曠瀛愯繎浼煎€欓€夊甫澶嶆牳銆?*/
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
  /** 瀹為檯浼犵粰寮曟搸鐨勫€欓€夐绠楋紱0 = 瀹屾暣鍊欓€夈€?*/
  prefilter: number;
  /** 鏈鏄惁浠庡尯鍩熸柇鐐规仮澶嶏紙鍏ㄥ浘锛夈€?*/
  resumed: boolean;
  /** 褰撳墠闃舵棰勮鍓╀綑绉掓暟锛?1 = 璁＄畻涓€?*/
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
  return rpc(op, args).then((value) => normalize(op, value) as T);
}

