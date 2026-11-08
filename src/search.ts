import { ask } from './dialog';
import { caveDefaultAfkY, caveFullShellArea } from './cave-geometry';
import { gpuRendererName } from './gpu';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type SearchStatus } from './native';
import { applyForm, applyRunLock, captureForm, RunTimer, paintProgressCard, initProgressCard } from './panel-utils';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

const LUCKY_AREA = 6000001 * 6000001;
const LUCKY_BELOW = 0.75;
const LOW_PROB = 0.85;
const DEFAULT_SIDE = 131072;
const WORLD_SIDE = 60000001;
/** Default minimum weighted area ratio: 70% (product default). */
const DEFAULT_RATIO = '70';
/** Default river/biome conversion weight of the low-Y cave search. */
const DEFAULT_RIVER_WEIGHT = '0.70';
const BORDER_RATIO = '90';
/** Precise layer window (B1): defaults, hard limits and non-blocking warnings. */
const DEFAULT_Y_MIN = '-63';
const DEFAULT_Y_MAX = '-51';
const Y_LIMIT_MIN = -63;
const Y_LIMIT_MAX = 319;
const Y_MAX_SPAN = 48;
const Y_SOFT_SPAN = 24;
const Y_SOFT_MIN = -58;
/** 单次 searchPoll 的最长等待；超过即视为引擎无响应，解除界面锁定。 */
const POLL_TIMEOUT_MS = 30000;

/** 给引擎调用加超时：没有它，引擎崩溃/卡死时 Promise 永不 settle，界面会一直锁死。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('engine-timeout')), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 溶洞范围小于这个等效面积时，提示改去河流页搜索。 */
const RIVER_HINT_AREA = 100000 * 100000;

type SeedMode = 'single' | 'list';
type LowyUiVersion = 'pre' | 'sulfur';

function resolveLowyMc(ui: LowyUiVersion, versions: McVersion[]): number {
  if (ui === 'sulfur') {
    const hit =
      versions.find((item) => item.name === '26.3') ||
      versions.find((item) => item.name === '26.2') ||
      versions[versions.length - 1];
    return hit?.id ?? 0;
  }
  const hit =
    versions.find((item) => item.name === '26.1') ||
    versions.find((item) => item.name === '1.21.11') ||
    versions.find((item) => item.name.startsWith('1.21')) ||
    versions[0];
  return hit?.id ?? 0;
}

export class SearchPanel {
  readonly root: HTMLElement;
  private footer!: HTMLElement;
  private version!: HTMLSelectElement;
  private threads!: HTMLInputElement;
  private minX!: HTMLInputElement;
  private maxX!: HTMLInputElement;
  private minZ!: HTMLInputElement;
  private maxZ!: HTMLInputElement;
  private square!: HTMLInputElement;
  private side!: HTMLInputElement;
  private seedModeSelect!: HTMLSelectElement;
  private searcher: SearcherId = 'LowYDripstoneCave';
  /** 开始搜索时快照当前页是不是大坑（切 Tab 后阶段名称仍按启动页解释）。 */
  private searchPit = false;
  /** 开始搜索时快照的 tab / 种子列表模式 / 实际引擎版本，轮询时不再跟随当前页。 */
  private searchTab: SearcherId = 'LowYDripstoneCave';
  private searchListMode = false;
  private searchMapVersion = '26.3';
  private seedMode: SeedMode = 'single';
  private uiVersion: LowyUiVersion = 'sulfur';
  private supported = true;
  private running = false;
  private paused = false;
  /** 已发出停止请求、等待引擎结束当前工作单元；期间禁止再次点击/暂停。 */
  private stopping = false;
  /** 最近一次结束是用户主动停止（不是自然完成），用于进度行显示“已停止”。 */
  private stopped = false;
  private pollTimer = 0;
  private versions: McVersion[] = [];
  private seed = '';
  private river = DEFAULT_RIVER_WEIGHT;
  private ratio = DEFAULT_RATIO;
  private yMin = DEFAULT_Y_MIN;
  private yMax = DEFAULT_Y_MAX;
  private fastMode = true;
  private fastRatio = '90';
  /** Opt-in GPU coarse scan; the engine still gates it by window size / threads. */
  private allowGpu = false;
  private seedText = '';
  /** 0.75→0.70 的默认值迁移已写入本条件（避免用户手动改回 0.75 后被反复覆盖）。 */
  private riverMigrated = false;
  private readonly timer = new RunTimer();
  private lastPhase = Number.NaN;
  /** 最近一次轮询结果；render() 重建页脚后据此恢复进度，避免完成瞬间被清空。 */
  private lastStatus: SearchStatus | null = null;
  /** 两个低Y tab 共用面板：各自保存完成后的状态/耗时，切回时恢复已完成的 100% 进度。 */
  private readonly statusByTab: Partial<
    Record<
      SearcherId,
      {
        status: SearchStatus;
        elapsed: number;
        pit: boolean;
        stopped: boolean;
      }
    >
  > = {};
  /** Two low-Y tabs share one panel; keep each tab's form/conditions separately. */
  private readonly formStates: Partial<Record<SearcherId, Record<string, unknown>>> = {};
  private readonly pendingState = new Set<SearcherId>();
  private restoredElapsed: number | null = null;
  private results: ResultsColumn | null = null;
  onNavigate: (id: SearcherId) => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="s-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="s-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="s-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label><select id="s-version"></select>
          <label data-i18n="common.search.threads"></label><input id="s-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="s-minx" type="number" value="-65536" />
          <label data-i18n="common.search.maxX"></label><input id="s-maxx" type="number" value="65535" />
          <label data-i18n="common.search.minZ"></label><input id="s-minz" type="number" value="-65536" />
          <label data-i18n="common.search.maxZ"></label><input id="s-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="check-row"><input id="s-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="s-side" type="number" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="s-reset" type="button" class="btn ghost sm" data-i18n="common.search.reset"></button>
          <button id="s-border" type="button" class="btn ghost sm" data-i18n="common.search.border"></button>
        </div>
        <div id="s-params"></div>
      </div>
      <div class="search-panel-footer" id="s-footer"></div>
    `;
    this.footer = this.root.querySelector('#s-footer')!;
    this.version = this.root.querySelector('#s-version')!;
    this.threads = this.root.querySelector('#s-threads')!;
    this.minX = this.root.querySelector('#s-minx')!;
    this.maxX = this.root.querySelector('#s-maxx')!;
    this.minZ = this.root.querySelector('#s-minz')!;
    this.maxZ = this.root.querySelector('#s-maxz')!;
    this.square = this.root.querySelector('#s-square')!;
    this.side = this.root.querySelector('#s-side')!;
    this.seedModeSelect = this.root.querySelector('#s-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.root.querySelector('#s-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#s-border')!.addEventListener('click', () => this.resetWorldBorder());
    this.version.addEventListener('change', () => {
      this.uiVersion = this.version.value === 'pre' ? 'pre' : 'sulfur';
      void this.refreshSupport();
    });
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.render();
    });
    this.applySquare();
  }

  bindResults(results: ResultsColumn): void {
    this.results = results;
  }

  setSearcher(id: SearcherId): void {
    const changed = this.searcher !== id;
    if (changed && !this.pendingState.has(this.searcher)) {
      this.formStates[this.searcher] = this.exportState();
    }
    this.searcher = id;
    if (id === 'LowYPitDripstoneCave') this.seedMode = 'single';
    if (changed || this.pendingState.has(id)) {
      if (!this.running) {
        const saved = this.statusByTab[id];
        this.lastStatus = saved?.status ?? null;
        this.restoredElapsed = saved?.elapsed ?? null;
        this.stopped = saved?.stopped ?? false;
        this.searchPit = saved?.pit ?? id === 'LowYPitDripstoneCave';
      }
      const savedForm = this.formStates[id];
      if (savedForm) {
        this.applyState(savedForm);
        this.pendingState.delete(id);
      } else if (changed) {
        this.resetDefaultArea();
      }
    }
    this.render();
  }

  /** Session export: both low-Y tabs' conditions. */
  exportStates(): Record<string, unknown> {
    if (!this.pendingState.has(this.searcher)) {
      this.formStates[this.searcher] = this.exportState();
    }
    return { ...this.formStates };
  }

  importStates(states: unknown): void {
    if (!states || typeof states !== 'object') return;
    const source = states as Record<string, unknown>;
    for (const id of ['LowYDripstoneCave', 'LowYPitDripstoneCave'] as SearcherId[]) {
      const value = source[id];
      if (value && typeof value === 'object') {
        this.formStates[id] = value as Record<string, unknown>;
        this.pendingState.add(id);
      }
    }
    const current = this.formStates[this.searcher];
    if (current && this.pendingState.has(this.searcher)) {
      this.applyState(current);
      this.pendingState.delete(this.searcher);
    }
  }

  private exportState(): Record<string, unknown> {
    return {
      form: captureForm(this.root),
      seedMode: this.seedMode,
      uiVersion: this.uiVersion,
      seed: this.seed,
      seedText: this.seedText,
      river: this.river,
      riverMigrated: this.riverMigrated,
      ratio: this.ratio,
      yMin: this.yMin,
      yMax: this.yMax,
      fastRatio: this.fastRatio,
      fastMode: this.fastMode,
    };
  }

  private applyState(state: Record<string, unknown>): void {
    if (state.seedMode === 'single' || state.seedMode === 'list') this.seedMode = state.seedMode;
    if (state.uiVersion === 'pre' || state.uiVersion === 'sulfur') this.uiVersion = state.uiVersion;
    if (typeof state.seed === 'string') this.seed = state.seed;
    if (typeof state.seedText === 'string') this.seedText = state.seedText;
    if (typeof state.river === 'string') this.river = state.river;
    // 0.75 是旧版本的默认折算系数；老 session 保存的 0.75 与“用户改过”无法区分，
    // 首次读档时按新默认 0.70 迁移一次，迁移后写入 riverMigrated 标记。
    const legacyRiver = state.riverMigrated !== true && this.river.trim() === '0.75';
    if (legacyRiver) {
      this.river = DEFAULT_RIVER_WEIGHT;
      if (state.form && typeof state.form === 'object') {
        (state.form as Record<string, unknown>)['p-river'] = DEFAULT_RIVER_WEIGHT;
      }
    }
    this.riverMigrated = state.riverMigrated === true || legacyRiver;
    if (typeof state.ratio === 'string') this.ratio = state.ratio;
    if (typeof state.yMin === 'string') this.yMin = state.yMin;
    if (typeof state.yMax === 'string') this.yMax = state.yMax;
    if (typeof state.fastRatio === 'string') this.fastRatio = state.fastRatio;
    if (typeof state.fastMode === 'boolean') this.fastMode = state.fastMode;
    applyForm(this.root, state);
    this.render();
    applyForm(this.root, state);
    this.syncGpuField();
  }

  /** 读档/切 tab 后让 allowGpu 与复选框实际状态一致。 */
  private syncGpuField(): void {
    const gpu = this.root.querySelector<HTMLInputElement>('#p-gpu');
    if (gpu) this.allowGpu = gpu.checked;
  }

  setSeedFromMap(seed: string): void {
    // 只有“单种子”来源的 tab 才跟随地图/其他单种子页面的种子。
    if (this.seedMode !== 'single') return;
    if (!seed.trim()) return;
    this.seed = seed.trim();
    const input = this.root.querySelector<HTMLInputElement>('#p-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.version.innerHTML = `
      <option value="sulfur" data-i18n="dripstonecave.verSulfur"></option>
      <option value="pre" data-i18n="dripstonecave.verPre"></option>
    `;
    this.version.value = this.uiVersion;
    applyI18n(this.version);
    void this.refreshSupport();
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private pageId(): string {
    if (this.searcher === 'LowYPitDripstoneCave') return 'lowy-fast';
    return this.seedMode === 'list' ? 'lowy-list' : 'lowy-single';
  }

  private shared() {
    return {
      mc: resolveLowyMc(this.uiVersion, this.versions),
      threads: Math.max(1, Math.min(256, Number(this.threads.value) || 1)),
      minX: Number(this.minX.value),
      maxX: Number(this.maxX.value),
      minZ: Number(this.minZ.value),
      maxZ: Number(this.maxZ.value),
    };
  }

  private defaultSide(): number {
    return this.searcher === 'LowYPitDripstoneCave' ? WORLD_SIDE : DEFAULT_SIDE;
  }

  private resetDefaultArea(): void {
    this.square.checked = true;
    this.side.value = String(this.defaultSide());
    this.ratio = DEFAULT_RATIO;
    this.yMin = DEFAULT_Y_MIN;
    this.yMax = DEFAULT_Y_MAX;
    this.applySquare();
    this.render();
  }

  private resetWorldBorder(): void {
    this.square.checked = true;
    this.side.value = String(WORLD_SIDE);
    this.ratio = BORDER_RATIO;
    this.fastRatio = BORDER_RATIO;
    this.applySquare();
    this.render();
  }

  private applySquare(): void {
    const locked = this.square.checked;
    this.side.disabled = !locked;
    for (const input of [this.minX, this.maxX, this.minZ, this.maxZ]) input.disabled = locked;
    if (!locked) return;
    const side = Math.max(1, Math.floor(Number(this.side.value) || 1));
    const min = -Math.floor(side / 2);
    const max = min + side - 1;
    this.minX.value = String(min);
    this.maxX.value = String(max);
    this.minZ.value = String(min);
    this.maxZ.value = String(max);
  }

  private area(): number {
    const box = this.shared();
    return (box.maxX - box.minX + 1) * (box.maxZ - box.minZ + 1);
  }

  private caveRatioLimits(pit: boolean): [number, number] {
    if (pit) return [80, 95];
    return this.fastMode ? [60, 95] : [40, 95];
  }

  /** 当前输入对应的有效采样层窗口；非法输入退回默认窗口。 */
  private caveYWindow(): { yMin: number; yMax: number } {
    const rawMin = Math.trunc(Number(this.yMin));
    const rawMax = Math.trunc(Number(this.yMax));
    const yMin = Number.isFinite(rawMin) ? Math.min(Y_LIMIT_MAX, Math.max(Y_LIMIT_MIN, rawMin)) : Number(DEFAULT_Y_MIN);
    const yMax = Number.isFinite(rawMax) ? Math.min(Y_LIMIT_MAX, Math.max(yMin, rawMax)) : yMin + 12;
    return { yMin, yMax: Math.min(yMax, yMin + Y_MAX_SPAN - 1) };
  }

  /** 当前窗口的展示分母（满球壳格数），面积与占比互算都用它。 */
  private caveFullArea(): number {
    const { yMin, yMax } = this.caveYWindow();
    return caveFullShellArea(yMin, yMax, caveDefaultAfkY(yMin));
  }

  /** 由占比算出的面积；占比不在当前模式允许区间时留空。 */
  private caveAreaValue(pit: boolean): string {
    const ratio = Number(pit ? this.fastRatio : this.ratio);
    const [min, max] = this.caveRatioLimits(pit);
    if (!Number.isFinite(ratio) || ratio < min || ratio > max) return '';
    return String(Math.round((ratio / 100) * this.caveFullArea()));
  }

  private caveRatioFromArea(value: string, pit: boolean): number | null {
    const area = Number(value);
    if (!Number.isFinite(area) || area < 0) return null;
    const ratio = Math.round((area / this.caveFullArea()) * 100);
    const [min, max] = this.caveRatioLimits(pit);
    if (ratio < min || ratio > max) return null;
    return ratio;
  }

  /** GPU opt-in row shared by the single/list cave pages (the pit page has no GPU path). */
  private gpuToggleHtml(): string {
    return (
      '<div class="span-full"><label class="check-row"><input id="p-gpu" type="checkbox" ' +
      (this.allowGpu ? 'checked' : '') +
      ' /><span data-i18n="dripstonecave.allowGpu"></span></label></div>'
    );
  }

  private async refreshSupport(): Promise<void> {
    try {
      this.supported = await call<boolean>('lowySupports', this.shared().mc);
    } catch {
      this.supported = false;
    }
    this.render();
  }

  private renderSeedBlock(): void {
    const host = this.root.querySelector('#s-seed-block')!;
    const pit = this.searcher === 'LowYPitDripstoneCave';
    if (pit || this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="p-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="p-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="p-file-name"></div>`;
      const fileName = host.querySelector('#p-file-name');
      if (fileName && this.seedText) {
        const count = this.seedText.split(/\r?\n/).filter((line) => line.trim()).length;
        fileName.textContent = String(count);
      }
      host.querySelector('#p-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    const pit = this.searcher === 'LowYPitDripstoneCave';
    this.seedModeSelect.disabled = pit;
    this.seedModeSelect.value = pit ? 'single' : this.seedMode;
    if (pit) this.seedMode = 'single';
    this.version.value = this.uiVersion;
    this.renderSeedBlock();

    const params = this.root.querySelector('#s-params')!;
    const notice = this.supported ? '' : `<div class="hint" data-i18n="common.search.unsupported"></div>`;
    /* 采样说明放在快速模式下方，溶洞总说明放在允许调用显卡下方。 */
    const caveHelp = '<div class="span-full hint" data-i18n="dripstonecave.helpCave"></div>';

    if (pit) {
      params.innerHTML = `${notice}<div class="grid">
        <label data-i18n="dripstonecave.fastRatio"></label><input id="p-ratio" type="number" min="80" max="95" step="1" value="${escapeAttr(this.fastRatio)}" />
        <label data-i18n="dripstonecave.area"></label><input id="p-area" type="number" min="0" step="1" value="${this.caveAreaValue(true)}" />
        <label data-i18n="dripstonecave.yMin"></label><input id="p-ymin" type="number" min="${Y_LIMIT_MIN}" max="${Y_LIMIT_MAX}" step="1" value="${escapeAttr(this.yMin)}" />
        <label data-i18n="dripstonecave.yMax"></label><input id="p-ymax" type="number" min="${Y_LIMIT_MIN}" max="${Y_LIMIT_MAX}" step="1" value="${escapeAttr(this.yMax)}" />
        <div class="span-full hint" data-i18n="dripstonecave.yHint"></div>
      </div><div class="hint" data-i18n="dripstonecave.helpPit"></div>`;
    } else {
      params.innerHTML = `${notice}<div class="grid">
        <label data-i18n="dripstonecave.riverWeight"></label><input id="p-river" type="number" min="0" max="1" step="0.05" value="${escapeAttr(this.river)}" />
        <label data-i18n="dripstonecave.ratio"></label><input id="p-ratio" type="number" min="40" max="95" step="1" value="${escapeAttr(this.ratio)}" />
        <label data-i18n="dripstonecave.area"></label><input id="p-area" type="number" min="0" step="1" value="${this.caveAreaValue(false)}" />
        <label data-i18n="dripstonecave.yMin"></label><input id="p-ymin" type="number" min="${Y_LIMIT_MIN}" max="${Y_LIMIT_MAX}" step="1" value="${escapeAttr(this.yMin)}" />
        <label data-i18n="dripstonecave.yMax"></label><input id="p-ymax" type="number" min="${Y_LIMIT_MIN}" max="${Y_LIMIT_MAX}" step="1" value="${escapeAttr(this.yMax)}" />
        <label class="feature span-full"><input id="p-fast" type="checkbox" ${this.fastMode ? 'checked' : ''} /><span data-i18n="dripstonecave.fastMode"></span></label>
        <div class="span-full hint" data-i18n="dripstonecave.yHint"></div>
        ${this.gpuToggleHtml()}
        ${caveHelp}
      </div>`;
    }

    const ratioInput = params.querySelector<HTMLInputElement>('#p-ratio');
    const areaInput = params.querySelector<HTMLInputElement>('#p-area');
    ratioInput?.addEventListener('input', () => {
      if (pit) this.fastRatio = ratioInput.value;
      else this.ratio = ratioInput.value;
      const area = this.caveAreaValue(pit);
      if (areaInput) areaInput.value = area;
    });
    areaInput?.addEventListener('input', () => {
      const ratio = this.caveRatioFromArea(areaInput.value, pit);
      if (ratio == null) return;
      if (ratioInput) ratioInput.value = String(ratio);
      if (pit) this.fastRatio = String(ratio);
      else this.ratio = String(ratio);
    });
    params.querySelector<HTMLInputElement>('#p-fast')?.addEventListener('change', () => {
      const fast = params.querySelector<HTMLInputElement>('#p-fast');
      if (fast) this.fastMode = fast.checked;
    });
    const yMinInput = params.querySelector<HTMLInputElement>('#p-ymin');
    const yMaxInput = params.querySelector<HTMLInputElement>('#p-ymax');
    /* 采样窗口决定满球壳面积（含 AFK Y），面积框要跟着窗口一起刷新。 */
    const refreshArea = () => {
      const area = this.caveAreaValue(pit);
      if (areaInput) areaInput.value = area;
    };
    yMinInput?.addEventListener('input', () => {
      this.yMin = yMinInput.value;
      refreshArea();
    });
    yMaxInput?.addEventListener('input', () => {
      this.yMax = yMaxInput.value;
      refreshArea();
    });
    params.querySelector<HTMLInputElement>('#p-gpu')?.addEventListener('change', () => {
      const gpu = params.querySelector<HTMLInputElement>('#p-gpu');
      if (gpu) this.allowGpu = gpu.checked;
    });

    this.footer.innerHTML = `
      <div class="row">
        <button id="s-start" type="button" class="btn primary" data-i18n="common.search.start" ${this.supported && !this.running && !this.stopping ? '' : 'disabled'}></button>
        <button id="s-pause" type="button" class="btn amber" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running && !this.stopping ? '' : 'disabled'}></button>
        <button id="s-stop" type="button" class="btn danger" data-i18n="${this.stopping ? 'common.search.stopping' : 'common.search.stop'}" ${this.running && !this.stopping ? '' : 'disabled'}></button>
      </div>
      <div class="progress-card">
        <div class="progress-top">
          <span class="progress-state"><span class="state-dot"></span><span id="s-state"></span></span>
          <span class="progress-percent" id="s-percent">0%</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="s-bar"></div></div>
        <div class="progress-meta"><strong id="s-progress"></strong></div>
        <div id="s-gpu" class="hint" hidden></div>
        <div id="s-elapsed" class="hint"></div>
        <div id="s-eta" class="progress-estimate"></div>
      </div>
    `;

    this.footer.querySelector('#s-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#s-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#s-stop')?.addEventListener('click', () => void this.stop());
    applyI18n(this.root);
    applyRunLock(this.root, this.running, this.paused);
    if (this.lastStatus) this.paintStatus(this.lastStatus);
    initProgressCard(this.footer, 's');
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#p-seed');
    const river = this.root.querySelector<HTMLInputElement>('#p-river');
    const ratio = this.root.querySelector<HTMLInputElement>('#p-ratio');
    const yMin = this.root.querySelector<HTMLInputElement>('#p-ymin');
    const yMax = this.root.querySelector<HTMLInputElement>('#p-ymax');
    const fast = this.root.querySelector<HTMLInputElement>('#p-fast');
    const gpu = this.root.querySelector<HTMLInputElement>('#p-gpu');
    if (seed) this.seed = seed.value.trim();
    if (river) this.river = river.value;
    if (yMin) this.yMin = yMin.value;
    if (yMax) this.yMax = yMax.value;
    if (this.searcher === 'LowYPitDripstoneCave') {
      if (ratio) this.fastRatio = ratio.value;
    } else if (ratio) this.ratio = ratio.value;
    if (fast) this.fastMode = fast.checked;
    if (gpu) this.allowGpu = gpu.checked;
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#p-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    const box = this.shared();
    const fastPage = this.searcher === 'LowYPitDripstoneCave';
    this.searchPit = fastPage;
    this.searchTab = this.searcher;
    const listMode = !fastPage && this.seedMode === 'list';
    this.searchListMode = listMode;
    this.searchMapVersion =
      this.versions.find((item) => item.id === box.mc)?.name ?? (this.uiVersion === 'pre' ? '26.1' : '26.3');
    const boxArea = Math.max(0, box.maxX - box.minX + 1) * Math.max(0, box.maxZ - box.minZ + 1);
    /* 超大范围（> 20000001²）时，溶洞占比至少 90%；大坑不受此限制。 */
    const hugeArea = !fastPage && boxArea > 20000001 * 20000001;
    let ratio = Number(fastPage ? this.fastRatio : this.ratio);
    if (hugeArea && ratio < 90) {
      await ask(t('dripstonecave.ratio90'), [{ id: 'dismiss', key: 'common.dialog.close' }]);
      this.ratio = '90';
      ratio = 90;
      const ratioField = this.root.querySelector<HTMLInputElement>('#p-ratio');
      if (ratioField) ratioField.value = '90';
    }
    const min = fastPage ? 80 : hugeArea ? 90 : this.fastMode ? 60 : 40;
    if (!(ratio >= min && ratio <= 95)) {
      await ask(t('common.error.bad-ratio'), [{ id: 'dismiss', key: 'common.dialog.close' }]);
      return;
    }
    /* B1 precise layer window: hard checks, then two non-blocking warnings.
     * Both the normal and the large-pit page use their own fields. */
    const yMinText = this.yMin.trim();
    const yMaxText = this.yMax.trim();
    const yMin = Number(yMinText);
    const yMax = Number(yMaxText);
    const yLayers = yMax - yMin + 1;
    if (
      yMinText === '' ||
      yMaxText === '' ||
      !Number.isInteger(yMin) ||
      !Number.isInteger(yMax) ||
      yMin > yMax ||
      yMin < Y_LIMIT_MIN ||
      yMax > Y_LIMIT_MAX ||
      yLayers > Y_MAX_SPAN
    ) {
      await ask(t('common.error.bad-y-range'), [{ id: 'dismiss', key: 'common.dialog.close' }]);
      return;
    }
    if (yLayers > Y_SOFT_SPAN) {
      await ask(t('dripstonecave.yWide', { layers: yLayers }), [{ id: 'dismiss', key: 'common.dialog.close' }]);
    }
    if (yMin > Y_SOFT_MIN) {
      await ask(t('dripstonecave.yLowMin', { min: yMin }), [{ id: 'dismiss', key: 'common.dialog.close' }]);
    }
    /* shell 模型的 AFK Y 与展示分母都跟随采样窗口：AFK = 最低层 + 23，
     * 分母 = 窗口内满球壳格数的平均值（与引擎 fullShellArea() 一致）。 */
    const afkY = caveDefaultAfkY(yMin);
    const fullArea = caveFullShellArea(yMin, yMax, afkY);
    const areaInput = this.root.querySelector<HTMLInputElement>('#p-area');
    if (areaInput) areaInput.value = String(Math.round((ratio / 100) * fullArea));
    // 范围较小时先问要不要改去河流页；选“是”直接切 Tab，不启动本次搜索。
    if (!fastPage) {
      const width = box.maxX - box.minX + 1;
      const height = box.maxZ - box.minZ + 1;
      if (width > 0 && height > 0 && width * height < RIVER_HINT_AREA) {
        const choice = await ask(t('dripstonecave.toRiver'), [
          { id: 'yes', key: 'dripstonecave.goRiver' },
          { id: 'no', key: 'dripstonecave.stay' },
          { id: 'dismiss', key: 'common.dialog.close' },
        ]);
        if (choice === 'yes') {
          this.onNavigate('River');
          return;
        }
        if (choice !== 'no') return;
      }
    }
    if (!fastPage && !listMode && this.area() >= LUCKY_AREA) {
      try {
        const score = await call<number>('weirdness', this.seed);
        if (score < LUCKY_BELOW) {
          const choice = await ask(t('dripstonecave.tryLuck'), [
            { id: 'yes', key: 'dripstonecave.goFast' },
            { id: 'no', key: 'dripstonecave.stay' },
            { id: 'dismiss', key: 'common.dialog.close' },
          ]);
          if (choice === 'yes') {
            this.onNavigate('LowYPitDripstoneCave');
            return;
          }
          if (choice !== 'no') return;
        }
      } catch (error) {
        await ask(messageOf(error), [{ id: 'dismiss', key: 'common.dialog.close' }]);
        return;
      }
    }
    if (fastPage) {
      try {
        const score = await call<number>('weirdness', this.seed);
        if (score > LOW_PROB) {
          const choice = await ask(t('dripstonecave.unlikely'), [
            { id: 'yes', key: 'dripstonecave.anyway' },
            { id: 'no', key: 'dripstonecave.back' },
            { id: 'dismiss', key: 'common.dialog.close' },
          ]);
          if (choice === 'no') {
            this.ratio = this.fastRatio;
            this.onNavigate('LowYDripstoneCave');
            return;
          }
          if (choice !== 'yes') return;
        }
      } catch (error) {
        await ask(messageOf(error), [{ id: 'dismiss', key: 'common.dialog.close' }]);
        return;
      }
    }
    try {
      await call('searchStart', {
        page: this.pageId(),
        ...box,
        fastMode: fastPage ? true : this.fastMode,
        allowGpu: fastPage ? false : this.allowGpu,
        ratio,
        riverWeight: Number(this.river) || Number(DEFAULT_RIVER_WEIGHT),
        yMin,
        yMax,
        afkY,
        seed: this.seed,
        seeds: listMode ? this.seedText : undefined,
      });
      this.results?.clear(this.searchTab, listMode);
      this.results?.setLowyMapVersion(this.searchTab, this.searchMapVersion);
      this.results?.setLowyGeometry(this.searchTab, afkY, fullArea);
      /* 地图跳转要落在真正采样的层上，而不是球心 Y。 */
      this.results?.setLowyYWindow(this.searchTab, yMin, yMax);
      this.results?.setLowyModel(this.searchTab, `drowned-weighted-shell-b/${yLayers}/afk${afkY}`);
      this.running = true;
      this.paused = false;
      this.stopping = false;
      this.stopped = false;
      this.lastStatus = null;
      this.restoredElapsed = null;
      delete this.statusByTab[this.searchTab];
      this.timer.start();
      this.lastPhase = Number.NaN;
      this.render();
      this.poll();
    } catch (error) {
      await ask(messageOf(error), [{ id: 'dismiss', key: 'common.dialog.close' }]);
    }
  }

  private async togglePause(): Promise<void> {
    if (this.stopping) return;
    if (this.paused) {
      await call('searchResume');
      this.paused = false;
      this.timer.resume();
    } else {
      await call('searchPause');
      this.paused = true;
      this.timer.pause();
    }
    this.render();
  }

  /**
   * 停止是异步的：引擎要先结束当前工作单元。立刻切换按钮/进度文案，轮询继续，
   * 避免用户以为点击无效而反复点击（旧实现在大批量范围下会一直停在“停止”前的状态）。
   */
  private async stop(): Promise<void> {
    if (!this.running || this.stopping) return;
    this.stopping = true;
    this.render();
    try {
      await call('searchStop');
    } catch (error) {
      this.stopping = false;
      this.render();
      await ask(messageOf(error), [{ id: 'dismiss', key: 'common.dialog.close' }]);
    }
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await withTimeout(call<SearchStatus>('searchPoll'), POLL_TIMEOUT_MS);
        this.lastStatus = status;
        this.restoredElapsed = null;
        this.running = status.running;
        this.paused = status.paused;
        if (status.phase !== this.lastPhase) {
          this.lastPhase = status.phase;
          this.timer.markPhase();
        }
        this.paintStatus(status);
        this.results?.setHits(status.hits, this.searchTab, this.searchListMode);
        /* 引擎算出的 AFK/分母是权威值；同步给结果栏的 /tp 与百分比。 */
        if (status.fullArea > 0) {
          this.results?.setLowyGeometry(this.searchTab, status.afkY, status.fullArea);
        }
        // done，或“引擎已结束但没报告 done”（停止/出错后的收尾）都要立刻解锁界面；
        // 只认 done 的话，引擎提前收尾时页面会一直停在“停止中”且所有按钮禁用。
        if (status.done || (!status.running && !status.paused)) {
          window.clearInterval(this.pollTimer);
          // 引擎收尾时可能没把 done 置位；统一按“已完成”收进该 tab 的状态。
          const finished: SearchStatus = status.done ? status : { ...status, done: true };
          // 结束前先记录是不是用户按了停止，进度行据此显示“已停止”而不是“已完成”。
          const stopped = this.stopping;
          this.lastStatus = finished;
          this.running = false;
          this.paused = false;
          this.stopping = false;
          this.stopped = stopped;
          const elapsed = this.timer.elapsed();
          this.statusByTab[this.searchTab] = {
            status: finished,
            elapsed,
            pit: this.searchPit,
            stopped,
          };
          this.restoredElapsed = elapsed;
          this.render();
        }
      } catch (error) {
        window.clearInterval(this.pollTimer);
        this.running = false;
        this.paused = false;
        this.stopping = false;
        this.lastStatus = null;
        this.render();
        // 轮询超时说明引擎已无响应：解除锁定并明确告知，避免界面永久停在“停止中”。
        if (error instanceof Error && error.message === 'engine-timeout') {
          await ask(messageOf(error), [{ id: 'dismiss', key: 'common.dialog.close' }]);
        }
      }
    }, 100);
  }

  /** 与源程序一致的阶段名称：普通溶洞 0/1/2，大坑 0/1/2/3。 */
  private stageLabel(phase: number): string {
    if (this.searchPit) {
      if (phase === 0) return t('dripstonecave.stage.0');
      if (phase === 2) return t('dripstonecave.pitStage.2');
      if (phase === 3 || phase === -1) return t('dripstonecave.pitStage.3');
      return t('dripstonecave.pitStage.1');
    }
    if (phase === 0) return t('dripstonecave.stage.0');
    if (phase === 2 || phase === -1) return t('dripstonecave.stage.2');
    return t('dripstonecave.stage.1');
  }

  /** 把一次状态写入页脚；render() 重建页脚后会再用 lastStatus 调用它恢复进度。 */
  private paintStatus(status: SearchStatus): void {
    const progress = this.footer.querySelector('#s-progress');
    const gpu = this.footer.querySelector<HTMLElement>('#s-gpu');
    const eta = this.footer.querySelector('#s-eta');
    const elapsed = this.footer.querySelector('#s-elapsed');
    const bar = this.footer.querySelector<HTMLElement>('#s-bar');
    if (progress) progress.textContent = this.progressText(status);
    if (gpu) {
      // Only the phase-1 coarse scan can run on OpenCL. When the user asked for
      // the GPU but the engine fell back to CPU, say why instead of hiding.
      const active = status.scanBackend === 'gpu';
      const waitingCpu = this.allowGpu && status.running && !!status.gpuReason;
      const device = status.gpuDevice || gpuRendererName() || t('dripstonecave.gpuUnknown');
      const reason =
        status.gpuReason === 'no-opencl'
          ? t('dripstonecave.gpuNoOpencl')
          : status.gpuReason === 'no-device'
            ? t('dripstonecave.gpuNoDevice')
            : t('dripstonecave.gpuFallback');
      gpu.hidden = !(active || waitingCpu);
      gpu.textContent = active ? t('dripstonecave.gpuLine', { device }) : waitingCpu ? reason : '';
    }
    if (eta) eta.textContent = this.etaText(status);
    if (elapsed) {
      const ms = status.done && this.restoredElapsed != null ? this.restoredElapsed : this.timer.elapsed();
      elapsed.textContent = t('common.searchExtra.elapsed', {
        time: formatDuration(ms),
      });
    }
    if (bar) {
      // 主动停止时保留实际进度，避免被当成 100% 完成。
      const pct =
        status.done && !this.stopped
          ? 100
          : status.total > 0
            ? Math.min(100, (status.current / status.total) * 100)
            : 0;
      bar.style.width = `${pct}%`;
    }
  
    paintProgressCard(this.footer, 's', {
      state: status.error ? 'error' : status.done ? 'done' : this.running ? (this.paused ? 'paused' : 'running') : 'idle',
      stateText: this.progressStateText(status),
    });
  }

  private progressText(status: SearchStatus): string {
    if (this.stopping) return t('common.search.stopping');
    const seeds =
      status.seedCount > 1
        ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
        : '';
    if (this.stopped && !status.error) return `${seeds}${t('common.search.stopped')}`;
    if (status.done && !status.error) return `${seeds}${t('common.search.completed')}`;
    const phase = this.stageLabel(status.phase);
    const complete = status.done && (status.total <= 0 || status.current >= status.total);
    const pct = complete
      ? 100
      : status.total > 0
        ? Math.min(100, Math.round((status.current / status.total) * 100))
        : 0;
    return `${seeds}${phase} ${status.current}/${status.total} (${pct}%)${status.error ? ` ${t(`common.error.${status.error}`) || status.error}` : ''}`;
  }

  private etaText(status: SearchStatus): string {
    if (this.stopping) return t('common.search.stoppingEta');
    if (status.done || status.phase < 0) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = this.timer.phaseElapsed();
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }

  /** 进度卡左上角状态词，与 paintProgressCard 配套。 */
  private progressStateText(status: SearchStatus): string {
    if (status.error) return messageOf(status.error);
    if (status.done) return t('common.search.completed');
    if (this.running && this.paused) return t('common.search.paused');
    if (this.running) return t('common.search.working');
    return t('common.search.start');
  }}


function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function messageOf(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const key = `common.error.${code}`;
  const text = t(key);
  return text === key ? code : text;
}
