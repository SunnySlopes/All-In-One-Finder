import { ask, showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type MonumentStatus } from './native';
import { escapeAttr, formatDuration, messageOf, applyRunLock } from './panel-utils';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

export type MonumentVariant = 'double' | 'multi';

type SeedMode = 'single' | 'list';

const DEFAULT_SIDE = 131072;
const DEFAULT_LIST_SIDE = 8192;
const WORLD_SIDE = 60000001;
const WORLD_COORD = 30000000;
const DOUBLE_SINGLE_SIDE = 262144;
const DOUBLE_LIST_SIDE = 131072;
const DEFAULT_GATE_SIDE = 2000001;
const DEFAULT_GATE_AREA = DEFAULT_GATE_SIDE * DEFAULT_GATE_SIDE;
const DEFAULT_MIN_GROUP_AREA = 8000;
const DEFAULT_MIN_GROUP_AREA_DUAL = 10000;
const DEFAULT_MIN_GROUP_AREA_GATE = 10000;
const MIN_GROUP_AREA = 6728;
const MAX_GROUP_AREA = 13455;

function defaultAreaForMode(mode: number): number {
  if (mode === 1) return DEFAULT_MIN_GROUP_AREA_DUAL;
  if (mode === 2) return DEFAULT_MIN_GROUP_AREA_GATE;
  return DEFAULT_MIN_GROUP_AREA;
}

function areaLabelKey(mode: number): string {
  if (mode === 1) return 'monument.areaLabelDual';
  if (mode === 2) return 'monument.areaLabelGate';
  return 'monument.areaLabelSingle';
}

function resolveMonumentMc(versions: McVersion[]): number | null {
  const modern = versions.find((item) => item.name === '26.3');
  if (modern) return modern.id;
  const fallback = versions.find((item) => item.name === '26.2')
    || versions[versions.length - 1];
  return fallback ? fallback.id : null;
}

export class MonumentPanel {
  readonly root: HTMLElement;
  readonly tab: SearcherId;
  private readonly variant: MonumentVariant;
  private footer!: HTMLElement;
  private threads!: HTMLInputElement;
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
  private searchStartedAt = 0;
  private shownError = '';
  /** 最近一次轮询结果；render() 重建页脚后用它恢复进度（含瞬间结束时补 100%）。 */
  private lastStatus: MonumentStatus | null = null;
  /** 多联面积口径：0 单假人 / 1 双假人 / 2 单门。 */
  private mode: 0 | 1 | 2 = 0;
  private level = 3;
  private areaValue = DEFAULT_MIN_GROUP_AREA;
  private biomeCheck = true;

  constructor(variant: MonumentVariant) {
    this.variant = variant;
    this.tab = variant === 'double' ? 'DoubleMonument' : 'MultiMonument';
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="m-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="m-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="m-version" disabled><option>1.18~26.3</option></select>
          <label data-i18n="common.search.threads"></label><input id="m-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="m-minx" type="number" value="-65536" />
          <label data-i18n="common.search.maxX"></label><input id="m-maxx" type="number" value="65535" />
          <label data-i18n="common.search.minZ"></label><input id="m-minz" type="number" value="-65536" />
          <label data-i18n="common.search.maxZ"></label><input id="m-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="m-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="m-side" type="number" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="m-reset" type="button" data-i18n="monument.resetDefault"></button>
          <button id="m-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div id="m-params"></div>
      </div>
      <div class="search-panel-footer" id="m-footer"></div>
    `;
    this.footer = this.root.querySelector('#m-footer')!;
    this.threads = this.root.querySelector('#m-threads')!;
    this.minX = this.root.querySelector('#m-minx')!;
    this.maxX = this.root.querySelector('#m-maxx')!;
    this.minZ = this.root.querySelector('#m-minz')!;
    this.maxZ = this.root.querySelector('#m-maxz')!;
    this.square = this.root.querySelector('#m-square')!;
    this.side = this.root.querySelector('#m-side')!;
    this.seedModeSelect = this.root.querySelector('#m-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.side.value = String(this.defaultSide());
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.root.querySelector('#m-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#m-border')!.addEventListener('click', () => this.resetWorldBorder());
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

  setSeedFromMap(seed: string): void {
    // 只有“单种子”来源的 tab 才跟随地图/其他单种子页面的种子。
    if (this.seedMode !== 'single') return;
    if (!seed.trim()) return;
    this.seed = seed.trim();
    const input = this.root.querySelector<HTMLInputElement>('#m-seed');
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
    // 多联默认按世界边界搜索；二联保持 131072（种子列表 8192）。
    if (this.variant === 'multi') return WORLD_SIDE;
    return this.seedMode === 'list' ? DEFAULT_LIST_SIDE : DEFAULT_SIDE;
  }

  private resetDefaultArea(): void {
    this.square.checked = true;
    this.side.value = String(this.defaultSide());
    this.applySquare();
    this.render();
  }

  private resetWorldBorder(): void {
    if (this.variant === 'double') return;
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
    const host = this.root.querySelector('#m-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="m-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="m-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="m-file-name"></div>`;
      const fileName = host.querySelector('#m-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#m-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.renderSeedBlock();

    const borderButton = this.root.querySelector<HTMLButtonElement>('#m-border');
    if (borderButton) borderButton.hidden = this.variant === 'double' || this.mode === 2;

    const params = this.root.querySelector('#m-params')!;
    if (this.variant === 'double') {
      params.innerHTML = `
        <div class="hint" data-i18n="monument.double.help"></div>
        <div class="hint" data-i18n="monument.double.lowHint"></div>`;
    } else {
      params.innerHTML = `
        <div class="grid">
          <label data-i18n="monument.level"></label>
          <select id="m-level">
            <option value="3"${this.level === 3 ? ' selected' : ''}>3</option>
            <option value="4"${this.level === 4 ? ' selected' : ''}>4</option>
          </select>
          <label data-i18n="monument.mode"></label>
          <select id="m-mode">
            <option value="0"${this.mode === 0 ? ' selected' : ''} data-i18n="monument.modeSingle"></option>
            <option value="1"${this.mode === 1 ? ' selected' : ''} data-i18n="monument.modeDual"></option>
            <option value="2"${this.mode === 2 ? ' selected' : ''} data-i18n="monument.modeGate"></option>
          </select>
          <label data-i18n="${areaLabelKey(this.mode)}"></label>
          <input id="m-area" type="number" min="${MIN_GROUP_AREA}" max="${MAX_GROUP_AREA}" step="1" value="${this.areaValue}" />
        </div>
        <label class="feature">
          <input id="m-biome" type="checkbox"${this.biomeCheck ? ' checked' : ''} />
          <span data-i18n="monument.biomeCheck"></span>
        </label>
        <div class="hint" data-i18n="monument.help"></div>`;
    }

    if (this.variant === 'multi') {
      params.querySelector<HTMLSelectElement>('#m-level')?.addEventListener('change', (event) => {
        this.level = Number((event.target as HTMLSelectElement).value) === 4 ? 4 : 3;
      });
      const modeSelect = params.querySelector<HTMLSelectElement>('#m-mode');
      modeSelect?.addEventListener('change', () => {
        this.readFields();
        const value = Number(modeSelect.value);
        this.mode = value === 1 ? 1 : value === 2 ? 2 : 0;
        this.areaValue = defaultAreaForMode(this.mode);
        this.render();
      });
      params.querySelector<HTMLInputElement>('#m-area')?.addEventListener('input', (event) => {
        this.areaValue = Number((event.target as HTMLInputElement).value);
      });
      params.querySelector<HTMLInputElement>('#m-biome')?.addEventListener('change', (event) => {
        this.biomeCheck = (event.target as HTMLInputElement).checked;
      });
    }

    this.footer.innerHTML = `
      <div class="row">
        <button id="m-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="m-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="m-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="m-bar"></div></div>
      <div id="m-progress" class="hint"></div>
      <div id="m-elapsed" class="hint"></div>
      <div id="m-eta" class="hint"></div>
    `;
    this.footer.querySelector('#m-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#m-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#m-stop')?.addEventListener('click', () => void call(this.stopOp()));
    applyI18n(this.root);
    applyRunLock(this.root, this.running, this.paused);
    if (this.lastStatus) this.paintStatus(this.lastStatus);
  }

  private stopOp(): string {
    return this.variant === 'double' ? 'doubleMonumentSearchStop' : 'multiMonumentSearchStop';
  }

  private pauseOp(): string {
    return this.variant === 'double' ? 'doubleMonumentSearchPause' : 'multiMonumentSearchPause';
  }

  private resumeOp(): string {
    return this.variant === 'double' ? 'doubleMonumentSearchResume' : 'multiMonumentSearchResume';
  }

  private pollOp(): string {
    return this.variant === 'double' ? 'doubleMonumentSearchPoll' : 'multiMonumentSearchPoll';
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#m-seed');
    if (seed) this.seed = seed.value.trim();
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
    const node = this.root.querySelector('#m-file-name');
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

    let minX = Number(this.minX.value);
    let maxX = Number(this.maxX.value);
    let minZ = Number(this.minZ.value);
    let maxZ = Number(this.maxZ.value);
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || maxX < minX || maxZ < minZ
      || minX < -WORLD_COORD || maxX > WORLD_COORD
      || minZ < -WORLD_COORD || maxZ > WORLD_COORD) {
      await showNotice(t('common.error.bad-bounds'));
      return;
    }

    if (this.variant === 'double') {
      const limit = listMode ? DOUBLE_LIST_SIDE : DOUBLE_SINGLE_SIDE;
      if (maxX - minX + 1 > limit || maxZ - minZ + 1 > limit) {
        await showNotice(t('common.error.range-too-large'));
        return;
      }
    }

    const seeds = listMode ? this.seedText : this.seed;
    if (!seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return;
    }

    const mc = resolveMonumentMc(this.versions);
    if (mc == null) {
      await showNotice(t('common.error.unsupported-version'));
      return;
    }

    const threads = Math.max(1, Math.min(256, Number(this.threads.value) || 1));
    const payload: Record<string, unknown> = {
      mc,
      threads,
      minX,
      maxX,
      minZ,
      maxZ,
      seeds,
    };

    if (this.variant === 'multi') {
      const levelValue = Number(this.root.querySelector<HTMLSelectElement>('#m-level')?.value || this.level);
      this.level = levelValue === 4 ? 4 : 3;
      const modeValue = Number(this.root.querySelector<HTMLSelectElement>('#m-mode')?.value ?? this.mode);
      this.mode = modeValue === 1 ? 1 : modeValue === 2 ? 2 : 0;
      const areaInput = this.root.querySelector<HTMLInputElement>('#m-area');
      const minGroupArea = Math.round(Number(areaInput?.value || this.areaValue || DEFAULT_MIN_GROUP_AREA));
      if (!Number.isFinite(minGroupArea) || minGroupArea < MIN_GROUP_AREA || minGroupArea > MAX_GROUP_AREA) {
        await showNotice(t('common.error.bad-monument-area'));
        return;
      }
      this.areaValue = minGroupArea;
      this.biomeCheck = !!this.root.querySelector<HTMLInputElement>('#m-biome')?.checked;
      payload.level = this.level;
      payload.biomeCheck = this.biomeCheck;
      payload.minGroupArea = minGroupArea;
      payload.searchModes = 1 << this.mode;
      payload.filterMode = this.mode;

      // 单地狱门模式没有预筛：大范围时先询问是否收缩到默认搜索区域。
      if (this.mode === 2 && (maxX - minX + 1) * (maxZ - minZ + 1) > DEFAULT_GATE_AREA) {
        const choice = await ask(t('monument.modeHintGate'), [
          { id: 'yes', key: 'common.dialog.yes' },
          { id: 'cancel', key: 'common.dialog.cancel' },
          { id: 'dismiss', key: 'common.dialog.close' },
        ]);
        if (choice === 'dismiss') return;
        if (choice === 'yes') {
          this.square.checked = true;
          this.side.value = String(DEFAULT_GATE_SIDE);
          this.applySquare();
          minX = Number(this.minX.value);
          maxX = Number(this.maxX.value);
          minZ = Number(this.minZ.value);
          maxZ = Number(this.maxZ.value);
          payload.minX = minX;
          payload.maxX = maxX;
          payload.minZ = minZ;
          payload.maxZ = maxZ;
          this.render();
        }
      }
    }

    try {
      await call(this.variant === 'double' ? 'doubleMonumentSearchStart' : 'multiMonumentSearchStart', payload);
      this.results?.clearMonument(this.tab, listMode);
      this.lastStatus = null;
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
      await call(this.resumeOp());
      this.paused = false;
    } else {
      await call(this.pauseOp());
      this.paused = true;
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<MonumentStatus>(this.pollOp());
        this.running = status.running;
        this.paused = status.paused;
        this.lastStatus = status;
        this.paintStatus(status);
        this.results?.setMonumentHits(status.hits, this.tab);
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

  /** 把一次状态写入页脚；render() 重建页脚后会再用 lastStatus 调用它恢复进度。 */
  private paintStatus(status: MonumentStatus): void {
    const progress = this.footer.querySelector('#m-progress');
    const eta = this.footer.querySelector('#m-eta');
    const elapsed = this.footer.querySelector('#m-elapsed');
    const bar = this.footer.querySelector<HTMLElement>('#m-bar');
    if (progress) progress.textContent = this.progressText(status);
    if (eta) eta.textContent = this.etaText(status);
    if (elapsed) elapsed.textContent = t('common.searchExtra.elapsed', { time: formatDuration(Date.now() - this.searchStartedAt) });
    if (bar) {
      // 搜索瞬间结束（total 还是 0，或已经跑满）时也按 100% 展示。
      const complete = status.done && (status.total <= 0 || status.current >= status.total);
      const pct = complete ? 100 : status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
    }
  }

  private progressText(status: MonumentStatus): string {
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    const complete = status.done && (status.total <= 0 || status.current >= status.total);
    const pct = complete
      ? 100
      : status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : 0;
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${t('common.search.working')} ${status.current}/${status.total} (${pct}%)${error}`;
  }

  private etaText(status: MonumentStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = Date.now() - this.searchStartedAt;
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
