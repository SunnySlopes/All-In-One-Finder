import { ask, showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type SlimeStatus } from './native';
import type { ResultsColumn } from './results';

export type SlimeVersionGroup = '1.18' | 'middle' | 'modern';
type SeedMode = 'single' | 'list';

const DEFAULT_SIDE = 32768;
const WORLD_SIDE = 60000001;
const WORLD_COORD = 30000000;
const MIN_AREA = 9000;
const MAX_AREA = 15000;
const DEFAULT_MIN_AREA = 10500;
const FULL_MIN_AREA = 13500;

const VERSION_OPTIONS: { value: SlimeVersionGroup; label: string }[] = [
  { value: '1.18', label: '1.18' },
  { value: 'middle', label: '1.19~26.1' },
  { value: 'modern', label: '26.2+' },
];

function versionRule(group: SlimeVersionGroup): number {
  if (group === '1.18') return 0;
  if (group === 'middle') return 1;
  return 2;
}

/** 点击结果时地图应切换到的版本名；与搜索器的三个版本档一致。 */
export function slimeMapVersion(group: SlimeVersionGroup): string {
  if (group === '1.18') return '1.18';
  if (group === 'middle') return '26.1';
  return '26.3';
}

function resolveMc(group: SlimeVersionGroup, versions: McVersion[]): number | null {
  const names = group === '1.18' ? ['1.18']
    : group === 'middle' ? ['26.1', '1.21.11', '1.21.9']
      : ['26.3', '26.2'];
  for (const name of names) {
    const hit = versions.find((item) => item.name === name);
    if (hit) return hit.id;
  }
  if (group === '1.18') {
    const hit = versions.find((item) => item.name.startsWith('1.18'));
    if (hit) return hit.id;
  }
  return versions.length ? versions[versions.length - 1].id : null;
}

function areaWarning(area: number, minArea: number): number | null {
  const square = (n: number) => n * n;
  if (area > square(10000001) && minArea < 13000) return 13000;
  if (area > square(2000001) && minArea < 12500) return 12500;
  if (area > square(500001) && area <= square(2000001) && minArea < 12000) return 12000;
  if (area >= square(131072) && area <= square(500001) && minArea < 11000) return 11000;
  if (area >= square(32768) && area < square(131072) && minArea < 10500) return 10500;
  return null;
}

export class SlimePanel {
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
  private minArea!: HTMLInputElement;
  private convert!: HTMLInputElement;
  private seedModeSelect!: HTMLSelectElement;
  private seedMode: SeedMode = 'single';
  private versionGroup: SlimeVersionGroup = 'modern';
  private versions: McVersion[] = [];
  private results: ResultsColumn | null = null;
  private seed = '';
  private seedText = '';
  private running = false;
  private paused = false;
  private pollTimer = 0;
  private currentConvert = true;
  private searchVersion: SlimeVersionGroup = 'modern';
  private phaseStartedAt = 0;
  private searchStartedAt = 0;
  private lastStage = Number.NaN;
  private shownError = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="sl-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="sl-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="sl-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="sl-version">
            ${VERSION_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')}
          </select>
          <label data-i18n="common.search.threads"></label><input id="sl-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="sl-minx" type="number" value="-16384" />
          <label data-i18n="common.search.maxX"></label><input id="sl-maxx" type="number" value="16383" />
          <label data-i18n="common.search.minZ"></label><input id="sl-minz" type="number" value="-16384" />
          <label data-i18n="common.search.maxZ"></label><input id="sl-maxz" type="number" value="16383" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="sl-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="sl-side" type="number" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="sl-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="sl-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="grid">
          <label data-i18n="slime.minArea"></label>
          <input id="sl-min-area" type="number" min="${MIN_AREA}" max="${MAX_AREA}" step="1" value="${DEFAULT_MIN_AREA}" />
        </div>
        <label class="feature">
          <input id="sl-convert" type="checkbox" checked />
          <span data-i18n="slime.convert"></span>
        </label>
        <div class="hint" data-i18n="slime.help"></div>
      </div>
      <div class="search-panel-footer" id="sl-footer"></div>
    `;
    this.footer = this.root.querySelector('#sl-footer')!;
    this.version = this.root.querySelector('#sl-version')!;
    this.threads = this.root.querySelector('#sl-threads')!;
    this.minX = this.root.querySelector('#sl-minx')!;
    this.maxX = this.root.querySelector('#sl-maxx')!;
    this.minZ = this.root.querySelector('#sl-minz')!;
    this.maxZ = this.root.querySelector('#sl-maxz')!;
    this.square = this.root.querySelector('#sl-square')!;
    this.side = this.root.querySelector('#sl-side')!;
    this.minArea = this.root.querySelector('#sl-min-area')!;
    this.convert = this.root.querySelector('#sl-convert')!;
    this.seedModeSelect = this.root.querySelector('#sl-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.root.querySelector('#sl-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#sl-border')!.addEventListener('click', () => this.resetFullMap());
    this.version.addEventListener('change', () => {
      this.versionGroup = this.version.value as SlimeVersionGroup;
    });
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.render();
    });
    this.applySquare();
    this.render();
  }

  bindResults(results: ResultsColumn): void {
    this.results = results;
  }

  setSeedFromMap(seed: string): void {
    if (!seed.trim()) return;
    this.seed = seed.trim();
    const input = this.root.querySelector<HTMLInputElement>('#sl-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.applySquare();
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private defaultSide(): number {
    return DEFAULT_SIDE;
  }

  private resetDefaultArea(): void {
    this.square.checked = true;
    this.side.value = String(this.defaultSide());
    this.minArea.value = String(DEFAULT_MIN_AREA);
    this.applySquare();
    this.render();
  }

  private resetFullMap(): void {
    this.square.checked = true;
    this.side.value = String(WORLD_SIDE);
    this.minArea.value = String(FULL_MIN_AREA);
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
    const host = this.root.querySelector('#sl-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="sl-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="sl-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="sl-file-name"></div>`;
      const fileName = host.querySelector('#sl-file-name');
      if (fileName && this.seedText) {
        const count = this.seedText.split(/\r?\n/).filter((line) => line.trim()).length;
        fileName.textContent = String(count);
      }
      host.querySelector('#sl-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.version.value = this.versionGroup;
    this.renderSeedBlock();
    this.footer.innerHTML = `
      <div class="row">
        <button id="sl-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="sl-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="sl-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="sl-bar"></div></div>
      <div id="sl-progress" class="hint"></div>
      <div id="sl-elapsed" class="hint"></div>
      <div id="sl-eta" class="hint"></div>
    `;
    this.footer.querySelector('#sl-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#sl-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#sl-stop')?.addEventListener('click', () => void call('slimeFarmStop'));
    applyI18n(this.root);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#sl-seed');
    if (seed) this.seed = seed.value.trim();
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#sl-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    this.currentConvert = this.convert.checked;
    this.searchVersion = this.versionGroup;

    const rawMinArea = Number(this.minArea.value);
    let minArea = Math.round(Number.isFinite(rawMinArea) ? rawMinArea : MIN_AREA);
    const adjusted = !Number.isFinite(rawMinArea) || rawMinArea !== minArea
      || minArea < MIN_AREA || minArea > MAX_AREA;
    minArea = Math.min(MAX_AREA, Math.max(MIN_AREA, minArea));
    if (adjusted) {
      this.minArea.value = String(minArea);
      await showNotice(t('slime.areaClamped', { min: minArea }));
    }

    if (this.square.checked) {
      const side = Math.floor(Number(this.side.value) || 0);
      if (side < 1) {
        await showNotice(t('common.error.bad-bounds'));
        return;
      }
      if (side > WORLD_SIDE) {
        await showNotice(t('common.error.area-too-large'));
        return;
      }
      this.applySquare();
    }

    const minX = Number(this.minX.value);
    const maxX = Number(this.maxX.value);
    const minZ = Number(this.minZ.value);
    const maxZ = Number(this.maxZ.value);
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite) || maxX < minX || maxZ < minZ) {
      await showNotice(t('common.error.bad-bounds'));
      return;
    }
    const width = maxX - minX + 1;
    const height = maxZ - minZ + 1;
    if (width > WORLD_SIDE || height > WORLD_SIDE
      || minX < -WORLD_COORD || maxX > WORLD_COORD
      || minZ < -WORLD_COORD || maxZ > WORLD_COORD) {
      await showNotice(t('common.error.area-too-large'));
      return;
    }

    const warning = areaWarning(width * height, minArea);
    if (warning != null) {
      const choice = await ask(t('slime.tooMany', { min: warning }), [
        { id: 'adjust', key: 'slime.adjust' },
        { id: 'keep', key: 'slime.keep' },
        { id: 'cancel', key: 'common.dialog.close' },
      ]);
      if (choice === 'cancel' || choice === 'dismiss') return;
      if (choice === 'adjust') {
        minArea = warning;
        this.minArea.value = String(minArea);
      }
    }

    const mc = resolveMc(this.searchVersion, this.versions);
    if (mc == null) {
      await showNotice(t('common.error.unsupported-version'));
      return;
    }

    try {
      await call('slimeFarmStart', {
        mc,
        versionRule: versionRule(this.searchVersion),
        threads: Math.max(1, Math.min(256, Number(this.threads.value) || 1)),
        minSlimeArea: minArea,
        minX,
        maxX,
        minZ,
        maxZ,
        convert: this.currentConvert,
        seeds: this.seedMode === 'list' ? this.seedText : this.seed,
      });
      this.results?.clearSlime(this.currentConvert, this.searchVersion);
      this.running = true;
      this.paused = false;
      this.shownError = '';
      this.searchStartedAt = Date.now();
      this.phaseStartedAt = Date.now();
      this.lastStage = Number.NaN;
      this.render();
      this.poll();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('slimeFarmResume');
      this.paused = false;
      this.phaseStartedAt = Date.now();
    } else {
      await call('slimeFarmPause');
      this.paused = true;
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<SlimeStatus>('slimeFarmPoll');
        this.running = status.running;
        this.paused = status.paused;
        if (status.stage !== this.lastStage) {
          this.lastStage = status.stage;
          this.phaseStartedAt = Date.now();
        }
        const progress = this.footer.querySelector('#sl-progress');
        const eta = this.footer.querySelector('#sl-eta');
        const elapsed = this.footer.querySelector('#sl-elapsed');
        const bar = this.footer.querySelector<HTMLElement>('#sl-bar');
        if (progress) progress.textContent = this.progressText(status);
        if (eta) eta.textContent = this.etaText(status);
        if (elapsed) elapsed.textContent = t('common.searchExtra.elapsed', { time: formatDuration(Date.now() - this.searchStartedAt) });
        if (bar) {
          const useTiles = status.tilesTotal > 1 && status.stage >= 2;
          const pct = useTiles
            ? Math.min(100, (status.tilesDone / status.tilesTotal) * 100)
            : (status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0);
          bar.style.width = `${pct}%`;
        }
        this.results?.setSlimeHits(status.hits, this.currentConvert, this.searchVersion);
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

  private progressText(status: SlimeStatus): string {
    // 阶段 4 与“群系折算”复选框共用 slime.convert，不再保留重复 key。
    const stage = t(status.stage === 4 ? 'slime.convert' : `slime.stage.${status.stage}`);
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    const tiles = status.tilesTotal > 1
      ? `${t('slime.tileProgress', { done: status.tilesDone, total: status.tilesTotal })} `
      : '';
    const pct = status.total > 0 ? Math.min(100, Math.round(status.current / status.total * 100)) : 0;
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${tiles}${stage} ${status.current}/${status.total} (${pct}%)${error}`;
  }

  private etaText(status: SlimeStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (status.tilesTotal > 1 && status.tilesDone > 0) {
      const elapsed = Date.now() - this.searchStartedAt;
      const remaining = elapsed * ((status.tilesTotal - status.tilesDone) / status.tilesDone);
      if (remaining > 0 && Number.isFinite(remaining)) {
        return t('common.search.eta.remaining', { time: formatDuration(remaining) });
      }
    }
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = Date.now() - this.phaseStartedAt;
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}

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
