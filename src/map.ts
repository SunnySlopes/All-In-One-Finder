import { escapeText, showNotice } from './dialog';
import { biomeLabel, onLocale, structureLabel, t } from './i18n';
import {
  call,
  type Bounds3,
  type FeatureInfo,
  type GeodeChunkInfo,
  type McVersion,
  type Placed,
  type StrongholdPortalInfo,
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
  /** 在刷怪环旁显示的标注（例如“半径 64”）。 */
  spawnLabel?: string;
  /** 多中心挂机圈（双假人）；优先于 spawnCircles。 */
  spawnCenters?: { x: number; z: number; radii?: number[] }[];
  /** 只点出前两个挂机圈的中心连线中点，不画连线。 */
  spawnMidpoint?: boolean;
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
/** Terrain tiles carry an extra cave canvas plus height/mask buffers; keep fewer of them. */
const MAX_TILE_CACHE_TERRAIN = 192;
/** Only 1:1 renders terrain; every coarser zoom level stays on the biome map. */
const TERRAIN_SCALE = 1;
/** One cave cell covers 4x4 blocks, so a 128 px tile holds 32x32 cells (1:1 only). */
const CAVE_CELL_SIZE = 4;
const CAVE_CELLS = TILE_CELLS / CAVE_CELL_SIZE;
/** Cave opening classes shared with the native mask byte. */
const CAVE_WATER = 2;
const CAVE_LAVA = 3;
// Class 0 (no opening), 1 (dry opening) and 2 (water-filled opening) are part
// of the wire format but are never painted: the light-blue water fill read as
// noise on the relief, so only lava openings keep a fill. Water still feeds the
// hover readout.
const CAVE_FILL_LAVA = 'rgba(255, 140, 40, 0.65)';
/** Vanilla floods everything below this level with lava; the map paints it flat. */
const LAVA_LEVEL = -54;
const LAVA_TOP_BLOCK = LAVA_LEVEL - 1;
/** Terrain batches request more tiles per round trip than biome batches. */
const TERRAIN_BATCH = 24;
const BIOME_BATCH = 8;
/** Drop pending jobs that fall outside the view expanded by this many tiles. */
const PENDING_MARGIN_TILES = 1;
const MAX_PENDING = 96;
const ICON_SIZE = 20;
/** Ocean monuments are 58x58 blocks and centered on the structure position. */
const MONUMENT_SIZE = 58;
/** Swamp huts use the same 7x9 / 9x7 footprint frame color for every visible hut. */
const SWAMP_HUT_FRAME_COLOR = '#9acd5a';
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
/**
 * Poll interval for the biome under the pointer. The coordinates and terrain Y
 * update synchronously on every pointer move; biomeAt is a native round trip,
 * so it is throttled (not debounced) to keep following a moving mouse.
 */
const BIOME_POLL_MS = 30;
const TRIAL_CAGE_EDGE = 'rgba(20, 20, 20, 0.8)';
/**
 * Stronghold End portals. The 3x3 end_portal area is always drawn (no zoom
 * threshold) so a portal is visible wherever its stronghold icon is; only the
 * leader line has a threshold, and that one is a pixel distance so it doubles
 * as the "portal overlaps the icon" test.
 */
const STRONGHOLD_PORTAL_MIN_PX = 3;
const STRONGHOLD_PORTAL_FILL = 'rgba(122, 229, 180, 0.55)';
/**
 * 缩放过小时 3×3 的绿框不到最小像素、无法辨认，改用这个图标代替，
 * 尺寸取要塞标记（ICON_SIZE）的一半。
 */
const END_PORTAL_ICON = 'end_portal_frame_top';
/**
 * Leader line is suppressed only when the portal genuinely sits on top of the
 * stronghold icon. That is a *world* distance test, not a pixel test: at 1:16 a
 * 55-block gap is only 3.4 px, and suppressing the line there would make zoom
 * silently change the meaning of the layer.
 */
const STRONGHOLD_LEADER_MIN_BLOCKS = 4;
const STRONGHOLD_LEADER_STROKE = 'rgba(122, 229, 180, 0.45)';
const STRONGHOLD_DETAIL_BATCH = 8;
const STRONGHOLD_DETAIL_MARGIN = 128;
const STRONGHOLD_DETAIL_DEBOUNCE = 150;
const STRONGHOLD_DETAIL_CACHE = 200;
const STRONGHOLD_PORTAL_HIT_PX = 7;
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
  return versions
    .filter((item) => {
      const match = /^(\d+)\.(\d+)/.exec(item.name);
      if (!match) return false;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      return major > 1 || (major === 1 && minor >= 18);
    })
    .reverse();
}

interface MapSession {
  seed: string;
  version: string;
  dim: number;
  y: number;
  /** 地图中心坐标；旧存档没有时回落到 0,0。 */
  x: number;
  z: number;
  largeBiomes: boolean;
  grid: boolean;
  terrain: boolean;
  features: string[];
  searchers?: Record<string, unknown>;
}

/** Effective native tile layer for a zoom level (see native/terrain_map.h). */
type MapLayer = 0 | 1 | 2;

/** A cached map tile: the biome/terrain bitmap plus its extra payloads. */
interface CachedTile {
  canvas: HTMLCanvasElement;
  /** Cave opening overlay canvas (layer 2, 1:1 only). */
  cave?: HTMLCanvasElement;
  /** Surface Y per pixel (layer > 0, 1:1 only). */
  height?: Int16Array;
  /** Cave opening class per 4x4 cell (layer 2, 1:1 only). */
  mask?: Uint8Array;
  /** Highest fluid surface per cell for openings (layer 2, 1:1 only). */
  floodY?: Int16Array;
}

interface TileJob {
  scale: number;
  x: number;
  z: number;
  layer: MapLayer;
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
  /** Geode icon: generate that chunk and show its budding-amethyst counts. */
  geode?: {
    state: 'pending' | 'ready' | 'failed';
    /** 最大母岩数（该晶洞的全部母岩）。 */
    budding?: number;
    /** 常见下限母岩数（同批加载下会落地的）。 */
    buddingRealistic?: number;
    /** 下限母岩数（任何加载顺序都必然落地的）。 */
    buddingLower?: number;
  };
}

/** Compact portal data kept in the map cache. Y is exact (see stronghold_detail.h). */
interface StrongholdPortalDetail {
  ok: boolean;
  truncated: boolean;
  portalX: number;
  portalZ: number;
  /** World Y of the 3x3 end portal frame; exact. */
  portalY: number;
  /** World Y bounds of the whole portal room; exact. */
  roomMinY: number;
  roomMaxY: number;
  /** null when the version has no eye data. */
  eyes: number | null;
  frame: { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  footprint: { minX: number; minZ: number; maxX: number; maxZ: number; area: number } | null;
}

/** All cages sharing one XZ column; drawn as a single point, listed Y by Y. */
interface TrialCageColumn {  x: number;
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

/** 地图页采样 Y 下拉预设（仅主世界）：常用地表与洞穴高度，输入框仍可手填任意值。 */
const Y_PRESETS = [256, 128, 64, 48, 32, 16, 0, -16, -32, -40, -48, -52, -56, -60, -64];

function parseSession(raw: string | null): MapSession | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<MapSession> & { mcVersion?: unknown };
    if (typeof data.seed !== 'string' || !data.seed.trim()) return null;
    // 自动保存文件使用 version（字符串），手动导出的 session 使用 mcVersion。
    const named =
      typeof data.version === 'string' ? data.version : typeof data.mcVersion === 'string' ? data.mcVersion : '';
    const x = Number(data.x);
    const z = Number(data.z);
    return {
      seed: data.seed.trim(),
      version: named,
      dim: Number.isFinite(Number(data.dim)) ? Number(data.dim) : 0,
      y: Number.isFinite(Number(data.y)) ? Number(data.y) : 256,
      // 旧存档没有中心坐标：缺省 0,0（与旧版本行为一致）。
      x: Number.isFinite(x) ? Math.round(x) : 0,
      z: Number.isFinite(z) ? Math.round(z) : 0,
      largeBiomes: !!data.largeBiomes,
      grid: data.grid !== false,
      // Older sessions have no state and must stay on the biome map; the
      // retired `caves` flag from 0.9.0 is simply ignored.
      terrain: data.terrain === true,
      features: Array.isArray(data.features)
        ? data.features.filter((item): item is string => typeof item === 'string')
        : [...DEFAULT_FEATURES],
      searchers: data.searchers && typeof data.searchers === 'object' ? data.searchers : undefined,
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
  /** 采样 Y 下拉的展开按钮与候选列表：主世界可用，其它维度隐藏。 */
  private yToggle: HTMLButtonElement;
  private yMenu: HTMLUListElement;
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
  /** setSeedDraft() 已把种子写入输入框但还没重绘；下次提交时必须强制换图。 */
  private draftDirty = false;
  private tiles = new Map<string, CachedTile>();
  private inflight = new Set<string>();
  private pending = new Map<string, TileJob>();
  private attempts = new Map<string, number>();
  private flushQueued = false;
  private flushRunning = false;
  private generation = 0;
  private placed: Placed[] = [];
  private featureTimer = 0;
  private featureGen = 0;
  private biomeTimer = 0;
  private biomePolledAt = 0;
  private biomeInFlight = false;
  private biomeQueued = false;
  private pointer = { x: 0, z: 0 };
  private selected: SelectedStructure | null = null;
  private selectGen = 0;
  private press: { x: number; y: number; moved: boolean } | null = null;
  private grid!: HTMLInputElement;
  private terrain!: HTMLInputElement;
  private terrainRow!: HTMLElement;
  private layerHint!: HTMLElement;
  private currentLayer: MapLayer = 0;
  private terrainFailed = false;
  private icons = new Map<string, HTMLImageElement>();
  private slimeCanvas: HTMLCanvasElement | null = null;
  private slimeSeed = '';
  private slimeOrigin = { cx: 0, cz: 0 };
  private slimeSpan = { w: 0, h: 0 };
  private slimeFlight = false;
  private spawnOverlays: { x: number; z: number; radii?: number[]; label?: string }[] = [];
  private spawnMidpoint = false;
  private areaOverlay: MapAreaOverlay | null = null;
  private trialTypeId = -1;
  private trialDetail = new Map<string, TrialChamberDetail>();
  private trialInflight = new Set<string>();
  private trialEpoch = 0;
  private trialView = 0;
  private trialTimer = 0;
  private trialFailed = false;
  private trialHover: TrialCageColumn | null = null;
  private strongholdTypeId = -1;
  private strongholdDetail = new Map<string, StrongholdPortalDetail>();
  private strongholdInflight = new Set<string>();
  private strongholdEpoch = 0;
  private strongholdView = 0;
  private strongholdTimer = 0;
  private strongholdFailed = false;
  private biomeName = '';
  private saveTimer = 0;
  private collectSearchers: (() => Record<string, unknown>) | null = null;
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
        <label data-i18n="common.map.y"></label>
        <div class="y-combo">
          <input id="map-y" type="number" value="256" />
          <button id="map-y-toggle" type="button" class="y-combo-toggle" aria-haspopup="listbox" aria-expanded="false" data-i18n-aria-label="common.map.y">▾</button>
          <ul id="map-y-menu" class="y-combo-menu" role="listbox" hidden></ul>
        </div>
        <label class="feature span-full"><input id="map-large" type="checkbox" /><span data-i18n="common.map.largeBiomes"></span></label>
      </div>
      <div class="row">
        <label class="check-row"><input id="map-grid" type="checkbox" checked /><span data-i18n="common.map.grid"></span></label>
      </div>
      <div class="row" id="map-terrain-row">
        <label class="check-row"><input id="map-terrain" type="checkbox" /><span data-i18n="common.map.terrain"></span></label>
      </div>
      <div id="map-layer-hint" class="hint" hidden></div>
      <div id="map-features" class="features"></div>
    `;
    this.version = this.root.querySelector('#map-version')!;
    this.seed = this.root.querySelector('#map-seed')!;
    this.dimension = this.root.querySelector('#map-dim')!;
    this.y = this.root.querySelector('#map-y')!;
    this.yToggle = this.root.querySelector('#map-y-toggle')!;
    this.yMenu = this.root.querySelector('#map-y-menu')!;
    this.large = this.root.querySelector('#map-large')!;
    this.featureBox = this.root.querySelector('#map-features')!;
    this.grid = this.root.querySelector('#map-grid')!;
    this.terrain = this.root.querySelector('#map-terrain')!;
    this.terrainRow = this.root.querySelector('#map-terrain-row')!;
    this.layerHint = this.root.querySelector('#map-layer-hint')!;
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
    tools.innerHTML = `<button type="button" class="btn ghost sm" id="zoom-in">+</button><button type="button" class="btn ghost sm" id="zoom-out">−</button>`;
    stage.append(tools);
    tools.querySelector('#zoom-in')!.addEventListener('click', () => this.zoom(1.25));
    tools.querySelector('#zoom-out')!.addEventListener('click', () => this.zoom(0.8));
    new ResizeObserver(() => this.queueDraw()).observe(this.canvas);
    this.resize();
  }

  async load(versions: McVersion[], features: FeatureInfo[]): Promise<MapSession | null> {
    this.versions = mapVersions(versions);
    this.features = features;
    this.trialTypeId = features.find((feature) => feature.key === 'trial_chambers')?.id ?? -1;
    this.strongholdTypeId = features.find((feature) => feature.key === 'stronghold')?.id ?? -1;
    this.version.innerHTML = this.versions.map((item) => `<option value="${item.id}">${item.name}</option>`).join('');
    const hadSession = !!window.aio?.hasSession;
    const session = await this.loadSession();
    const preferred =
      (session?.version && this.versions.find((item) => item.name === session.version)) ||
      this.versions.find((item) => item.name === '26.3') ||
      this.versions[0];
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
      this.terrain.checked = session.terrain;
      localStorage.setItem('aio.grid', session.grid ? '1' : '0');
      // 跨 session 打开：把地图中心恢复到上次的位置（旧存档缺省 0,0）。
      this.restoreCenter(session.x, session.z);
    }
    const enabledKeys = new Set(session?.features ?? DEFAULT_FEATURES);
    this.enabled.clear();
    for (const feature of features) {
      if (enabledKeys.has(feature.key)) this.enabled.add(feature.id);
    }
    this.renderFeatures();
    this.syncLayerControls();
    this.schedule(true);
    this.queueFeatures();
    this.loaded = true;
    // 没有旧 session 时立即生成一份；旧文件存在时等搜索器条件恢复后再写，避免
    // 用默认条件覆盖存档里的 searchers。
    if (!hadSession) this.persistSession();
    this.onSeedChange(this.getSeed());
    return session;
  }

  getSeed(): string {
    return this.seed.value.trim();
  }

  /** 版本/地物列表就绪后才允许自动保存，避免启动瞬间用默认值覆盖旧 session。 */
  hasLoaded(): boolean {
    return this.loaded;
  }

  /** 自动保存/导出 session 时附带各搜索器的条件。 */
  setSearcherStateProvider(provider: () => Record<string, unknown>): void {
    this.collectSearchers = provider;
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
    this.persistSession();
    this.schedule();
    this.queueFeatures();
  }

  setSeed(seed: string, announce = true): void {
    const value = seed.trim();
    if (!value) return;
    /* 搜索页输入时 setSeedDraft() 已经把输入框同步成新种子；此时即使值相同，
     * 也必须清空瓦片并重绘，否则地图仍停在上一个种子。 */
    if (this.seed.value.trim() === value && !this.draftDirty) {
      if (announce) this.onSeedChange(value);
      return;
    }
    this.draftDirty = false;
    this.seed.value = value;
    this.persistSession();
    this.clearSpawnCircles();
    this.clearAreaOverlay();
    this.schedule(true);
    this.queueFeatures();
    if (announce) this.onSeedChange(value);
  }

  /** 搜索页输入种子时先同步“待保存”的值，不触发地图重绘；失焦/回车仍走 setSeed。 */
  setSeedDraft(seed: string): void {
    const value = seed.trim();
    if (!value) return;
    this.draftDirty = true;
    this.seed.value = value;
    this.persistSession();
  }

  /** 切回地图页时，把搜索页留下但还没提交的草稿种子真正画出来。 */
  commitDraft(): void {
    if (this.draftDirty) this.setSeed(this.getSeed(), false);
  }

  setY(y: number): void {
    this.y.value = String(y);
    this.persistSession();
    this.schedule(true);
    this.queueFeatures();
  }

  clearSpawnCircles(): void {
    if (!this.spawnOverlays.length && !this.spawnMidpoint) return;
    this.spawnOverlays = [];
    this.spawnMidpoint = false;
    this.queueDraw();
  }

  jumpTo(options: JumpOptions): void {
    this.clearSelection();
    const previous = {
      seed: this.seed.value.trim(),
      version: this.version.value,
      dim: this.dimension.value,
      y: this.y.value,
      // `large` is a checkbox: read `.checked`, not `.value` (which is always "on").
      large: this.large.checked,
    };
    const nextSeed = options.seed != null ? options.seed.trim() : this.seed.value.trim();
    let nextY = options.y != null ? String(options.y) : this.y.value;
    if (options.seed != null && nextSeed) {
      this.seed.value = nextSeed;
      this.draftDirty = false;
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
    this.syncYPreset();
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
    const worldChanged =
      nextSeed !== previous.seed ||
      nextY !== previous.y ||
      this.version.value !== previous.version ||
      this.dimension.value !== previous.dim ||
      this.large.checked !== previous.large;
    this.cx = options.x;
    this.cz = options.z;
    this.persistSession();
    // Panning keeps the current tiles on screen. Only a seed/Y/version/dimension change drops the cache.
    this.schedule(worldChanged);
    this.spawnOverlays =
      options.spawnCenters ??
      (options.spawnCircles
        ? [{ x: options.x, z: options.z, radii: options.spawnRadii, label: options.spawnLabel }]
        : []);
    this.spawnMidpoint = !!options.spawnMidpoint && this.spawnOverlays.length >= 2;
    this.areaOverlay = options.areaOverlay ?? null;
    this.queueFeatures();
    requestAnimationFrame(() => {
      this.resize();
      this.queueDraw();
      this.queueFeatures();
    });
  }

  /**
   * 把地图中心恢复到存档里的坐标。
   * 旧存档没有坐标（undefined/NaN）时不动当前中心；越界值夹到世界边界内。
   */
  private restoreCenter(x?: number, z?: number): void {
    const limit = 30000000;
    if (Number.isFinite(x)) this.cx = Math.max(-limit, Math.min(limit, Math.round(Number(x))));
    if (Number.isFinite(z)) this.cz = Math.max(-limit, Math.min(limit, Math.round(Number(z))));
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
      // 同时记录地图中心，跨 session 打开时回到同一个位置。
      x: Math.round(this.cx),
      z: Math.round(this.cz),
      largeBiomes: this.large.checked,
      grid: this.grid.checked,
      terrain: this.terrain.checked,
      features: this.features.filter((feature) => this.enabled.has(feature.id)).map((feature) => feature.key),
      searchers: this.collectSearchers ? this.collectSearchers() : undefined,
    };
  }

  applySnapshot(data: MapSessionData): void {
    this.seed.value = data.seed;
    this.draftDirty = false;
    const match = this.versions.find((item) => item.name === data.mcVersion);
    if (match) this.version.value = String(match.id);
    this.dimension.value = String(data.dim);
    this.y.value = String(data.dim === 0 ? data.y : defaultYForDim(data.dim));
    // 恢复到存档里的地图中心（旧存档没有坐标时保持当前中心）。
    this.restoreCenter(data.x, data.z);
    this.large.checked = data.largeBiomes && data.dim === 0;
    this.grid.checked = data.grid;
    this.terrain.checked = data.terrain === true;
    localStorage.setItem('aio.grid', data.grid ? '1' : '0');
    if (data.features.length) {
      this.enabled.clear();
      for (const feature of this.features) {
        if (data.features.includes(feature.key)) this.enabled.add(feature.id);
      }
    }
    this.renderFeatures();
    this.persistSession();
    this.syncLayerControls();
    this.schedule(true);
    this.queueFeatures();
    this.onSeedChange(data.seed);
  }

  refreshText(): void {
    this.renderFeatures();
    this.dimension.querySelectorAll('option').forEach((option) => {
      option.textContent = t(`common.map.${option.dataset.key}`);
    });
    this.syncLayerControls();
    this.renderSelectedInfo();
  }

  /**
   * Native layer for a zoom level. The terrain toggle is a single feature:
   * relief plus the cheese cave openings and the lava sea. Only 1:1 renders
   * terrain; coarser levels silently fall back to the biome map while the
   * checkbox state is kept.
   */
  private terrainLayerFor(scale: number): MapLayer {
    if (!this.terrain.checked || this.terrainFailed) return 0;
    if (Number(this.dimension.value) !== 0) return 0;
    if (scale !== TERRAIN_SCALE) return 0;
    return 2;
  }

  /**
   * 采样 Y 组合框同步。
   *
   * 结构是"可编辑输入框 + 自定义下拉"，**不是**原生 datalist：
   *  - 输入框始终可手填任意整数（没有任何过滤/限制）；
   *  - 主世界才显示右侧下拉按钮，点开列出 Y_PRESETS 全部预设；
   *  - 下界/末地 Y 范围不同，隐藏按钮并关闭列表，只保留手填。
   *
   * 用自定义下拉而不是 `<input list>`：Chromium 的 datalist 会按输入框当前值
   * 做前缀过滤（值=256 时只列出 256），既看不到全部预设，也容易让人以为不可编辑。
   */
  private syncYPreset(): void {
    const overworld = Number(this.dimension.value) === 0;
    this.yToggle.hidden = !overworld;
    if (!overworld) {
      this.closeYMenu();
      return;
    }
    if (!this.yMenu.hidden) this.renderYMenu();
  }

  /** 重建下拉项；与当前值相同的一项高亮。 */
  private renderYMenu(): void {
    const current = Number(this.y.value);
    this.yMenu.innerHTML = Y_PRESETS.map(
      (value) => `<li role="option" data-y="${value}" class="${value === current ? 'is-active' : ''}">${value}</li>`,
    ).join('');
  }

  private toggleYMenu(open?: boolean): void {
    const next = open ?? this.yMenu.hidden;
    if (!next) {
      this.closeYMenu();
      return;
    }
    this.renderYMenu();
    this.yMenu.hidden = false;
    this.yToggle.setAttribute('aria-expanded', 'true');
  }

  private closeYMenu(): void {
    if (this.yMenu.hidden) return;
    this.yMenu.hidden = true;
    this.yToggle.setAttribute('aria-expanded', 'false');
  }

  /**
   * Keep the terrain toggle, its availability and the cache invalidation in
   * sync. Called from every place that can change the effective layer.
   */
  private syncLayerControls(): void {
    const overworld = Number(this.dimension.value) === 0;
    this.terrainRow.hidden = !overworld;
    this.syncYPreset();
    this.terrain.title = t('common.map.terrainHint');

    const scale = this.activeScale();
    const layer = this.terrainLayerFor(scale);
    const hint = layer > 0 ? t('common.map.terrainLegend') : '';
    this.layerHint.hidden = !hint;
    this.layerHint.textContent = hint;

    if (layer !== this.currentLayer) {
      this.currentLayer = layer;
      this.persistSession();
      // layer is part of the tile key, so the whole cache is stale now.
      this.schedule(true);
      this.queueFeatures();
    }
  }

  private bind(): void {
    this.dimension.innerHTML = ['overworld', 'nether', 'end']
      .map((key, index) => {
        const dim = index === 0 ? 0 : index === 1 ? -1 : 1;
        return `<option value="${dim}" data-key="${key}"></option>`;
      })
      .join('');
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
      this.syncLayerControls();
    });
    this.y.addEventListener('change', worldChanged);
    /* 采样 Y 组合框：输入框始终可手填；下拉按钮只在主世界显示。
     * 选中预设后写回输入框并派发 change，与手填走同一条刷新路径。 */
    this.yToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleYMenu();
    });
    this.yMenu.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-y]');
      if (!item) return;
      const value = Number(item.dataset.y);
      if (!Number.isFinite(value)) return;
      this.y.value = String(value);
      this.closeYMenu();
      this.y.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 点空白处 / 按 Esc 收起；菜单打开时随手填同步高亮。
    document.addEventListener('click', (event) => {
      if (this.yMenu.hidden) return;
      const target = event.target as Node;
      if (this.yMenu.contains(target) || this.yToggle.contains(target)) return;
      this.closeYMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeYMenu();
    });
    this.y.addEventListener('input', () => {
      if (!this.yMenu.hidden) this.renderYMenu();
    });
    this.syncYPreset();
    this.large.addEventListener('change', worldChanged);
    this.terrain.addEventListener('change', () => {
      // The layer is part of the tile key, so toggling drops the whole cache.
      this.persistSession();
      this.syncLayerControls();
      this.queueDraw();
    });
    this.seed.addEventListener('change', () => {
      this.draftDirty = false;
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
      if (press?.moved) this.persistSession(); // 拖动改了地图中心，落盘供下次打开恢复
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
      this.persistSession();
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
      // Coordinates and surface Y follow the pointer immediately; the biome
      // lookup is throttled so it keeps updating while the mouse is moving
      // instead of waiting for the pointer to stop.
      this.syncReadout();
      this.scheduleBiomePoll();
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const before = this.screenToWorld(event.offsetX, event.offsetY);
        this.pixelsPerBlock *= event.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.pixelsPerBlock = clampZoom(this.pixelsPerBlock);
        const after = this.screenToWorld(event.offsetX, event.offsetY);
        this.cx += before.x - after.x;
        this.cz += before.z - after.z;
        this.persistSession(); // 缩放也会平移中心，落盘供下次打开恢复
        this.onZoomChanged();
      },
      { passive: false },
    );
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
    this.syncLayerControls();
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
    this.featureBox.innerHTML = items
      .map((feature) => {
        const icon = ICONS[feature.key];
        const mark = icon
          ? `<img class="icon" src="/icons/${icon}.png" alt="" />`
          : `<span class="swatch" style="background:${COLORS[feature.key] || '#ddd'}"></span>`;
        return `
      <label class="check-row">
        <input type="checkbox" data-id="${feature.id}" ${this.enabled.has(feature.id) ? 'checked' : ''} />
        ${mark}
        <span>${structureLabel(feature.key)}</span>
      </label>`;
      })
      .join('');
    this.featureBox.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.id);
        if (input.checked) this.enabled.add(id);
        else {
          this.enabled.delete(id);
          this.placed = this.placed.filter((item) => item.type !== id);
          if (id === this.trialTypeId) this.clearTrialDetail();
          if (id === this.strongholdTypeId) this.clearStrongholdDetail();
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
        })
          .then((list) => {
            if (token !== this.selectGen || this.selected !== selected) return;
            for (const info of list) this.trialDetail.set(this.trialKey(info.x, info.z), this.compactTrial(info));
            selected.details = this.trialDetailAt(item.x, item.z) ? 'ready' : 'failed';
            this.renderSelectedInfo();
            this.queueDraw();
          })
          .catch(() => {
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
      })
        .then((info) => {
          if (token !== this.selectGen || this.selected !== selected) return;
          selected.geode = {
            state: 'ready',
            budding: info.budding,
            buddingRealistic: info.buddingRealistic,
            buddingLower: info.buddingLower,
          };
          selected.details = 'ready';
          this.renderSelectedInfo();
        })
        .catch(() => {
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
        })
          .then((bounds) => {
            if (token !== this.selectGen || this.selected !== selected) return;
            if (bounds) {
              selected.large = bounds.large;
              selected.details = 'ready';
            } else {
              selected.details = 'failed';
            }
            this.renderSelectedInfo();
            this.queueDraw();
          })
          .catch(() => {
            if (token !== this.selectGen || this.selected !== selected) return;
            selected.details = 'failed';
            this.renderSelectedInfo();
            this.queueDraw();
          });
      }
    } else if (feature.key === 'stronghold') {
      const cached = this.strongholdDetailAt(item.x, item.z);
      if (cached) {
        selected.details = 'ready';
      } else {
        selected.details = 'pending';
        void call<StrongholdPortalInfo[]>('strongholdPortals', {
          ...this.state(),
          portals: [{ x: item.x, z: item.z }],
        })
          .then((list) => {
            if (token !== this.selectGen || this.selected !== selected) return;
            for (const info of list) {
              this.strongholdDetail.set(this.trialKey(info.x, info.z), this.compactStronghold(info));
            }
            selected.details = this.strongholdDetailAt(item.x, item.z) ? 'ready' : 'failed';
            this.renderSelectedInfo();
            this.queueDraw();
          })
          .catch(() => {
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
    const name = structureLabel(selected.key);
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
      // 三个口径：最大（全部母岩）/ 常见下限（同批加载会落地的）/ 下限（必然落地的）。
      rows.push(
        `<div>${escapeText(
          t('common.map.geodeBuddingBounds', {
            max: selected.geode.budding ?? 0,
            realistic: selected.geode.buddingRealistic ?? 0,
            lower: selected.geode.buddingLower ?? 0,
          }),
        )}</div>`,
      );
    } else if (selected.key === 'stronghold') {
      // Y is exact: the backend reproduces vanilla's moveBelowSeaLevel, which
      // depends only on constant sea level / min Y plus the layout RNG state.
      const detail = this.strongholdDetailAt(selected.x, selected.z);
      if (detail?.ok) {
        rows.push(
          `<div>${escapeText(
            t('common.map.strongholdPortal', {
              x: detail.portalX,
              y: detail.portalY,
              z: detail.portalZ,
            }),
          )}</div>`,
        );
        if (detail.eyes !== null) {
          rows.push(`<div>${escapeText(t('common.map.strongholdEyes', { eyes: detail.eyes }))}</div>`);
        }
      } else if (detail?.truncated) {
        rows.push(`<div>${escapeText(t('common.map.strongholdPortalTruncated'))}</div>`);
      } else if (selected.details === 'pending') {
        rows.push(`<div>${escapeText(t('common.map.calculating'))}</div>`);
      } else if (selected.details === 'failed') {
        rows.push(`<div>${escapeText(t('common.map.boundsFailed'))}</div>`);
      }
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
    // A visible portal wins over the icon underneath it: it is drawn on top, so
    // the click should hit what the user actually sees.
    const portal = this.findStrongholdPortal(screenX, screenY);
    if (portal) {
      this.selectStructure(portal.item);
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
      this.clearStrongholdDetail();
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

  /** Same, for the stronghold portal layer. */
  private clearStrongholdDetail(): void {
    this.strongholdEpoch += 1;
    this.strongholdDetail.clear();
    this.strongholdInflight.clear();
    this.strongholdFailed = false;
    window.clearTimeout(this.strongholdTimer);
  }

  private queueDraw(): void {
    if (this.drawing) {
      this.drawQueued = true;
      return;
    }
    this.draw();
  }

  private queueFeatures(): void {
    window.clearTimeout(this.featureTimer);
    this.featureTimer = window.setTimeout(() => void this.loadFeatures(), 180);
    this.queueTrialDetails();
    this.queueStrongholdDetails();
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

  /* ---------------------------------------------------------------------- */
  /* Stronghold End portals                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Portal details are available for the overworld whenever the stronghold
   * layer is on. Unlike trial chambers, large biomes are fine: the stronghold
   * salt config does not depend on the biome.
   */
  private strongholdDetailAllowed(): boolean {
    if (Number(this.dimension.value) !== 0) return false;
    if (this.strongholdTypeId < 0 || !this.enabled.has(this.strongholdTypeId)) return false;
    return !this.strongholdFailed;
  }

  private queueStrongholdDetails(): void {
    window.clearTimeout(this.strongholdTimer);
    if (!this.strongholdDetailAllowed()) return;
    this.strongholdTimer = window.setTimeout(() => void this.loadStrongholdDetails(), STRONGHOLD_DETAIL_DEBOUNCE);
  }

  private strongholdViewport(): { x0: number; z0: number; x1: number; z1: number } {
    const view = this.viewBounds();
    const pad = STRONGHOLD_DETAIL_MARGIN;
    return { x0: view.x0 - pad, z0: view.z0 - pad, x1: view.x1 + pad, z1: view.z1 + pad };
  }

  /** Portal data already cached for one stronghold icon point. */
  private strongholdDetailAt(x: number, z: number): StrongholdPortalDetail | undefined {
    return this.strongholdDetail.get(this.trialKey(x, z));
  }

  private compactStronghold(info: StrongholdPortalInfo): StrongholdPortalDetail {
    return {
      ok: info.ok,
      truncated: info.truncated,
      portalX: info.portalX ?? 0,
      portalZ: info.portalZ ?? 0,
      portalY: info.portalY ?? 0,
      roomMinY: info.roomMinY ?? 0,
      roomMaxY: info.roomMaxY ?? 0,
      eyes: info.eyes === undefined ? null : info.eyes,
      frame: info.frame ?? null,
      footprint: info.footprint ?? null,
    };
  }

  private async loadStrongholdDetails(): Promise<void> {
    if (!this.strongholdDetailAllowed()) return;
    const view = this.strongholdViewport();
    const todo: Placed[] = [];
    for (const item of this.placed) {
      if (item.type !== this.strongholdTypeId) continue;
      if (item.x < view.x0 || item.x > view.x1 || item.z < view.z0 || item.z > view.z1) continue;
      const key = this.trialKey(item.x, item.z);
      if (this.strongholdDetail.has(key) || this.strongholdInflight.has(key)) continue;
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

    const batch = todo.slice(0, STRONGHOLD_DETAIL_BATCH);
    for (const item of batch) this.strongholdInflight.add(this.trialKey(item.x, item.z));
    const epoch = this.strongholdEpoch;
    const viewToken = ++this.strongholdView;
    try {
      const list = await call<StrongholdPortalInfo[]>('strongholdPortals', {
        ...this.state(),
        portals: batch.map((item) => ({ x: item.x, z: item.z })),
      });
      if (epoch !== this.strongholdEpoch) return;
      for (const info of list) {
        this.strongholdDetail.set(this.trialKey(info.x, info.z), this.compactStronghold(info));
      }
      this.trimStrongholdCache();
      this.queueDraw();
      if (list.length < batch.length) {
        // Engine rejected the version/batch; stop instead of retrying every pan.
        this.strongholdFailed = true;
        return;
      }
      if (viewToken === this.strongholdView && this.strongholdDetailAllowed()) {
        this.strongholdTimer = window.setTimeout(() => void this.loadStrongholdDetails(), 16);
      }
    } catch {
      if (epoch === this.strongholdEpoch) this.strongholdFailed = true;
    } finally {
      for (const item of batch) this.strongholdInflight.delete(this.trialKey(item.x, item.z));
    }
  }

  /** Drop off-screen portal details once the cache outgrows its budget. */
  private trimStrongholdCache(): void {
    if (this.strongholdDetail.size <= STRONGHOLD_DETAIL_CACHE) return;
    const view = this.strongholdViewport();
    const icons = new Map(this.placed.map((item) => [this.trialKey(item.x, item.z), item]));
    for (const key of [...this.strongholdDetail.keys()]) {
      if (this.strongholdInflight.has(key)) continue;
      const icon = icons.get(key);
      if (!icon) {
        this.strongholdDetail.delete(key);
        continue;
      }
      if (icon.x < view.x0 || icon.x > view.x1 || icon.z < view.z0 || icon.z > view.z1) {
        this.strongholdDetail.delete(key);
      }
    }
    if (this.strongholdDetail.size > STRONGHOLD_DETAIL_CACHE) this.strongholdDetail.clear();
  }

  /** Strongholds in view whose portal was successfully located. */
  private visibleStrongholdPortals(): Placed[] {
    if (!this.strongholdDetailAllowed()) return [];
    const view = this.viewBounds();
    const out: Placed[] = [];
    for (const item of this.placed) {
      if (item.type !== this.strongholdTypeId) continue;
      if (item.x < view.x0 || item.x > view.x1 || item.z < view.z0 || item.z > view.z1) continue;
      const detail = this.strongholdDetailAt(item.x, item.z);
      if (!detail || !detail.ok || !detail.frame) continue;
      out.push(item);
    }
    return out;
  }

  /** Nearest portal under the cursor/click; preferred over the icon hit test. */
  private findStrongholdPortal(screenX: number, screenY: number): { item: Placed; detail: StrongholdPortalDetail } | null {
    if (!this.strongholdDetailAllowed()) return null;
    let best: { item: Placed; detail: StrongholdPortalDetail } | null = null;
    let bestDistance = STRONGHOLD_PORTAL_HIT_PX * STRONGHOLD_PORTAL_HIT_PX;
    for (const item of this.visibleStrongholdPortals()) {
      const detail = this.strongholdDetailAt(item.x, item.z);
      if (!detail) continue;
      const point = this.worldToScreen(detail.portalX + 0.5, detail.portalZ + 0.5);
      const dx = point.x - screenX;
      const dy = point.y - screenY;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { item, detail };
      }
    }
    return best;
  }

  /** Loaded chambers whose whole-trial extent intersects the viewport. */
  private visibleTrialChambers(): Placed[] {    if (!this.trialDetailAllowed()) return [];
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
  private findTrialCage(
    screenX: number,
    screenY: number,
    radiusPx: number,
  ): { item: Placed; cage: TrialCageColumn } | null {
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
    const same =
      next === null
        ? this.trialHover === null
        : this.trialHover !== null &&
          this.trialHover.x === next.x &&
          this.trialHover.z === next.z &&
          this.trialHover.slow === next.slow &&
          this.trialHover.entries.length === next.entries.length;
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
      return column.entries.map((entry) =>
        t('common.map.trialCageAt', {
          kind: kindOf(entry.slow),
          x: entry.x,
          y: entry.y,
          z: entry.z,
        }),
      );
    }
    const kind = kindOf(column.slow);
    if (column.entries.length === 1) {
      const entry = column.entries[0];
      return [t('common.map.trialCageAt', { kind, x: entry.x, y: entry.y, z: entry.z })];
    }
    const ys = column.entries.map((entry) => entry.y).join('、');
    return [t('common.map.trialCageColumn', { kind, x: column.x, z: column.z, ys })];
  }

  private tileKey(state: ReturnType<MapView['state']>, layer: number, scale: number, x: number, z: number): string {
    // `layer` sits before `scale` so existing key parsers (which pop z/x/scale)
    // keep working unchanged.
    return `${state.mc}|${state.seed}|${state.dim}|${state.largeBiomes ? 1 : 0}|${state.y}|${layer}|${scale}|${x}|${z}`;
  }

  private draw(): void {
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
        const request =
          level === scale || (scale === 1 && level === 4 && underlayOk) || (scale > 1 && level === scale * 4);
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
      // Portals are drawn after the icons so a portal that overlaps its icon
      // is still visible (and clickable) — see the plan's hit-test priority.
      this.drawPlaced(ctx);
      this.drawStrongholdPortals(ctx);
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
    parts.push(...this.terrainReadout());
    if (this.trialHover) parts.push(...this.trialCageLines(this.trialHover));
    const text = parts.join('  ');
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }

  /**
   * Surface Y and cave-opening fluid level for the hovered 1:1 terrain tile.
   * Returns nothing when the pointer is over an unloaded tile or a zoom level
   * without the real terrain layer.
   */
  private terrainReadout(): string[] {
    if (this.activeScale() !== 1 || this.terrainFailed) return [];
    const layer = this.terrainLayerFor(1);
    if (layer === 0) return [];
    const tile = this.tiles.get(
      this.tileKey(
        this.state(),
        layer,
        1,
        Math.floor(this.pointer.x / TILE_CELLS) * TILE_CELLS,
        Math.floor(this.pointer.z / TILE_CELLS) * TILE_CELLS,
      ),
    );
    if (!tile) return [];
    const x0 = Math.floor(this.pointer.x / TILE_CELLS) * TILE_CELLS;
    const z0 = Math.floor(this.pointer.z / TILE_CELLS) * TILE_CELLS;
    const ix = Math.min(TILE_CELLS - 1, Math.max(0, Math.floor(this.pointer.x) - x0));
    const iz = Math.min(TILE_CELLS - 1, Math.max(0, Math.floor(this.pointer.z) - z0));
    const parts: string[] = [];
    const theoretical = t('common.map.theoreticalSuffix');
    if (tile.height) {
      const y = tile.height[iz * TILE_CELLS + ix];
      const text = t('common.map.heightY', { y });
      parts.push(y <= -64 ? `${text}${theoretical}` : text);
      // Vanilla floods everything under the lava level; the terrain layer
      // paints those columns flat lava, so name the level in the readout too.
      // With the sample-Y clamp active below the lava level every column is
      // synthetic, so the lava note would be wrong for all of them.
      const sampleY = Number(this.y.value);
      if (y <= LAVA_TOP_BLOCK && sampleY > LAVA_TOP_BLOCK) {
        parts.push(t('common.map.lavaY', { y: LAVA_LEVEL }));
      }
    }
    if (tile.mask && tile.floodY) {
      const cell = (iz >> 2) * CAVE_CELLS + (ix >> 2);
      const value = tile.mask[cell];
      if (value === CAVE_WATER || value === CAVE_LAVA) {
        const y = tile.floodY[cell];
        const text = t('common.map.floodY', { y });
        parts.push(y < -54 ? `${text}${theoretical}` : text);
      }
    }
    return parts;
  }

  /**
   * Draw the lava-filled cheese cave openings into a tile-sized canvas.
   * Water and dry openings are left alone: the old light-blue fill looked like
   * stray dots on the relief, so only lava keeps a marker.
   */
  private buildCaveCanvas(mask: Uint8Array): HTMLCanvasElement | undefined {
    const canvas = document.createElement('canvas');
    canvas.width = TILE_CELLS;
    canvas.height = TILE_CELLS;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    let painted = false;
    for (let cz = 0; cz < CAVE_CELLS; cz++) {
      for (let cx = 0; cx < CAVE_CELLS; cx++) {
        const value = mask[cz * CAVE_CELLS + cx];
        if (value !== CAVE_LAVA) continue;
        ctx.fillStyle = CAVE_FILL_LAVA;
        ctx.fillRect(cx * CAVE_CELL_SIZE, cz * CAVE_CELL_SIZE, CAVE_CELL_SIZE, CAVE_CELL_SIZE);
        painted = true;
      }
    }
    return painted ? canvas : undefined;
  }

  /** Give up on the terrain layer for this session and go back to biome tiles. */
  private failTerrain(): void {
    if (this.terrainFailed) return;
    this.terrainFailed = true;
    this.terrain.checked = false;
    showNotice(t('common.error.terrain-failed'));
    this.syncLayerControls();
    this.queueDraw();
  }

  private drawSpawnCircles(ctx: CanvasRenderingContext2D): void {
    if (!this.spawnOverlays.length) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(110, 220, 120, 0.95)';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(110, 220, 120, 0.85)';
    for (const overlay of this.spawnOverlays) {
      const center = this.worldToScreen(overlay.x, overlay.z);
      for (const radius of overlay.radii ?? [24, 128]) {
        const px = radius * this.pixelsPerBlock;
        ctx.beginPath();
        ctx.arc(center.x, center.y, px, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(center.x, center.y, 3, 0, Math.PI * 2);
      ctx.fill();
      if (overlay.label) {
        const radius = overlay.radii?.[0] ?? 128;
        const px = radius * this.pixelsPerBlock;
        ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
        const width = ctx.measureText(overlay.label).width;
        const fitsRight = center.x + px + 8 + width + 8 <= ctx.canvas.width;
        const x = fitsRight ? center.x + px + 8 : center.x - px - 8 - width - 8;
        const y = center.y - 8;
        ctx.fillStyle = 'rgba(10, 12, 16, 0.86)';
        ctx.fillRect(x - 4, y - 9, width + 8, 18);
        ctx.strokeStyle = 'rgba(110, 220, 120, 0.75)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 4, y - 9, width + 8, 18);
        ctx.fillStyle = '#d7f5dd';
        ctx.textBaseline = 'middle';
        ctx.fillText(overlay.label, x, y);
      }
    }
    if (this.spawnMidpoint && this.spawnOverlays.length >= 2) {
      const a = this.spawnOverlays[0];
      const b = this.spawnOverlays[1];
      const mid = this.worldToScreen(Math.trunc((a.x + b.x) / 2), Math.trunc((a.z + b.z) / 2));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.strokeStyle = 'rgba(20, 24, 30, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
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

  private paintLevel(
    ctx: CanvasRenderingContext2D,
    state: ReturnType<MapView['state']>,
    scale: number,
    request: boolean,
  ): void {
    const tileBlocks = TILE_CELLS * scale;
    const size = tileBlocks * this.pixelsPerBlock;
    // Skip levels that would stretch past the safe canvas destination size.
    if (size > MAX_TILE_DRAW_PX) return;
    const layer = this.terrainLayerFor(scale);
    const view = this.viewBounds();
    const x0 = Math.floor(view.x0 / tileBlocks) * tileBlocks;
    const z0 = Math.floor(view.z0 / tileBlocks) * tileBlocks;
    for (let z = z0; z < view.z1; z += tileBlocks) {
      for (let x = x0; x < view.x1; x += tileBlocks) {
        const key = this.tileKey(state, layer, scale, x, z);
        const tile = this.tiles.get(key);
        const origin = this.worldToScreen(x, z);
        if (tile) {
          try {
            ctx.drawImage(tile.canvas, origin.x, origin.y, size, size);
            // Cave openings sit above the relief but below the grid/structures.
            if (tile.cave) ctx.drawImage(tile.cave, origin.x, origin.y, size, size);
          } catch {
            /* oversized/invalid draw must not blank the whole frame */
          }
        } else if (request) {
          this.enqueueTile(key, layer, scale, x / scale, z / scale);
        }
      }
    }
  }

  private enqueueTile(key: string, layer: MapLayer, scale: number, x: number, z: number): void {
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
    this.pending.set(key, { layer, scale, x, z });
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
        // Prefer the active scale/layer, then tiles closest to the view center.
        const preferScale = this.activeScale();
        const preferLayer = this.terrainLayerFor(preferScale);
        const view = this.viewBounds();
        const midX = (view.x0 + view.x1) / 2;
        const midZ = (view.z0 + view.z1) / 2;
        const ranked = [...this.pending.entries()].map(([key, job]) => {
          const bx = job.x * job.scale + (TILE_CELLS * job.scale) / 2;
          const bz = job.z * job.scale + (TILE_CELLS * job.scale) / 2;
          const dist = Math.abs(bx - midX) + Math.abs(bz - midZ);
          const scaleRank = job.scale === preferScale ? 0 : job.scale < preferScale ? 1 : 2;
          const layerRank = job.layer === preferLayer ? 0 : 1;
          return { key, job, dist, scaleRank, layerRank };
        });
        ranked.sort((a, b) => a.scaleRank - b.scaleRank || a.layerRank - b.layerRank || a.dist - b.dist);
        const pickScale = ranked[0]?.job.scale;
        const pickLayer = ranked[0]?.job.layer;
        const batchLimit = pickLayer > 0 ? TERRAIN_BATCH : BIOME_BATCH;
        const batch: { key: string; scale: number; x: number; z: number; layer: MapLayer }[] = [];
        for (const item of ranked) {
          if (item.job.scale !== pickScale || item.job.layer !== pickLayer) continue;
          if (batch.length >= batchLimit) break;
          batch.push({ key: item.key, ...item.job });
          this.pending.delete(item.key);
          this.inflight.add(item.key);
        }
        if (!batch.length) break;
        const generation = this.generation;
        const state = this.state();
        // Native layout for this batch (mirrors addon.cpp).
        const layer = batch[0].layer;
        const scale = batch[0].scale;
        const rgbaStride = TILE_CELLS * TILE_CELLS * 4;
        const heightStride = layer > 0 && scale === 1 ? TILE_CELLS * TILE_CELLS * 2 : 0;
        const maskStride = layer === 2 && scale === 1 ? CAVE_CELLS * CAVE_CELLS : 0;
        const floodStride = maskStride ? CAVE_CELLS * CAVE_CELLS * 2 : 0;
        const perTile = rgbaStride + heightStride + maskStride + floodStride;
        try {
          const buffer = await call<ArrayBuffer | Uint8Array>('renderTiles', {
            ...state,
            layer,
            sx: TILE_CELLS,
            sz: TILE_CELLS,
            tiles: batch.map((job) => ({ scale: job.scale, x: job.x, z: job.z })),
          });
          if (generation !== this.generation) {
            for (const job of batch) this.inflight.delete(job.key);
            break;
          }
          const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
          if (bytes.byteLength < batch.length * perTile) {
            throw new Error('terrain-buffer-short');
          }
          batch.forEach((job, index) => {
            const start = index * perTile;
            // A fully transparent first pixel means the native side could not
            // build this tile; keep it out of the cache so it is retried later.
            if (bytes.length < start + rgbaStride || bytes[start + 3] === 0) return;
            const copy = new Uint8ClampedArray(rgbaStride);
            copy.set(bytes.subarray(start, start + rgbaStride));
            const image = new ImageData(copy, TILE_CELLS, TILE_CELLS);
            const canvas = document.createElement('canvas');
            canvas.width = TILE_CELLS;
            canvas.height = TILE_CELLS;
            canvas.getContext('2d')!.putImageData(image, 0, 0);
            const tile: CachedTile = { canvas };
            // Copy the payloads out of the batch buffer so caching a tile does
            // not retain the whole multi-tile response.
            if (heightStride) {
              tile.height = new Int16Array(TILE_CELLS * TILE_CELLS);
              new Uint8Array(tile.height.buffer).set(
                bytes.subarray(start + rgbaStride, start + rgbaStride + heightStride),
              );
            }
            if (maskStride) {
              const maskStart = start + rgbaStride + heightStride;
              tile.mask = new Uint8Array(maskStride);
              tile.mask.set(bytes.subarray(maskStart, maskStart + maskStride));
              tile.floodY = new Int16Array(CAVE_CELLS * CAVE_CELLS);
              new Uint8Array(tile.floodY.buffer).set(
                bytes.subarray(maskStart + maskStride, maskStart + maskStride + floodStride),
              );
              tile.cave = this.buildCaveCanvas(tile.mask);
            }
            this.tiles.set(job.key, tile);
            this.evictTiles(job.key);
            this.attempts.delete(job.key);
          });
          this.queueDraw();
        } catch (error) {
          this.readout.textContent = error instanceof Error ? error.message : String(error);
          if (generation === this.generation) {
            if (batch.some((job) => job.layer > 0)) {
              // Terrain/layer requests failed: fall back to the biome map once,
              // tell the user, and never retry the expensive path this session.
              this.failTerrain();
              break;
            }
            for (const job of batch) {
              const tries = (this.attempts.get(job.key) ?? 0) + 1;
              this.attempts.set(job.key, tries);
              if (tries < 3) this.pending.set(job.key, { scale: job.scale, x: job.x, z: job.z, layer: job.layer });
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
    const limit = this.terrain.checked ? MAX_TILE_CACHE_TERRAIN : MAX_TILE_CACHE;
    const keepView = this.expandedViewBounds(PENDING_MARGIN_TILES);
    // Always drop canvases that are no longer near the viewport.
    for (const cached of [...this.tiles.keys()]) {
      if (cached === keep) continue;
      if (this.tileVisible(cached, keepView)) continue;
      this.tiles.delete(cached);
    }
    if (this.tiles.size <= limit) return;
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
      if (this.tiles.size <= limit) break;
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
      this.queueStrongholdDetails();
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
    return (
      Number(this.dimension.value) === 0 &&
      this.features.some((feature) => feature.id === -2 && this.enabled.has(feature.id))
    );
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

  private ensureSlime(
    state: ReturnType<MapView['state']>,
    view: { x0: number; z0: number; x1: number; z1: number },
  ): void {
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
    void call<ArrayBuffer | Uint8Array>('slimeMask', { seed: state.seed, cx, cz, w, h })
      .then((buffer) => {
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
      })
      .catch((error) => {
        this.readout.textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
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
    // A stronghold with a located portal selects the portal, not the icon.
    const portal =
      selected.key === 'stronghold' && this.strongholdDetailAllowed()
        ? this.strongholdDetailAt(selected.x, selected.z)
        : undefined;
    let point: { x: number; y: number };
    if (cage) point = this.worldToScreen(cage.x + 0.5, cage.z + 0.5);
    else if (portal?.ok) point = this.worldToScreen(portal.portalX + 0.5, portal.portalZ + 0.5);
    else point = this.worldToScreen(selected.x, selected.z);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const radius = cage ? 5 : portal?.ok ? 6 : ICON_SIZE / 2 + 5;
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
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
      if (
        topLeft.x > this.canvas.width ||
        topLeft.y > this.canvas.height ||
        topLeft.x + width < 0 ||
        topLeft.y + height < 0
      )
        continue;
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
    return point.x >= -12 && point.y >= -12 && point.x <= this.canvas.width + 12 && point.y <= this.canvas.height + 12;
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
        this.drawWorldRect(
          ctx,
          item.x - half,
          item.z - half,
          item.x + MONUMENT_SIZE - half - 1,
          item.z + MONUMENT_SIZE - half - 1,
          '#4fd1c5',
        );
      } else if (feature.key === 'swamp_hut' && item.large) {
        // Native supplies the orientation-dependent 7x9 / 9x7 footprint.
        this.drawWorldRect(
          ctx,
          item.large.minX,
          item.large.minZ,
          item.large.maxX,
          item.large.maxZ,
          SWAMP_HUT_FRAME_COLOR,
        );
      } else if (feature.key === 'fortress' && item.large) {
        this.drawWorldRect(ctx, item.large.minX, item.large.minZ, item.large.maxX, item.large.maxZ, '#e06a4a');
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
          if (
            topLeft.x > this.canvas.width ||
            topLeft.y > this.canvas.height ||
            topLeft.x + width < 0 ||
            topLeft.y + height < 0
          )
            continue;
          ctx.rect(topLeft.x, topLeft.y, width, height);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  private drawWorldRect(
    ctx: CanvasRenderingContext2D,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    color: string,
  ): void {
    // Cubiomes bb1 values are inclusive, so the drawn edge is one block past max.
    const topLeft = this.worldToScreen(minX, minZ);
    const bottomRight = this.worldToScreen(maxX + 1, maxZ + 1);
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

    const visible =
      topLeft.x < this.canvas.width &&
      topLeft.y < this.canvas.height &&
      topLeft.x + width > 0 &&
      topLeft.y + height > 0;
    if (!visible) return;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.strokeRect(topLeft.x, topLeft.y, width, height);
    ctx.restore();
  }

  /**
   * Stronghold End portals: the 3x3 end_portal area plus a leader line back to
   * the stronghold start icon.
   *
   * Always drawn, at every zoom level, so a portal is visible wherever its
   * stronghold is. The only threshold is the leader line, and it is a pixel
   * distance rather than a zoom level: when the portal sits on top of the icon
   * the line is skipped, which is exactly the "overlapping" case.
   */
  private drawStrongholdPortals(ctx: CanvasRenderingContext2D): void {
    if (!this.strongholdDetailAllowed()) return;
    const portals = this.visibleStrongholdPortals();
    if (!portals.length) return;
    ctx.save();

    // (1) Leader line: stronghold start icon -> portal centre.
    ctx.strokeStyle = STRONGHOLD_LEADER_STROKE;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (const item of portals) {
      const detail = this.strongholdDetailAt(item.x, item.z);
      if (!detail?.frame) continue;
      // Overlapping / too close in *world* space: no line. A pixel test here
      // would make deeply zoomed-out views lose their lines.
      const bx = detail.portalX - item.x;
      const bz = detail.portalZ - item.z;
      if (bx * bx + bz * bz < STRONGHOLD_LEADER_MIN_BLOCKS * STRONGHOLD_LEADER_MIN_BLOCKS) continue;
      const from = this.worldToScreen(item.x + 0.5, item.z + 0.5);
      const to = this.worldToScreen(detail.portalX + 0.5, detail.portalZ + 0.5);
      // Both endpoints off the same screen edge: skip.
      if (
        (from.x < 0 && to.x < 0) || (from.x > this.canvas.width && to.x > this.canvas.width) ||
        (from.y < 0 && to.y < 0) || (from.y > this.canvas.height && to.y > this.canvas.height)
      ) continue;
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // (2) The 3x3 portal blocks, on top of the icons.
    ctx.fillStyle = STRONGHOLD_PORTAL_FILL;
    for (const item of portals) {
      const detail = this.strongholdDetailAt(item.x, item.z);
      const frame = detail?.frame;
      if (!detail || !frame) continue;
      const topLeft = this.worldToScreen(frame.minX, frame.minZ);
      const bottomRight = this.worldToScreen(frame.maxX + 1, frame.maxZ + 1);
      let width = bottomRight.x - topLeft.x;
      let height = bottomRight.y - topLeft.y;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
      let x = topLeft.x;
      let y = topLeft.y;
      // 缩小到 3×3 不足最小像素时绿框无法辨认，改画末地传送门图标，
      // 尺寸为要塞标记（ICON_SIZE）的一半，保证任何缩放级别都能看到。
      if (width < STRONGHOLD_PORTAL_MIN_PX || height < STRONGHOLD_PORTAL_MIN_PX) {
        const center = this.worldToScreen(detail.portalX + 0.5, detail.portalZ + 0.5);
        const size = ICON_SIZE / 2;
        if (
          center.x + size < 0 || center.y + size < 0 ||
          center.x - size > this.canvas.width || center.y - size > this.canvas.height
        ) continue;
        const icon = this.loadIcon(END_PORTAL_ICON);
        if (icon.complete && icon.naturalWidth > 0) {
          ctx.drawImage(icon, center.x - size / 2, center.y - size / 2, size, size);
        } else {
          // 图标尚未加载完成：退回原来的小方块，避免出现空档。
          ctx.fillRect(center.x - size / 2, center.y - size / 2, size, size);
        }
        continue;
      }
      if (x > this.canvas.width || y > this.canvas.height || x + width < 0 || y + height < 0) continue;
      ctx.fillRect(x, y, width, height);
    }
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

  /** Throttle the biome lookup: at most one request per BIOME_POLL_MS. */
  private scheduleBiomePoll(): void {
    if (this.biomeTimer) return;
    const wait = Math.max(0, BIOME_POLL_MS - (performance.now() - this.biomePolledAt));
    this.biomeTimer = window.setTimeout(() => {
      this.biomeTimer = 0;
      void this.updateBiome();
    }, wait);
  }

  private async updateBiome(): Promise<void> {
    if (this.biomeInFlight) {
      // The pointer moved again while a lookup was pending: run once more after it.
      this.biomeQueued = true;
      return;
    }
    if (!this.version.value) return;
    this.biomeInFlight = true;
    this.biomePolledAt = performance.now();
    let name = '';
    try {
      const biome = await call<{ name: string }>('biomeAt', {
        ...this.state(),
        x: Math.round(this.pointer.x),
        z: Math.round(this.pointer.z),
      });
      name = biome.name;
    } catch {
      name = '';
    }
    this.biomeName = name;
    this.biomeInFlight = false;
    this.syncReadout();
    if (this.biomeQueued) {
      this.biomeQueued = false;
      this.scheduleBiomePoll();
    }
  }
}
