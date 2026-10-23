import { parseCoords } from './coords';
import { applyI18n, t } from './i18n';
import type { MapView } from './map';
import type { SearchHit } from './native';
import { isDripstoneTab, type SearcherId } from './searchers';

const AREA = Math.PI * (128 * 128 - 24 * 24);

export class ResultsColumn {
  readonly root: HTMLElement;
  private jumpX!: HTMLInputElement;
  private jumpZ!: HTMLInputElement;
  private parseText!: HTMLTextAreaElement;
  private parseError!: HTMLElement;
  private spawnWrap!: HTMLElement;
  private spawnCheck!: HTMLInputElement;
  private list!: HTMLElement;
  private exportSeedsBtn!: HTMLButtonElement;
  private exportAllBtn!: HTMLButtonElement;
  private hits: SearchHit[] = [];
  private sourceTab: SearcherId | null = null;
  private viewTab: SearcherId = 'map';
  private listMode = false;
  private map: MapView;
  onShowMap: () => void = () => {};

  constructor(map: MapView) {
    this.map = map;
    this.root = document.createElement('aside');
    this.root.id = 'results';
    this.root.innerHTML = `
      <div class="results-jump stack">
        <div class="row jump-coords">
          <label data-i18n="map.coordX"></label>
          <input id="r-x" type="number" value="0" />
          <label data-i18n="map.coordZ"></label>
          <input id="r-z" type="number" value="0" />
          <button type="button" id="r-go" data-i18n="map.goto"></button>
        </div>
        <label data-i18n="map.parseText"></label>
        <div class="row">
          <textarea id="r-parse" rows="2" data-i18n-placeholder="map.parseHint"></textarea>
          <button type="button" id="r-parse-btn" data-i18n="map.parse"></button>
        </div>
        <div class="hint" id="r-parse-error"></div>
        <label class="feature" id="r-spawn-wrap">
          <input id="r-spawn" type="checkbox" />
          <span data-i18n="results.drawSpawn"></span>
        </label>
      </div>
      <div id="r-list" class="results-list"></div>
      <div class="results-export row">
        <button type="button" id="r-export-seeds" data-i18n="results.exportSeeds" disabled></button>
        <button type="button" id="r-export-all" data-i18n="results.exportAll" disabled></button>
      </div>
    `;
    this.jumpX = this.root.querySelector('#r-x')!;
    this.jumpZ = this.root.querySelector('#r-z')!;
    this.parseText = this.root.querySelector('#r-parse')!;
    this.parseError = this.root.querySelector('#r-parse-error')!;
    this.spawnWrap = this.root.querySelector('#r-spawn-wrap')!;
    this.spawnCheck = this.root.querySelector('#r-spawn')!;
    this.list = this.root.querySelector('#r-list')!;
    this.exportSeedsBtn = this.root.querySelector('#r-export-seeds')!;
    this.exportAllBtn = this.root.querySelector('#r-export-all')!;
    this.root.querySelector('#r-go')!.addEventListener('click', () => this.jumpFromInputs());
    this.root.querySelector('#r-parse-btn')!.addEventListener('click', () => this.parse());
    this.spawnCheck.addEventListener('change', () => {
      if (!this.spawnCheck.checked) this.map.clearSpawnCircles();
    });
    this.exportSeedsBtn.addEventListener('click', () => this.exportSeeds());
    this.exportAllBtn.addEventListener('click', () => this.exportAll());
    this.paint();
  }

  focusJump(): void {
    this.jumpX.focus();
    this.jumpX.select();
  }

  setViewTab(tab: SearcherId): void {
    this.viewTab = tab;
    this.updateSpawnUi();
  }

  clear(sourceTab: SearcherId | null = null, listMode = false): void {
    this.hits = [];
    this.sourceTab = sourceTab;
    this.listMode = listMode;
    this.map.clearSpawnCircles();
    this.updateSpawnUi();
    this.paint();
  }

  setHits(hits: SearchHit[], sourceTab: SearcherId, listMode: boolean): void {
    this.hits = hits;
    this.sourceTab = sourceTab;
    this.listMode = listMode;
    this.updateSpawnUi();
    this.paint();
  }

  refresh(): void {
    this.updateSpawnUi();
    this.paint();
    const hint = this.parseText.getAttribute('data-i18n-placeholder');
    if (hint) this.parseText.placeholder = t(hint);
    applyI18n(this.root);
  }

  private updateSpawnUi(): void {
    // The go button always lives on this column, so the spawn-ring checkbox stays visible.
    this.spawnWrap.hidden = false;
  }

  private parse(): void {
    const parsed = parseCoords(this.parseText.value);
    if (!parsed) {
      this.parseError.textContent = t('map.badParse');
      return;
    }
    this.parseError.textContent = '';
    this.jumpX.value = String(parsed.x);
    this.jumpZ.value = String(parsed.z);
  }

  private jumpFromInputs(): void {
    const x = Number(this.jumpX.value);
    const z = Number(this.jumpZ.value);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      this.parseError.textContent = t('map.badCoords');
      return;
    }
    this.parseError.textContent = '';
    this.performJump(x, z, undefined, false);
  }

  private performJump(x: number, z: number, seed?: string, fromResult = false): void {
    const dripstoneResult = isDripstoneTab(this.sourceTab);
    const draw = this.spawnCheck.checked;
    this.onShowMap();
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x,
        z,
        seed,
        y: dripstoneResult && fromResult ? -56 : undefined,
        spawnCircles: draw,
      });
    };
    requestAnimationFrame(jump);
  }

  private paint(): void {
    this.exportSeedsBtn.disabled = !(this.listMode && this.hits.length > 0);
    this.exportAllBtn.disabled = this.hits.length === 0;
    if (!this.hits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    const showDetail = this.sourceTab !== 'LowYPitDripstoneCave';
    this.list.innerHTML = this.hits.map((hit, index) => {
      const full = Math.floor(AREA);
      const stats = showDetail
        ? `<div class="result-stats">
            <span>${hit.total}/${full} (${hit.ratio.toFixed(2)}%)</span>
            <span>${escapeText(t('results.cave'))} ${hit.cave}</span>
            <span>${escapeText(t('results.river'))} ${hit.river}</span>
          </div>`
        : `<div class="result-stats"><span>${hit.total}/${full} (${hit.ratio.toFixed(2)}%)</span></div>`;
      return `<article class="result-card" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>X ${hit.x}</span>
          <span>Z ${hit.z}</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        ${stats}
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.hits[Number(card.dataset.index)];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performJump(hit.x, hit.z, hit.seed, true);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.hits[Number(button.dataset.index)];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} 64 ${hit.z}`);
      });
    });
    applyI18n(this.list);
  }

  private exportAll(): void {
    const showDetail = this.sourceTab !== 'LowYPitDripstoneCave';
    const text = this.hits.map((hit) => line(hit, showDetail)).join('\n');
    void window.aio.saveFile('results.txt', text);
  }

  private exportSeeds(): void {
    const seeds = [...new Set(this.hits.map((hit) => hit.seed))];
    void window.aio.saveFile('seeds.txt', seeds.join('\n'));
  }
}

function line(hit: SearchHit, showRiver: boolean): string {
  const full = Math.floor(AREA);
  const base = `/tp ${hit.x} 64 ${hit.z} ${hit.total}/${full} (${hit.ratio.toFixed(2)}%)`;
  return showRiver ? `${base} cave=${hit.cave} river=${hit.river}` : base;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}
