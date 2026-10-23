import { biomeLabel, onLocale, structureLabel, t } from './i18n';
import { call, type FeatureInfo, type McVersion, type Placed } from './native';
import { type MapSessionData } from './session';

export interface JumpOptions {
  x: number;
  z: number;
  seed?: string;
  y?: number;
  spawnCircles?: boolean;
}

const COLORS: Record<string, string> = {
  desert_pyramid: '#d8b15a',
  jungle_temple: '#67a15a',
  swamp_hut: '#6d8a4e',
  igloo: '#d5e4ef',
  village: '#c8a05a',
  ocean_ruin: '#4f8f9a',
  shipwreck: '#8d6a45',
  monument: '#3f8f78',
  mansion: '#7a5a3a',
  outpost: '#b7b7b7',
  ruined_portal: '#8d4de0',
  ancient_city: '#6d7c90',
  treasure: '#e0c15a',
  mineshaft: '#8a8a8a',
  desert_well: '#c2a36b',
  geode: '#b07adf',
  trail_ruins: '#a07a52',
  trial_chambers: '#d0a24a',
  abandoned_camp: '#c47a4a',
  stronghold: '#6d8f6d',
  slime_chunk: '#7ec850',
  spawn: '#f2f2f2',
  fortress: '#a33b3b',
  bastion: '#8a6238',
  ruined_portal_n: '#c45ad0',
  end_city: '#d7d2a4',
  end_gateway: '#7fd0c8',
};

const SCALES = [1, 4, 16, 64, 256];
const TILE_CELLS = 128;
/** GPU/canvas dest textures often fail above ~4k–8k; oversized drawImage aborts the frame. */
const MAX_TILE_DRAW_PX = 4096;
const ICON_SIZE = 20;
const SESSION_NAME = 'map';
const DEFAULT_FEATURES = [
  'swamp_hut',
  'village',
  'monument',
  'stronghold',
  'spawn',
  'fortress',
  'bastion',
  'end_city',
];

interface MapSession {
  seed: string;
  version: string;
  dim: number;
  y: number;
  largeBiomes: boolean;
  features: string[];
}

function randomMcSeed(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  let value = (BigInt(words[0]) << 32n) | BigInt(words[1]);
  if (value >= 0x8000000000000000n) value -= 0x10000000000000000n;
  return value.toString();
}

function clampZoom(value: number): number {
  return Math.min(16, Math.max(1 / 256, value));
}

function defaultYForDim(dim: number): number {
  if (dim === -1) return 64; // nether
  if (dim === 1) return 64; // end
  return 256; // overworld surface-ish
}

function parseSession(raw: string | null): MapSession | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<MapSession>;
    if (typeof data.seed !== 'string' || !data.seed.trim()) return null;
    return {
      seed: data.seed.trim(),
      version: typeof data.version === 'string' ? data.version : '',
      dim: Number.isFinite(Number(data.dim)) ? Number(data.dim) : 0,
      y: Number.isFinite(Number(data.y)) ? Number(data.y) : 256,
      largeBiomes: !!data.largeBiomes,
      features: Array.isArray(data.features)
        ? data.features.filter((item): item is string => typeof item === 'string')
        : [...DEFAULT_FEATURES],
    };
  } catch {
    return null;
  }
}

const ICONS: Record<string, string> = {
  desert_pyramid: 'desert',
  jungle_temple: 'jungle',
  swamp_hut: 'hut',
  igloo: 'igloo',
  village: 'village',
  ocean_ruin: 'ruins',
  shipwreck: 'shipwreck',
  monument: 'monument',
  mansion: 'mansion',
  outpost: 'outpost',
  ruined_portal: 'portal',
  ancient_city: 'ancient_city',
  treasure: 'treasure',
  mineshaft: 'mineshaft',
  desert_well: 'well',
  geode: 'geode',
  trail_ruins: 'trails',
  trial_chambers: 'chambers',
  abandoned_camp: 'camp',
  stronghold: 'stronghold',
  slime_chunk: 'slime',
  spawn: 'spawn',
  fortress: 'fortress',
  bastion: 'bastion',
  ruined_portal_n: 'portal',
  end_city: 'endcity',
  end_gateway: 'gateway',
};

export class MapView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLElement;
  private featureBox: HTMLElement;
  private version: HTMLSelectElement;
  private seed: HTMLInputElement;
  private dimension: HTMLSelectElement;
  private y: HTMLInputElement;
  private large: HTMLInputElement;
  private versions: McVersion[] = [];
  private features: FeatureInfo[] = [];
  private enabled = new Set<number>();
  private cx = 0;
  private cz = 0;
  private pixelsPerBlock = 1 / 8;
  private lastActiveScale = 256;
  private dragging = false;
  private lastX = 0;
  private lastZ = 0;
  private tiles = new Map<string, HTMLCanvasElement>();
  private inflight = new Set<string>();
  private pending = new Map<string, { scale: number; x: number; z: number }>();
  private attempts = new Map<string, number>();
  private flushQueued = false;
  private flushRunning = false;
  private generation = 0;
  private placed: Placed[] = [];
  private featureTimer = 0;
  private featureGen = 0;
  private biomeTimer = 0;
  private pointer = { x: 0, z: 0 };
  private grid!: HTMLInputElement;
  private icons = new Map<string, HTMLImageElement>();
  private slimeCanvas: HTMLCanvasElement | null = null;
  private slimeSeed = '';
  private slimeOrigin = { cx: 0, cz: 0 };
  private slimeSpan = { w: 0, h: 0 };
  private slimeFlight = false;
  private spawnOverlay: { x: number; z: number } | null = null;
  private saveTimer = 0;
  private drawing = false;
  private drawQueued = false;
  onSeedChange: (seed: string) => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack';
    this.root.innerHTML = `
      <div class="grid">
        <label data-i18n="map.version"></label><select id="map-version"></select>
        <label data-i18n="map.seed"></label><input id="map-seed" value="${randomMcSeed()}" />
        <label data-i18n="map.dimension"></label><select id="map-dim"></select>
        <label data-i18n="map.y"></label><input id="map-y" type="number" value="256" />
        <label data-i18n="map.largeBiomes"></label><input id="map-large" type="checkbox" />
      </div>
      <div class="row">
        <label class="feature"><input id="map-grid" type="checkbox" checked /><span data-i18n="map.grid"></span></label>
      </div>
      <div id="map-features" class="features"></div>
    `;
    this.version = this.root.querySelector('#map-version')!;
    this.seed = this.root.querySelector('#map-seed')!;
    this.dimension = this.root.querySelector('#map-dim')!;
    this.y = this.root.querySelector('#map-y')!;
    this.large = this.root.querySelector('#map-large')!;
    this.featureBox = this.root.querySelector('#map-features')!;
    this.grid = this.root.querySelector('#map-grid')!;
    this.grid.checked = localStorage.getItem('aio.grid') !== '0';
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'map';
    this.readout = document.createElement('div');
    this.readout.id = 'readout';
    this.bind();
  }

  mountCanvas(stage: HTMLElement): void {
    stage.append(this.canvas, this.readout);
    const tools = document.createElement('div');
    tools.id = 'tools';
    tools.innerHTML = `<button type="button" id="zoom-in">+</button><button type="button" id="zoom-out">−</button>`;
    stage.append(tools);
    tools.querySelector('#zoom-in')!.addEventListener('click', () => this.zoom(1.25));
    tools.querySelector('#zoom-out')!.addEventListener('click', () => this.zoom(0.8));
    new ResizeObserver(() => this.queueDraw()).observe(this.canvas);
    this.resize();
  }

  async load(versions: McVersion[], features: FeatureInfo[]): Promise<void> {
    this.versions = versions;
    this.features = features;
    this.version.innerHTML = versions.map((item) => `<option value="${item.id}">${item.name}</option>`).join('');
    const session = await this.loadSession();
    const preferred = (session?.version && versions.find((item) => item.name === session.version))
      || versions.find((item) => item.name === '26.3')
      || versions[versions.length - 1];
    if (preferred) this.version.value = String(preferred.id);
    if (session) {
      this.seed.value = session.seed;
      this.dimension.value = String(session.dim);
      const dim = Number(this.dimension.value);
      // Avoid restoring an overworld cave Y into nether/end (blank tiles).
      const y = Number(session.y);
      if (dim !== 0 && (!Number.isFinite(y) || y < 0 || y > 128)) this.y.value = String(defaultYForDim(dim));
      else if (Number.isFinite(y)) this.y.value = String(y);
      else this.y.value = String(defaultYForDim(dim));
      this.large.checked = session.largeBiomes;
    }
    const enabledKeys = new Set(session?.features ?? DEFAULT_FEATURES);
    this.enabled.clear();
    for (const feature of features) {
      if (enabledKeys.has(feature.key)) this.enabled.add(feature.id);
    }
    this.renderFeatures();
    this.schedule(true);
    this.queueFeatures();
    this.persistSession();
    this.onSeedChange(this.getSeed());
  }

  getSeed(): string {
    return this.seed.value.trim();
  }

  center(x: number, z: number): void {
    this.cx = x;
    this.cz = z;
    this.schedule();
    this.queueFeatures();
  }

  setSeed(seed: string, announce = true): void {
    if (!seed.trim()) return;
    if (this.seed.value.trim() === seed.trim()) {
      if (announce) this.onSeedChange(seed.trim());
      return;
    }
    this.seed.value = seed.trim();
    this.persistSession();
    this.clearSpawnCircles();
    this.schedule(true);
    this.queueFeatures();
    if (announce) this.onSeedChange(seed.trim());
  }

  setY(y: number): void {
    this.y.value = String(y);
    this.persistSession();
    this.schedule(true);
    this.queueFeatures();
  }

  clearSpawnCircles(): void {
    if (!this.spawnOverlay) return;
    this.spawnOverlay = null;
    this.queueDraw();
  }

  jumpTo(options: JumpOptions): void {
    const nextSeed = options.seed != null ? options.seed.trim() : this.seed.value.trim();
    const nextY = options.y != null ? String(options.y) : this.y.value;
    const worldChanged = nextSeed !== this.seed.value.trim() || nextY !== this.y.value;
    if (options.seed != null && nextSeed) {
      this.seed.value = nextSeed;
      this.onSeedChange(nextSeed);
    }
    if (options.y != null) this.y.value = nextY;
    this.cx = options.x;
    this.cz = options.z;
    this.persistSession();
    // Panning keeps the current tiles on screen. Only a seed/Y change drops the cache.
    this.schedule(worldChanged);
    this.spawnOverlay = options.spawnCircles ? { x: options.x, z: options.z } : null;
    this.queueFeatures();
    requestAnimationFrame(() => {
      this.resize();
      this.queueDraw();
      this.queueFeatures();
    });
  }

  exportSnapshot(): MapSessionData {
    const version = this.versions.find((item) => String(item.id) === this.version.value);
    const dim = Number(this.dimension.value);
    const y = Number(this.y.value);
    return {
      kind: 'aio-session',
      version: 1,
      seed: this.seed.value.trim() || '0',
      mcVersion: version?.name || '',
      dim: dim === -1 || dim === 1 ? dim : 0,
      y: Number.isFinite(y) ? y : 256,
      largeBiomes: this.large.checked,
      grid: this.grid.checked,
      features: this.features.filter((feature) => this.enabled.has(feature.id)).map((feature) => feature.key),
    };
  }

  applySnapshot(data: MapSessionData): void {
    this.seed.value = data.seed;
    const match = this.versions.find((item) => item.name === data.mcVersion);
    if (match) this.version.value = String(match.id);
    this.dimension.value = String(data.dim);
    this.y.value = String(data.dim === 0 ? data.y : defaultYForDim(data.dim));
    this.large.checked = data.largeBiomes && data.dim === 0;
    this.grid.checked = data.grid;
    localStorage.setItem('aio.grid', data.grid ? '1' : '0');
    if (data.features.length) {
      this.enabled.clear();
      for (const feature of this.features) {
        if (data.features.includes(feature.key)) this.enabled.add(feature.id);
      }
    }
    this.renderFeatures();
    this.persistSession();
    this.schedule(true);
    this.queueFeatures();
    this.onSeedChange(data.seed);
  }

  refreshText(): void {
    this.renderFeatures();
    this.dimension.querySelectorAll('option').forEach((option) => {
      option.textContent = t(`map.${option.dataset.key}`);
    });
  }

  private bind(): void {
    this.dimension.innerHTML = ['overworld', 'nether', 'end'].map((key, index) => {
      const dim = index === 0 ? 0 : index === 1 ? -1 : 1;
      return `<option value="${dim}" data-key="${key}"></option>`;
    }).join('');
    const worldChanged = () => {
      this.clearSpawnCircles();
      this.persistSession();
      this.schedule(true);
      this.queueFeatures();
    };
    this.version.addEventListener('change', worldChanged);
    this.dimension.addEventListener('change', () => {
      this.y.value = String(defaultYForDim(Number(this.dimension.value)));
      this.renderFeatures();
      worldChanged();
    });
    this.y.addEventListener('change', worldChanged);
    this.large.addEventListener('change', worldChanged);
    this.seed.addEventListener('change', () => {
      this.clearSpawnCircles();
      this.persistSession();
      this.schedule(true);
      this.queueFeatures();
      this.onSeedChange(this.getSeed());
    });
    this.seed.addEventListener('input', () => {
      this.persistSession();
      this.onSeedChange(this.getSeed());
    });
    this.grid.addEventListener('change', () => {
      localStorage.setItem('aio.grid', this.grid.checked ? '1' : '0');
      this.queueDraw();
    });
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.canvas.classList.add('dragging');
      this.lastX = event.clientX;
      this.lastZ = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointerup', () => {
      this.dragging = false;
      this.canvas.classList.remove('dragging');
      this.schedule();
      this.queueFeatures();
    });
    this.canvas.addEventListener('pointermove', (event) => {
      const world = this.screenToWorld(event.offsetX, event.offsetY);
      this.pointer = world;
      if (this.dragging) {
        this.cx -= (event.clientX - this.lastX) / this.pixelsPerBlock;
        this.cz -= (event.clientY - this.lastZ) / this.pixelsPerBlock;
        this.lastX = event.clientX;
        this.lastZ = event.clientY;
        this.queueDraw();
      }
      window.clearTimeout(this.biomeTimer);
      this.biomeTimer = window.setTimeout(() => this.updateBiome(), 80);
    });
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const before = this.screenToWorld(event.offsetX, event.offsetY);
      this.pixelsPerBlock *= event.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.pixelsPerBlock = clampZoom(this.pixelsPerBlock);
      const after = this.screenToWorld(event.offsetX, event.offsetY);
      this.cx += before.x - after.x;
      this.cz += before.z - after.z;
      this.onZoomChanged();
    }, { passive: false });
    onLocale(() => this.refreshText());
  }

  private zoom(factor: number): void {
    this.pixelsPerBlock = clampZoom(this.pixelsPerBlock * factor);
    this.onZoomChanged();
  }

  private onZoomChanged(): void {
    const next = this.activeScale();
    // Drop stale coarse tiles when entering a finer scale so the view isn't stuck on blurry upscales.
    if (next < this.lastActiveScale) {
      for (const key of [...this.tiles.keys()]) {
        const parts = key.split('|');
        const scale = Number(parts[parts.length - 3]);
        if (Number.isFinite(scale) && scale > next) this.tiles.delete(key);
      }
      this.pending.clear();
    }
    this.lastActiveScale = next;
    this.schedule();
    this.queueFeatures();
  }

  private state() {
    const dim = Number(this.dimension.value);
    const rawY = Number(this.y.value);
    // Nether and End biome samples are stable around Y=64. A saved overworld Y
    // (256 or negative cave Y) makes those dimensions come back blank.
    const y = dim === 0 ? (Number.isFinite(rawY) ? rawY : 64) : 64;
    return {
      mc: Number(this.version.value),
      seed: this.seed.value.trim() || '0',
      dim,
      largeBiomes: !!(this.large.checked && dim === 0),
      y,
    };
  }

  private visibleFeatures(): FeatureInfo[] {
    const dim = Number(this.dimension.value);
    return this.features.filter((feature) => feature.dim === dim);
  }

  private renderFeatures(): void {
    const items = this.visibleFeatures();
    this.featureBox.innerHTML = items.map((feature) => {
      const icon = ICONS[feature.key];
      const mark = icon
        ? `<img class="icon" src="/icons/${icon}.png" alt="" />`
        : `<span class="swatch" style="background:${COLORS[feature.key] || '#ddd'}"></span>`;
      return `
      <label class="feature">
        <input type="checkbox" data-id="${feature.id}" ${this.enabled.has(feature.id) ? 'checked' : ''} />
        ${mark}
        <span>${structureLabel(feature.key)}</span>
      </label>`;
    }).join('');
    this.featureBox.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.id);
        if (input.checked) this.enabled.add(id);
        else {
          this.enabled.delete(id);
          this.placed = this.placed.filter((item) => item.type !== id);
        }
        if (id === -2) this.slimeCanvas = null;
        this.persistSession();
        this.queueDraw();
        this.queueFeatures();
      });
    });
  }

  private async loadSession(): Promise<MapSession | null> {
    try {
      if (window.aio?.readSession) {
        const raw = await window.aio.readSession(SESSION_NAME);
        const parsed = parseSession(raw);
        if (parsed) return parsed;
      }
    } catch {
      /* fall through */
    }
    try {
      return parseSession(localStorage.getItem('aio.session'));
    } catch {
      return null;
    }
  }

  private persistSession(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.writeSession(), 120);
  }

  private async writeSession(): Promise<void> {
    const version = this.versions.find((item) => String(item.id) === this.version.value);
    const dim = Number(this.dimension.value);
    const y = Number(this.y.value);
    const session: MapSession = {
      seed: this.seed.value.trim() || '0',
      version: version?.name || '',
      dim: Number.isFinite(dim) ? dim : 0,
      y: Number.isFinite(y) ? y : 256,
      largeBiomes: this.large.checked,
      features: this.features.filter((feature) => this.enabled.has(feature.id)).map((feature) => feature.key),
    };
    const text = JSON.stringify(session);
    try {
      localStorage.setItem('aio.session', text);
    } catch {
      /* ignore */
    }
    try {
      await window.aio?.writeSession?.(SESSION_NAME, text);
    } catch {
      /* ignore */
    }
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private screenToWorld(sx: number, sy: number): { x: number; z: number } {
    return {
      x: this.cx + (sx - this.canvas.width / 2) / this.pixelsPerBlock,
      z: this.cz + (sy - this.canvas.height / 2) / this.pixelsPerBlock,
    };
  }

  private worldToScreen(x: number, z: number): { x: number; y: number } {
    return {
      x: this.canvas.width / 2 + (x - this.cx) * this.pixelsPerBlock,
      y: this.canvas.height / 2 + (z - this.cz) * this.pixelsPerBlock,
    };
  }

  /** Match cubiomes-viewer: use scale 1 once a block is at least ~1 screen pixel. */
  private activeScale(): number {
    const ppb = this.pixelsPerBlock;
    if (ppb >= 1) return 1;
    if (ppb >= 0.25) return 4;
    if (ppb >= 0.0625) return 16;
    if (ppb >= 0.015625) return 64;
    return 256;
  }

  private schedule(clear = false): void {
    if (clear) {
      this.tiles.clear();
      this.pending.clear();
      this.inflight.clear();
      this.attempts.clear();
      this.generation += 1;
      this.featureGen += 1;
      this.slimeCanvas = null;
      this.slimeFlight = false;
      this.placed = [];
    }
    this.queueDraw();
  }

  private queueDraw(): void {
    if (this.drawing) {
      this.drawQueued = true;
      return;
    }
    void this.draw();
  }

  private queueFeatures(): void {
    window.clearTimeout(this.featureTimer);
    this.featureTimer = window.setTimeout(() => void this.loadFeatures(), 180);
  }

  private tileKey(state: ReturnType<MapView['state']>, scale: number, x: number, z: number): string {
    return `${state.mc}|${state.seed}|${state.dim}|${state.largeBiomes ? 1 : 0}|${state.y}|${scale}|${x}|${z}`;
  }

  private async draw(): Promise<void> {
    this.drawing = true;
    this.drawQueued = false;
    try {
      this.resize();
      const ctx = this.canvas.getContext('2d');
      if (!ctx || !this.version.value) return;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#0e1116';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      const scale = this.activeScale();
      this.lastActiveScale = scale;
      const levels: number[] = [];
      // At finest zoom only request/draw scale 1; keep scale 4 underlay only while it still fits GPU limits.
      const underlayOk = TILE_CELLS * 4 * this.pixelsPerBlock <= MAX_TILE_DRAW_PX;
      const maxLevel = scale === 1 ? (underlayOk ? 4 : 1) : 256;
      for (let level = scale; level <= maxLevel; level *= 4) levels.push(level);
      const state = this.state();
      for (const level of [...levels].reverse()) {
        const request = level === scale
          || (scale === 1 && level === 4 && underlayOk)
          || (scale > 1 && level === scale * 4);
        this.paintLevel(ctx, state, level, request);
      }
      this.drawGrid(ctx, scale);
      this.drawSlime(ctx, state);
      this.drawSpawnCircles(ctx);
      this.drawPlaced(ctx);
      this.readout.textContent = `${Math.round(this.pointer.x)}, ${Math.round(this.pointer.z)}`;
    } finally {
      this.drawing = false;
      if (this.drawQueued) this.queueDraw();
    }
  }

  private drawSpawnCircles(ctx: CanvasRenderingContext2D): void {
    if (!this.spawnOverlay) return;
    const center = this.worldToScreen(this.spawnOverlay.x, this.spawnOverlay.z);
    ctx.save();
    ctx.strokeStyle = 'rgba(110, 220, 120, 0.95)';
    ctx.lineWidth = 2;
    for (const radius of [24, 128]) {
      const px = radius * this.pixelsPerBlock;
      ctx.beginPath();
      ctx.arc(center.x, center.y, px, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(110, 220, 120, 0.85)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private paintLevel(ctx: CanvasRenderingContext2D, state: ReturnType<MapView['state']>, scale: number, request: boolean): void {
    const tileBlocks = TILE_CELLS * scale;
    const size = tileBlocks * this.pixelsPerBlock;
    // Skip levels that would stretch past the safe canvas destination size.
    if (size > MAX_TILE_DRAW_PX) return;
    const view = this.viewBounds();
    const x0 = Math.floor(view.x0 / tileBlocks) * tileBlocks;
    const z0 = Math.floor(view.z0 / tileBlocks) * tileBlocks;
    for (let z = z0; z < view.z1; z += tileBlocks) {
      for (let x = x0; x < view.x1; x += tileBlocks) {
        const key = this.tileKey(state, scale, x, z);
        const tile = this.tiles.get(key);
        const origin = this.worldToScreen(x, z);
        if (tile) {
          try {
            ctx.drawImage(tile, origin.x, origin.y, size, size);
          } catch {
            /* oversized/invalid draw must not blank the whole frame */
          }
        } else if (request) {
          this.enqueueTile(key, scale, x / scale, z / scale);
        }
      }
    }
  }

  private enqueueTile(key: string, scale: number, x: number, z: number): void {
    if (this.tiles.has(key) || this.inflight.has(key) || this.pending.has(key)) return;
    this.pending.set(key, { scale, x, z });
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => void this.flush());
  }

  private async flush(): Promise<void> {
    this.flushQueued = false;
    if (this.flushRunning) {
      this.flushQueued = true;
      return;
    }
    if (!this.pending.size || !this.version.value) return;
    this.flushRunning = true;
    try {
      while (this.pending.size && this.version.value) {
        // When zoomed in, prioritize the finest pending scale so scale-1 tiles land first.
        const preferFine = this.activeScale() <= 4;
        let pick = preferFine ? Number.POSITIVE_INFINITY : 1;
        for (const job of this.pending.values()) {
          pick = preferFine ? Math.min(pick, job.scale) : Math.max(pick, job.scale);
        }
        const batch: { key: string; scale: number; x: number; z: number }[] = [];
        for (const [key, job] of this.pending) {
          if (job.scale !== pick) continue;
          batch.push({ key, ...job });
          this.pending.delete(key);
          this.inflight.add(key);
        }
        if (!batch.length) break;
        const generation = this.generation;
        const state = this.state();
        try {
          const buffer = await call<ArrayBuffer | Uint8Array>('renderTiles', {
            ...state,
            sx: TILE_CELLS,
            sz: TILE_CELLS,
            tiles: batch.map((job) => ({ scale: job.scale, x: job.x, z: job.z })),
          });
          if (generation !== this.generation) {
            for (const job of batch) this.inflight.delete(job.key);
            break;
          }
          const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
          const stride = TILE_CELLS * TILE_CELLS * 4;
          batch.forEach((job, index) => {
            const start = index * stride;
            const slice = bytes.subarray(start, start + stride);
            if (slice.length !== stride || slice[3] === 0) return;
            const copy = new Uint8ClampedArray(stride);
            copy.set(slice);
            const image = new ImageData(copy, TILE_CELLS, TILE_CELLS);
            const tile = document.createElement('canvas');
            tile.width = TILE_CELLS;
            tile.height = TILE_CELLS;
            tile.getContext('2d')!.putImageData(image, 0, 0);
            this.tiles.set(job.key, tile);
            this.evictTiles(job.key);
            this.attempts.delete(job.key);
          });
          this.queueDraw();
        } catch (error) {
          this.readout.textContent = error instanceof Error ? error.message : String(error);
          if (generation === this.generation) {
            for (const job of batch) {
              const tries = (this.attempts.get(job.key) ?? 0) + 1;
              this.attempts.set(job.key, tries);
              if (tries < 3) this.pending.set(job.key, { scale: job.scale, x: job.x, z: job.z });
            }
            await new Promise((resolve) => window.setTimeout(resolve, 300));
          } else {
            break;
          }
        } finally {
          for (const job of batch) this.inflight.delete(job.key);
        }
      }
    } finally {
      this.flushRunning = false;
      if (this.flushQueued && this.pending.size) {
        this.flushQueued = false;
        queueMicrotask(() => void this.flush());
      }
    }
  }

  private viewBounds() {
    const halfW = this.canvas.width / 2 / this.pixelsPerBlock;
    const halfH = this.canvas.height / 2 / this.pixelsPerBlock;
    return { x0: this.cx - halfW, z0: this.cz - halfH, x1: this.cx + halfW, z1: this.cz + halfH };
  }

  private evictTiles(keep: string): void {
    const view = this.viewBounds();
    const span = TILE_CELLS * this.activeScale();
    const cols = Math.ceil((view.x1 - view.x0) / span) + 1;
    const rows = Math.ceil((view.z1 - view.z0) / span) + 1;
    const limit = Math.min(800, Math.max(cols * rows * 2 + 4, 16));
    if (this.tiles.size <= limit) return;
    for (const cached of [...this.tiles.keys()]) {
      if (this.tiles.size <= limit) break;
      if (cached === keep || this.tileVisible(cached, view)) continue;
      this.tiles.delete(cached);
    }
  }

  private tileVisible(key: string, view: { x0: number; z0: number; x1: number; z1: number }): boolean {
    const parts = key.split('|');
    const z = Number(parts.pop());
    const x = Number(parts.pop());
    const scale = Number(parts.pop());
    const span = TILE_CELLS * scale;
    return x + span > view.x0 && x < view.x1 && z + span > view.z0 && z < view.z1;
  }

  private async loadFeatures(): Promise<void> {
    if (!this.version.value) return;
    const view = this.viewBounds();
    const state = this.state();
    const types = this.visibleFeatures()
      .filter((feature) => this.enabled.has(feature.id) && feature.id !== -2)
      .map((feature) => feature.id);
    if (!types.length) {
      this.placed = [];
      this.queueDraw();
      return;
    }
    const token = ++this.featureGen;
    try {
      const placed = await call<Placed[]>('structures', {
        ...state,
        x0: Math.round(view.x0),
        z0: Math.round(view.z0),
        x1: Math.round(view.x1),
        z1: Math.round(view.z1),
        types,
      });
      if (token !== this.featureGen) return;
      this.placed = placed;
      this.queueDraw();
    } catch {
      if (token !== this.featureGen) return;
      this.placed = [];
      this.queueDraw();
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, scale: number): void {
    if (!this.grid.checked) return;
    const span = TILE_CELLS * scale;
    const view = this.viewBounds();
    const x0 = Math.floor(view.x0 / span) * span;
    const z0 = Math.floor(view.z0 / span) * span;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.lineWidth = 1;
    ctx.font = '12px "Segoe UI", sans-serif';
    for (let z = z0; z < view.z1; z += span) {
      for (let x = x0; x < view.x1; x += span) {
        const origin = this.worldToScreen(x, z);
        const size = span * this.pixelsPerBlock;
        ctx.strokeRect(origin.x + 0.5, origin.y + 0.5, size, size);
        if (size < 50) continue;
        const label = `${x}, ${z}`;
        const width = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(origin.x + 1, origin.y + 1, width + 6, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, origin.x + 4, origin.y + 13);
      }
    }
    ctx.restore();
  }

  private slimeEnabled(): boolean {
    return Number(this.dimension.value) === 0 && this.features.some((feature) => feature.id === -2 && this.enabled.has(feature.id));
  }

  private drawSlime(ctx: CanvasRenderingContext2D, state: ReturnType<MapView['state']>): void {
    if (!this.slimeEnabled() || 16 * this.pixelsPerBlock <= 0.5) return;
    const view = this.viewBounds();
    if (this.slimeCanvas && this.slimeSeed === state.seed && this.slimeCovers(view)) {
      const origin = this.worldToScreen(this.slimeOrigin.cx * 16, this.slimeOrigin.cz * 16);
      const w = this.slimeSpan.w * 16 * this.pixelsPerBlock;
      const h = this.slimeSpan.h * 16 * this.pixelsPerBlock;
      if (w <= MAX_TILE_DRAW_PX * 4 && h <= MAX_TILE_DRAW_PX * 4) {
        try {
          ctx.drawImage(this.slimeCanvas, origin.x, origin.y, w, h);
        } catch {
          /* ignore oversized slime overlay */
        }
      }
    }
    this.ensureSlime(state, view);
  }

  private slimeCovers(view: { x0: number; z0: number; x1: number; z1: number }): boolean {
    const x0 = this.slimeOrigin.cx * 16;
    const z0 = this.slimeOrigin.cz * 16;
    const x1 = x0 + this.slimeSpan.w * 16;
    const z1 = z0 + this.slimeSpan.h * 16;
    return x0 <= view.x0 && z0 <= view.z0 && x1 >= view.x1 && z1 >= view.z1;
  }

  private ensureSlime(state: ReturnType<MapView['state']>, view: { x0: number; z0: number; x1: number; z1: number }): void {
    if (this.slimeFlight) return;
    if (this.slimeCanvas && this.slimeSeed === state.seed && this.slimeCovers(view)) return;
    const pad = Math.max(8, Math.ceil(20 / this.pixelsPerBlock / 16));
    const cx = Math.floor(view.x0 / 16) - pad;
    const cz = Math.floor(view.z0 / 16) - pad;
    const w = Math.ceil((view.x1 - view.x0) / 16) + pad * 2 + 2;
    const h = Math.ceil((view.z1 - view.z0) / 16) + pad * 2 + 2;
    if (w > 2048 || h > 2048) return;
    this.slimeFlight = true;
    const generation = this.generation;
    void call<ArrayBuffer | Uint8Array>('slimeMask', { seed: state.seed, cx, cz, w, h }).then((buffer) => {
      if (generation !== this.generation) return;
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      if (bytes.length !== w * h) return;
      const pixels = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < bytes.length; i++) {
        const slime = bytes[i] === 1;
        pixels[i * 4] = 0;
        pixels[i * 4 + 1] = slime ? 255 : 0;
        pixels[i * 4 + 2] = 0;
        pixels[i * 4 + 3] = 64;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')!.putImageData(new ImageData(pixels, w, h), 0, 0);
      this.slimeCanvas = canvas;
      this.slimeSeed = state.seed;
      this.slimeOrigin = { cx, cz };
      this.slimeSpan = { w, h };
      this.queueDraw();
    }).catch((error) => {
      this.readout.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      this.slimeFlight = false;
    });
  }

  private loadIcon(name: string): HTMLImageElement {
    let image = this.icons.get(name);
    if (!image) {
      image = new Image();
      image.src = `/icons/${name}.png`;
      image.addEventListener('load', () => this.queueDraw());
      this.icons.set(name, image);
    }
    return image;
  }

  private structureIcon(key: string, variant = 0): HTMLImageElement | null {
    let name = ICONS[key];
    if (key === 'end_city' && variant === 1) name = 'end_ship';
    if (key === 'abandoned_camp' && variant === 1) name = 'camp_copper';
    if (!name) return null;
    const image = this.loadIcon(name);
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  private drawPlaced(ctx: CanvasRenderingContext2D): void {
    const byId = new Map(this.features.map((feature) => [feature.id, feature]));
    for (const item of this.placed) {
      if (item.type === -2) continue;
      const feature = byId.get(item.type);
      const point = this.worldToScreen(item.x, item.z);
      const icon = feature ? this.structureIcon(feature.key, item.variant ?? 0) : null;
      if (icon) {
        ctx.drawImage(icon, point.x - ICON_SIZE / 2, point.y - ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
      } else {
        ctx.fillStyle = COLORS[feature?.key || ''] || '#fff';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private async updateBiome(): Promise<void> {
    if (!this.version.value) return;
    try {
      const biome = await call<{ name: string }>('biomeAt', {
        ...this.state(),
        x: Math.round(this.pointer.x),
        z: Math.round(this.pointer.z),
      });
      this.readout.textContent = `${Math.round(this.pointer.x)}, ${Math.round(this.pointer.z)}  ${t('map.biome')} ${biomeLabel(biome.name)}`;
    } catch {
      this.readout.textContent = `${Math.round(this.pointer.x)}, ${Math.round(this.pointer.z)}`;
    }
  }
}
