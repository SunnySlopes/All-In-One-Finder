import { ask, showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type WitchStatus } from './native';
import { escapeAttr, formatDuration, messageOf } from './panel-utils';
import type { ResultsColumn } from './results';

export type WitchVersionGroup = 0 | 1 | 2;

type SeedMode = 'single' | 'list';

/** 单种子与种子列表的默认范围统一为 131072 边长的正方形区域。 */
const DEFAULT_SINGLE_SIDE = 131072;
const DEFAULT_LIST_SIDE = 131072;
const WORLD_SIDE = 60000001;
const MAX_SIDE = 60000001;
const WORLD_COORD = 30000000;

const MAX_Y_OPTIONS = [0, -10, -20, -30, -40, -50, -54];

const VERSION_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: '1.18.x' },
  { value: '1', label: '1.19.x~26.1' },
  { value: '2', label: '26.2+' },
];

/** 点击结果时地图应切换到的版本名；与搜索器的三个版本档一致。 */
export function witchMapVersion(group: WitchVersionGroup): string {
  if (group === 0) return '1.18';
  if (group === 1) return '26.1';
  return '26.3';
}

function groupOf(value: string): WitchVersionGroup {
  if (value === '0') return 0;
  if (value === '1') return 1;
  return 2;
}

export class WitchPanel {
  readonly root: HTMLElement;
  private footer!: HTMLElement;
  private sortRow!: HTMLElement;
  private sortByY!: HTMLButtonElement;
  private sortByDistance!: HTMLButtonElement;
  private version!: HTMLSelectElement;
  private maxYSelect!: HTMLSelectElement;
  private threads!: HTMLInputElement;
  private minX!: HTMLInputElement;
  private maxX!: HTMLInputElement;
  private minZ!: HTMLInputElement;
  private maxZ!: HTMLInputElement;
  private square!: HTMLInputElement;
  private side!: HTMLInputElement;
  private seedModeSelect!: HTMLSelectElement;
  private seedMode: SeedMode = 'single';
  private versionGroup: WitchVersionGroup = 2;
  private searchVersion: WitchVersionGroup = 2;
  private versions: McVersion[] = [];
  private results: ResultsColumn | null = null;
  private seed = '';
  private seedText = '';
  private running = false;
  private paused = false;
  private hasResults = false;
  private pollTimer = 0;
  private searchStartedAt = 0;
  private shownError = '';
  /** 最近一次轮询结果；render() 重建页脚后据此恢复进度，避免完成瞬间被清空。 */
  private lastStatus: WitchStatus | null = null;
  /** 开始搜索时快照的地图预设（大型生物群系跟随地图勾选）。 */
  getLargeBiomes: () => boolean = () => false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="w-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="w-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="w-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="w-version">
            ${VERSION_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')}
          </select>
          <label data-i18n="common.search.threads"></label><input id="w-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="w-minx" type="number" value="-65536" />
          <label data-i18n="common.search.maxX"></label><input id="w-maxx" type="number" value="65535" />
          <label data-i18n="common.search.minZ"></label><input id="w-minz" type="number" value="-65536" />
          <label data-i18n="common.search.maxZ"></label><input id="w-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="w-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="w-side" type="number" value="${DEFAULT_SINGLE_SIDE}" />
        </div>
        <div class="row">
          <button id="w-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="w-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="grid">
          <label data-i18n="lowyswamphut.maxY"></label>
          <select id="w-maxy">
            ${MAX_Y_OPTIONS.map((value) => `<option value="${value}" ${value === -40 ? 'selected' : ''}>${value}</option>`).join('')}
          </select>
        </div>
        <div class="row" id="w-sort-row" hidden>
          <button id="w-sort-distance" type="button" data-i18n="lowyswamphut.sortByDistance" disabled></button>
          <button id="w-sort-y" type="button" data-i18n="lowyswamphut.sortByY" disabled></button>
        </div>
        <div class="hint" data-i18n="lowyswamphut.help"></div>
      </div>
      <div class="search-panel-footer" id="w-footer"></div>
    `;
    this.footer = this.root.querySelector('#w-footer')!;
    this.sortRow = this.root.querySelector('#w-sort-row')!;
    this.sortByY = this.root.querySelector('#w-sort-y')!;
    this.sortByDistance = this.root.querySelector('#w-sort-distance')!;
    this.version = this.root.querySelector('#w-version')!;
    this.maxYSelect = this.root.querySelector('#w-maxy')!;
    this.threads = this.root.querySelector('#w-threads')!;
    this.minX = this.root.querySelector('#w-minx')!;
    this.maxX = this.root.querySelector('#w-maxx')!;
    this.minZ = this.root.querySelector('#w-minz')!;
    this.maxZ = this.root.querySelector('#w-maxz')!;
    this.square = this.root.querySelector('#w-square')!;
    this.side = this.root.querySelector('#w-side')!;
    this.seedModeSelect = this.root.querySelector('#w-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.root.querySelector('#w-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#w-border')!.addEventListener('click', () => this.resetWorldBorder());
    this.version.addEventListener('change', () => {
      this.versionGroup = groupOf(this.version.value);
    });
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.resetDefaultArea();
    });
    this.sortByY.addEventListener('click', () => this.results?.sortWitch('height'));
    this.sortByDistance.addEventListener('click', () => this.results?.sortWitch('distance'));
    this.applySquare();
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
    const input = this.root.querySelector<HTMLInputElement>('#w-seed');
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

  private renderSeedBlock(): void {
    const host = this.root.querySelector('#w-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="w-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="w-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="w-file-name"></div>`;
      const fileName = host.querySelector('#w-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#w-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.version.value = String(this.versionGroup);
    this.renderSeedBlock();
    // `.row` 的 author 样式会压过 [hidden] 的 UA 规则，用内联 display 切换。
    this.sortRow.style.display = '';
    this.updateSortButtons();
    this.footer.innerHTML = `
      <div class="row">
        <button id="w-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="w-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="w-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="w-bar"></div></div>
      <div id="w-progress" class="hint"></div>
      <div id="w-elapsed" class="hint"></div>
      <div id="w-eta" class="hint"></div>
    `;
    this.footer.querySelector('#w-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#w-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#w-stop')?.addEventListener('click', () => void call('witchSearchStop'));
    applyI18n(this.root);
    if (this.lastStatus) this.paintStatus(this.lastStatus);
  }

  private updateSortButtons(): void {
    const enabled = this.hasResults && !this.running;
    this.sortByY.disabled = !enabled;
    this.sortByDistance.disabled = !enabled;
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#w-seed');
    if (seed) this.seed = seed.value.trim();
    this.versionGroup = groupOf(this.version.value);
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#w-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    const listMode = this.seedMode === 'list';

    let maxY = Number(this.maxYSelect.value);
    if (!MAX_Y_OPTIONS.includes(maxY)) maxY = -40;
    if (!listMode && (maxY === -50 || maxY === -54)) {
      const choice = await ask(t('lowyswamphut.lowYWarning'), [
        { id: 'yes', key: 'common.dialog.yes' },
        { id: 'no', key: 'common.dialog.no' },
        { id: 'dismiss', key: 'common.dialog.close' },
      ]);
      if (choice === 'yes') {
        maxY = -40;
        this.maxYSelect.value = '-40';
      } else if (choice !== 'no') {
        return;
      }
    }

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

    const seeds = listMode ? this.seedText : this.seed;
    if (!seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return;
    }

    const threads = Math.max(1, Math.min(256, Number(this.threads.value) || 1));
    const largeBiomes = !!this.getLargeBiomes();
    this.searchVersion = this.versionGroup;

    try {
      await call('witchSearchStart', {
        versionGroup: this.searchVersion,
        largeBiomes,
        singleBiome: false,
        threads,
        maxY,
        minX,
        maxX,
        minZ,
        maxZ,
        seeds,
      });
      this.results?.clearWitch(this.searchVersion, listMode);
      this.running = true;
      this.paused = false;
      this.hasResults = false;
      this.shownError = '';
      this.lastStatus = null;
      this.searchStartedAt = Date.now();
      this.render();
      this.poll();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('witchSearchResume');
      this.paused = false;
    } else {
      await call('witchSearchPause');
      this.paused = true;
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<WitchStatus>('witchSearchPoll');
        this.lastStatus = status;
        this.running = status.running;
        this.paused = status.paused;
        this.hasResults = status.hits.length > 0;
        this.paintStatus(status);
        this.results?.setWitchHits(status.hits, this.searchVersion);
        if (status.done) {
          window.clearInterval(this.pollTimer);
          this.running = false;
          this.updateSortButtons();
          if (status.error && status.error !== this.shownError) {
            this.shownError = status.error;
            await showNotice(messageOf(status.error));
          }
          this.render();
        } else {
          this.updateSortButtons();
        }
      } catch {
        window.clearInterval(this.pollTimer);
        this.running = false;
        this.updateSortButtons();
      }
    }, 100);
  }

  /** 把一次状态写入页脚；render() 重建页脚后会再用 lastStatus 调用它恢复进度。 */
  private paintStatus(status: WitchStatus): void {
    const progress = this.footer.querySelector('#w-progress');
    const eta = this.footer.querySelector('#w-eta');
    const elapsed = this.footer.querySelector('#w-elapsed');
    const bar = this.footer.querySelector<HTMLElement>('#w-bar');
    if (progress) progress.textContent = this.progressText(status);
    if (eta) eta.textContent = this.etaText(status);
    if (elapsed) {
      elapsed.textContent = t('common.searchExtra.elapsed', {
        time: formatDuration(Date.now() - this.searchStartedAt),
      });
    }
    if (bar) {
      const complete = status.done && (status.total <= 0 || status.current >= status.total);
      const pct = complete
        ? 100
        : status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
    }
  }

  private progressText(status: WitchStatus): string {
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    const complete = status.done && (status.total <= 0 || status.current >= status.total);
    const pct = complete
      ? 100
      : status.total > 0 ? Math.min(100, Math.round(status.current / status.total * 100)) : 0;
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${t('lowyswamphut.progress')} ${status.current}/${status.total} (${pct}%)${error}`;
  }

  private etaText(status: WitchStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = Date.now() - this.searchStartedAt;
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
