import { showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type FlowerStatus, type McVersion } from './native';
import { escapeAttr, formatDuration, messageOf } from './panel-utils';
import type { ResultsColumn } from './results';

export type FlowerVersionTier = 'legacy' | 'latest';

type SeedMode = 'single' | 'list';

/** 原 GUI 的默认值（FlowerFarmFinderSearchRunner）：都是“边长”。 */
const SINGLE_SIDE_LATEST = 131072;
const SINGLE_SIDE_LEGACY = 32768;
const LIST_SIDE_LATEST = 32768;
const LIST_SIDE_LEGACY = 8192;
const WORLD_SIDE = 60000001;
const WORLD_COORD = 30000000;
const MAX_WINDOW = 1024;
const MIN_WINDOW = 256;
/** 模距（simulation distance，区块）与原 GUI 的取值区间和默认值。 */
const MAX_SIMULATION_DISTANCE = 32;
const MIN_SIMULATION_DISTANCE = 8;
const DEFAULT_SIMULATION_DISTANCE = 10;
/** 模距换算窗口：每个区块 32 格，另加 16 格边距（原 GUI 的 32×模距+16）。 */
const BLOCKS_PER_DISTANCE = 32;
const WINDOW_MARGIN = 16;

const VERSION_OPTIONS: { value: FlowerVersionTier; label: string }[] = [
  { value: 'legacy', label: '1.18~1.21.3' },
  { value: 'latest', label: '1.21.4+' },
];

/** 旧档结果跳图：当前地图版本不高于 1.21.3 时沿用，否则固定 1.21.3。 */
export function flowerMapVersion(tier: FlowerVersionTier, current: string): string {
  if (tier === 'latest') return '26.3';
  const tuple = versionTuple(current);
  const limit = [1, 21, 3];
  if (tuple && compareTuple(tuple, limit) <= 0) return current;
  return '1.21.3';
}

function versionTuple(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareTuple(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export class FlowerPanel {
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
  private longSide!: HTMLInputElement;
  private shortSide!: HTMLInputElement;
  private windowSquare!: HTMLInputElement;
  private fastMode!: HTMLInputElement;
  private viewDistance!: HTMLInputElement;
  private seedMode: SeedMode = 'single';
  private tier: FlowerVersionTier = 'latest';
  private searchTier: FlowerVersionTier = 'latest';
  private versions: McVersion[] = [];
  private results: ResultsColumn | null = null;
  private seed = '';
  private seedText = '';
  private running = false;
  private paused = false;
  private pollTimer = 0;
  private searchStartedAt = 0;
  private shownError = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="f-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="f-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="f-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="f-version">
            ${VERSION_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')}
          </select>
          <label data-i18n="common.search.threads"></label><input id="f-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="f-minx" type="number" value="-65536" />
          <label data-i18n="common.search.maxX"></label><input id="f-maxx" type="number" value="65535" />
          <label data-i18n="common.search.minZ"></label><input id="f-minz" type="number" value="-65536" />
          <label data-i18n="common.search.maxZ"></label><input id="f-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="f-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="f-side" type="number" value="${SINGLE_SIDE_LATEST}" />
        </div>
        <div class="row">
          <button id="f-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="f-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="grid">
          <label data-i18n="flower.longSide"></label><input id="f-long" type="number" min="${MIN_WINDOW}" max="${MAX_WINDOW}" value="640" />
          <label data-i18n="flower.shortSide"></label><input id="f-short" type="number" min="${MIN_WINDOW}" max="${MAX_WINDOW}" value="320" />
          <label class="feature"><input id="f-window-square" type="checkbox" /><span data-i18n="flower.windowSquare"></span></label>
          <label class="feature"><input id="f-fast" type="checkbox" checked /><span data-i18n="flower.fastMode"></span></label>
        </div>
        <div class="grid">
          <label data-i18n="flower.simulationDistance"></label>
          <input id="f-view-distance" type="number" step="1" min="${MIN_SIMULATION_DISTANCE}" max="${MAX_SIMULATION_DISTANCE}" value="${DEFAULT_SIMULATION_DISTANCE}" />
        </div>
        <div class="hint" data-i18n="flower.help"></div>
      </div>
      <div class="search-panel-footer" id="f-footer"></div>
    `;
    this.footer = this.root.querySelector('#f-footer')!;
    this.version = this.root.querySelector('#f-version')!;
    this.threads = this.root.querySelector('#f-threads')!;
    this.minX = this.root.querySelector('#f-minx')!;
    this.maxX = this.root.querySelector('#f-maxx')!;
    this.minZ = this.root.querySelector('#f-minz')!;
    this.maxZ = this.root.querySelector('#f-maxz')!;
    this.square = this.root.querySelector('#f-square')!;
    this.side = this.root.querySelector('#f-side')!;
    this.seedModeSelect = this.root.querySelector('#f-seed-mode')!;
    this.longSide = this.root.querySelector('#f-long')!;
    this.shortSide = this.root.querySelector('#f-short')!;
    this.windowSquare = this.root.querySelector('#f-window-square')!;
    this.fastMode = this.root.querySelector('#f-fast')!;
    this.viewDistance = this.root.querySelector('#f-view-distance')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.root.querySelector('#f-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#f-border')!.addEventListener('click', () => this.resetWorldBorder());
    this.version.addEventListener('change', () => {
      this.tier = this.version.value as FlowerVersionTier;
      this.resetDefaultArea();
    });
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.resetDefaultArea();
    });
    this.windowSquare.addEventListener('change', () => this.applyWindowSquare());
    this.viewDistance.addEventListener('change', () => this.applyViewDistance());
    this.longSide.addEventListener('input', () => {
      if (this.windowSquare.checked) this.shortSide.value = this.longSide.value;
    });
    this.applySquare();
    this.applyWindowSquare();
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
    const input = this.root.querySelector<HTMLInputElement>('#f-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private mcFor(tier: FlowerVersionTier): number {
    const name = tier === 'latest' ? '26.3' : '1.21.3';
    const hit = this.versions.find((item) => item.name === name);
    // 应用版本表固定包含这两个版本；fallback 仅在版本尚未加载时生效。
    return hit?.id ?? (tier === 'latest' ? 35 : 27);
  }

  private defaultSide(): number {
    if (this.seedMode === 'list') {
      return this.tier === 'latest' ? LIST_SIDE_LATEST : LIST_SIDE_LEGACY;
    }
    return this.tier === 'latest' ? SINGLE_SIDE_LATEST : SINGLE_SIDE_LEGACY;
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

  private applyWindowSquare(): void {
    const locked = this.windowSquare.checked;
    this.shortSide.disabled = locked;
    if (locked) this.shortSide.value = this.longSide.value;
  }

  /** 与原 GUI 的“模距”一致：换算成正方形窗口，长边 = 32×模距+16，32 时封顶 1024。 */
  private applyViewDistance(): void {
    const view = Number(this.viewDistance.value);
    if (!Number.isInteger(view) || view < MIN_SIMULATION_DISTANCE || view > MAX_SIMULATION_DISTANCE) {
      this.viewDistance.value = String(DEFAULT_SIMULATION_DISTANCE);
      showNotice(t('flower.badSimulationDistance'));
      return;
    }
    this.longSide.value = String(Math.min(MAX_WINDOW, view * BLOCKS_PER_DISTANCE + WINDOW_MARGIN));
    this.windowSquare.checked = true;
    this.applyWindowSquare();
  }

  private renderSeedBlock(): void {
    const host = this.root.querySelector('#f-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="f-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="f-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="f-file-name"></div>`;
      const fileName = host.querySelector('#f-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#f-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.version.value = this.tier;
    this.renderSeedBlock();
    this.applyWindowSquare();
    this.viewDistance.title = t('flower.simulationDistanceHint');
    this.footer.innerHTML = `
      <div class="row">
        <button id="f-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="f-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="f-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="f-bar"></div></div>
      <div id="f-progress" class="hint"></div>
      <div id="f-overall" class="hint"></div>
      <div id="f-elapsed" class="hint"></div>
      <div id="f-eta" class="hint"></div>
    `;
    this.footer.querySelector('#f-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#f-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#f-stop')?.addEventListener('click', () => void call('flowerFarmStop'));
    applyI18n(this.root);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#f-seed');
    if (seed) this.seed = seed.value.trim();
    this.tier = this.version.value as FlowerVersionTier;
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#f-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    const listMode = this.seedMode === 'list';

    if (this.square.checked) {
      const side = Math.floor(Number(this.side.value) || 0);
      if (side < 1 || side > WORLD_SIDE) {
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

    const longSide = Math.floor(Number(this.longSide.value) || 0);
    const shortSide = this.windowSquare.checked ? longSide : Math.floor(Number(this.shortSide.value) || 0);
    if (longSide < MIN_WINDOW || longSide > MAX_WINDOW
      || shortSide < MIN_WINDOW || shortSide > MAX_WINDOW || shortSide > longSide) {
      await showNotice(t('common.error.bad-bounds'));
      return;
    }

    const seeds = listMode ? this.seedText : this.seed;
    if (!seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return;
    }

    const threads = Math.max(1, Math.min(256, Number(this.threads.value) || 1));
    this.searchTier = this.tier;
    try {
      await call('flowerFarmStart', {
        mc: this.mcFor(this.searchTier),
        threads,
        minX,
        maxX,
        minZ,
        maxZ,
        longSide,
        shortSide,
        squareOnly: this.windowSquare.checked,
        fastMode: this.fastMode.checked,
        seeds,
      });
      this.results?.clearFlower(this.searchTier, listMode);
      this.running = true;
      this.paused = false;
      this.shownError = '';
      this.searchStartedAt = Date.now();
      this.render();
      this.poll();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('flowerFarmResume');
      this.paused = false;
    } else {
      await call('flowerFarmPause');
      this.paused = true;
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<FlowerStatus>('flowerFarmPoll');
        this.running = status.running;
        this.paused = status.paused;
        const progress = this.footer.querySelector('#f-progress');
        const overall = this.footer.querySelector('#f-overall');
        const eta = this.footer.querySelector('#f-eta');
        const elapsed = this.footer.querySelector('#f-elapsed');
        const bar = this.footer.querySelector<HTMLElement>('#f-bar');
        if (progress) progress.textContent = this.progressText(status);
        if (overall) overall.textContent = this.overallText(status);
        if (eta) eta.textContent = this.etaText(status);
        if (elapsed) {
          elapsed.textContent = t('common.searchExtra.elapsed', {
            time: formatDuration(Date.now() - this.searchStartedAt),
          });
        }
        if (bar) {
          const current = status.overallTotal > 0 ? status.overallCurrent : status.current;
          const total = status.overallTotal > 0 ? status.overallTotal : status.total;
          const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
          bar.style.width = `${pct}%`;
        }
        this.results?.setFlowerHits(status.hits, this.searchTier);
        if (status.done) {
          window.clearInterval(this.pollTimer);
          this.running = false;
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

  private phaseLabel(phase: number): string {
    const key = `flower.phase.${phase}`;
    const text = t(key);
    return text === key ? String(phase) : text;
  }

  private progressText(status: FlowerStatus): string {
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    const total = status.phaseTotal > 0 ? status.phaseTotal : status.total;
    const current = status.phaseTotal > 0 ? status.phaseCurrent : status.current;
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${this.phaseLabel(status.phase)} ${current}/${total} (${pct}%)${error}`;
  }

  private overallText(status: FlowerStatus): string {
    if (!(status.overallTotal > 0)) return '';
    return t('flower.overallProgress', {
      current: String(status.overallCurrent),
      total: String(status.overallTotal),
    });
  }

  private etaText(status: FlowerStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    const current = status.overallTotal > 0 ? status.overallCurrent : status.current;
    const total = status.overallTotal > 0 ? status.overallTotal : status.total;
    if (!(current > 0 && total > current)) return t('common.search.eta.calculating');
    const elapsed = Date.now() - this.searchStartedAt;
    const remaining = elapsed * ((total - current) / current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
