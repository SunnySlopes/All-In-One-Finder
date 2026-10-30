import { showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type FortressStatus, type McVersion } from './native';
import { escapeAttr, formatDuration, messageOf, applyRunLock, RunTimer, applyForm, captureForm } from './panel-utils';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

export type FortressMode = 'cross' | 'span';

type SeedMode = 'single' | 'list';
type BorderState = 'none' | 'nw' | 'sw' | 'se' | 'ne';

const DEFAULT_SIDE = 32768;
const DEFAULT_LIST_SIDE = 2048;
/** 两个下界要塞搜索器共用的范围上限：等效面积 262144×262144。 */
const MAX_EQUIVALENT_AREA = 262144 * 262144;
const MAX_SQUARE_SIDE = 262144;
const WORLD_COORD = 30000000;
const DEFAULT_SPAN_LONG = 240;
const DEFAULT_SPAN_SHORT = 240;
const DEFAULT_SPAN_HEIGHT = 0;

const BORDER_SEQUENCE: BorderState[] = ['none', 'nw', 'sw', 'se', 'ne'];

const BORDER_AREAS: Record<Exclude<BorderState, 'none'>, {
  minX: number; maxX: number; minZ: number; maxZ: number;
}> = {
  nw: { minX: -4000000, maxX: -3750001, minZ: -4000000, maxZ: -3750001 },
  sw: { minX: -4000000, maxX: -3750001, minZ: 3750001, maxZ: 4000000 },
  se: { minX: 3750001, maxX: 4000000, minZ: 3750001, maxZ: 4000000 },
  ne: { minX: 3750001, maxX: 4000000, minZ: -4000000, maxZ: -3750001 },
};

function resolveFortressMc(versions: McVersion[]): number | null {
  const modern = versions.find((item) => item.name === '26.3');
  if (modern) return modern.id;
  const fallback = versions.find((item) => item.name === '26.2')
    || versions[versions.length - 1];
  return fallback ? fallback.id : null;
}

export class FortressPanel {
  readonly root: HTMLElement;
  readonly tab: SearcherId;
  private readonly mode: FortressMode;
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
  private readonly timer = new RunTimer();
  private border: BorderState = 'none';
  private spanSquare = true;
  private spanLong = String(DEFAULT_SPAN_LONG);
  private spanShort = String(DEFAULT_SPAN_SHORT);
  private spanHeight = String(DEFAULT_SPAN_HEIGHT);
  private crossFilter = '2';
  private lastStatus: FortressStatus | null = null;
  private shownError = '';

  constructor(mode: FortressMode) {
    this.mode = mode;
    this.tab = mode === 'cross' ? 'NetherFortressCross' : 'NetherFortressOverall';
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body">
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
          <select id="f-version" disabled><option>1.18~26.3</option></select>
          <label data-i18n="common.search.threads"></label><input id="f-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="f-minx" type="number" value="-16384" />
          <label data-i18n="common.search.maxX"></label><input id="f-maxx" type="number" value="16383" />
          <label data-i18n="common.search.minZ"></label><input id="f-minz" type="number" value="-16384" />
          <label data-i18n="common.search.maxZ"></label><input id="f-maxz" type="number" value="16383" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="f-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="f-side" type="number" min="1" max="${MAX_SQUARE_SIDE}" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="f-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="f-border" type="button" data-i18n="fortress.maxRange"></button>
          <button id="f-bordermode" type="button" hidden></button>
        </div>
        <div id="f-params"></div>
      </div>
      <div class="search-panel-footer" id="f-footer"></div>
    `;
    this.footer = this.root.querySelector('#f-footer')!;
    this.threads = this.root.querySelector('#f-threads')!;
    this.minX = this.root.querySelector('#f-minx')!;
    this.maxX = this.root.querySelector('#f-maxx')!;
    this.minZ = this.root.querySelector('#f-minz')!;
    this.maxZ = this.root.querySelector('#f-maxz')!;
    this.square = this.root.querySelector('#f-square')!;
    this.side = this.root.querySelector('#f-side')!;
    this.seedModeSelect = this.root.querySelector('#f-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    this.root.querySelector('#f-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#f-border')!.addEventListener('click', () => this.resetMaxRange());
    this.root.querySelector('#f-bordermode')!.addEventListener('click', () => this.advanceBorder());
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
      border: this.border,
      spanSquare: this.spanSquare,
      spanLong: this.spanLong,
      spanShort: this.spanShort,
      spanHeight: this.spanHeight,
      crossFilter: this.crossFilter,
    };
  }

  importState(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    if (s.seedMode === 'single' || s.seedMode === 'list') this.seedMode = s.seedMode;
    if (typeof s.seed === 'string') this.seed = s.seed;
    if (typeof s.seedText === 'string') this.seedText = s.seedText;
    if (s.border === 'none' || s.border === 'nw' || s.border === 'sw' || s.border === 'se' || s.border === 'ne') {
      this.border = s.border;
    }
    if (typeof s.spanSquare === 'boolean') this.spanSquare = s.spanSquare;
    if (typeof s.spanLong === 'string') this.spanLong = s.spanLong;
    if (typeof s.spanShort === 'string') this.spanShort = s.spanShort;
    if (typeof s.spanHeight === 'string') this.spanHeight = s.spanHeight;
    if (typeof s.crossFilter === 'string') this.crossFilter = s.crossFilter;
    applyForm(this.root, s);
    this.render();
    applyForm(this.root, s);
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

  private defaultSide(): number {
    return this.seedMode === 'list' ? DEFAULT_LIST_SIDE : DEFAULT_SIDE;
  }

  private resetDefaultArea(): void {
    this.border = 'none';
    this.square.checked = true;
    this.side.value = String(this.defaultSide());
    this.applySquare();
    this.render();
  }

  private resetMaxRange(): void {
    this.border = 'none';
    this.square.checked = true;
    this.side.value = String(MAX_SQUARE_SIDE);
    this.applySquare();
    this.render();
  }

  private advanceBorder(): void {
    const index = BORDER_SEQUENCE.indexOf(this.border);
    this.border = BORDER_SEQUENCE[(index + 1) % BORDER_SEQUENCE.length];
    if (this.border === 'none') {
      this.resetDefaultArea();
      return;
    }
    const area = BORDER_AREAS[this.border];
    this.square.checked = false;
    this.applySquare();
    this.minX.value = String(area.minX);
    this.maxX.value = String(area.maxX);
    this.minZ.value = String(area.minZ);
    this.maxZ.value = String(area.maxZ);
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
    this.renderSeedBlock();

    const params = this.root.querySelector('#f-params')!;
    if (this.mode === 'cross') {
      params.innerHTML = `
        <div class="grid">
          <label data-i18n="fortress.crossFilter"></label>
          <select id="f-filter">
            <option value="2"${this.crossFilter === '2' ? ' selected' : ''} data-i18n="fortress.filter.all"></option>
            <option value="3"${this.crossFilter === '3' ? ' selected' : ''} data-i18n="fortress.filter.triple"></option>
            <option value="4"${this.crossFilter === '4' ? ' selected' : ''} data-i18n="fortress.filter.quad"></option>
          </select>
        </div>
        <div class="hint" data-i18n="fortress.crossHelp"></div>`;
      params.querySelector<HTMLSelectElement>('#f-filter')?.addEventListener('change', (event) => {
        this.crossFilter = (event.target as HTMLSelectElement).value;
      });
    } else {
      params.innerHTML = `
        <div class="grid">
          <label data-i18n="fortress.minLong"></label><input id="f-long" type="number" min="0" max="260" value="${escapeAttr(this.spanLong)}" />
          <label data-i18n="fortress.minShort"></label><input id="f-short" type="number" min="0" max="260" value="${escapeAttr(this.spanSquare ? this.spanLong : this.spanShort)}" />
          <label class="feature span-full"><input id="f-span-square" type="checkbox" ${this.spanSquare ? 'checked' : ''} /><span data-i18n="fortress.spanSquare"></span></label>
          <label data-i18n="fortress.minHeight"></label><input id="f-height" type="number" min="0" max="40" value="${escapeAttr(this.spanHeight)}" />
        </div>
        <div class="hint" data-i18n="fortress.spanHelp"></div>`;
      const longInput = params.querySelector<HTMLInputElement>('#f-long')!;
      const shortInput = params.querySelector<HTMLInputElement>('#f-short')!;
      const heightInput = params.querySelector<HTMLInputElement>('#f-height')!;
      const spanSquareInput = params.querySelector<HTMLInputElement>('#f-span-square')!;
      const applySpanSquare = (): void => {
        shortInput.disabled = this.spanSquare;
        if (!this.spanSquare) return;
        shortInput.value = longInput.value;
        this.spanShort = longInput.value;
      };
      spanSquareInput.addEventListener('change', () => {
        this.spanSquare = spanSquareInput.checked;
        applySpanSquare();
      });
      longInput.addEventListener('input', () => {
        this.spanLong = longInput.value;
        if (this.spanSquare) {
          shortInput.value = longInput.value;
          this.spanShort = longInput.value;
        }
      });
      shortInput.addEventListener('input', () => {
        this.spanShort = shortInput.value;
      });
      heightInput.addEventListener('input', () => {
        this.spanHeight = heightInput.value;
      });
      applySpanSquare();
    }

    const borderModeButton = this.root.querySelector<HTMLButtonElement>('#f-bordermode');
    if (borderModeButton) {
      borderModeButton.hidden = this.mode !== 'span';
      if (this.mode === 'span') {
        borderModeButton.textContent = `${t('fortress.border')}${t('common.labelColon')}${t(`fortress.borderState.${this.border}`)}`;
      }
    }

    this.footer.innerHTML = `
      <div class="row">
        <button id="f-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="f-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="f-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="f-bar"></div></div>
      <div id="f-progress" class="hint"></div>
      <div id="f-elapsed" class="hint"></div>
      <div id="f-eta" class="hint"></div>
    `;
    this.footer.querySelector('#f-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#f-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#f-stop')?.addEventListener('click', () => void call('fortressSearchStop'));
    applyI18n(this.root);
    applyRunLock(this.root, this.running, this.paused);
    if (this.lastStatus) this.paintStatus(this.lastStatus);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#f-seed');
    if (seed) this.seed = seed.value.trim();
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
    const node = this.root.querySelector('#f-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    const listMode = this.seedMode === 'list';

    if (this.square.checked) {
      const side = Math.floor(Number(this.side.value) || 0);
      if (side < 1 || side > 60000001) {
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

    const width = maxX - minX + 1;
    const height = maxZ - minZ + 1;
    if (width * height > MAX_EQUIVALENT_AREA) {
      await showNotice(t('fortress.areaTooLarge'));
      return;
    }

    const seeds = listMode ? this.seedText : this.seed;
    if (!seeds.trim()) {
      await showNotice(t('common.error.bad-seed'));
      return;
    }

    const mc = resolveFortressMc(this.versions);
    if (mc == null) {
      await showNotice(t('common.error.unsupported-version'));
      return;
    }

    const threads = Math.max(1, Math.min(256, Number(this.threads.value) || 1));
    const payload: Record<string, unknown> = {
      mc,
      threads,
      mode: this.mode === 'cross' ? 0 : 1,
      minX,
      maxX,
      minZ,
      maxZ,
      seeds,
    };

    if (this.mode === 'cross') {
      const filter = this.root.querySelector<HTMLSelectElement>('#f-filter');
      if (filter) this.crossFilter = filter.value;
      payload.crossFilter = Number(this.crossFilter || 2);
    } else {
      const minLong = Math.round(Number(this.root.querySelector<HTMLInputElement>('#f-long')?.value || 0));
      const minShort = this.spanSquare
        ? minLong
        : Math.round(Number(this.root.querySelector<HTMLInputElement>('#f-short')?.value || 0));
      const minHeight = Math.round(Number(this.root.querySelector<HTMLInputElement>('#f-height')?.value || 0));
      if (!Number.isFinite(minLong) || minLong < 0 || minLong > 260
        || !Number.isFinite(minShort) || minShort < 0 || minShort > 260) {
        await showNotice(t('common.error.bad-span-edge'));
        return;
      }
      if (!Number.isFinite(minHeight) || minHeight < 0 || minHeight > 40) {
        await showNotice(t('common.error.bad-span-height'));
        return;
      }
      payload.minLong = minLong;
      payload.minShort = minShort;
      payload.minHeight = minHeight;
    }

    try {
      await call('fortressSearchStart', payload);
      this.results?.clearFortress(this.tab, listMode);
      this.running = true;
      this.paused = false;
      this.shownError = '';
      this.lastStatus = null;
      this.timer.start();
      this.render();
      this.poll();
    } catch (error) {
      await showNotice(messageOf(error));
    }
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('fortressSearchResume');
      this.paused = false;
      this.timer.resume();
    } else {
      await call('fortressSearchPause');
      this.paused = true;
      this.timer.pause();
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<FortressStatus>('fortressSearchPoll');
        this.lastStatus = status;
        this.running = status.running;
        this.paused = status.paused;
        this.paintStatus(status);
        this.results?.setFortressHits(status.hits, this.tab);
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
  private paintStatus(status: FortressStatus): void {
    const progress = this.footer.querySelector('#f-progress');
    const eta = this.footer.querySelector('#f-eta');
    const elapsed = this.footer.querySelector('#f-elapsed');
    const bar = this.footer.querySelector<HTMLElement>('#f-bar');
    if (progress) progress.textContent = this.progressText(status);
    if (eta) eta.textContent = this.etaText(status);
    if (elapsed) {
      elapsed.textContent = t('common.searchExtra.elapsed', { time: formatDuration(this.timer.elapsed()) });
    }
    if (bar) {
      const pct = status.done
        ? 100
        : status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
    }
  }

  private progressText(status: FortressStatus): string {
    const seeds = status.seedCount > 1
      ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
      : '';
    if (status.done && !status.error) return `${seeds}${t('common.search.completed')}`;
    const pct = status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : 0;
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${t('common.search.working')} ${status.current}/${status.total} (${pct}%)${error}`;
  }

  private etaText(status: FortressStatus): string {
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = this.timer.elapsed();
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
