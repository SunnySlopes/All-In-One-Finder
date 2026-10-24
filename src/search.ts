import { ask } from './dialog';
import { applyI18n, t } from './i18n';
import { call, type McVersion, type SearchStatus } from './native';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

const LUCKY_AREA = 6000001 * 6000001;
const LUCKY_BELOW = 0.75;
const LOW_PROB = 0.85;
const DEFAULT_SIDE = 131072;
const WORLD_SIDE = 60000001;
const DEFAULT_RATIO = '70';
const BORDER_RATIO = '90';
/** 溶洞范围小于这个等效面积时，提示改去河流页搜索。 */
const RIVER_HINT_AREA = 100000 * 100000;

/** 溶洞搜索的面积口径：24 < r <= 128 刷怪环格点总面积。 */
const FULL_RING_AREA = 49640;

type SeedMode = 'single' | 'list';
type LowyUiVersion = 'pre' | 'sulfur';

function resolveLowyMc(ui: LowyUiVersion, versions: McVersion[]): number {
  if (ui === 'sulfur') {
    const hit = versions.find((item) => item.name === '26.3')
      || versions.find((item) => item.name === '26.2')
      || versions[versions.length - 1];
    return hit?.id ?? 0;
  }
  const hit = versions.find((item) => item.name === '26.1')
    || versions.find((item) => item.name === '1.21.11')
    || versions.find((item) => item.name.startsWith('1.21'))
    || versions[0];
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
  private seedMode: SeedMode = 'single';
  private uiVersion: LowyUiVersion = 'sulfur';
  private supported = true;
  private running = false;
  private paused = false;
  private pollTimer = 0;
  private versions: McVersion[] = [];
  private seed = '';
  private river = '0.75';
  private ratio = DEFAULT_RATIO;
  private fastMode = true;
  private fastRatio = '90';
  private seedText = '';
  private phaseStartedAt = 0;
  private searchStartedAt = 0;
  private lastPhase = Number.NaN;
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
          <label class="feature"><input id="s-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="s-side" type="number" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="s-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="s-border" type="button" data-i18n="common.search.border"></button>
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
    this.searcher = id;
    if (id === 'LowYPitDripstoneCave') this.seedMode = 'single';
    if (changed) this.resetDefaultArea();
    this.render();
  }

  setSeedFromMap(seed: string): void {
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

  /** 由占比算出的面积；占比不在当前模式允许区间时留空。 */
  private caveAreaValue(pit: boolean): string {
    const ratio = Number(pit ? this.fastRatio : this.ratio);
    const [min, max] = this.caveRatioLimits(pit);
    if (!Number.isFinite(ratio) || ratio < min || ratio > max) return '';
    return String(Math.round(ratio / 100 * FULL_RING_AREA));
  }

  private caveRatioFromArea(value: string, pit: boolean): number | null {
    const area = Number(value);
    if (!Number.isFinite(area) || area < 0) return null;
    const ratio = Math.round(area / FULL_RING_AREA * 100);
    const [min, max] = this.caveRatioLimits(pit);
    if (ratio < min || ratio > max) return null;
    return ratio;
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
    const help = pit
      ? `<div class="hint" data-i18n="dripstonecave.helpPit"></div>`
      : `<div class="hint" data-i18n="dripstonecave.helpCave"></div>`;

    if (pit) {
      params.innerHTML = `${notice}<div class="grid">
        <label data-i18n="dripstonecave.fastRatio"></label><input id="p-ratio" type="number" min="80" max="95" step="1" value="${escapeAttr(this.fastRatio)}" />
        <label data-i18n="dripstonecave.area"></label><input id="p-area" type="number" min="0" step="1" value="${this.caveAreaValue(true)}" />
      </div>${help}`;
    } else if (this.seedMode === 'list') {
      params.innerHTML = `${notice}<div class="grid">
        <label data-i18n="dripstonecave.riverWeight"></label><input id="p-river" type="number" min="0" max="1" step="0.05" value="${escapeAttr(this.river)}" />
        <label data-i18n="dripstonecave.ratio"></label><input id="p-ratio" type="number" min="40" max="95" step="1" value="${escapeAttr(this.ratio)}" />
        <label data-i18n="dripstonecave.area"></label><input id="p-area" type="number" min="0" step="1" value="${this.caveAreaValue(false)}" />
        <label data-i18n="dripstonecave.fastMode"></label><input id="p-fast" type="checkbox" ${this.fastMode ? 'checked' : ''} />
      </div>${help}`;
    } else {
      params.innerHTML = `${notice}<div class="grid">
        <label data-i18n="dripstonecave.riverWeight"></label><input id="p-river" type="number" min="0" max="1" step="0.05" value="${escapeAttr(this.river)}" />
        <label data-i18n="dripstonecave.ratio"></label><input id="p-ratio" type="number" min="40" max="95" step="1" value="${escapeAttr(this.ratio)}" />
        <label data-i18n="dripstonecave.area"></label><input id="p-area" type="number" min="0" step="1" value="${this.caveAreaValue(false)}" />
        <label data-i18n="dripstonecave.fastMode"></label><input id="p-fast" type="checkbox" ${this.fastMode ? 'checked' : ''} />
      </div>${help}`;
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

    this.footer.innerHTML = `
      <div class="row">
        <button id="s-start" type="button" data-i18n="common.search.start" ${this.supported && !this.running ? '' : 'disabled'}></button>
        <button id="s-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="s-stop" type="button" data-i18n="common.search.stop" ${this.running ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="s-bar"></div></div>
      <div id="s-progress" class="hint"></div>
      <div id="s-elapsed" class="hint"></div>
      <div id="s-eta" class="hint"></div>
    `;

    this.footer.querySelector('#s-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#s-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#s-stop')?.addEventListener('click', () => void call('searchStop'));
    applyI18n(this.root);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#p-seed');
    const river = this.root.querySelector<HTMLInputElement>('#p-river');
    const ratio = this.root.querySelector<HTMLInputElement>('#p-ratio');
    const fast = this.root.querySelector<HTMLInputElement>('#p-fast');
    if (seed) this.seed = seed.value.trim();
    if (river) this.river = river.value;
    if (this.searcher === 'LowYPitDripstoneCave') {
      if (ratio) this.fastRatio = ratio.value;
    } else if (ratio) this.ratio = ratio.value;
    if (fast) this.fastMode = fast.checked;
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
    const listMode = !fastPage && this.seedMode === 'list';
    const ratio = Number(fastPage ? this.fastRatio : this.ratio);
    const min = fastPage ? 80 : this.fastMode ? 60 : 40;
    if (!(ratio >= min && ratio <= 95)) {
      await ask(t('common.error.bad-ratio'), [{ id: 'dismiss', key: 'common.dialog.close' }]);
      return;
    }
    const areaInput = this.root.querySelector<HTMLInputElement>('#p-area');
    if (areaInput) areaInput.value = String(Math.round(ratio / 100 * FULL_RING_AREA));
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
        ratio,
        riverWeight: Number(this.river) || 0.75,
        seed: this.seed,
        seeds: listMode ? this.seedText : undefined,
      });
      this.results?.clear(this.searcher, listMode);
      this.running = true;
      this.paused = false;
      this.searchStartedAt = Date.now();
      this.phaseStartedAt = Date.now();
      this.lastPhase = Number.NaN;
      this.render();
      this.poll();
    } catch (error) {
      await ask(messageOf(error), [{ id: 'dismiss', key: 'common.dialog.close' }]);
    }
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('searchResume');
      this.paused = false;
      this.phaseStartedAt = Date.now();
    } else {
      await call('searchPause');
      this.paused = true;
    }
    this.render();
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<SearchStatus>('searchPoll');
        this.running = status.running;
        this.paused = status.paused;
        if (status.phase !== this.lastPhase) {
          this.lastPhase = status.phase;
          this.phaseStartedAt = Date.now();
        }
        const progress = this.footer.querySelector('#s-progress');
        const eta = this.footer.querySelector('#s-eta');
        const elapsed = this.footer.querySelector('#s-elapsed');
        const bar = this.footer.querySelector<HTMLElement>('#s-bar');
        if (progress) progress.textContent = this.progressText(status);
        if (eta) eta.textContent = this.etaText(status);
        if (elapsed) elapsed.textContent = t('common.searchExtra.elapsed', { time: formatDuration(Date.now() - this.searchStartedAt) });
        if (bar) {
          const pct = status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
          bar.style.width = `${pct}%`;
        }
        const listMode = this.pageId() === 'lowy-list';
        this.results?.setHits(status.hits, this.searcher, listMode);
        if (status.done) {
          window.clearInterval(this.pollTimer);
          this.running = false;
          this.render();
        }
      } catch {
        window.clearInterval(this.pollTimer);
        this.running = false;
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

  private progressText(status: SearchStatus): string {
    const phase = this.stageLabel(status.phase);
    const seeds = status.seedCount > 1 ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} ` : '';
    const pct = status.total > 0 ? Math.min(100, Math.round(status.current / status.total * 100)) : 0;
    return `${seeds}${phase} ${status.current}/${status.total} (${pct}%)${status.error ? ` ${t(`common.error.${status.error}`) || status.error}` : ''}`;
  }

  private etaText(status: SearchStatus): string {
    if (status.done || status.phase < 0) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
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
