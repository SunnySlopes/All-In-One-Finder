import { showNotice } from './dialog';
import { gpuRendererName } from './gpu';
import { applyI18n, t } from './i18n';
import { call, type GeodeStatus, type McVersion } from './native';
import { escapeAttr, formatDuration, messageOf } from './panel-utils';
import type { ResultsColumn } from './results';

type SeedMode = 'single' | 'list';

/** Snapshot of the parameters a finished/cleared result set was produced with. */
export interface GeodeView {
  version: string;
  /** 该引擎档位跳图时使用的地图版本（可能是 1.19 这类基版本）。 */
  mapVersion: string;
  listMode: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  prefilter: number;
  verifyTop: number;
  /** 开始搜索时的模距，用于跳图活动范围框选。 */
  simulationDistance: number;
  /** 1.21.5+ 使用模拟距离方形；更早版本使用 tick 半径圆形。 */
  modernActivity: boolean;
}

const DEFAULT_SIDE = 32768;
const DEFAULT_MIN = -16384;
const DEFAULT_MAX = 16383;
const DEFAULT_TICK_RADIUS = 128;
const DEFAULT_SIMULATION_DISTANCE = 10;
const MAX_THREADS = 64;
const MAX_SIDE = 60000001;
const WORLD_MIN = -30000000;
const WORLD_MAX = 30000000;
const MIN_GEODES = 1;
const MAX_TICK_RADIUS = 256;
const MIN_SIMULATION_DISTANCE = 2;
const MAX_SIMULATION_DISTANCE = 16;
const LARGE_RANGE_HALF = 32768;

/** 每个引擎档位只显示一行；标签里的地图版本用于结果跳图。 */
const VERSION_GROUPS = [
  { engine: '26.3', map: '26.3', label: '26.3+' },
  { engine: '26.2', map: '26.2', label: '1.21.9~26.2' },
  { engine: '1.21.6', map: '1.21.6', label: '1.21.5~1.21.8' },
  { engine: '1.21.4', map: '1.21.4', label: '1.21.2~1.21.4' },
  { engine: '1.21.1', map: '1.21.1', label: '1.21~1.21.1' },
  { engine: '1.20.6', map: '1.20', label: '1.19.4~1.20.6' },
  { engine: '1.19.2', map: '1.19.2', label: '1.19~1.19.3' },
  { engine: '1.18.2', map: '1.18', label: '1.18.2' },
  { engine: '1.18.1', map: '1.18', label: '1.18~1.18.1' },
] as const;

function numericVersion(name: string): [number, number, number] {
  const parts = name.split('.').map((part) => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function versionGroup(engine: string): (typeof VERSION_GROUPS)[number] | undefined {
  return VERSION_GROUPS.find((group) => group.engine === engine);
}

/** 1.21.5 起活动规则改为“玩家区块 + 模拟距离方形”。 */
function isModernVersion(name: string): boolean {
  const [major, minor, patch] = numericVersion(name);
  if (major >= 26) return true;
  return major === 1 && (minor > 21 || (minor === 21 && patch >= 5));
}

function autoBudgetFor(width: number, height: number): number {
  // 按圆直径 / 正方形等效区域边长分档；矩形取 sqrt(width*height)。
  const side = Math.sqrt(Math.max(1, width) * Math.max(1, height));
  if (side <= 32768) return 0;
  if (side <= 131072) return 20000;
  if (side <= 1000001) return 100000;
  if (side <= 2000001) return 200000;
  if (side <= 10000001) return 500000;
  if (side <= 20000001) return 750000;
  return 1000000;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isWorldBounds(minX: number, maxX: number, minZ: number, maxZ: number): boolean {
  return minX <= WORLD_MIN && maxX >= WORLD_MAX && minZ <= WORLD_MIN && maxZ >= WORLD_MAX;
}

export class GeodePanel {
  readonly root: HTMLElement;
  private footer!: HTMLElement;
  private seedModeSelect!: HTMLSelectElement;
  private version!: HTMLSelectElement;
  private threads!: HTMLInputElement;
  private activity!: HTMLElement;
  private tickRadius!: HTMLInputElement;
  private simulationDistance!: HTMLInputElement;
  private minXInput!: HTMLInputElement;
  private maxXInput!: HTMLInputElement;
  private minZInput!: HTMLInputElement;
  private maxZInput!: HTMLInputElement;
  private square!: HTMLInputElement;
  private side!: HTMLInputElement;
  private minGeodes!: HTMLInputElement;
  private minBudding!: HTMLInputElement;
  /** Opt-in GPU coarse scan; unchecked by default, so the engine stays on CPU. */
  private allowGpu!: HTMLInputElement;
  /** Whether the current range is the whole world (drives the 40/1600 defaults). */
  private fullMapMode = false;
  private rangeHint!: HTMLElement;
  private seedMode: SeedMode = 'single';
  private versions: McVersion[] = [];
  private results: ResultsColumn | null = null;
  private seed = '';
  private seedText = '';
  private running = false;
  private paused = false;
  private pausing = false;
  private stopping = false;
  private pollTimer = 0;
  private searchStartedAt = 0;
  private shownError = '';
  private searchView: GeodeView = {
    version: '26.3',
    mapVersion: '26.3',
    listMode: false,
    minX: DEFAULT_MIN,
    maxX: DEFAULT_MAX,
    minZ: DEFAULT_MIN,
    maxZ: DEFAULT_MAX,
    prefilter: 0,
    verifyTop: 0,
    simulationDistance: DEFAULT_SIMULATION_DISTANCE,
    modernActivity: true,
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="g-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="g-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="g-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="g-version"></select>
          <label data-i18n="common.search.threads"></label>
          <input id="g-threads" type="number" min="1" max="${MAX_THREADS}" value="8" />
          <label data-i18n="common.search.minX"></label><input id="g-min-x" type="number" value="${DEFAULT_MIN}" />
          <label data-i18n="common.search.maxX"></label><input id="g-max-x" type="number" value="${DEFAULT_MAX}" />
          <label data-i18n="common.search.minZ"></label><input id="g-min-z" type="number" value="${DEFAULT_MIN}" />
          <label data-i18n="common.search.maxZ"></label><input id="g-max-z" type="number" value="${DEFAULT_MAX}" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="g-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="g-side" type="number" min="1" max="${MAX_SIDE}" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="g-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="g-full" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="hint" id="g-range-hint"></div>
        <div class="grid">
          <div class="span-full hint" id="g-activity"></div>
          <label data-i18n="geode.tickRadius"></label>
          <input id="g-tick" type="number" min="1" max="${MAX_TICK_RADIUS}" value="${DEFAULT_TICK_RADIUS}" />
          <label data-i18n="geode.simulationDistance"></label>
          <input id="g-sim" type="number" min="${MIN_SIMULATION_DISTANCE}" max="${MAX_SIMULATION_DISTANCE}" value="${DEFAULT_SIMULATION_DISTANCE}" />
        </div>
        <div class="grid">
          <label data-i18n="geode.minGeodes"></label>
          <input id="g-min-geodes" type="number" min="${MIN_GEODES}" value="20" />
          <label data-i18n="geode.minBudding"></label>
          <input id="g-min-budding" type="number" min="0" value="800" />
          <div class="span-full">
            <label class="feature"><input id="g-allow-gpu" type="checkbox" /><span data-i18n="geode.allowGpu"></span></label>
          </div>
          <div class="span-full hint" data-i18n="geode.help"></div>
        </div>
      </div>
      <div class="search-panel-footer" id="g-footer"></div>
    `;
    this.footer = this.root.querySelector('#g-footer')!;
    this.seedModeSelect = this.root.querySelector('#g-seed-mode')!;
    this.version = this.root.querySelector('#g-version')!;
    this.threads = this.root.querySelector('#g-threads')!;
    this.activity = this.root.querySelector('#g-activity')!;
    this.tickRadius = this.root.querySelector('#g-tick')!;
    this.simulationDistance = this.root.querySelector('#g-sim')!;
    this.minXInput = this.root.querySelector('#g-min-x')!;
    this.maxXInput = this.root.querySelector('#g-max-x')!;
    this.minZInput = this.root.querySelector('#g-min-z')!;
    this.maxZInput = this.root.querySelector('#g-max-z')!;
    this.square = this.root.querySelector('#g-square')!;
    this.side = this.root.querySelector('#g-side')!;
    this.minGeodes = this.root.querySelector('#g-min-geodes')!;
    this.minBudding = this.root.querySelector('#g-min-budding')!;
    this.allowGpu = this.root.querySelector('#g-allow-gpu')!;
    this.rangeHint = this.root.querySelector('#g-range-hint')!;
    this.threads.value = String(Math.min(MAX_THREADS, navigator.hardwareConcurrency || 8));
    this.populateVersions();

    this.square.addEventListener('change', () => this.applyRange());
    this.side.addEventListener('input', () => this.applyRange());
    this.version.addEventListener('change', () => this.applyActivity());
    for (const input of [this.minXInput, this.maxXInput, this.minZInput, this.maxZInput]) {
      input.addEventListener('input', () => this.updateDerived());
    }
    this.root.querySelector('#g-reset')!.addEventListener('click', () => this.resetRange());
    this.root.querySelector('#g-full')!.addEventListener('click', () => this.fullMap());
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.render();
    });
    this.applyRange();
    this.applyActivity();
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
    const input = this.root.querySelector<HTMLInputElement>('#g-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.populateVersions();
    this.render();
  }

  refresh(): void {
    this.populateVersions();
    this.render();
  }

  private populateVersions(): void {
    const previous = this.version.value;
    this.version.innerHTML = VERSION_GROUPS
      .map((group) => `<option value="${group.engine}">${group.label}</option>`)
      .join('');
    if (VERSION_GROUPS.some((group) => group.engine === previous)) this.version.value = previous;
    else this.version.value = '26.3';
  }

  private selectedVersion(): string {
    return this.version.value || '26.3';
  }

  private selectedMapVersion(): string {
    const group = versionGroup(this.selectedVersion());
    if (!group) return this.selectedVersion();
    // 地图没有 1.21.4 时退回 1.21.3。
    if (group.map === '1.21.4' && this.versions.length && !this.versions.some((item) => item.name === '1.21.4')) {
      if (this.versions.some((item) => item.name === '1.21.3')) return '1.21.3';
    }
    return group.map;
  }

  private applyActivity(): void {
    const modern = isModernVersion(this.selectedVersion());
    this.tickRadius.disabled = modern;
    this.simulationDistance.disabled = !modern;
    this.activity.textContent = modern
      ? t('geode.activityModern')
      : t('geode.activityLegacy');
    this.updateDerived();
  }

  /** 正方形勾选时由边长填充四至；取消后四至保留最后值并可手改。 */
  private applyRange(): void {
    const square = this.square.checked;
    this.side.disabled = !square;
    for (const input of [this.minXInput, this.maxXInput, this.minZInput, this.maxZInput]) {
      input.disabled = square;
    }
    if (!square) {
      this.updateDerived();
      return;
    }
    const side = clampInt(Number(this.side.value), 1, MAX_SIDE);
    this.side.value = String(side);
    const min = Math.max(WORLD_MIN, -Math.floor(side / 2));
    const max = Math.min(WORLD_MAX, min + side - 1);
    this.minXInput.value = String(min);
    this.maxXInput.value = String(max);
    this.minZInput.value = String(min);
    this.maxZInput.value = String(max);
    this.updateDerived();
  }

  private currentRange(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return {
      minX: Number(this.minXInput.value),
      maxX: Number(this.maxXInput.value),
      minZ: Number(this.minZInput.value),
      maxZ: Number(this.maxZInput.value),
    };
  }

  private prefilterFor(range: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
    return autoBudgetFor(Math.max(1, range.maxX - range.minX + 1), Math.max(1, range.maxZ - range.minZ + 1));
  }

  private updateDerived(): void {
    const range = this.currentRange();
    const fullMap = isWorldBounds(range.minX, range.maxX, range.minZ, range.maxZ);
    this.syncThresholdDefaults(fullMap);
    const half = Math.max(range.maxX - range.minX + 1, range.maxZ - range.minZ + 1) / 2;
    let hint = '';
    if (!fullMap && half > LARGE_RANGE_HALF) hint = t('geode.rangeLargeHint');
    this.rangeHint.textContent = hint;
    this.rangeHint.hidden = !hint;
  }

  /** Whole-world searches need higher default thresholds; restore 20/800 when leaving. */
  private syncThresholdDefaults(fullMap: boolean): void {
    if (fullMap === this.fullMapMode) return;
    this.fullMapMode = fullMap;
    this.minGeodes.value = String(fullMap ? 40 : 20);
    this.minBudding.value = String(fullMap ? 1600 : 800);
  }

  private resetRange(): void {
    this.square.checked = true;
    this.side.value = String(DEFAULT_SIDE);
    this.applyRange();
    this.render();
  }

  private fullMap(): void {
    // 世界边界显示为 [-30000000, 30000000]，同时勾选正方形快捷并填入 60000001；
    // 宿主/引擎内部仍按 29999999 的真实可生成边界裁切。
    this.square.checked = true;
    this.side.value = String(MAX_SIDE);
    this.applyRange();
    this.render();
  }

  private renderSeedBlock(): void {
    const current = this.root.querySelector<HTMLInputElement>('#g-seed');
    if (current) this.seed = current.value.trim();
    const host = this.root.querySelector('#g-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="g-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="g-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="g-file-name"></div>`;
      const fileName = host.querySelector('#g-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#g-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.renderSeedBlock();
    this.applyActivity();

    const pauseLabel = this.pausing
      ? 'geode.pausingButton'
      : this.paused ? 'common.search.resume' : 'common.search.pause';
    const startDisabled = this.running || this.pausing || this.stopping;
    const pauseDisabled = this.stopping || this.pausing || (!this.running && !this.paused);
    const stopDisabled = (!this.running && !this.paused) || this.stopping;
    this.footer.innerHTML = `
      <div class="row">
        <button id="g-start" type="button" data-i18n="common.search.start" ${startDisabled ? 'disabled' : ''}></button>
        <button id="g-pause" type="button" data-i18n="${pauseLabel}" ${pauseDisabled ? 'disabled' : ''}></button>
        <button id="g-stop" type="button" data-i18n="${this.stopping ? 'geode.stoppingButton' : 'common.search.stop'}" ${stopDisabled ? 'disabled' : ''}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="g-bar"></div></div>
      <div id="g-progress" class="hint"></div>
      <div id="g-gpu" class="hint" hidden></div>
      <div id="g-elapsed" class="hint"></div>
      <div id="g-eta" class="hint"></div>
      <div id="g-error" class="hint"></div>
    `;
    this.footer.querySelector('#g-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#g-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#g-stop')?.addEventListener('click', () => void this.stop());
    applyI18n(this.root);
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#g-file-name');
    if (node) node.textContent = String(count);
  }

  private readSeedField(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#g-seed');
    if (seed) this.seed = seed.value.trim();
  }

  private collectRequest(): {
    version: string;
    threads: number;
    model: string;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    fullWorld: boolean;
    tickRadius: number;
    simulationDistance: number;
    minGeodes: number;
    minBudding: number;
    autoBudget: boolean;
    budget: number;
    verifyTop: number;
    allowGpu: boolean;
    resume: boolean;
    seeds: string;
  } {
    const range = this.currentRange();
    const listMode = this.seedMode === 'list';
    return {
      version: this.selectedVersion(),
      threads: clampInt(Number(this.threads.value), 1, MAX_THREADS),
      // 地形模型固定为局部地形；UI 不再提供 stone 对照。
      model: 'terrain',
      ...range,
      fullWorld: isWorldBounds(range.minX, range.maxX, range.minZ, range.maxZ),
      tickRadius: clampInt(Number(this.tickRadius.value), 1, MAX_TICK_RADIUS),
      simulationDistance: clampInt(
        Number(this.simulationDistance.value),
        MIN_SIMULATION_DISTANCE,
        MAX_SIMULATION_DISTANCE,
      ),
      minGeodes: clampInt(Number(this.minGeodes.value), MIN_GEODES, 1000),
      minBudding: Math.max(0, clampInt(Number(this.minBudding.value), 0, 1000)),
      // 候选预算由引擎按等效边长自动分档；复核/断点续跑不再暴露给用户。
      autoBudget: true,
      budget: 0,
      verifyTop: 0,
      allowGpu: this.allowGpu.checked,
      resume: false,
      seeds: listMode ? this.seedText : this.seed,
    };
  }

  private async validatedRequest(): Promise<ReturnType<GeodePanel['collectRequest']> | null> {
    this.readSeedField();
    const request = this.collectRequest();
    if (!request.seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return null;
    }
    if (this.seedMode === 'single') {
      const seed = request.seeds.trim();
      if (!/^[+-]?\d+$/.test(seed)) {
        await showNotice(t('common.error.bad-seed'));
        return null;
      }
      try {
        BigInt(seed);
      } catch {
        await showNotice(t('common.error.bad-seed'));
        return null;
      }
    } else {
      const lines = request.seeds.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
      if (!lines.length) {
        await showNotice(t('common.error.no-seeds'));
        return null;
      }
    }
    if (![request.minX, request.maxX, request.minZ, request.maxZ].every(Number.isFinite)
      || request.minX > request.maxX || request.minZ > request.maxZ
      || request.minX < WORLD_MIN || request.maxX > WORLD_MAX
      || request.minZ < WORLD_MIN || request.maxZ > WORLD_MAX) {
      await showNotice(t('common.error.bad-bounds'));
      return null;
    }
    if (this.square.checked) {
      const side = clampInt(Number(this.side.value), 1, MAX_SIDE);
      if (side < 1 || side > MAX_SIDE) {
        await showNotice(t('common.error.bad-bounds'));
        return null;
      }
    }
    if (request.tickRadius < 1 || request.tickRadius > MAX_TICK_RADIUS
      || request.simulationDistance < MIN_SIMULATION_DISTANCE
      || request.simulationDistance > MAX_SIMULATION_DISTANCE) {
      await showNotice(t('common.error.bad-bounds'));
      return null;
    }
    if (request.minGeodes < MIN_GEODES || request.minBudding < 0) {
      await showNotice(t('common.error.bad-level'));
      return null;
    }
    if (request.fullWorld && this.seedMode === 'list') {
      await showNotice(t('geode.fullMapSingleSeed'));
      return null;
    }
    return request;
  }

  private async start(): Promise<void> {
    this.readSeedField();
    const request = await this.validatedRequest();
    if (!request) return;
    const range = this.currentRange();
    this.searchView = {
      version: request.version,
      mapVersion: this.selectedMapVersion(),
      listMode: this.seedMode === 'list',
      minX: range.minX,
      maxX: range.maxX,
      minZ: range.minZ,
      maxZ: range.maxZ,
      prefilter: this.prefilterFor(range),
      verifyTop: 0,
      simulationDistance: request.simulationDistance,
      modernActivity: isModernVersion(request.version),
    };
    try {
      await call('geodeStart', request);
    } catch (error) {
      await showNotice(messageOf(error));
      return;
    }
    this.results?.clearGeode(this.searchView);
    this.running = true;
    this.paused = false;
    this.pausing = false;
    this.stopping = false;
    this.shownError = '';
    this.searchStartedAt = Date.now();
    this.render();
    this.poll();
  }

  private async togglePause(): Promise<void> {
    if (this.pausing || this.stopping) return;
    try {
      if (this.paused) {
        await call('geodeResume');
        this.paused = false;
        this.pausing = false;
      } else if (this.running) {
        await call('geodePause');
        this.pausing = true;
      }
    } catch (error) {
      await showNotice(messageOf(error));
      return;
    }
    this.render();
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    this.render();
    try {
      await call('geodeStop');
    } catch {
      /* the host clears its state even if the thread is already gone */
    }
    this.running = false;
    this.paused = false;
    this.pausing = false;
    this.stopping = false;
    this.results?.clearGeode(this.searchView);
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<GeodeStatus>('geodePoll');
        const changed = status.running !== this.running
          || status.paused !== this.paused
          || status.pausing !== this.pausing
          || status.stopping !== this.stopping;
        this.running = status.running;
        this.paused = status.paused;
        this.pausing = status.pausing;
        this.stopping = status.stopping;
        if (changed) this.render();
        this.updateProgress(status);
        if (status.done) {
          window.clearInterval(this.pollTimer);
          this.running = false;
          this.paused = false;
          this.pausing = false;
          this.stopping = false;
          if (status.error && status.error !== this.shownError) {
            this.shownError = status.error;
            await showNotice(messageOf(status.error));
          }
          this.results?.setGeodeHits(status.hits, this.searchView);
          this.render();
          this.updateProgress(status);
        }
      } catch {
        window.clearInterval(this.pollTimer);
        this.running = false;
        this.pausing = false;
        this.stopping = false;
        this.render();
      }
    }, 100);
  }

  private phaseLabel(status: GeodeStatus): string {
    const key = `geode.phase.${status.phase}`;
    const text = t(key);
    return text === key ? status.phase : text;
  }

  private progressText(status: GeodeStatus): string {
    if (status.stopped) return t('geode.stoppedProgress');
    const phase = Math.max(1, Math.min(status.phaseCount || 3, status.phaseIndex || 1));
    const count = status.phaseCount || 3;
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} · `
      : '';
    const state = status.stopping
      ? `${t('geode.stopping')} `
      : status.pausing
        ? `${t('geode.pausing')} `
        : status.paused ? `${t('geode.paused')} ` : '';
    const pct = status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : 0;
    const units = status.total > 0
      ? ` · ${status.current.toLocaleString()} / ${status.total.toLocaleString()} (${pct}%)`
      : '';
    return `${seeds}${state}${t('geode.phaseLine', { index: phase, count, phase: this.phaseLabel(status) })}${units}`;
  }

  private etaText(status: GeodeStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.stopping) return t('geode.stoppingEta');
    if (status.paused) return t('common.search.eta.paused');
    if (status.pausing) return t('geode.pausingEta');
    if (!(status.etaSeconds > 0) || !Number.isFinite(status.etaSeconds)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(status.etaSeconds * 1000) });
  }

  private updateProgress(status: GeodeStatus): void {
    const progress = this.footer.querySelector('#g-progress');
    const gpu = this.footer.querySelector<HTMLElement>('#g-gpu');
    const elapsed = this.footer.querySelector('#g-elapsed');
    const eta = this.footer.querySelector('#g-eta');
    const error = this.footer.querySelector('#g-error');
    const bar = this.footer.querySelector<HTMLElement>('#g-bar');
    const pct = status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
    if (progress) progress.textContent = this.progressText(status);
    if (gpu) {
      // Only the phase-1 coarse scan can run on OpenCL; scanBackend flips to "gpu"
      // as soon as the kernel is built and the batches start. When the user asked
      // for the GPU but the scan fell back to CPU, say why instead of hiding.
      const active = status.scanBackend === 'gpu';
      const waitingCpu = this.allowGpu.checked && status.running && status.phase === 'scan';
      const device = status.gpuDevice || gpuRendererName() || t('geode.gpuUnknown');
      const reason = status.gpuReason === 'no-opencl'
        ? t('geode.gpuNoOpencl')
        : status.gpuReason === 'no-device' ? t('geode.gpuNoDevice') : t('geode.gpuFallback');
      gpu.hidden = !(active || waitingCpu);
      gpu.textContent = active ? t('geode.gpuLine', { device }) : waitingCpu ? reason : '';
    }
    if (elapsed) {
      const ms = status.elapsedMs > 0 ? status.elapsedMs : Date.now() - this.searchStartedAt;
      elapsed.textContent = t('common.searchExtra.elapsed', { time: formatDuration(ms) });
    }
    if (eta) eta.textContent = this.etaText(status);
    if (error) {
      // “已停止”只由进度行显示，避免同一状态出现两次。
      error.textContent = '';
    }
    if (bar) bar.style.width = `${pct}%`;
  }
}
