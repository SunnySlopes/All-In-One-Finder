import { applyI18n, t } from './i18n';
import { call, type McVersion, type SearchHit, type SearchStatus } from './native';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

const LUCKY_AREA = 6000001 * 6000001;
const LUCKY_BELOW = 0.75;
const LOW_PROB = 0.85;
const DEFAULT_SIDE = 131072;
const WORLD_SIDE = 60000001;
const DEFAULT_RATIO = '70';
const BORDER_RATIO = '90';

type Choice = 'yes' | 'no' | 'dismiss';
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
  private form!: HTMLElement;
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
  private seedMode: SeedMode = 'single';
  private uiVersion: LowyUiVersion = 'sulfur';
  private supported = true;
  private running = false;
  private paused = false;
  private hits: SearchHit[] = [];
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
          <label data-i18n="search.seedMode"></label>
          <select id="s-seed-mode">
            <option value="single" data-i18n="search.seedModeSingle"></option>
            <option value="list" data-i18n="search.seedModeList"></option>
          </select>
        </div>
        <div id="s-seed-block"></div>
        <div class="grid">
          <label data-i18n="search.version"></label><select id="s-version"></select>
          <label data-i18n="search.threads"></label><input id="s-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="search.minX"></label><input id="s-minx" type="number" value="-65536" />
          <label data-i18n="search.maxX"></label><input id="s-maxx" type="number" value="65535" />
          <label data-i18n="search.minZ"></label><input id="s-minz" type="number" value="-65536" />
          <label data-i18n="search.maxZ"></label><input id="s-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="s-square" type="checkbox" checked /><span data-i18n="search.square"></span></label>
          <input id="s-side" type="number" value="${DEFAULT_SIDE}" />
        </div>
        <div class="row">
          <button id="s-reset" type="button" data-i18n="search.reset"></button>
          <button id="s-border" type="button" data-i18n="search.border"></button>
        </div>
        <div id="s-params"></div>
      </div>
      <div class="search-panel-footer" id="s-footer"></div>
    `;
    this.form = this.root.querySelector('#s-form')!;
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
      <option value="sulfur" data-i18n="lowy.verSulfur"></option>
      <option value="pre" data-i18n="lowy.verPre"></option>
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
        <label data-i18n="lowy.seed"></label><input id="p-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="lowy.seeds"></label><button id="p-file" type="button" data-i18n="lowy.pick"></button>
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
    const notice = this.supported ? '' : `<div class="hint" data-i18n="search.unsupported"></div>`;
    const help = pit
      ? `<div class="hint" data-i18n="lowy.helpPit"></div>`
      : `<div class="hint" data-i18n="lowy.helpCave"></div>`;

    if (pit) {
      params.innerHTML = `${notice}${help}<div class="grid">
        <label data-i18n="lowy.fastRatio"></label><input id="p-ratio" type="number" min="80" max="95" step="1" value="${escapeAttr(this.fastRatio)}" />
      </div>`;
    } else if (this.seedMode === 'list') {
      params.innerHTML = `${notice}${help}<div class="grid">
        <label data-i18n="lowy.river"></label><input id="p-river" type="number" min="0" max="1" step="0.05" value="${escapeAttr(this.river)}" />
        <label data-i18n="lowy.ratio"></label><input id="p-ratio" type="number" min="40" max="95" step="1" value="${escapeAttr(this.ratio)}" />
        <label data-i18n="lowy.fastMode"></label><input id="p-fast" type="checkbox" ${this.fastMode ? 'checked' : ''} />
      </div>`;
    } else {
      params.innerHTML = `${notice}${help}<div class="grid">
        <label data-i18n="lowy.river"></label><input id="p-river" type="number" min="0" max="1" step="0.05" value="${escapeAttr(this.river)}" />
        <label data-i18n="lowy.ratio"></label><input id="p-ratio" type="number" min="40" max="95" step="1" value="${escapeAttr(this.ratio)}" />
        <label data-i18n="lowy.fastMode"></label><input id="p-fast" type="checkbox" ${this.fastMode ? 'checked' : ''} />
      </div>`;
    }

    this.footer.innerHTML = `
      <div class="row">
        <button id="s-start" type="button" data-i18n="search.start" ${this.supported && !this.running ? '' : 'disabled'}></button>
        <button id="s-pause" type="button" data-i18n="${this.paused ? 'search.resume' : 'search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="s-stop" type="button" data-i18n="search.stop" ${this.running ? '' : 'disabled'}></button>
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
    const listMode = !fastPage && this.seedMode === 'list';
    const ratio = Number(fastPage ? this.fastRatio : this.ratio);
    const min = fastPage ? 80 : this.fastMode ? 60 : 40;
    if (!(ratio >= min && ratio <= 95)) {
      await ask(t('error.bad-ratio'), [{ id: 'dismiss', key: 'lowy.dismiss' }]);
      return;
    }
    if (!fastPage && !listMode && this.area() >= LUCKY_AREA) {
      try {
        const score = await call<number>('weirdness', this.seed);
        if (score < LUCKY_BELOW) {
          const choice = await ask(t('lowy.tryLuck'), [
            { id: 'yes', key: 'lowy.goFast' },
            { id: 'no', key: 'lowy.stay' },
            { id: 'dismiss', key: 'lowy.dismiss' },
          ]);
          if (choice === 'yes') {
            this.onNavigate('LowYPitDripstoneCave');
            return;
          }
          if (choice !== 'no') return;
        }
      } catch (error) {
        await ask(messageOf(error), [{ id: 'dismiss', key: 'lowy.dismiss' }]);
        return;
      }
    }
    if (fastPage) {
      try {
        const score = await call<number>('weirdness', this.seed);
        if (score > LOW_PROB) {
          const choice = await ask(t('lowy.unlikely'), [
            { id: 'yes', key: 'lowy.anyway' },
            { id: 'no', key: 'lowy.back' },
            { id: 'dismiss', key: 'lowy.dismiss' },
          ]);
          if (choice === 'no') {
            this.ratio = this.fastRatio;
            this.onNavigate('LowYDripstoneCave');
            return;
          }
          if (choice !== 'yes') return;
        }
      } catch (error) {
        await ask(messageOf(error), [{ id: 'dismiss', key: 'lowy.dismiss' }]);
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
      this.hits = [];
      this.searchStartedAt = Date.now();
      this.phaseStartedAt = Date.now();
      this.lastPhase = Number.NaN;
      this.render();
      this.poll();
    } catch (error) {
      await ask(messageOf(error), [{ id: 'dismiss', key: 'lowy.dismiss' }]);
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
        this.hits = status.hits;
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
        if (elapsed) elapsed.textContent = t('searchExtra.elapsed', { time: formatDuration(Date.now() - this.searchStartedAt) });
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

  private progressText(status: SearchStatus): string {
    const phase = status.phase === 0 ? t('search.phase.cache')
      : status.phase === 1 ? t('search.phase.scan')
        : status.phase === 2 ? t('search.phase.refine')
          : status.phase < 0 ? t('search.phase.done')
            : t('search.phase.work');
    const seeds = status.seedCount > 1 ? `${t('search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} ` : '';
    const pct = status.total > 0 ? Math.min(100, Math.round(status.current / status.total * 100)) : 0;
    return `${seeds}${phase} ${status.current}/${status.total} (${pct}%)${status.error ? ` ${t(`error.${status.error}`) || status.error}` : ''}`;
  }

  private etaText(status: SearchStatus): string {
    if (status.done || status.phase < 0) return t('search.eta.completed');
    if (status.paused) return t('search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('search.eta.calculating');
    const elapsed = Date.now() - this.phaseStartedAt;
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('search.eta.calculating');
    return t('search.eta.remaining', { time: formatDuration(remaining) });
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
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? code : text;
}

function ask(message: string, buttons: { id: Choice; key: string }[]): Promise<Choice> {
  const modal = document.querySelector<HTMLElement>('#modal')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  dialog.innerHTML = `<div>${escapeText(message)}</div><div class="row">${buttons.map((button) =>
    `<button type="button" data-choice="${button.id}">${escapeText(t(button.key))}</button>`).join('')}</div>`;
  modal.classList.add('show');
  return new Promise((resolve) => {
    const finish = (choice: Choice) => {
      modal.classList.remove('show');
      modal.onclick = null;
      resolve(choice);
    };
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        finish(button.dataset.choice as Choice);
      });
    });
    modal.onclick = (event) => {
      if (event.target === modal) finish('dismiss');
    };
  });
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}
