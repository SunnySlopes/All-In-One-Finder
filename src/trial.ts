import { ask, showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type TrialStatus } from './native';
import { escapeAttr, formatDuration, messageOf } from './panel-utils';
import type { ResultsColumn, TrialWindowView } from './results';

export type TrialVersionTier = 'legacy' | 'modern' | 'latest';

type SeedMode = 'single' | 'list';

const DEFAULT_SIDE = 131072;
const DEFAULT_MIN = -65536;
const DEFAULT_MAX = 65535;
const DEFAULT_CLUSTER_RADIUS = 160;
const DEFAULT_CLUSTER_LONG = 320;
const DEFAULT_CLUSTER_SHORT = 320;
const DEFAULT_SIMULATION_DISTANCE = 10;
const MIN_SIMULATION_DISTANCE = 8;
const MAX_SIMULATION_DISTANCE = 16;
const BLOCKS_PER_DISTANCE = 32;
const WINDOW_MARGIN = 16;
/** 统计窗口等效面积上限：512×512 格（262,144 格²）。 */
const MAX_WINDOW_AREA = 512 * 512;
const MAX_SIMULATION_WINDOW = 512;
const MIN_WINDOW_SIDE = 1;
const MAX_WINDOW_SIDE = 512;
const SEARCH_AREA_WARN = Math.PI * 1e6 * 1e6;
const WINDOW_AREA_WARN = Math.PI * 128 * 128;
const WARN_MIN_STRUCTURES = 3;
const WARN_MIN_SPAWNERS = 60;
const BORDER_MIN_STRUCTURES = 4;
const BORDER_MIN_SPAWNERS = 80;
const DEFAULT_MIN_STRUCTURES = 2;
const DEFAULT_MIN_SPAWNERS = 50;
const DEFAULT_LIMIT = 1000;
const DEFAULT_RATIO = 1 / 6;
const MAX_SIDE = 60000001;const MAX_THREADS = 32;
/** 圆形窗口半径上限 256 格（与“圆半径不得超过 256”一致）。 */
const MAX_CLUSTER_RADIUS = 256;
/** 严格模式内缩格数：结构起点需离窗口边界至少这么多格；默认关闭、默认 0。 */
const DEFAULT_STRICT_MARGIN = 0;
const MAX_STRICT_MARGIN = 256;
/** 联数上限：试炼笼结果最多 4 联（二联/三联/四联），超过的簇整组剔除。 */
const MAX_TRIAL_STRUCTURES = 4;
const WORLD_MIN = -30000000;
const WORLD_MAX = 30000000;

const VERSION_OPTIONS: { value: TrialVersionTier; label: string }[] = [
  { value: 'legacy', label: '1.21 ~ 1.21.1' },
  { value: 'modern', label: '1.21.2 ~ 26.2' },
  { value: 'latest', label: '26.3+' },
];

/** The trial engine only exposes generation 1/2/3; the app never sends a version string. */
export function trialGeneration(tier: TrialVersionTier): number {
  if (tier === 'legacy') return 1;
  if (tier === 'modern') return 2;
  return 3;
}

/** Map version used when jumping to a result (matches the engine's generation data). */
export function trialMapVersion(tier: TrialVersionTier): string {
  // The app's map version table has 1.21.1 but not bare 1.21; both belong to generation 1.
  if (tier === 'legacy') return '1.21.1';
  if (tier === 'modern') return '26.2';
  return '26.3';
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(1, Math.max(0, value));
}

interface TrialStartArgs {
  generation: number;
  threads: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  clusterCircle: boolean;
  clusterRadius: number;
  clusterLongSide: number;
  clusterShortSide: number;
  minStructures: number;
  minSpawners: number;
  /** 联数上限：结果最多 4 联；产品固定传 4。 */
  maxStructures: number;
  /** 严格模式：结构起点需离统计窗口边界至少 strictMargin 格。 */
  strictMode: boolean;
  strictMargin: number;
  limit: number;
  conversionRatio: number;
  seeds: string;
}

export class TrialPanel {
  readonly root: HTMLElement;
  private footer!: HTMLElement;
  private version!: HTMLSelectElement;
  private threads!: HTMLInputElement;
  private side!: HTMLInputElement;
  private square!: HTMLInputElement;
  private minXInput!: HTMLInputElement;
  private maxXInput!: HTMLInputElement;
  private minZInput!: HTMLInputElement;
  private maxZInput!: HTMLInputElement;
  private clusterShape!: HTMLSelectElement;
  private clusterRadius!: HTMLInputElement;
  private clusterLong!: HTMLInputElement;
  private clusterShort!: HTMLInputElement;
  private clusterSquare!: HTMLInputElement;
  private viewDistance!: HTMLInputElement;
  private strictMode!: HTMLInputElement;
  private strictMargin!: HTMLInputElement;
  private minStructures!: HTMLInputElement;
  private minSpawners!: HTMLInputElement;
  private ratio!: HTMLInputElement;
  private seedModeSelect!: HTMLSelectElement;
  private seedMode: SeedMode = 'single';
  private tier: TrialVersionTier = 'latest';
  private searchTier: TrialVersionTier = 'latest';
  private resultsWindow: TrialWindowView = {
    circle: false,
    radius: DEFAULT_CLUSTER_RADIUS,
    longSide: DEFAULT_CLUSTER_LONG,
    shortSide: DEFAULT_CLUSTER_SHORT,
  };
  private versions: McVersion[] = [];
  private results: ResultsColumn | null = null;
  private seed = '';
  private seedText = '';
  private running = false;
  private paused = false;
  private pausing = false;
  private pollTimer = 0;
  private searchStartedAt = 0;
  private shownError = '';
  private savedRequest: TrialStartArgs | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="t-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="t-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="t-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="t-version">
            ${VERSION_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')}
          </select>
          <label data-i18n="common.search.threads"></label>
          <input id="t-threads" type="number" min="1" max="${MAX_THREADS}" value="8" />
          <label data-i18n="common.search.minX"></label><input id="t-minx" type="number" value="${DEFAULT_MIN}" />
          <label data-i18n="common.search.maxX"></label><input id="t-maxx" type="number" value="${DEFAULT_MAX}" />
          <label data-i18n="common.search.minZ"></label><input id="t-minz" type="number" value="${DEFAULT_MIN}" />
          <label data-i18n="common.search.maxZ"></label><input id="t-maxz" type="number" value="${DEFAULT_MAX}" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="t-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="t-side" type="number" min="1" max="${MAX_SIDE}" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="t-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="t-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="grid">
          <label data-i18n="trial.clusterShape"></label>
          <select id="t-cluster-shape">
            <option value="rect" data-i18n="trial.clusterShapeRect"></option>
            <option value="circle" data-i18n="trial.clusterShapeCircle"></option>
          </select>
          <label data-i18n="trial.clusterRadius"></label>
          <input id="t-cluster-radius" type="number" min="1" max="${MAX_CLUSTER_RADIUS}" value="${DEFAULT_CLUSTER_RADIUS}" />
          <label data-i18n="trial.clusterLong"></label>
          <input id="t-cluster-long" type="number" min="${MIN_WINDOW_SIDE}" max="${MAX_WINDOW_SIDE}" value="${DEFAULT_CLUSTER_LONG}" />
          <label data-i18n="trial.clusterShort"></label>
          <input id="t-cluster-short" type="number" min="${MIN_WINDOW_SIDE}" max="${MAX_WINDOW_SIDE}" value="${DEFAULT_CLUSTER_SHORT}" />
          <div class="span-full row">
            <label class="feature"><input id="t-cluster-square" type="checkbox" checked /><span data-i18n="trial.clusterSquareWindow"></span></label>
          </div>
          <label data-i18n="trial.simulationDistance"></label>
          <input id="t-view-distance" type="number" min="${MIN_SIMULATION_DISTANCE}" max="${MAX_SIMULATION_DISTANCE}" value="${DEFAULT_SIMULATION_DISTANCE}" />
          <label data-i18n="trial.minStructures"></label>
          <input id="t-min-structures" type="number" min="1" max="${MAX_TRIAL_STRUCTURES}" value="${DEFAULT_MIN_STRUCTURES}" />
          <label data-i18n="trial.minSpawners"></label>
          <input id="t-min-spawners" type="number" min="0" value="${DEFAULT_MIN_SPAWNERS}" />
          <label data-i18n="trial.conversionRatio"></label>
          <input id="t-ratio" type="number" min="0" max="1" step="0.001" value="${DEFAULT_RATIO.toFixed(3)}" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="t-strict" type="checkbox" /><span data-i18n="trial.strictMode"></span></label>
          <input id="t-strict-margin" type="number" min="0" max="${MAX_STRICT_MARGIN}" value="${DEFAULT_STRICT_MARGIN}" />
        </div>
        <div class="hint" data-i18n="trial.help"></div>
      </div>
      <div class="search-panel-footer" id="t-footer"></div>
    `;
    this.footer = this.root.querySelector('#t-footer')!;
    this.version = this.root.querySelector('#t-version')!;
    this.threads = this.root.querySelector('#t-threads')!;
    this.side = this.root.querySelector('#t-side')!;
    this.square = this.root.querySelector('#t-square')!;
    this.minXInput = this.root.querySelector('#t-minx')!;
    this.maxXInput = this.root.querySelector('#t-maxx')!;
    this.minZInput = this.root.querySelector('#t-minz')!;
    this.maxZInput = this.root.querySelector('#t-maxz')!;
    this.clusterShape = this.root.querySelector('#t-cluster-shape')!;
    this.clusterRadius = this.root.querySelector('#t-cluster-radius')!;
    this.clusterLong = this.root.querySelector('#t-cluster-long')!;
    this.clusterShort = this.root.querySelector('#t-cluster-short')!;
    this.clusterSquare = this.root.querySelector('#t-cluster-square')!;
    this.viewDistance = this.root.querySelector('#t-view-distance')!;
    this.strictMode = this.root.querySelector('#t-strict')!;
    this.strictMargin = this.root.querySelector('#t-strict-margin')!;
    this.minStructures = this.root.querySelector('#t-min-structures')!;
    this.minSpawners = this.root.querySelector('#t-min-spawners')!;
    this.ratio = this.root.querySelector('#t-ratio')!;
    this.seedModeSelect = this.root.querySelector('#t-seed-mode')!;
    this.threads.value = String(Math.min(MAX_THREADS, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applyArea());
    this.side.addEventListener('input', () => this.applyArea());
    this.clusterShape.addEventListener('change', () => this.applyClusterWindow());
    this.clusterSquare.addEventListener('change', () => this.applyClusterWindow());
    this.clusterLong.addEventListener('input', () => {
      if (this.clusterSquare.checked) this.clusterShort.value = this.clusterLong.value;
    });
    this.viewDistance.addEventListener('change', () => this.applyViewDistance());
    this.strictMode.addEventListener('change', () => this.applyStrictMode());
    this.ratio.addEventListener('change', () => this.normalizeRatioInput());
    this.root.querySelector('#t-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#t-border')!.addEventListener('click', () => this.resetWorldBorder());
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.render();
    });
    this.version.addEventListener('change', () => {
      this.tier = this.version.value as TrialVersionTier;
      this.render();
    });
    this.applyArea();
    this.render();
  }

  bindResults(results: ResultsColumn): void {
    this.results = results;
  }

  setSeedFromMap(seed: string): void {
    // 只有“单种子”来源的 tab 才跟随地图/其他单种子页面的种子。
    if (this.seedMode !== 'single') return;
    if (!seed.trim()) return;
    this.seed = seed.trim();
    const input = this.root.querySelector<HTMLInputElement>('#t-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  /** 正方形边长只是四至的快捷填充；取消勾选后四个 min/max 才是输入源。 */
  private applyArea(): void {
    const square = this.square.checked;
    this.side.disabled = !square;
    for (const input of [this.minXInput, this.maxXInput, this.minZInput, this.maxZInput]) {
      input.disabled = square;
    }
    if (!square) return;
    const side = Math.max(1, Math.floor(Number(this.side.value) || 1));
    // 世界边界按钮使用 60000001；按闭区间裁到引擎的世界边界内。
    const min = Math.max(WORLD_MIN, -Math.floor(side / 2));
    const max = Math.min(WORLD_MAX, min + side - 1);
    this.minXInput.value = String(min);
    this.maxXInput.value = String(max);
    this.minZInput.value = String(min);
    this.maxZInput.value = String(max);
  }

  private resetDefaultArea(): void {
    this.square.checked = true;
    this.side.value = String(DEFAULT_SIDE);
    this.applyArea();
    this.render();
  }

  private resetWorldBorder(): void {
    this.square.checked = true;
    this.side.value = String(MAX_SIDE);
    this.applyArea();
    // 世界边界范围很大；统计窗口也不小时，提高最低阈值以避免极慢搜索。
    const circle = this.clusterShape.value === 'circle';
    const radius = Math.floor(Number(this.clusterRadius.value) || 0);
    const longSide = Math.floor(Number(this.clusterLong.value) || 0);
    const shortSide = this.clusterSquare.checked
      ? longSide
      : Math.floor(Number(this.clusterShort.value) || 0);
    const windowArea = circle ? Math.PI * radius * radius : longSide * shortSide;
    if (windowArea > WINDOW_AREA_WARN) {
      this.minStructures.value = String(BORDER_MIN_STRUCTURES);
      this.minSpawners.value = String(BORDER_MIN_SPAWNERS);
    }
    this.render();
  }

  /** 圆形窗口只使用窗口半径；方形/矩形窗口使用长边/短边和正方形窗口勾选。 */
  private applyClusterWindow(): void {
    const circle = this.clusterShape.value === 'circle';
    this.clusterRadius.disabled = !circle;
    this.clusterLong.disabled = circle;
    this.clusterShort.disabled = circle || this.clusterSquare.checked;
    this.clusterSquare.disabled = circle;
    this.viewDistance.disabled = circle;
    if (!circle && this.clusterSquare.checked) this.clusterShort.value = this.clusterLong.value;
  }

  /** 严格模式的内缩格数只在勾选时生效。 */
  private applyStrictMode(): void {
    this.strictMargin.disabled = !this.strictMode.checked;
  }

  /** 折算比例固定 0–1（含端点）；超出范围静默裁剪。 */
  private normalizeRatioInput(): void {
    const text = this.ratio.value.trim();
    const raw = Number(text);
    this.ratio.value = text === '' || !Number.isFinite(raw)
      ? DEFAULT_RATIO.toFixed(3)
      : String(clampRatio(raw));
  }

  /** 模距 8–16 → 长边 = 32×模距+16（封顶 512）。 */
  private applyViewDistance(): void {
    const view = Number(this.viewDistance.value);
    if (!Number.isInteger(view) || view < MIN_SIMULATION_DISTANCE || view > MAX_SIMULATION_DISTANCE) {
      this.viewDistance.value = String(DEFAULT_SIMULATION_DISTANCE);
      void showNotice(t('trial.badSimulationDistance'));
      return;
    }
    this.clusterLong.value = String(Math.min(MAX_SIMULATION_WINDOW, view * BLOCKS_PER_DISTANCE + WINDOW_MARGIN));
    this.clusterSquare.checked = true;
    this.applyClusterWindow();
  }

  private renderSeedBlock(): void {
    const host = this.root.querySelector('#t-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="t-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="t-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="t-file-name"></div>`;
      const fileName = host.querySelector('#t-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#t-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.version.value = this.tier;
    this.renderSeedBlock();
    this.applyArea();
    this.applyClusterWindow();
    this.applyStrictMode();
    this.viewDistance.title = t('trial.simulationDistanceHint');
    this.strictMargin.title = t('trial.strictMarginHint');
    this.minStructures.title = t('trial.structuresCapHint');
    this.ratio.title = t('trial.conversionRatioHint');

    const pauseLabel = this.pausing
      ? 'trial.pausingButton'
      : this.paused ? 'common.search.resume' : 'common.search.pause';
    const startDisabled = this.running || this.pausing;
    const pauseDisabled = this.pausing || (!this.running && !this.paused);
    const stopDisabled = !this.running && !this.paused;
    this.footer.innerHTML = `
      <div class="row">
        <button id="t-start" type="button" data-i18n="common.search.start" ${startDisabled ? 'disabled' : ''}></button>
        <button id="t-pause" type="button" data-i18n="${pauseLabel}" ${pauseDisabled ? 'disabled' : ''}></button>
        <button id="t-stop" type="button" data-i18n="common.search.stop" ${stopDisabled ? 'disabled' : ''}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="t-bar"></div></div>
      <div id="t-progress" class="hint"></div>
      <div id="t-counters" class="hint"></div>
      <div id="t-elapsed" class="hint"></div>
      <div id="t-eta" class="hint"></div>
      <div id="t-truncated" class="hint"></div>
    `;
    this.footer.querySelector('#t-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#t-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#t-stop')?.addEventListener('click', () => void this.stop());
    applyI18n(this.root);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#t-seed');
    if (seed) this.seed = seed.value.trim();
    this.tier = this.version.value as TrialVersionTier;
    this.normalizeRatioInput();
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#t-file-name');
    if (node) node.textContent = String(count);
  }

  /** Read the form without validation; used for both starting and resume-signature checks. */
  private collectRequest(): TrialStartArgs {
    const bounds = {
      minX: Math.floor(Number(this.minXInput.value) || 0),
      maxX: Math.floor(Number(this.maxXInput.value) || 0),
      minZ: Math.floor(Number(this.minZInput.value) || 0),
      maxZ: Math.floor(Number(this.maxZInput.value) || 0),
    };
    const clusterCircle = this.clusterShape.value === 'circle';
    const clusterLongSide = Math.floor(Number(this.clusterLong.value) || 0);
    const clusterShortSide = this.clusterSquare.checked
      ? clusterLongSide
      : Math.floor(Number(this.clusterShort.value) || 0);
    return {
      generation: trialGeneration(this.tier),
      threads: Math.max(1, Math.min(MAX_THREADS, Math.floor(Number(this.threads.value) || 1))),
      ...bounds,
      clusterCircle,
      clusterRadius: Math.floor(Number(this.clusterRadius.value) || 0),
      clusterLongSide,
      clusterShortSide,
      minStructures: Math.floor(Number(this.minStructures.value) || 0),
      minSpawners: Math.floor(Number(this.minSpawners.value) || 0),
      maxStructures: MAX_TRIAL_STRUCTURES,
      strictMode: this.strictMode.checked,
      strictMargin: Math.floor(Number(this.strictMargin.value) || 0),
      // 结果上限由产品固定为 1,000，不再暴露输入。
      limit: DEFAULT_LIMIT,
      conversionRatio: clampRatio(Number(this.ratio.value)),
      seeds: this.seedMode === 'list' ? this.seedText : this.seed,
    };
  }

  private async validatedRequest(): Promise<TrialStartArgs | null> {
    const request = this.collectRequest();
    if (!request.seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return null;
    }
    if (!this.square.checked
      && [this.minXInput, this.maxXInput, this.minZInput, this.maxZInput]
        .some((input) => input.value.trim() === '')) {
      await showNotice(t('common.error.bad-bounds'));
      return null;
    }
    if (![request.minX, request.maxX, request.minZ, request.maxZ].every(Number.isFinite)
      || request.minX > request.maxX || request.minZ > request.maxZ
      || request.minX < WORLD_MIN || request.maxX > WORLD_MAX
      || request.minZ < WORLD_MIN || request.maxZ > WORLD_MAX) {
      await showNotice(t('common.error.bad-bounds'));
      return null;
    }
    if (this.square.checked) {
      const side = Math.floor(Number(this.side.value) || 0);
      if (side < 1 || side > MAX_SIDE) {
        await showNotice(t('common.error.bad-bounds'));
        return null;
      }
    }
    if (request.clusterCircle) {
      if (request.clusterRadius < 1 || request.clusterRadius > MAX_CLUSTER_RADIUS) {
        await showNotice(t('common.error.bad-bounds'));
        return null;
      }
    } else if (request.clusterLongSide < MIN_WINDOW_SIDE || request.clusterLongSide > MAX_WINDOW_SIDE
      || request.clusterShortSide < MIN_WINDOW_SIDE || request.clusterShortSide > MAX_WINDOW_SIDE
      || request.clusterShortSide > request.clusterLongSide) {
      await showNotice(t('common.error.bad-bounds'));
      return null;
    }
    // 统计窗口面积上限 512×512：矩形=长×短，圆形=πr²。
    if (this.windowArea(request) > MAX_WINDOW_AREA + 1e-9) {
      await showNotice(t('trial.windowTooLarge', { area: MAX_WINDOW_AREA }));
      return null;
    }
    if (request.strictMode) {
      const halfX = request.clusterCircle ? request.clusterRadius : Math.floor(request.clusterLongSide / 2);
      const halfZ = request.clusterCircle ? request.clusterRadius : Math.floor(request.clusterShortSide / 2);
      if (request.strictMargin < 0 || request.strictMargin > MAX_STRICT_MARGIN
        || halfX <= request.strictMargin || halfZ <= request.strictMargin) {
        await showNotice(t('trial.badStrictMargin'));
        return null;
      }
    }
    if (request.minStructures < 1 || request.minStructures > MAX_TRIAL_STRUCTURES) {
      await showNotice(t('trial.badStructures'));
      return null;
    }
    if (request.minSpawners < 0) {
      await showNotice(t('common.error.bad-bounds'));
      return null;
    }
    return request;
  }

  private windowArea(request: TrialStartArgs): number {
    return request.clusterCircle
      ? Math.PI * request.clusterRadius * request.clusterRadius
      : request.clusterLongSide * request.clusterShortSide;
  }

  /**
   * Large search + large statistics window with low thresholds is extremely slow.
   * Returns the (possibly adjusted) request, or null when the user dismisses the dialog.
   */
  private async confirmSlowParams(request: TrialStartArgs): Promise<TrialStartArgs | null> {
    const searchArea = (request.maxX - request.minX + 1) * (request.maxZ - request.minZ + 1);
    const lowThresholds = request.minStructures <= WARN_MIN_STRUCTURES || request.minSpawners < WARN_MIN_SPAWNERS;
    if (!lowThresholds || searchArea <= SEARCH_AREA_WARN || this.windowArea(request) <= WINDOW_AREA_WARN) {
      return request;
    }
    const choice = await ask(t('trial.slowWarning'), [
      { id: 'adjust', key: 'trial.warnAdjust' },
      { id: 'keep', key: 'common.dialog.cancel' },
      { id: 'dismiss', key: 'common.dialog.close' },
    ]);
    if (choice === 'dismiss') return null;
    if (choice === 'adjust') {
      request.minStructures = Math.max(WARN_MIN_STRUCTURES, request.minStructures);
      request.minSpawners = Math.max(WARN_MIN_SPAWNERS, request.minSpawners);
      this.minStructures.value = String(request.minStructures);
      this.minSpawners.value = String(request.minSpawners);
    }
    return request;
  }

  private async start(): Promise<void> {
    this.readFields();
    let request = await this.validatedRequest();
    if (!request) return;
    request = await this.confirmSlowParams(request);
    if (!request) return;
    this.searchTier = this.tier;
    this.resultsWindow = {
      circle: request.clusterCircle,
      radius: request.clusterRadius,
      longSide: request.clusterLongSide,
      shortSide: request.clusterShortSide,
    };
    this.savedRequest = request;
    try {
      await call('trialStart', request);
      this.results?.clearTrial(
        this.searchTier,
        this.resultsWindow,
        request.conversionRatio,
        this.seedMode === 'list',
      );
      this.running = true;
      this.paused = false;
      this.pausing = false;
      this.shownError = '';
      this.searchStartedAt = Date.now();
      this.render();
      this.poll();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async togglePause(): Promise<void> {
    if (this.pausing) return;
    if (this.paused) {
      this.readFields();
      const next = this.collectRequest();
      if (!this.savedRequest || JSON.stringify(next) !== JSON.stringify(this.savedRequest)) {
        await showNotice(t('trial.restartNotice'));
        await this.start();
        return;
      }
      try {
        await call('trialResume');
        this.paused = false;
        this.pausing = false;
        this.running = true;
        this.render();
        this.poll();
      } catch (error) {
        await showNotice(messageOf(error));
      }
      return;
    }
    if (!this.running) return;
    try {
      await call('trialPause');
      this.pausing = true;
      this.render();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async stop(): Promise<void> {
    try {
      await call('trialStop');
    } catch {
      /* the host clears its state even if the thread is already gone */
    }
    this.running = false;
    this.paused = false;
    this.pausing = false;
    this.results?.clearTrial(
      this.searchTier,
      this.resultsWindow,
      this.savedRequest?.conversionRatio ?? 1 / 6,
      this.seedMode === 'list',
    );
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<TrialStatus>('trialPoll');
        const changed = status.running !== this.running
          || status.paused !== this.paused
          || status.pausing !== this.pausing;
        this.running = status.running;
        this.paused = status.paused;
        this.pausing = status.pausing;
        if (changed) this.render();
        this.updateProgress(status);
        if (status.done) {
          window.clearInterval(this.pollTimer);
          this.running = false;
          this.paused = false;
          this.pausing = false;
          if (status.error && status.error !== this.shownError) {
            this.shownError = status.error;
            await showNotice(messageOf(status.error));
          }
          this.results?.setTrialHits(
            status.hits,
            this.searchTier,
            this.resultsWindow,
            this.savedRequest?.conversionRatio ?? 1 / 6,
          );
          this.render();
          this.updateProgress(status);
        }
      } catch {
        window.clearInterval(this.pollTimer);
        this.running = false;
        this.pausing = false;
        this.render();
      }
    }, 100);
  }

  private updateProgress(status: TrialStatus): void {
    const progress = this.footer.querySelector('#t-progress');
    const counters = this.footer.querySelector('#t-counters');
    const elapsed = this.footer.querySelector('#t-elapsed');
    const eta = this.footer.querySelector('#t-eta');
    const truncated = this.footer.querySelector('#t-truncated');
    const bar = this.footer.querySelector<HTMLElement>('#t-bar');
    const pct = status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
    if (progress) progress.textContent = this.progressText(status);
    if (counters) {
      counters.textContent = t('trial.counters', {
        candidates: String(status.candidates),
        layouts: String(status.layouts),
      });
    }
    if (elapsed) {
      elapsed.textContent = t('common.searchExtra.elapsed', {
        time: formatDuration(status.elapsedMs > 0 ? status.elapsedMs : Date.now() - this.searchStartedAt),
      });
    }
    if (eta) eta.textContent = this.etaText(status);
    if (truncated) {
      truncated.textContent = status.truncated
        ? t('trial.truncated', { limit: this.savedRequest?.limit ?? DEFAULT_LIMIT })
        : '';
    }
    if (bar) bar.style.width = `${pct}%`;
  }

  private phaseLabel(phase: number): string {
    const key = `trial.phase.${phase}`;
    const text = t(key);
    return text === key ? String(phase) : text;
  }

  private progressText(status: TrialStatus): string {
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    const state = status.pausing
      ? `${t('trial.pausing')} `
      : status.paused ? `${t('trial.paused')} ` : '';
    const pct = status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : 0;
    const shards = status.total > 0 ? ` ${status.current}/${status.total} (${pct}%)` : '';
    return `${seeds}${state}${this.phaseLabel(status.phase)}${shards}`;
  }

  private etaText(status: TrialStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (status.pausing) return t('trial.pausingEta');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    if (!(status.elapsedMs > 0)) return t('common.search.eta.calculating');
    const remaining = status.elapsedMs * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
