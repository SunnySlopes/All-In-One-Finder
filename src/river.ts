import { ask, showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type RiverStatus } from './native';
import { escapeAttr, formatDuration, messageOf, applyRunLock, RunTimer, applyForm, captureForm } from './panel-utils';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

export const RIVER_MAP_VERSION = '26.3';

type SeedMode = 'single' | 'list';

/** 24 < r <= 128 的完整环面积：π × (128² − 24²) ≈ 49662，与上游一致。 */
const FULL_RING = 49662;
const MIN_RATIO = 50;
const MAX_RATIO = 95;
const DEFAULT_RATIO = 70;
const MIN_AREA = 24831;
const MAX_AREA = 47178;
const DEFAULT_AREA = 34763;

/** 默认搜索范围照抄上游：单种子 131072，种子列表 8192。 */
const DEFAULT_SINGLE_SIDE = 131072;
const DEFAULT_LIST_SIDE = 8192;
const WORLD_SIDE = 60000001;
const MAX_SIDE = 60000001;
const WORLD_COORD = 30000000;
/** 河流范围大于这个等效面积时，提示改去溶洞页搜索。 */
const CAVE_HINT_AREA = 2000001 * 2000001;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveRiverMc(versions: McVersion[]): number | null {
  const modern = versions.find((item) => item.name === '26.3');
  if (modern) return modern.id;
  const fallback = versions.find((item) => item.name === '26.2')
    || versions[versions.length - 1];
  return fallback ? fallback.id : null;
}

export class RiverPanel {
  readonly root: HTMLElement;
  private footer!: HTMLElement;
  private threads!: HTMLInputElement;
  private minRatio!: HTMLInputElement;
  private minArea!: HTMLInputElement;
  private sampleY!: HTMLInputElement;
  private calcCave!: HTMLInputElement;
  private minX!: HTMLInputElement;
  private maxX!: HTMLInputElement;
  private minZ!: HTMLInputElement;
  private maxZ!: HTMLInputElement;
  private square!: HTMLInputElement;
  private side!: HTMLInputElement;
  private seedModeSelect!: HTMLSelectElement;
  private seedMode: SeedMode = 'single';
  private versions: McVersion[] = [];
  private results: ResultsColumn | null = null;
  private seed = '';
  private seedText = '';
  private running = false;
  private paused = false;
  private pollTimer = 0;
  private readonly timer = new RunTimer();
  private lastStage = Number.NaN;
  private lastStatus: RiverStatus | null = null;
  private shownError = '';
  onNavigate: (id: SearcherId) => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="rv-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="rv-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="rv-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="rv-version" disabled><option>1.18~26.3+</option></select>
          <label data-i18n="common.search.threads"></label><input id="rv-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="rv-minx" type="number" value="-65536" />
          <label data-i18n="common.search.maxX"></label><input id="rv-maxx" type="number" value="65535" />
          <label data-i18n="common.search.minZ"></label><input id="rv-minz" type="number" value="-65536" />
          <label data-i18n="common.search.maxZ"></label><input id="rv-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="rv-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="rv-side" type="number" value="${DEFAULT_SINGLE_SIDE}" />
        </div>
        <div class="row">
          <button id="rv-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="rv-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="grid">
          <label data-i18n="river.minRatio"></label>
          <input id="rv-ratio" type="number" min="${MIN_RATIO}" max="${MAX_RATIO}" step="1" value="${DEFAULT_RATIO}" />
          <label data-i18n="river.minArea"></label>
          <input id="rv-area" type="number" min="${MIN_AREA}" max="${MAX_AREA}" step="1" value="${DEFAULT_AREA}" />
          <label data-i18n="river.sampleY"></label><input id="rv-y" type="number" value="-64" />
        </div>
        <label class="feature">
          <input id="rv-cave" type="checkbox" checked />
          <span data-i18n="river.calcCave"></span>
        </label>
        <div class="hint" data-i18n="river.help"></div>
        <div class="hint" data-i18n="river.filtered"></div>
      </div>
      <div class="search-panel-footer" id="rv-footer"></div>
    `;
    this.footer = this.root.querySelector('#rv-footer')!;
    this.threads = this.root.querySelector('#rv-threads')!;
    this.minRatio = this.root.querySelector('#rv-ratio')!;
    this.minArea = this.root.querySelector('#rv-area')!;
    this.sampleY = this.root.querySelector('#rv-y')!;
    this.calcCave = this.root.querySelector('#rv-cave')!;
    this.minX = this.root.querySelector('#rv-minx')!;
    this.maxX = this.root.querySelector('#rv-maxx')!;
    this.minZ = this.root.querySelector('#rv-minz')!;
    this.maxZ = this.root.querySelector('#rv-maxz')!;
    this.square = this.root.querySelector('#rv-square')!;
    this.side = this.root.querySelector('#rv-side')!;
    this.seedModeSelect = this.root.querySelector('#rv-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.minRatio.addEventListener('input', () => this.syncAreaFromRatio());
    this.minArea.addEventListener('input', () => this.syncRatioFromArea());
    this.root.querySelector('#rv-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#rv-border')!.addEventListener('click', () => this.resetWorldBorder());
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.resetDefaultArea();
    });
    this.applySquare();
    this.render();
  }

  bindResults(results: ResultsColumn): void {
    this.results = results;
  }

  exportState(): Record<string, unknown> {
    return {
      form: captureForm(this.root),
      seedMode: this.seedMode,
      seed: this.seed,
      seedText: this.seedText,
    };
  }

  importState(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    if (s.seedMode === 'single' || s.seedMode === 'list') this.seedMode = s.seedMode;
    if (typeof s.seed === 'string') this.seed = s.seed;
    if (typeof s.seedText === 'string') this.seedText = s.seedText;
    applyForm(this.root, s);
    this.render();
    applyForm(this.root, s);
  }

  setSeedFromMap(seed: string): void {
    // 只有“单种子”来源的 tab 才跟随地图/其他单种子页面的种子。
    if (this.seedMode !== 'single') return;
    if (!seed.trim()) return;
    this.seed = seed.trim();
    const input = this.root.querySelector<HTMLInputElement>('#rv-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private defaultSide(): number {
    return this.seedMode === 'list' ? DEFAULT_LIST_SIDE : DEFAULT_SINGLE_SIDE;
  }

  private resetDefaultArea(): void {
    this.square.checked = true;
    this.side.value = String(this.defaultSide());
    this.minRatio.value = String(DEFAULT_RATIO);
    this.minArea.value = String(DEFAULT_AREA);
    this.applySquare();
    this.render();
  }

  private resetWorldBorder(): void {
    this.square.checked = true;
    this.side.value = String(WORLD_SIDE);
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

  /**
   * 最低面积与最低占比联动：只在输入已经落在有效区间时才更新另一个框，
   * 不在一位数输入时立刻改写/夹取（否则输入 “7” 会立刻变成 50）。
   */
  private syncAreaFromRatio(): void {
    const ratio = Number(this.minRatio.value);
    if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) return;
    const area = Math.round(ratio / 100 * FULL_RING);
    if (area < MIN_AREA || area > MAX_AREA) return;
    this.minArea.value = String(area);
  }

  private syncRatioFromArea(): void {
    const area = Number(this.minArea.value);
    if (!Number.isFinite(area) || area < MIN_AREA || area > MAX_AREA) return;
    const ratio = Math.round(area / FULL_RING * 100);
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) return;
    this.minRatio.value = String(ratio);
  }

  private renderSeedBlock(): void {
    const host = this.root.querySelector('#rv-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="rv-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="rv-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="rv-file-name"></div>`;
      const fileName = host.querySelector('#rv-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#rv-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.renderSeedBlock();
    this.footer.innerHTML = `
      <div class="row">
        <button id="rv-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="rv-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="rv-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="rv-bar"></div></div>
      <div id="rv-progress" class="hint"></div>
      <div id="rv-elapsed" class="hint"></div>
      <div id="rv-eta" class="hint"></div>
    `;
    this.footer.querySelector('#rv-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#rv-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#rv-stop')?.addEventListener('click', () => void call('riverSearchStop'));
    applyI18n(this.root);
    applyRunLock(this.root, this.running, this.paused);
    if (this.lastStatus) this.paintStatus(this.lastStatus);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#rv-seed');
    if (seed) this.seed = seed.value.trim();
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#rv-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    const listMode = this.seedMode === 'list';

    if (this.square.checked) {
      const side = Math.floor(Number(this.side.value) || 0);
      if (side < 1 || side > MAX_SIDE) {
        await showNotice(t('common.error.bad-bounds'));
        return;
      }
      this.applySquare();
    }

    const minX = Number(this.minX.value);
    const maxX = Number(this.maxX.value);
    const minZ = Number(this.minZ.value);
    const maxZ = Number(this.maxZ.value);
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || maxX < minX || maxZ < minZ
      || minX < -WORLD_COORD || maxX > WORLD_COORD
      || minZ < -WORLD_COORD || maxZ > WORLD_COORD) {
      await showNotice(t('common.error.bad-bounds'));
      return;
    }

    // 范围过大时先问要不要改去溶洞页；选“是”直接切 Tab，不启动本次搜索。
    const area = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (area > CAVE_HINT_AREA) {
      const choice = await ask(t('river.toCave'), [
        { id: 'yes', key: 'river.goCave' },
        { id: 'no', key: 'river.stayRiver' },
        { id: 'dismiss', key: 'common.dialog.close' },
      ]);
      if (choice === 'yes') {
        this.onNavigate('LowYDripstoneCave');
        return;
      }
      if (choice !== 'no') return;
    }

    const y = Math.round(Number(this.sampleY.value));
    if (!Number.isFinite(y) || y < -64 || y > 320) {
      await showNotice(t('common.error.bad-bounds'));
      return;
    }

    const seeds = listMode ? this.seedText : this.seed;
    if (!seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return;
    }

    const mc = resolveRiverMc(this.versions);
    if (mc == null) {
      await showNotice(t('common.error.unsupported-version'));
      return;
    }

    const minScore = clamp(Math.round(Number(this.minRatio.value) / 100 * FULL_RING), MIN_AREA, MAX_AREA);
    const ratio = Number(this.minRatio.value);
    if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) {
      await showNotice(t('common.error.bad-ratio'));
      return;
    }
    this.minRatio.value = String(Math.round(ratio));
    this.minArea.value = String(minScore);
    const threads = Math.max(1, Math.min(256, Number(this.threads.value) || 1));

    try {
      await call('riverSearchStart', {
        mc,
        threads,
        minScore,
        y,
        calcCave: this.calcCave.checked,
        minX,
        maxX,
        minZ,
        maxZ,
        seeds,
      });
      this.results?.clearRiver(listMode);
      this.running = true;
      this.paused = false;
      this.shownError = '';
      this.lastStatus = null;
      this.timer.start();
      this.lastStage = Number.NaN;
      this.render();
      this.poll();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('riverSearchResume');
      this.paused = false;
      this.timer.resume();
    } else {
      await call('riverSearchPause');
      this.paused = true;
      this.timer.pause();
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<RiverStatus>('riverSearchPoll');
        this.lastStatus = status;
        this.running = status.running;
        this.paused = status.paused;
        if (status.stage !== this.lastStage) {
          this.lastStage = status.stage;
          this.timer.markPhase();
        }
        this.paintStatus(status);
        this.results?.setRiverHits(status.hits);
        if (status.done) {
          window.clearInterval(this.pollTimer);
          this.running = false;
          this.paused = false;
          if (status.error && status.error !== this.shownError) {
            this.shownError = status.error;
            await showNotice(messageOf(status.error));
          }
          this.render();
        }
      } catch {
        window.clearInterval(this.pollTimer);
        this.running = false;
      }
    }, 100);
  }

  /** 状态写入页脚；render() 重建页脚后再用它恢复进度（含完成时的 100%）。 */
  private paintStatus(status: RiverStatus): void {
    const progress = this.footer.querySelector('#rv-progress');
    const eta = this.footer.querySelector('#rv-eta');
    const elapsed = this.footer.querySelector('#rv-elapsed');
    const bar = this.footer.querySelector<HTMLElement>('#rv-bar');
    if (progress) progress.textContent = this.progressText(status);
    if (eta) eta.textContent = this.etaText(status);
    if (elapsed) {
      elapsed.textContent = t('common.searchExtra.elapsed', {
        time: formatDuration(this.timer.elapsed()),
      });
    }
    if (bar) {
      const pct = status.done
        ? 100
        : status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
    }
  }

  private progressText(status: RiverStatus): string {
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    if (status.done && !status.error) return `${seeds}${t('common.search.completed')}`;
    const stage = status.stage === 1 ? t('river.stage.scan')
      : status.stage === 2 ? t('river.stage.refine')
        : t('common.search.working');
    const pct = status.total > 0 ? Math.min(100, Math.round(status.current / status.total * 100)) : 0;
    const pausing = status.paused ? ` ${t('river.pausing')}` : '';
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${stage} ${status.current}/${status.total} (${pct}%)${pausing}${error}`;
  }

  private etaText(status: RiverStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = this.timer.phaseElapsed();
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
