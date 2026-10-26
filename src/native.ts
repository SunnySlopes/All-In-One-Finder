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
