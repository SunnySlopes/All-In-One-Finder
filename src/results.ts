import { parseCoords } from './coords';
import { escapeText } from './dialog';
import { applyI18n, t } from './i18n';
import type { MapView } from './map';
import type { RiverHit, SearchHit, SlimeHit, WitchHit } from './native';
import { RIVER_MAP_VERSION } from './river';
import { isDripstoneTab, type SearcherId } from './searchers';
import { slimeMapVersion, type SlimeVersionGroup } from './slime';
import { witchMapVersion, type WitchVersionGroup } from './witch';

/** 24 < r <= 128 刷怪环的格点总面积；溶洞与史莱姆共用同一口径，河流展示也沿用该分母。 */
const FULL_RING_AREA = 49640;
const RIVER_FULL_RING = 49640;

type Display = 'lowy' | 'slime' | 'witch' | 'river';
export type WitchSortMode = 'height' | 'distance';

function displayFor(tab: SearcherId): Display | null {
  if (tab === 'LowYSwampHut') return 'witch';
  if (tab === 'River') return 'river';
  if (tab === 'SlimeChunk') return 'slime';
  if (isDripstoneTab(tab)) return 'lowy';
  return null;
}

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
  private slimeHits: SlimeHit[] = [];
  private witchHits: WitchHit[] = [];
  private riverHits: RiverHit[] = [];
  private slimeConvert = true;
  private slimeVersion: SlimeVersionGroup = 'modern';
  private witchVersion: WitchVersionGroup = 2;
  private witchSort: WitchSortMode | null = null;
  private sourceTab: SearcherId | null = null;
  private viewTab: SearcherId = 'map';
  private display: Display = 'lowy';
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
          <label data-i18n="common.map.coordX"></label>
          <input id="r-x" type="number" value="0" />
          <label data-i18n="common.map.coordZ"></label>
          <input id="r-z" type="number" value="0" />
          <button type="button" id="r-go" data-i18n="common.map.goto"></button>
        </div>
        <label data-i18n="common.map.parseText"></label>
        <div class="row">
          <textarea id="r-parse" rows="2" data-i18n-placeholder="common.map.parseHint"></textarea>
          <button type="button" id="r-parse-btn" data-i18n="common.map.parse"></button>
        </div>
        <div class="hint" id="r-parse-error"></div>
        <label class="feature" id="r-spawn-wrap">
          <input id="r-spawn" type="checkbox" />
          <span data-i18n="common.results.drawSpawn"></span>
        </label>
      </div>
      <div id="r-list" class="results-list"></div>
      <div class="results-export row">
        <button type="button" id="r-export-seeds" data-i18n="common.results.exportSeeds" disabled></button>
        <button type="button" id="r-export-all" data-i18n="common.results.exportAll" disabled></button>
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
    const next = displayFor(tab);
    if (next) this.display = next;
    this.updateSpawnUi();
    this.paint();
  }

  clear(sourceTab: SearcherId | null = null, listMode = false): void {
    this.hits = [];
    this.sourceTab = sourceTab;
    this.listMode = listMode;
    this.display = (sourceTab ? displayFor(sourceTab) : displayFor(this.viewTab)) ?? 'lowy';
    this.map.clearSpawnCircles();
    this.updateSpawnUi();
    this.paint();
  }

  setHits(hits: SearchHit[], sourceTab: SearcherId, listMode: boolean): void {
    this.hits = hits;
    this.sourceTab = sourceTab;
    this.listMode = listMode;
    this.display = displayFor(sourceTab) ?? 'lowy';
    this.updateSpawnUi();
    this.paint();
  }

  clearSlime(convert: boolean, version: SlimeVersionGroup): void {
    this.slimeHits = [];
    this.slimeConvert = convert;
    this.slimeVersion = version;
    if (this.viewTab === 'SlimeChunk' || this.viewTab === 'map') this.display = 'slime';
    this.map.clearSpawnCircles();
    this.updateSpawnUi();
    this.paint();
  }

  setSlimeHits(hits: SlimeHit[], convert: boolean, version: SlimeVersionGroup): void {
    this.slimeHits = hits;
    this.slimeConvert = convert;
    this.slimeVersion = version;
    if (this.viewTab === 'SlimeChunk' || this.viewTab === 'map') this.display = 'slime';
    this.updateSpawnUi();
    this.paint();
  }

  clearWitch(version: WitchVersionGroup, listMode = false): void {
    this.witchHits = [];
    this.witchVersion = version;
    this.witchSort = null;
    this.listMode = listMode;
    if (displayFor(this.viewTab) === 'witch' || this.viewTab === 'map') this.display = 'witch';
    this.map.clearSpawnCircles();
    this.updateSpawnUi();
    this.paint();
  }

  /**
   * 女巫小屋结果按内核产生顺序追加，默认不排序、不截断。
   * 只有用户点过排序按钮（witchSort 非空）后才按当前模式重排。
   */
  setWitchHits(hits: WitchHit[], version: WitchVersionGroup): void {
    const changedVersion = version !== this.witchVersion;
    this.witchVersion = version;
    if (displayFor(this.viewTab) === 'witch' || this.viewTab === 'map') this.display = 'witch';
    if (this.display !== 'witch') {
      this.witchHits = hits;
      return;
    }

    const previous = this.witchHits.length;
    if (this.witchSort) {
      this.witchHits = sortWitchHits(hits, this.witchSort);
      this.renderWitch(true);
      return;
    }
    this.witchHits = hits;
    const rendered = this.list.querySelectorAll('.result-card').length;
    if (changedVersion || hits.length < previous || rendered !== previous) {
      this.renderWitch(true);
    } else if (hits.length > previous) {
      this.renderWitch(false, previous);
    } else {
      this.updateExportButtons();
    }
  }

  clearRiver(listMode = false): void {
    this.riverHits = [];
    this.listMode = listMode;
    if (displayFor(this.viewTab) === 'river' || this.viewTab === 'map') this.display = 'river';
    this.map.clearSpawnCircles();
    this.updateSpawnUi();
    this.paint();
  }

  setRiverHits(hits: RiverHit[]): void {
    if (displayFor(this.viewTab) === 'river' || this.viewTab === 'map') this.display = 'river';
    if (this.display !== 'river') {
      this.riverHits = hits;
      return;
    }
    const previous = this.riverHits.length;
    this.riverHits = hits;
    const rendered = this.list.querySelectorAll('.result-card').length;
    if (hits.length < previous || rendered !== previous) {
      this.renderRiver(true);
    } else if (hits.length > previous) {
      this.renderRiver(false, previous);
    } else {
      this.updateExportButtons();
    }
  }

  /** 女巫小屋列表模式的排序按钮入口：只重排当前结果，不触发重新搜索。 */
  sortWitch(mode: WitchSortMode): void {
    this.witchSort = mode;
    this.witchHits = sortWitchHits(this.witchHits, mode);
    if (this.display === 'witch') this.renderWitch(true);
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
      this.parseError.textContent = t('common.map.badParse');
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
      this.parseError.textContent = t('common.map.badCoords');
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
        dimension: dripstoneResult ? 0 : undefined,
        spawnCircles: draw,
      });
    };
    requestAnimationFrame(jump);
  }

  private performSlimeJump(hit: SlimeHit): void {
    this.spawnCheck.checked = true;
    this.onShowMap();
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y: -64,
        dimension: 0,
        mcVersion: slimeMapVersion(this.slimeVersion),
        slimeChunks: true,
        spawnCircles: true,
      });
    };
    requestAnimationFrame(jump);
  }

  private updateExportButtons(): void {
    if (this.display === 'witch' || this.display === 'river') {
      const source = this.display === 'witch' ? this.witchHits : this.riverHits;
      this.exportSeedsBtn.disabled = !(this.listMode && source.length > 0);
      this.exportAllBtn.disabled = source.length === 0;
      return;
    }
    if (this.display === 'slime') {
      this.exportSeedsBtn.disabled = this.slimeHits.length === 0;
      this.exportAllBtn.disabled = this.slimeHits.length === 0;
      return;
    }
    this.exportSeedsBtn.disabled = !(this.listMode && this.hits.length > 0);
    this.exportAllBtn.disabled = this.hits.length === 0;
  }

  private performWitchJump(hit: WitchHit): void {
    // 点击结果固定主世界 + y=64 + 打开女巫小屋图标；不切大型生物群系、不画刷怪环。
    this.spawnCheck.checked = false;
    this.onShowMap();
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y: 64,
        dimension: 0,
        mcVersion: witchMapVersion(this.witchVersion),
        features: ['swamp_hut'],
        spawnCircles: false,
      });
    };
    requestAnimationFrame(jump);
  }

  private performRiverJump(hit: RiverHit): void {
    this.spawnCheck.checked = true;
    this.onShowMap();
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y: hit.sampleY,
        dimension: 0,
        mcVersion: RIVER_MAP_VERSION,
        spawnCircles: true,
      });
    };
    requestAnimationFrame(jump);
  }

  private paint(): void {
    if (this.display === 'slime') {
      this.paintSlime();
      return;
    }
    if (this.display === 'witch') {
      this.renderWitch(true);
      return;
    }
    if (this.display === 'river') {
      this.renderRiver(true);
      return;
    }
    this.updateExportButtons();
    if (!this.hits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    const showDetail = this.sourceTab !== 'LowYPitDripstoneCave';
    this.list.innerHTML = this.hits.map((hit, index) => {
      const full = FULL_RING_AREA;
      const stats = showDetail
        ? `<div class="result-stats">
            <span>${hit.total}/${full} (${hit.ratio.toFixed(2)}%)</span>
            <span>${escapeText(t('dripstonecave.caveLabel'))} ${hit.cave}</span>
            <span>${escapeText(t('dripstonecave.riverLabel'))} ${hit.river}</span>
          </div>`
        : `<div class="result-stats"><span>${hit.total}/${full} (${hit.ratio.toFixed(2)}%)</span></div>`;
      return `<article class="result-card" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${hit.x}, ${hit.z})</span>
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

  private paintSlime(): void {
    this.exportSeedsBtn.disabled = this.slimeHits.length === 0;
    this.exportAllBtn.disabled = this.slimeHits.length === 0;
    if (!this.slimeHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    this.list.innerHTML = this.slimeHits.map((hit, index) => {
      const equivalent = this.slimeConvert
        ? `<span>${escapeText(t('slime.equivalentArea'))} ${formatArea(hit.areaEquiv)}</span>`
        : '';
      return `<article class="result-card result-slime" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${hit.x}, ${hit.z})</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        <div class="result-stats">
          ${equivalent}
          <span>${escapeText(t('slime.generatedArea'))} ${hit.area}</span>
          <span>${escapeText(t('slime.chunks'))} ${hit.chunks}</span>
        </div>
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.slimeHits[Number(card.dataset.index)];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performSlimeJump(hit);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.slimeHits[Number(button.dataset.index)];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} -64 ${hit.z}`);
      });
    });
    applyI18n(this.list);
  }

  /**
   * 女巫小屋结果：默认按内核实际扫描顺序增量 append（不整表重绘），
   * 只有排序模式或清空/切 Tab 时才整表重画。
   */
  private renderWitch(full: boolean, from = 0): void {
    this.updateExportButtons();
    if (!this.witchHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    if (full || from === 0 || !this.list.querySelector('.result-card')) {
      this.list.innerHTML = this.witchHits.map((hit, index) => witchCard(hit, index)).join('');
      this.bindWitchCards(0);
    } else {
      this.list.insertAdjacentHTML('beforeend', this.witchHits
        .slice(from)
        .map((hit, offset) => witchCard(hit, from + offset))
        .join(''));
      this.bindWitchCards(from);
    }
    applyI18n(this.list);
  }

  private bindWitchCards(from: number): void {
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      const index = Number(card.dataset.index);
      if (!(index >= from) || card.dataset.bound === '1') return;
      card.dataset.bound = '1';
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.witchHits[index];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performWitchJump(hit);
      });
      card.querySelector<HTMLButtonElement>('.result-copy')?.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.witchHits[index];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} ${hit.y} ${hit.z}`);
      });
    });
  }

  private renderRiver(full: boolean, from = 0): void {
    this.updateExportButtons();
    if (!this.riverHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    if (full || from === 0 || !this.list.querySelector('.result-card')) {
      this.list.innerHTML = this.riverHits.map((hit, index) => riverCard(hit, index)).join('');
      this.bindRiverCards(0);
    } else {
      this.list.insertAdjacentHTML('beforeend', this.riverHits
        .slice(from)
        .map((hit, offset) => riverCard(hit, from + offset))
        .join(''));
      this.bindRiverCards(from);
    }
    applyI18n(this.list);
  }

  private bindRiverCards(from: number): void {
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      const index = Number(card.dataset.index);
      if (!(index >= from) || card.dataset.bound === '1') return;
      card.dataset.bound = '1';
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.riverHits[index];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performRiverJump(hit);
      });
      card.querySelector<HTMLButtonElement>('.result-copy')?.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.riverHits[index];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} 64 ${hit.z}`);
      });
    });
  }

  private exportAll(): void {
    if (this.display === 'witch') {
      const text = this.witchHits.map((hit) =>
        `/tp ${hit.x} ${hit.y} ${hit.z} dir=${hit.dir} size=${hit.sizeX}x${hit.sizeZ} wet=${hit.wet}`).join('\n');
      void window.aio.saveFile('witch-results.txt', text);
      return;
    }
    if (this.display === 'river') {
      const text = this.riverHits.map((hit) =>
        `/tp ${hit.x} 64 ${hit.z} ${hit.score}/${RIVER_FULL_RING} (${(hit.score / RIVER_FULL_RING * 100).toFixed(2)}%) cave=${hit.cave} river=${hit.river}`).join('\n');
      void window.aio.saveFile('river-results.txt', text);
      return;
    }
    if (this.display === 'slime') {
      const text = this.slimeHits.map((hit) => {
        const equiv = this.slimeConvert ? ` equiv=${formatArea(hit.areaEquiv)}` : '';
        return `/tp ${hit.x} -64 ${hit.z}${equiv} area=${hit.area} chunks=${hit.chunks}`;
      }).join('\n');
      void window.aio.saveFile('slime-results.txt', text);
      return;
    }
    const showDetail = this.sourceTab !== 'LowYPitDripstoneCave';
    const text = this.hits.map((hit) => line(hit, showDetail)).join('\n');
    void window.aio.saveFile('results.txt', text);
  }

  private exportSeeds(): void {
    const seedSource = this.display === 'slime' ? this.slimeHits
      : this.display === 'witch' ? this.witchHits
        : this.display === 'river' ? this.riverHits
          : this.hits;
    const seeds = [...new Set(seedSource.map((hit) => hit.seed))];
    void window.aio.saveFile('seeds.txt', seeds.join('\n'));
  }
}

function formatArea(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function line(hit: SearchHit, showRiver: boolean): string {
  const full = FULL_RING_AREA;
  const base = `/tp ${hit.x} 64 ${hit.z} ${hit.total}/${full} (${hit.ratio.toFixed(2)}%)`;
  return showRiver ? `${base} cave=${hit.cave} river=${hit.river}` : base;
}

function witchCard(hit: WitchHit, index: number): string {
  return `<article class="result-card result-witch" data-index="${index}">
    <div class="result-seed">${escapeText(hit.seed)}</div>
    <div class="result-coords">
      <span>(${hit.x}, ${hit.z})</span>
      <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
    </div>
    <div class="result-stats">
      <span>${escapeText(t('lowyswamphut.yLabel'))} ${hit.y}</span>
    </div>
  </article>`;
}

function riverCard(hit: RiverHit, index: number): string {
  const pct = (hit.score / RIVER_FULL_RING * 100).toFixed(2);
  return `<article class="result-card result-river" data-index="${index}">
    <div class="result-seed">${escapeText(hit.seed)}</div>
    <div class="result-coords">
      <span>(${hit.x}, ${hit.z})</span>
      <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
    </div>
    <div class="result-stats">
      <span>${hit.score}/${RIVER_FULL_RING} (${pct}%)</span>
      <span>${escapeText(t('river.areaLabel'))} ${hit.river}</span>
      <span>${escapeText(t('river.caveLabel'))} ${hit.cave}</span>
    </div>
  </article>`;
}

/** 点击排序按钮时只重排当前结果：距离按 x²+z² 升序，高度按 y 升序。 */
function sortWitchHits(hits: WitchHit[], mode: WitchSortMode): WitchHit[] {
  const sorted = [...hits];
  if (mode === 'distance') {
    sorted.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
  } else {
    sorted.sort((a, b) => a.y - b.y);
  }
  return sorted;
}
