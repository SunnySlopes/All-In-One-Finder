import { escapeText, showNotice } from './dialog';
import { biomeLabel, onLocale, structureLabel, t } from './i18n';
import {
  call,
  type Bounds3,
  type FeatureInfo,
  type GeodeChunkInfo,
  type McVersion,
  type Placed,
  type StructureBoundsData,
  type TrialChamberInfo,
  type TrialFrame,
  type TrialSpawner,
} from './native';
import { type MapSessionData } from './session';

export interface MapAreaOverlay {
  kind: 'rect' | 'circle';
  x: number;
  z: number;
  width?: number;
  height?: number;
  radius?: number;
  color?: string;
}

interface JumpOptions {
  x: number;
  z: number;
  seed?: string;
  y?: number;
  dimension?: number;
  mcVersion?: string;
  largeBiomes?: boolean;
  slimeChunks?: boolean;
  /** 打开这些结构图标（例如女巫小屋结果跳转时的 swamp_hut）。 */
  features?: string[];
  spawnCircles?: boolean;
  /** 刷怪环半径；缺省 [24,128]。 */
  spawnRadii?: number[];
  /** 结果区域覆盖层；缺省会清掉上一块。 */
  areaOverlay?: MapAreaOverlay | null;
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

const TILE_CELLS = 128;
/** GPU/canvas dest textures often fail above ~4k–8k; oversized drawImage aborts the frame. */
const MAX_TILE_DRAW_PX = 4096;
/** Keep at most this many cached tile canvases; off-screen ones are evicted first. */
const MAX_TILE_CACHE = 256;
/** Drop pending jobs that fall outside the view expanded by this many tiles. */
const PENDING_MARGIN_TILES = 1;
const MAX_PENDING = 96;
const ICON_SIZE = 20;
/** Ocean monuments are 58x58 blocks and centered on the structure position. */
const MONUMENT_SIZE = 58;
/**
 * Trial chambers: only the whole-trial outline (outermost union of all pieces,
 * padded by one block) is drawn (from 1:4); cage columns appear at 1:1.
 */
const TRIAL_FRAME_MIN_PPB = 0.25;
const TRIAL_CAGE_MIN_PPB = 1;
/** Geodes generate roughly once per 43 chunks; below 1:1 their icons overlap into noise. */
const GEODE_ICON_MIN_PPB = 1;
const TRIAL_DETAIL_BATCH = 8;
const TRIAL_DETAIL_MARGIN = 128;
const TRIAL_DETAIL_DEBOUNCE = 150;
/** Keep the parsed detail cache bounded while panning at 1:4. */
const TRIAL_DETAIL_CACHE = 600;
const TRIAL_FRAME_MIN_PX = 6;
const TRIAL_CAGE_HIT_PX = 7;
const TRIAL_CAGE_HOVER_PX = 6;
const TRIAL_CAGE_RADIUS = 2.5;
const TRIAL_FRAME_STROKE = 'rgba(208, 162, 74, 0.9)';
const TRIAL_FRAME_FILL = 'rgba(208, 162, 74, 0.06)';
const TRIAL_CAGE_FAST = '#ffd166';
const TRIAL_CAGE_SLOW = '#7fd0c8';
const TRIAL_CAGE_EDGE = 'rgba(20, 20, 20, 0.8)';
const SESSION_NAME = 'map';
const DEFAULT_FEATURES = [
  'swamp_hut',
  'village',
  'outpost',
  'monument',
  'stronghold',
  'spawn',
  'fortress',
  'bastion',
  'end_city',
];

/**
 * 地图版本下拉只保留 1.18 及以上（本程序只支持 Java 1.18+），并按新到旧排列。
 * 原生 `versions()` 仍返回完整列表供其他面板解析版本档位，这里只裁剪地图选择器。
 */
function mapVersions(versions: McVersion[]): McVersion[] {
  return versions.filter((item) => {
    const match = /^(\d+)\.(\d+)/.exec(item.name);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 1 || (major === 1 && minor >= 18);
  }).reverse();
}

interface MapSession {
  seed: string;
  version: string;
  dim: number;
  y: number;
  largeBiomes: boolean;
  grid: boolean;
  features: string[];
}

type DetailState = 'none' | 'pending' | 'ready' | 'failed';

interface SelectedStructure {
  type: number;
  key: string;
  x: number;
  z: number;
  variant: number;
  large?: Bounds3;
  details: DetailState;
  /** Set when the user clicked a trial cage column instead of the chamber icon. */
  cage?: TrialCageColumn;
  /** Geode icon: generate that chunk and show its budding-amethyst count. */
  geode?: { state: 'pending' | 'ready' | 'failed'; budding?: number };
}

/** All cages sharing one XZ column; drawn as a single point, listed Y by Y. */
interface TrialCageColumn {
  x: number;
  z: number;
  entries: TrialSpawner[];
  slow: boolean;
  mixed: boolean;
}

interface TrialChamberDetail {
  exists: boolean;
  pieces: number;
  frames: TrialFrame[];
  spawners: TrialSpawner[];
  /** Cages aggregated by XZ for drawing and hit-testing. */
  cages: TrialCageColumn[];
  /** Frames union, computed once for whole-chamber culling. */
  extent?: { minX: number; minZ: number; maxX: number; maxZ: number };
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
    const data = JSON.parse(raw) as Partial<MapSession> & { mcVersion?: unknown };
    if (typeof data.seed !== 'string' || !data.seed.trim()) return null;
    // 自动保存文件使用 version（字符串），手动导出的 session 使用 mcVersion。
    const named = typeof data.version === 'string'
      ? data.version
      : typeof data.mcVersion === 'string' ? data.mcVersion : '';
    return {
      seed: data.seed.trim(),
      version: named,
      dim: Number.isFinite(Number(data.dim)) ? Number(data.dim) : 0,
      y: Number.isFinite(Number(data.y)) ? Number(data.y) : 256,
      largeBiomes: !!data.largeBiomes,
      grid: data.grid !== false,
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
  private info: HTMLElement;
  private infoIcon: HTMLImageElement;
  private infoName: HTMLElement;
  private infoCoords: HTMLElement;
  private infoDetails: HTMLElement;
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
  private selected: SelectedStructure | null = null;
  private selectGen = 0;
  private press: { x: number; y: number; moved: boolean } | null = null;
  private grid!: HTMLInputElement;
  private icons = new Map<string, HTMLImageElement>();
  private slimeCanvas: HTMLCanvasElement | null = null;
  private slimeSeed = '';
  private slimeOrigin = { cx: 0, cz: 0 };
  private slimeSpan = { w: 0, h: 0 };
  private slimeFlight = false;
  private spawnOverlay: { x: number; z: number; radii?: number[] } | null = null;
  private areaOverlay: MapAreaOverlay | null = null;
  private trialTypeId = -1;
  private trialDetail = new Map<string, TrialChamberDetail>();
  private trialInflight = new Set<string>();
  private trialEpoch = 0;
  private trialView = 0;
  private trialTimer = 0;
  private trialFailed = false;
  private trialHover: TrialCageColumn | null = null;
  private biomeName = '';
  private saveTimer = 0;
  private loaded = false;
  private saveNoticeShown = false;
  private drawing = false;
  private drawQueued = false;
  onSeedChange: (seed: string) => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack';
    this.root.innerHTML = `
      <div class="grid">
        <label data-i18n="common.search.version"></label><select id="map-version"></select>
        <label data-i18n="common.search.seed"></label><input id="map-seed" value="${randomMcSeed()}" />
        <label data-i18n="common.map.dimension"></label><select id="map-dim"></select>
        <label data-i18n="common.map.y"></label><input id="map-y" type="number" value="256" />
        <label data-i18n="common.map.largeBiomes"></label><input id="map-large" type="checkbox" />
      </div>
      <div class="row">
        <label class="feature"><input id="map-grid" type="checkbox" checked /><span data-i18n="common.map.grid"></span></label>
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
    this.info = document.createElement('div');
    this.info.id = 'structure-info';
    this.info.hidden = true;
    this.info.innerHTML = `
      <div class="si-head"><img class="si-icon" alt="" /><strong class="si-name"></strong></div>
      <div class="si-coords"></div>
      <div class="si-details"></div>
    `;
    this.infoIcon = this.info.querySelector('.si-icon')!;
    this.infoName = this.info.querySelector('.si-name')!;
    this.infoCoords = this.info.querySelector('.si-coords')!;
    this.infoDetails = this.info.querySelector('.si-details')!;
    this.bind();
  }

  mountCanvas(stage: HTMLElement): void {
    stage.append(this.canvas, this.readout, this.info);
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
    this.versions = mapVersions(versions);
    this.features = features;
    this.trialTypeId = features.find((feature) => feature.key === 'trial_chambers')?.id ?? -1;
    this.version.innerHTML = this.versions.map((item) => `<option value="${item.id}">${item.name}</option>`).join('');
    const hadSession = !!window.aio?.hasSession;
    const session = await this.loadSession();
    const preferred = (session?.version && this.versions.find((item) => item.name === session.version))
      || this.versions.find((item) => item.name === '26.3')
      || this.versions[0];
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
      this.grid.checked = session.grid;
      localStorage.setItem('aio.grid', session.grid ? '1' : '0');
    }
    const enabledKeys = new Set(session?.features ?? DEFAULT_FEATURES);
    this.enabled.clear();
    for (const feature of features) {
      if (enabledKeys.has(feature.key)) this.enabled.add(feature.id);
    }
    this.renderFeatures();
    this.schedule(true);
    this.queueFeatures();
    this.loaded = true;
    // 没有旧 session 时也立即生成一份，避免用户首次打开后看不到 map.json。
    // 只有“旧文件存在但读取失败”才不回写，防止用默认值覆盖可恢复的数据。
    if (session || !hadSession) this.persistSession();
    this.onSeedChange(this.getSeed());
  }

  getSeed(): string {
    return this.seed.value.trim();
  }

  /** 版本/地物列表就绪后才允许自动保存，避免启动瞬间用默认值覆盖旧 session。 */
  hasLoaded(): boolean {
    return this.loaded;
  }

  /** 女巫小屋搜索开始时的世界预设快照：大型生物群系跟随地图勾选。 */
  getLargeBiomes(): boolean {
    return this.large.checked && Number(this.dimension.value) === 0;
  }

  /** 当前地图版本名（例如 1.21.3 / 26.3），用于结果跳转时选择地图版本。 */
  getVersionName(): string {
    const version = this.versions.find((item) => String(item.id) === this.version.value);
    return version?.name ?? '';
  }

  /** 当前地图 Y；带 dimension 但没传 y 时 jumpTo 会重置，结果跳转需显式保留。 */
  getY(): number {
    const value = Number(this.y.value);
    return Number.isFinite(value) ? value : 64;
  }

  clearAreaOverlay(): void {
    this.areaOverlay = null;
    this.queueDraw();
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
    this.clearAreaOverlay();
    this.schedule(true);
    this.queueFeatures();
    if (announce) this.onSeedChange(seed.trim());
  }

  /** 搜索页输入种子时先同步“待保存”的值，不触发地图重绘；失焦/回车仍走 setSeed。 */
  setSeedDraft(seed: string): void {
    const value = seed.trim();
    if (!value) return;
    this.seed.value = value;
    this.persistSession();
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
    this.clearSelection();
    const previous = {
      seed: this.seed.value.trim(),
      version: this.version.value,
      dim: this.dimension.value,
      y: this.y.value,
      large: this.large.value,
    };
    const nextSeed = options.seed != null ? options.seed.trim() : this.seed.value.trim();
    let nextY = options.y != null ? String(options.y) : this.y.value;
    if (options.seed != null && nextSeed) {
      this.seed.value = nextSeed;
      this.onSeedChange(nextSeed);
    }
    if (options.mcVersion) {
      const match = this.versions.find((item) => item.name === options.mcVersion);
      if (match) this.version.value = String(match.id);
    }
    if (options.largeBiomes != null) {
      this.large.checked = options.largeBiomes;
    }
    if (options.dimension != null) {
      this.dimension.value = String(options.dimension);
      if (options.y == null) nextY = String(defaultYForDim(options.dimension));
      this.y.value = nextY;
      this.renderFeatures();
    } else if (options.y != null) {
      this.y.value = nextY;
    }
    if (options.slimeChunks) {
      const feature = this.features.find((item) => item.id === -2);
      if (feature) {
        this.enabled.add(feature.id);
        this.slimeCanvas = null;
        this.renderFeatures();
      }
    }
    if (options.features?.length) {
      let changed = false;
      for (const key of options.features) {
        const feature = this.features.find((item) => item.key === key);
        if (feature && !this.enabled.has(feature.id)) {
          this.enabled.add(feature.id);
          changed = true;
        }
      }
      if (changed) this.renderFeatures();
    }
    const worldChanged = nextSeed !== previous.seed
      || nextY !== previous.y
      || this.version.value !== previous.version
      || this.dimension.value !== previous.dim
      || this.large.value !== previous.large;
    this.cx = options.x;
    this.cz = options.z;
    this.persistSession();
    // Panning keeps the current tiles on screen. Only a seed/Y/version/dimension change drops the cache.
    this.schedule(worldChanged);
    this.spawnOverlay = options.spawnCircles
      ? { x: options.x, z: options.z, radii: options.spawnRadii }
      : null;
    this.areaOverlay = options.areaOverlay ?? null;
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
      option.textContent = t(`common.map.${option.dataset.key}`);
    });
    this.renderSelectedInfo();
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
    // 输入过程中也先落盘：用户直接关窗口时不会因为没触发 change 而丢掉新种子。
    this.seed.addEventListener('input', () => this.persistSession());
    // 关闭/切后台时立即提交，缩短“最后一次修改还没写回”的窗口。
    window.addEventListener('pagehide', () => this.flushSession());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSession();
    });
    // 输入过程中不做跳图/同步；失焦或回车后再提交。
    this.seed.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.seed.dispatchEvent(new Event('change', { bubbles: true }));
    });
    this.grid.addEventListener('change', () => {
      localStorage.setItem('aio.grid', this.grid.checked ? '1' : '0');
      this.queueDraw();
    });
    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.dragging = true;
      this.press = { x: event.clientX, y: event.clientY, moved: false };
      this.canvas.classList.add('dragging');
      this.lastX = event.clientX;
      this.lastZ = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointerup', (event) => {
      const press = this.press;
      this.press = null;
      this.dragging = false;
      this.canvas.classList.remove('dragging');
      this.pruneTilePipeline();
      if (press && !press.moved) this.selectAt(event.offsetX, event.offsetY);
      this.queueDraw();
      this.kickFlush();
      this.queueFeatures();
    });
    this.canvas.addEventListener('pointercancel', () => {
      this.press = null;
      this.dragging = false;
      this.canvas.classList.remove('dragging');
      this.pruneTilePipeline();
      this.queueDraw();
      this.kickFlush();
      this.queueFeatures();
    });
    this.canvas.addEventListener('pointermove', (event) => {
      const world = this.screenToWorld(event.offsetX, event.offsetY);
      this.pointer = world;
      this.updateTrialHover(event.offsetX, event.offsetY);
      if (this.press && !this.press.moved) {
        const dx = event.clientX - this.press.x;
        const dy = event.clientY - this.press.y;
        if (dx * dx + dy * dy > 16) this.press.moved = true;
      }
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
    this.trialHover = null;
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
          if (id === this.trialTypeId) this.clearTrialDetail();
          if (this.selected?.type === id) this.clearSelection();
        }
        if (id === -2) this.slimeCanvas = null;
        this.persistSession();
        this.queueDraw();
        this.queueFeatures();
      });
    });
  }

  private structureIconName(key: string, variant = 0): string {
    if (key === 'end_city' && variant === 1) return 'end_ship';
    if (key === 'abandoned_camp' && variant === 1) return 'camp_copper';
    return ICONS[key] || '';
  }

  private boxSizeText(box: Bounds3): string {
    return `${box.maxX - box.minX + 1}×${box.maxY - box.minY}×${box.maxZ - box.minZ + 1}`;
  }

  private clearSelection(): void {
    this.selectGen += 1;
    this.selected = null;
    this.info.hidden = true;
    this.queueDraw();
  }

  private selectStructure(item: Placed, cage?: TrialCageColumn): void {
    const feature = this.features.find((entry) => entry.id === item.type);
    if (!feature) return;

    const selected: SelectedStructure = {
      type: item.type,
      key: feature.key,
      x: item.x,
      z: item.z,
      variant: item.variant ?? 0,
      details: 'none',
      cage,
    };
    this.selected = selected;
    const token = ++this.selectGen;

    if (feature.key === 'monument') {
      selected.details = 'ready';
    } else if (feature.key === 'trial_chambers') {
      if (!this.trialDetailAllowed()) {
        // Large biomes / hidden layer: stay silent, no request and no extra text.
        selected.details = 'none';
      } else if (this.trialDetailAt(item.x, item.z)) {
        selected.details = 'ready';
      } else {
        selected.details = 'pending';
        void call<TrialChamberInfo[]>('trialChambers', {
          ...this.state(),
          chambers: [{ x: item.x, z: item.z }],
        }).then((list) => {
          if (token !== this.selectGen || this.selected !== selected) return;
          for (const info of list) this.trialDetail.set(this.trialKey(info.x, info.z), this.compactTrial(info));
          selected.details = this.trialDetailAt(item.x, item.z) ? 'ready' : 'failed';
          this.renderSelectedInfo();
          this.queueDraw();
        }).catch(() => {
          if (token !== this.selectGen || this.selected !== selected) return;
          selected.details = 'failed';
          this.renderSelectedInfo();
          this.queueDraw();
        });
      }
    } else if (feature.key === 'geode') {
      selected.details = 'pending';
      selected.geode = { state: 'pending' };
      void call<GeodeChunkInfo>('geodeChunk', {
        version: this.getVersionName(),
        seed: this.getSeed(),
        x: item.x,
        z: item.z,
      }).then((info) => {
        if (token !== this.selectGen || this.selected !== selected) return;
        selected.geode = { state: 'ready', budding: info.budding };
        selected.details = 'ready';
        this.renderSelectedInfo();
      }).catch(() => {
        if (token !== this.selectGen || this.selected !== selected) return;
        selected.geode = { state: 'failed' };
        selected.details = 'failed';
        this.renderSelectedInfo();
      });
    } else if (feature.key === 'fortress') {
      if (item.large) {
        selected.large = item.large;
        selected.details = 'ready';
      } else {
        selected.details = 'pending';
        void call<StructureBoundsData | null>('structureBounds', {
          ...this.state(),
          type: item.type,
          x: item.x,
          z: item.z,
        }).then((bounds) => {
          if (token !== this.selectGen || this.selected !== selected) return;
          if (bounds) {
            selected.large = bounds.large;
            selected.details = 'ready';
          } else {
            selected.details = 'failed';
          }
          this.renderSelectedInfo();
          this.queueDraw();
        }).catch(() => {
          if (token !== this.selectGen || this.selected !== selected) return;
          selected.details = 'failed';
          this.renderSelectedInfo();
          this.queueDraw();
        });
      }
    }

    this.renderSelectedInfo();
    this.queueDraw();
  }

  private renderSelectedInfo(): void {
    const selected = this.selected;
    if (!selected) {
      this.info.hidden = true;
      return;
    }
    this.info.hidden = false;
    const icon = this.structureIconName(selected.key, selected.variant);
    this.infoIcon.src = icon ? `/icons/${icon}.png` : '';
    this.infoIcon.style.display = icon ? '' : 'none';
    let name = structureLabel(selected.key);
    this.infoName.textContent = name;
    this.infoCoords.textContent = `(${selected.x}, ${selected.z})`;

    const rows: string[] = [];
    if (selected.large) {
      rows.push(`<div>${this.boxSizeText(selected.large)}</div>`);
    } else if (selected.key === 'trial_chambers') {
      if (!this.trialDetailAllowed()) {
        // Large biomes: silent by design (no request, no drawing, no hint).
      } else {
        const detail = this.trialDetailAt(selected.x, selected.z);
        if (detail) {
          if (!detail.exists) {
            rows.push(`<div>${escapeText(t('common.map.trialNotGenerated'))}</div>`);
          } else {
            const total = detail.spawners.length;
            const fast = detail.spawners.filter((spawner) => !spawner.slow).length;
            const slow = total - fast;
            rows.push(`<div>${escapeText(t('common.map.trialCages', { total, fast, slow }))}</div>`);
            if (selected.cage) {
              for (const line of this.trialCageLines(selected.cage)) {
                rows.push(`<div>${escapeText(line)}</div>`);
              }
            }
          }
        }
      }
    } else if (selected.key === 'geode' && selected.geode?.state === 'ready') {
      rows.push(`<div>${escapeText(t('common.map.geodeBudding', { count: selected.geode.budding ?? 0 }))}</div>`);
    } else if (selected.details === 'pending') {
      rows.push(`<div>${escapeText(t('common.map.calculating'))}</div>`);
    } else if (selected.details === 'failed') {
      rows.push(`<div>${escapeText(t('common.map.boundsFailed'))}</div>`);
    }
    this.infoDetails.innerHTML = rows.join('');
  }

  private selectAt(screenX: number, screenY: number): void {
    const cage = this.findTrialCage(screenX, screenY, TRIAL_CAGE_HIT_PX);
    if (cage) {
      this.selectStructure(cage.item, cage.cage);
      return;
    }
    const radius = ICON_SIZE / 2 + 6;
    let best: Placed | null = null;
    let bestDistance = radius * radius;
    for (const item of this.placed) {
      if (item.type === -2) continue;
      const point = this.worldToScreen(item.x, item.z);
      const dx = point.x - screenX;
      const dy = point.y - screenY;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    if (best) this.selectStructure(best);
    else this.clearSelection();
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

  /** 关闭/隐藏窗口时跳过防抖立即提交一次。 */
  private flushSession(): void {
    window.clearTimeout(this.saveTimer);
    void this.writeSession();
  }

  private async writeSession(): Promise<void> {
    if (!this.loaded) return;
    const text = JSON.stringify(this.exportSnapshot());
    try {
      localStorage.setItem('aio.session', text);
    } catch {
      /* ignore */
    }
    try {
      const saved = await window.aio?.writeSession?.(SESSION_NAME, text);
      if (saved === false && !this.saveNoticeShown) {
        this.saveNoticeShown = true;
        showNotice(t('common.error.session-save-failed'));
      }
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
      this.flushQueued = false;
      this.generation += 1;
      this.featureGen += 1;
      this.slimeCanvas = null;
      this.slimeFlight = false;
      this.placed = [];
      this.clearTrialDetail();
      this.clearSelection();
    }
    this.queueDraw();
  }

  /** Drop cached chamber layouts when the world/version changes or the layer is turned off. */
  private clearTrialDetail(): void {
    this.trialEpoch += 1;
    this.trialDetail.clear();
    this.trialInflight.clear();
    this.trialHover = null;
    this.trialFailed = false;
    window.clearTimeout(this.trialTimer);
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
    this.queueTrialDetails();
  }

  private trialKey(x: number, z: number): string {
    return `${x}|${z}`;
  }

  /**
   * Trial map details are only valid for the overworld, without large biomes
   * (the trial biome bridge has no LARGE_BIOMES flag), and while the layer is on.
   * Large biomes are skipped silently: no request, no drawing, no hint.
   */
  private trialDetailAllowed(): boolean {
    if (Number(this.dimension.value) !== 0) return false;
    if (this.large.checked) return false;
    if (this.trialTypeId < 0 || !this.enabled.has(this.trialTypeId)) return false;
    return !this.trialFailed;
  }

  private trialFramesVisible(): boolean {
    return this.trialDetailAllowed() && this.pixelsPerBlock >= TRIAL_FRAME_MIN_PPB;
  }

  private trialSpawnersVisible(): boolean {
    return this.trialDetailAllowed() && this.pixelsPerBlock >= TRIAL_CAGE_MIN_PPB;
  }

  private queueTrialDetails(): void {
    window.clearTimeout(this.trialTimer);
    if (!this.trialFramesVisible()) return;
    this.trialTimer = window.setTimeout(() => void this.loadTrialDetails(), TRIAL_DETAIL_DEBOUNCE);
  }

  private trialViewport(): { x0: number; z0: number; x1: number; z1: number } {
    const view = this.viewBounds();
    const pad = TRIAL_DETAIL_MARGIN;
    return { x0: view.x0 - pad, z0: view.z0 - pad, x1: view.x1 + pad, z1: view.z1 + pad };
  }

  private async loadTrialDetails(): Promise<void> {
    if (!this.trialFramesVisible()) return;
    const view = this.trialViewport();
    const todo: Placed[] = [];
    for (const item of this.placed) {
      if (item.type !== this.trialTypeId) continue;
      if (item.x < view.x0 || item.x > view.x1 || item.z < view.z0 || item.z > view.z1) continue;
      const key = this.trialKey(item.x, item.z);
      if (this.trialDetail.has(key) || this.trialInflight.has(key)) continue;
      todo.push(item);
    }
    if (!todo.length) return;
    const center = this.viewBounds();
    const midX = (center.x0 + center.x1) / 2;
    const midZ = (center.z0 + center.z1) / 2;
    todo.sort((a, b) => {
      const da = (a.x - midX) ** 2 + (a.z - midZ) ** 2;
      const db = (b.x - midX) ** 2 + (b.z - midZ) ** 2;
      return da - db;
    });
    const batch = todo.slice(0, TRIAL_DETAIL_BATCH);
    for (const item of batch) this.trialInflight.add(this.trialKey(item.x, item.z));
    const epoch = this.trialEpoch;
    const viewToken = ++this.trialView;
    try {
      const list = await call<TrialChamberInfo[]>('trialChambers', {
        ...this.state(),
        chambers: batch.map((item) => ({ x: item.x, z: item.z })),
      });
      if (epoch !== this.trialEpoch) return;
      for (const info of list) this.trialDetail.set(this.trialKey(info.x, info.z), this.compactTrial(info));
      this.trimTrialCache();
      this.queueDraw();
      if (list.length < batch.length) {
        // The engine rejected the version/batch; stop instead of retrying every pan.
        this.trialFailed = true;
        return;
      }
      // Continue one batch at a time; the view token drops stale continuations.
      if (viewToken === this.trialView && this.trialFramesVisible()) {
        this.trialTimer = window.setTimeout(() => void this.loadTrialDetails(), 16);
      }
    } catch {
      // A failed op must not retry on every pan.
      if (epoch === this.trialEpoch) this.trialFailed = true;
    } finally {
      for (const item of batch) this.trialInflight.delete(this.trialKey(item.x, item.z));
    }
  }

  /** Aggregate cages by XZ and pre-compute the frame extent used for culling. */
  private compactTrial(info: TrialChamberInfo): TrialChamberDetail {
    const columns = new Map<string, TrialCageColumn>();
    for (const spawner of info.spawners) {
      const key = this.trialKey(spawner.x, spawner.z);
      let column = columns.get(key);
      if (!column) {
        column = { x: spawner.x, z: spawner.z, entries: [], slow: spawner.slow, mixed: false };
        columns.set(key, column);
      }
      column.entries.push(spawner);
      if (spawner.slow !== column.slow) column.mixed = true;
    }
    const cages = [...columns.values()];
    for (const column of cages) column.entries.sort((a, b) => a.y - b.y);

    let extent: TrialChamberDetail['extent'];
    const whole = info.bounds;
    if (whole && whole.maxX > whole.minX && whole.maxZ > whole.minZ) {
      // Engine-provided outer bounds already include the one-block horizontal pad.
      extent = { minX: whole.minX, minZ: whole.minZ, maxX: whole.maxX, maxZ: whole.maxZ };
    } else if (info.frames.length) {
      let minX = Number.POSITIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (const frame of info.frames) {
        if (frame.minX < minX) minX = frame.minX;
        if (frame.minZ < minZ) minZ = frame.minZ;
        if (frame.maxX > maxX) maxX = frame.maxX;
        if (frame.maxZ > maxZ) maxZ = frame.maxZ;
      }
      if (Number.isFinite(minX)) extent = { minX, minZ, maxX, maxZ };
    }
    return {
      exists: info.exists,
      pieces: info.pieces,
      frames: info.frames,
      spawners: info.spawners,
      cages,
      extent,
    };
  }

  private trialDetailAt(x: number, z: number): TrialChamberDetail | undefined {
    return this.trialDetail.get(this.trialKey(x, z));
  }

  /** Drop off-screen chambers when panning accumulates too many parsed layouts. */
  private trimTrialCache(): void {
    if (this.trialDetail.size <= TRIAL_DETAIL_CACHE) return;
    const view = this.trialViewport();
    for (const [key, detail] of [...this.trialDetail]) {
      if (this.trialInflight.has(key)) continue;
      if (detail.extent) {
        const e = detail.extent;
        if (e.maxX < view.x0 || e.minX > view.x1 || e.maxZ < view.z0 || e.minZ > view.z1) {
          this.trialDetail.delete(key);
        }
      }
    }
    if (this.trialDetail.size > TRIAL_DETAIL_CACHE) this.trialDetail.clear();
    this.trialHover = null;
  }

  /** Loaded chambers whose whole-trial extent intersects the viewport. */
  private visibleTrialChambers(): Placed[] {
    if (!this.trialDetailAllowed()) return [];
    const view = this.viewBounds();
    const out: Placed[] = [];
    for (const item of this.placed) {
      if (item.type !== this.trialTypeId) continue;
      const detail = this.trialDetailAt(item.x, item.z);
      if (!detail || !detail.exists || !detail.extent) continue;
      const e = detail.extent;
      if (e.maxX < view.x0 || e.minX > view.x1 || e.maxZ < view.z0 || e.minZ > view.z1) continue;
      out.push(item);
    }
    return out;
  }

  /** Nearest cage column under the cursor/click, limited to loaded chambers. */
  private findTrialCage(screenX: number, screenY: number, radiusPx: number): { item: Placed; cage: TrialCageColumn } | null {
    if (!this.trialSpawnersVisible()) return null;
    let best: { item: Placed; cage: TrialCageColumn } | null = null;
    let bestDistance = radiusPx * radiusPx;
    for (const item of this.visibleTrialChambers()) {
      const detail = this.trialDetailAt(item.x, item.z);
      if (!detail) continue;
      for (const cage of detail.cages) {
        const point = this.worldToScreen(cage.x + 0.5, cage.z + 0.5);
        const dx = point.x - screenX;
        const dy = point.y - screenY;
        const distance = dx * dx + dy * dy;
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = { item, cage };
        }
      }
    }
    return best;
  }

  private updateTrialHover(screenX: number, screenY: number): void {
    const hit = this.findTrialCage(screenX, screenY, TRIAL_CAGE_HOVER_PX);
    const next = hit?.cage ?? null;
    const same = next === null
      ? this.trialHover === null
      : this.trialHover !== null
        && this.trialHover.x === next.x
        && this.trialHover.z === next.z
        && this.trialHover.slow === next.slow
        && this.trialHover.entries.length === next.entries.length;
    if (same) return;
    this.trialHover = next;
    this.syncReadout();
    this.queueDraw();
  }

  /** Cage detail lines for the readout and the info card (one line per Y when mixed). */
  private trialCageLines(column: TrialCageColumn): string[] {
    if (!column.entries.length) return [];
    const kindOf = (slow: boolean) => t(slow ? 'common.map.trialCageSlow' : 'common.map.trialCageFast');
    if (column.mixed) {
      return column.entries.map((entry) => t('common.map.trialCageAt', {
        kind: kindOf(entry.slow), x: entry.x, y: entry.y, z: entry.z,
      }));
    }
    const kind = kindOf(column.slow);
    if (column.entries.length === 1) {
      const entry = column.entries[0];
      return [t('common.map.trialCageAt', { kind, x: entry.x, y: entry.y, z: entry.z })];
    }
    const ys = column.entries.map((entry) => entry.y).join('、');
    return [t('common.map.trialCageColumn', { kind, x: column.x, z: column.z, ys })];
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
      this.pruneTilePipeline();
      for (const level of [...levels].reverse()) {
        const request = level === scale
          || (scale === 1 && level === 4 && underlayOk)
          || (scale > 1 && level === scale * 4);
        this.paintLevel(ctx, state, level, request);
      }
      this.evictTiles();
      this.drawGrid(ctx, scale);
      this.drawAreaOverlay(ctx);
      this.drawSlime(ctx, state);
      this.drawSpawnCircles(ctx);
      this.drawStructureFrames(ctx);
      this.drawTrialFrames(ctx);
      this.drawTrialSpawners(ctx);
      this.drawPlaced(ctx);
      this.drawSelection(ctx);
      this.syncReadout();
    } finally {
      this.drawing = false;
      if (this.drawQueued) this.queueDraw();
    }
  }

  /** Compose the pointer readout from the current biome, hovered cage and coordinates. */
  private syncReadout(): void {
    const parts = [`${Math.round(this.pointer.x)}, ${Math.round(this.pointer.z)}`];
    if (this.biomeName) parts.push(biomeLabel(this.biomeName));
    if (this.trialHover) parts.push(...this.trialCageLines(this.trialHover));
    this.readout.textContent = parts.join('  ');
  }

  private drawSpawnCircles(ctx: CanvasRenderingContext2D): void {
    if (!this.spawnOverlay) return;
    const center = this.worldToScreen(this.spawnOverlay.x, this.spawnOverlay.z);
    ctx.save();
    ctx.strokeStyle = 'rgba(110, 220, 120, 0.95)';
    ctx.lineWidth = 2;
    for (const radius of this.spawnOverlay.radii ?? [24, 128]) {
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

  private drawAreaOverlay(ctx: CanvasRenderingContext2D): void {
    const overlay = this.areaOverlay;
    if (!overlay) return;
    const color = overlay.color ?? '#e6bf5a';
    if (overlay.kind === 'circle') {
      const center = this.worldToScreen(overlay.x, overlay.z);
      const radius = Math.max(1, overlay.radius ?? 128);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius * this.pixelsPerBlock, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const width = Math.max(1, overlay.width ?? 1);
    const height = Math.max(1, overlay.height ?? 1);
    const minX = overlay.x - Math.floor(width / 2);
    const minZ = overlay.z - Math.floor(height / 2);
    this.drawWorldRect(ctx, minX, minZ, minX + width - 1, minZ + height - 1, color);
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
    if (this.pending.size >= MAX_PENDING) this.prunePendingOnly();
    if (this.pending.size >= MAX_PENDING) {
      // Drop farthest pending job so the newest visible tile can enter the queue.
      let farthest: string | null = null;
      let farthestDist = -1;
      const view = this.viewBounds();
      const midX = (view.x0 + view.x1) / 2;
      const midZ = (view.z0 + view.z1) / 2;
      for (const [pendingKey, job] of this.pending) {
        const bx = job.x * job.scale + (TILE_CELLS * job.scale) / 2;
        const bz = job.z * job.scale + (TILE_CELLS * job.scale) / 2;
        const dist = Math.abs(bx - midX) + Math.abs(bz - midZ);
        if (dist > farthestDist) {
          farthestDist = dist;
          farthest = pendingKey;
        }
      }
      if (farthest) this.pending.delete(farthest);
    }
    this.pending.set(key, { scale, x, z });
    this.kickFlush();
  }

  /** Always safe to call: starts flush if idle, or marks a follow-up if busy. */
  private kickFlush(): void {
    if (!this.pending.size || !this.version.value) return;
    if (this.flushRunning) {
      this.flushQueued = true;
      return;
    }
    this.flushQueued = true;
    queueMicrotask(() => void this.flush());
  }

  /** Drop off-screen pending jobs only (does not touch the tile cache). */
  private prunePendingOnly(): void {
    const view = this.expandedViewBounds(PENDING_MARGIN_TILES);
    for (const [key, job] of this.pending) {
      const span = TILE_CELLS * job.scale;
      const x = job.x * job.scale;
      const z = job.z * job.scale;
      if (x + span <= view.x0 || x >= view.x1 || z + span <= view.z0 || z >= view.z1) {
        this.pending.delete(key);
      }
    }
  }

  /** Drop off-screen pending work and trim the tile canvas cache. */
  private pruneTilePipeline(): void {
    this.prunePendingOnly();
    this.evictTiles();
  }

  private expandedViewBounds(marginTiles: number) {
    const view = this.viewBounds();
    const span = TILE_CELLS * this.activeScale();
    const pad = span * Math.max(0, marginTiles);
    return { x0: view.x0 - pad, z0: view.z0 - pad, x1: view.x1 + pad, z1: view.z1 + pad };
  }

  private async flush(): Promise<void> {
    if (this.flushRunning) {
      this.flushQueued = true;
      return;
    }
    this.flushRunning = true;
    this.flushQueued = false;
    try {
      while (this.pending.size && this.version.value) {
        this.prunePendingOnly();
        if (!this.pending.size) break;
        // Prefer the active scale, then tiles closest to the current view center.
        const preferScale = this.activeScale();
        const view = this.viewBounds();
        const midX = (view.x0 + view.x1) / 2;
        const midZ = (view.z0 + view.z1) / 2;
        const ranked = [...this.pending.entries()].map(([key, job]) => {
          const bx = job.x * job.scale + (TILE_CELLS * job.scale) / 2;
          const bz = job.z * job.scale + (TILE_CELLS * job.scale) / 2;
          const dist = Math.abs(bx - midX) + Math.abs(bz - midZ);
          const scaleRank = job.scale === preferScale ? 0 : job.scale < preferScale ? 1 : 2;
          return { key, job, dist, scaleRank };
        });
        ranked.sort((a, b) => a.scaleRank - b.scaleRank || a.dist - b.dist);
        const pickScale = ranked[0]?.job.scale;
        const batch: { key: string; scale: number; x: number; z: number }[] = [];
        for (const item of ranked) {
          if (item.job.scale !== pickScale) continue;
          if (batch.length >= 8) break;
          batch.push({ key: item.key, ...item.job });
          this.pending.delete(item.key);
          this.inflight.add(item.key);
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
      // Critical: always clear the latch. If we only cleared when pending was
      // non-empty, a prune-to-empty mid-flush left flushQueued=true forever and
      // enqueueTile stopped scheduling new work after the next drag.
      const again = this.flushQueued || this.pending.size > 0;
      this.flushQueued = false;
      if (again && this.pending.size && this.version.value) {
        queueMicrotask(() => void this.flush());
      }
    }
  }

  private viewBounds() {
    const halfW = this.canvas.width / 2 / this.pixelsPerBlock;
    const halfH = this.canvas.height / 2 / this.pixelsPerBlock;
    return { x0: this.cx - halfW, z0: this.cz - halfH, x1: this.cx + halfW, z1: this.cz + halfH };
  }

  private evictTiles(keep?: string): void {
    const keepView = this.expandedViewBounds(PENDING_MARGIN_TILES);
    // Always drop canvases that are no longer near the viewport.
    for (const cached of [...this.tiles.keys()]) {
      if (cached === keep) continue;
      if (this.tileVisible(cached, keepView)) continue;
      this.tiles.delete(cached);
    }
    if (this.tiles.size <= MAX_TILE_CACHE) return;
    // If still over budget, drop farthest visible tiles (keep `keep` and nearest).
    const view = this.viewBounds();
    const midX = (view.x0 + view.x1) / 2;
    const midZ = (view.z0 + view.z1) / 2;
    const ranked = [...this.tiles.keys()]
      .filter((key) => key !== keep)
      .map((key) => {
        const parts = key.split('|');
        const z = Number(parts.pop());
        const x = Number(parts.pop());
        const scale = Number(parts.pop());
        const span = TILE_CELLS * scale;
        const dist = Math.abs(x + span / 2 - midX) + Math.abs(z + span / 2 - midZ);
        return { key, dist };
      })
      .sort((a, b) => b.dist - a.dist);
    for (const item of ranked) {
      if (this.tiles.size <= MAX_TILE_CACHE) break;
      this.tiles.delete(item.key);
    }
  }

  private tileVisible(key: string, view: { x0: number; z0: number; x1: number; z1: number }): boolean {
    const parts = key.split('|');
    const z = Number(parts.pop());
    const x = Number(parts.pop());
    const scale = Number(parts.pop());
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(scale) || scale <= 0) {
      return false;
    }
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
      this.queueTrialDetails();
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
    const name = this.structureIconName(key, variant);
    if (!name) return null;
    const image = this.loadIcon(name);
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  private drawSelection(ctx: CanvasRenderingContext2D): void {
    const selected = this.selected;
    if (!selected) return;
    // The cage ring only makes sense while cage points are actually drawn.
    const cage = selected.cage && this.trialSpawnersVisible() ? selected.cage : null;
    const point = cage
      ? this.worldToScreen(cage.x + 0.5, cage.z + 0.5)
      : this.worldToScreen(selected.x, selected.z);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, cage ? 5 : ICON_SIZE / 2 + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Draw the whole-trial outline (outermost piece union, padded by one block). */
  private drawTrialFrames(ctx: CanvasRenderingContext2D): void {
    if (!this.trialFramesVisible()) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = TRIAL_FRAME_STROKE;
    ctx.fillStyle = TRIAL_FRAME_FILL;
    for (const item of this.visibleTrialChambers()) {
      const detail = this.trialDetailAt(item.x, item.z);
      const extent = detail?.extent;
      if (!extent) continue;
      const topLeft = this.worldToScreen(extent.minX, extent.minZ);
      const bottomRight = this.worldToScreen(extent.maxX + 1, extent.maxZ + 1);
      const width = bottomRight.x - topLeft.x;
      const height = bottomRight.y - topLeft.y;
      if (!(width > 0) || !(height > 0)) continue;
      if (Math.min(width, height) < TRIAL_FRAME_MIN_PX) continue;
      if (topLeft.x > this.canvas.width || topLeft.y > this.canvas.height
        || topLeft.x + width < 0 || topLeft.y + height < 0) continue;
      ctx.beginPath();
      ctx.rect(topLeft.x, topLeft.y, width, height);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Cage columns at 1:1: slow as hollow rings, fast as filled dots, one point per XZ. */
  private drawTrialSpawners(ctx: CanvasRenderingContext2D): void {
    if (!this.trialSpawnersVisible()) return;
    const chambers = this.visibleTrialChambers();
    ctx.save();
    // Slow rings first so a fast dot never hides a slow one.
    ctx.strokeStyle = TRIAL_CAGE_SLOW;
    ctx.lineWidth = 1.5;
    for (const item of chambers) {
      const detail = this.trialDetailAt(item.x, item.z);
      if (!detail) continue;
      for (const cage of detail.cages) {
        if (!cage.slow && !cage.mixed) continue;
        const point = this.worldToScreen(cage.x + 0.5, cage.z + 0.5);
        if (!this.cageOnScreen(point)) continue;
        ctx.beginPath();
        ctx.arc(point.x, point.y, TRIAL_CAGE_RADIUS, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Fast discs (on a mixed column the dot sits inside the ring).
    ctx.fillStyle = TRIAL_CAGE_FAST;
    ctx.strokeStyle = TRIAL_CAGE_EDGE;
    ctx.lineWidth = 1;
    for (const item of chambers) {
      const detail = this.trialDetailAt(item.x, item.z);
      if (!detail) continue;
      for (const cage of detail.cages) {
        if (cage.slow && !cage.mixed) continue;
        const point = this.worldToScreen(cage.x + 0.5, cage.z + 0.5);
        if (!this.cageOnScreen(point)) continue;
        ctx.beginPath();
        ctx.arc(point.x, point.y, TRIAL_CAGE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // ×N badge: one point is drawn per XZ even when several cages share the column.
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.textBaseline = 'alphabetic';
    for (const item of chambers) {
      const detail = this.trialDetailAt(item.x, item.z);
      if (!detail) continue;
      for (const cage of detail.cages) {
        if (cage.entries.length <= 1) continue;
        const point = this.worldToScreen(cage.x + 0.5, cage.z + 0.5);
        if (!this.cageOnScreen(point)) continue;
        const label = `×${cage.entries.length}`;
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeText(label, point.x + 3, point.y - 3);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, point.x + 3, point.y - 3);
      }
    }
    if (this.trialHover) {
      const point = this.worldToScreen(this.trialHover.x + 0.5, this.trialHover.z + 0.5);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private cageOnScreen(point: { x: number; y: number }): boolean {
    return point.x >= -12 && point.y >= -12
      && point.x <= this.canvas.width + 12 && point.y <= this.canvas.height + 12;
  }

  /**
   * Monument frames are fixed 58x58 boxes. Fortress frames are drawn for every
   * visible fortress: the full bounds always, and every generated piece once
   * the zoom is high enough to make the piece outlines readable.
   */
  private drawStructureFrames(ctx: CanvasRenderingContext2D): void {
    const byId = new Map(this.features.map((feature) => [feature.id, feature]));
    for (const item of this.placed) {
      if (item.type === -2) continue;
      const feature = byId.get(item.type);
      if (!feature) continue;
      if (feature.key === 'monument') {
        const half = Math.floor(MONUMENT_SIZE / 2);
        this.drawWorldRect(ctx, item.x - half, item.z - half,
          item.x + MONUMENT_SIZE - half - 1, item.z + MONUMENT_SIZE - half - 1,
          '#4fd1c5');
      } else if (feature.key === 'fortress' && item.large) {
        this.drawWorldRect(ctx, item.large.minX, item.large.minZ, item.large.maxX, item.large.maxZ,
          '#e06a4a');
        const pieces = item.pieces ?? [];
        if (!pieces.length) continue;
        const frameTopLeft = this.worldToScreen(item.large.minX, item.large.minZ);
        const frameBottomRight = this.worldToScreen(item.large.maxX + 1, item.large.maxZ + 1);
        // At far zoom the individual pieces collapse into sub-pixel noise.
        if (frameBottomRight.x - frameTopLeft.x < 16 || frameBottomRight.y - frameTopLeft.y < 16) continue;
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffd166';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        for (const piece of pieces) {
          const topLeft = this.worldToScreen(piece.minX, piece.minZ);
          const bottomRight = this.worldToScreen(piece.maxX + 1, piece.maxZ + 1);
          const width = bottomRight.x - topLeft.x;
          const height = bottomRight.y - topLeft.y;
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
          if (topLeft.x > this.canvas.width || topLeft.y > this.canvas.height
            || topLeft.x + width < 0 || topLeft.y + height < 0) continue;
          ctx.rect(topLeft.x, topLeft.y, width, height);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  private drawWorldRect(ctx: CanvasRenderingContext2D, minX: number, minZ: number, maxX: number, maxZ: number,
                        color: string): void {
    // Cubiomes bb1 values are inclusive, so the drawn edge is one block past max.
    const topLeft = this.worldToScreen(minX, minZ);
    const bottomRight = this.worldToScreen(maxX + 1, maxZ + 1);
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

    const visible = topLeft.x < this.canvas.width && topLeft.y < this.canvas.height
      && topLeft.x + width > 0 && topLeft.y + height > 0;
    if (!visible) return;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.strokeRect(topLeft.x, topLeft.y, width, height);
    ctx.restore();
  }

  private drawPlaced(ctx: CanvasRenderingContext2D): void {
    const byId = new Map(this.features.map((feature) => [feature.id, feature]));
    for (const item of this.placed) {
      if (item.type === -2) continue;
      const feature = byId.get(item.type);
      if (feature?.key === 'geode' && this.pixelsPerBlock < GEODE_ICON_MIN_PPB) continue;
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
      this.biomeName = biome.name;
    } catch {
      this.biomeName = '';
    }
    this.syncReadout();
  }
}
