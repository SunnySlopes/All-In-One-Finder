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

function normalize(op: string, value: unknown): unknown {
  if ((op !== 'searchPoll' && op !== 'slimeFarmPoll') || !value || typeof value !== 'object') return value;
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
