import { parseCoords } from './coords';
import { escapeText, showNotice } from './dialog';
import { flowerMapVersion, type FlowerVersionTier } from './flower';
import type { GeodeView } from './geode';
import { applyI18n, biomeLabel, t } from './i18n';
import type { MapView } from './map';
import type {
  FlowerHit,
  FortressHit,
  GeodeHit,
  MonumentHit,
  RiverHit,
  SearchHit,
  SlimeHit,
  TrialHit,
  WitchHit,
} from './native';
import { RIVER_MAP_VERSION } from './river';
import { isDripstoneTab, type SearcherId } from './searchers';
import { slimeMapVersion, type SlimeVersionGroup } from './slime';
import { trialMapVersion, type TrialVersionTier } from './trial';
import { witchMapVersion, type WitchVersionGroup } from './witch';

/** 24 < r <= 128 刷怪环的格点总面积；溶洞与史莱姆共用同一口径，河流展示也沿用该分母。 */
const FULL_RING_AREA = 49640;
const RIVER_FULL_RING = 49640;

/** The trial statistics window, used for map overlays. */
export interface TrialWindowView {
  circle: boolean;
  radius: number;
  longSide: number;
  shortSide: number;
}

type Display = 'lowy' | 'slime' | 'witch' | 'river' | 'monument' | 'fortress' | 'flower' | 'trial' | 'geode';
export type WitchSortMode = 'height' | 'distance';

function displayFor(tab: SearcherId): Display | null {
  if (tab === 'LowYSwampHut') return 'witch';
  if (tab === 'River') return 'river';
  if (tab === 'SlimeChunk') return 'slime';
  if (tab === 'FlowerFarm') return 'flower';
  if (tab === 'TrialSpawner') return 'trial';
  if (tab === 'BuddingAmethyst') return 'geode';
  if (tab === 'DoubleMonument' || tab === 'MultiMonument') return 'monument';
  if (tab === 'NetherFortressCross' || tab === 'NetherFortressOverall') return 'fortress';
  if (isDripstoneTab(tab)) return 'lowy';
  return null;
}

function monumentFocus(hit: MonumentHit): { x: number; z: number } {
  if (hit.mode === 1) {
    return { x: Math.trunc((hit.x + hit.x2) / 2), z: Math.trunc((hit.z + hit.z2) / 2) };
  }
  if (hit.mode === 2) return { x: hit.areaMaxX, z: hit.areaMaxZ };
  return { x: hit.x, z: hit.z };
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
  private flowerHits: FlowerHit[] = [];
  private flowerVersion: FlowerVersionTier = 'latest';
  private trialHits: TrialHit[] = [];
  private trialVersion: TrialVersionTier = 'latest';
  private trialWindow: TrialWindowView = { circle: false, radius: 160, longSide: 320, shortSide: 320 };
  private trialRatio = 1 / 6;
  private geodeHits: GeodeHit[] = [];
  private geodeView: GeodeView = {
    version: '26.3',
    mapVersion: '26.3',
    listMode: false,
    minX: -16384,
    maxX: 16383,
    minZ: -16384,
    maxZ: 16383,
    prefilter: 0,
    verifyTop: 0,
    simulationDistance: 10,
    modernActivity: true,
  };
  private riverHits: RiverHit[] = [];
  private monumentHits: MonumentHit[] = [];
  private fortressHits: FortressHit[] = [];
  private monumentTab: SearcherId | null = null;
  private fortressTab: SearcherId | null = null;
  private slimeConvert = true;
  private slimeVersion: SlimeVersionGroup = 'modern';
  private witchVersion: WitchVersionGroup = 2;
  private witchSort: WitchSortMode | null = null;
  private sourceTab: SearcherId | null = null;
  private viewTab: SearcherId = 'map';
  private display: Display = 'lowy';
  private listMode = false;
  private map: MapView;

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

  clearSlime(convert: boolean, version: SlimeVersionGroup, listMode = false): void {
    this.slimeHits = [];
    this.slimeConvert = convert;
    this.slimeVersion = version;
    this.listMode = listMode;
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

  clearFlower(version: FlowerVersionTier, listMode = false): void {
    this.flowerHits = [];
    this.flowerVersion = version;
    this.listMode = listMode;
    if (displayFor(this.viewTab) === 'flower' || this.viewTab === 'map') this.display = 'flower';
    this.map.clearSpawnCircles();
    this.map.clearAreaOverlay();
    this.updateSpawnUi();
    this.paint();
  }

  setFlowerHits(hits: FlowerHit[], version: FlowerVersionTier): void {
    const previous = this.flowerHits.length;
    const changedVersion = version !== this.flowerVersion;
    this.flowerVersion = version;
    if (displayFor(this.viewTab) === 'flower' || this.viewTab === 'map') this.display = 'flower';
    this.flowerHits = hits;
    if (this.display !== 'flower') return;
    if (changedVersion || hits.length !== previous) this.renderFlower();
    else this.updateExportButtons();
  }

  clearTrial(
    version: TrialVersionTier,
    window: TrialWindowView,
    conversionRatio: number,
    listMode = false,
  ): void {
    this.trialHits = [];
    this.trialVersion = version;
    this.trialWindow = window;
    this.trialRatio = conversionRatio;
    this.listMode = listMode;
    if (displayFor(this.viewTab) === 'trial' || this.viewTab === 'map') this.display = 'trial';
    this.map.clearSpawnCircles();
    this.map.clearAreaOverlay();
    this.updateSpawnUi();
    this.paint();
  }

  setTrialHits(
    hits: TrialHit[],
    version: TrialVersionTier,
    window: TrialWindowView,
    conversionRatio: number,
  ): void {
    const previous = this.trialHits.length;
    const changedSetup = version !== this.trialVersion
      || window.circle !== this.trialWindow.circle
      || window.radius !== this.trialWindow.radius
      || window.longSide !== this.trialWindow.longSide
      || window.shortSide !== this.trialWindow.shortSide
      || conversionRatio !== this.trialRatio;
    this.trialVersion = version;
    this.trialWindow = window;
    this.trialRatio = conversionRatio;
    if (displayFor(this.viewTab) === 'trial' || this.viewTab === 'map') this.display = 'trial';
    this.trialHits = hits;
    if (this.display !== 'trial') return;
    if (changedSetup || hits.length !== previous) this.renderTrial();
    else this.updateExportButtons();
  }

  clearGeode(view: GeodeView): void {
    this.geodeHits = [];
    this.geodeView = view;
    this.listMode = view.listMode;
    if (displayFor(this.viewTab) === 'geode' || this.viewTab === 'map') this.display = 'geode';
    this.map.clearSpawnCircles();
    this.map.clearAreaOverlay();
    this.updateSpawnUi();
    this.paint();
  }

  setGeodeHits(hits: GeodeHit[], view: GeodeView): void {
    const changedSetup = view.version !== this.geodeView.version
      || view.listMode !== this.geodeView.listMode
      || view.minX !== this.geodeView.minX
      || view.maxX !== this.geodeView.maxX
      || view.minZ !== this.geodeView.minZ
      || view.maxZ !== this.geodeView.maxZ
      || view.prefilter !== this.geodeView.prefilter
      || view.verifyTop !== this.geodeView.verifyTop;
    const previous = this.geodeHits.length;
    this.geodeView = view;
    this.listMode = view.listMode;
    if (displayFor(this.viewTab) === 'geode' || this.viewTab === 'map') this.display = 'geode';
    this.geodeHits = hits;
    if (this.display !== 'geode') return;
    if (changedSetup || hits.length !== previous) this.renderGeode();
    else this.updateExportButtons();
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

  clearMonument(tab: SearcherId, listMode = false): void {
    this.monumentHits = [];
    this.monumentTab = tab;
    this.listMode = listMode;
    if (displayFor(this.viewTab) === 'monument' || this.viewTab === 'map') this.display = 'monument';
    this.map.clearSpawnCircles();
    this.paint();
  }

  setMonumentHits(hits: MonumentHit[], tab: SearcherId): void {
    this.monumentTab = tab;
    if (displayFor(this.viewTab) === 'monument' || this.viewTab === 'map') this.display = 'monument';
    if (this.display !== 'monument') {
      this.monumentHits = hits;
      return;
    }
    this.monumentHits = hits;
    this.renderMonument();
  }

  clearFortress(tab: SearcherId, listMode = false): void {
    this.fortressHits = [];
    this.fortressTab = tab;
    this.listMode = listMode;
    if (displayFor(this.viewTab) === 'fortress' || this.viewTab === 'map') this.display = 'fortress';
    this.map.clearSpawnCircles();
    this.paint();
  }

  setFortressHits(hits: FortressHit[], tab: SearcherId): void {
    this.fortressTab = tab;
    if (displayFor(this.viewTab) === 'fortress' || this.viewTab === 'map') this.display = 'fortress';
    if (this.display !== 'fortress') {
      this.fortressHits = hits;
      return;
    }
    this.fortressHits = hits;
    this.renderFortress();
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
    if (this.display === 'flower') {
      this.exportSeedsBtn.disabled = !(this.listMode && this.flowerHits.length > 0);
      this.exportAllBtn.disabled = this.flowerHits.length === 0;
      return;
    }
    if (this.display === 'trial') {
      this.exportSeedsBtn.disabled = !(this.listMode && this.trialHits.length > 0);
      this.exportAllBtn.disabled = this.trialHits.length === 0;
      return;
    }
    if (this.display === 'geode') {
      this.exportSeedsBtn.disabled = !(this.listMode && this.geodeHits.length > 0);
      this.exportAllBtn.disabled = this.geodeHits.length === 0;
      return;
    }
    if (this.display === 'monument') {
      this.exportSeedsBtn.disabled = !(this.listMode && this.monumentHits.length > 0);
      this.exportAllBtn.disabled = this.monumentHits.length === 0;
      return;
    }
    if (this.display === 'fortress') {
      this.exportSeedsBtn.disabled = !(this.listMode && this.fortressHits.length > 0);
      this.exportAllBtn.disabled = this.fortressHits.length === 0;
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

  private performFlowerJump(hit: FlowerHit): void {
    // 结果没有 Y；跳图用采样 y=256，关闭大型生物群系，并按结果方向画窗口矩形。
    this.spawnCheck.checked = false;
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y: 256,
        dimension: 0,
        mcVersion: flowerMapVersion(this.flowerVersion, this.map.getVersionName()),
        largeBiomes: false,
        areaOverlay: {
          kind: 'rect',
          x: hit.x,
          z: hit.z,
          width: hit.sideX,
          height: hit.sideZ,
          color: '#e6bf5a',
        },
        spawnCircles: false,
      });
    };
    requestAnimationFrame(jump);
  }

  private performTrialJump(hit: TrialHit): void {
    // Cards never show Y; the jump uses the engine's display height (-30) and draws the
    // statistics window (circle radius, or long/short rectangle sides) around the center.
    this.spawnCheck.checked = false;
    const window = this.trialWindow;
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y: -30,
        dimension: 0,
        mcVersion: trialMapVersion(this.trialVersion),
        largeBiomes: false,
        features: ['trial_chambers'],
        areaOverlay: window.circle
          ? { kind: 'circle', x: hit.x, z: hit.z, radius: Math.max(1, window.radius), color: '#d0a24a' }
          : {
            kind: 'rect',
            x: hit.x,
            z: hit.z,
            width: Math.max(1, window.longSide),
            height: Math.max(1, window.shortSide),
            color: '#d0a24a',
          },
        spawnCircles: false,
      });
    };
    requestAnimationFrame(jump);
  }

  private performGeodeJump(hit: GeodeHit): void {
    // 紫水晶结果跳点：保留地图当前 Y，并打开紫晶洞图层。
    // 1.21.5+ 画活动范围正方形（32×模距+16）；更早版本只画 128 格刷怪外圈，不画内圈。
    const view = this.geodeView;
    this.spawnCheck.checked = !view.modernActivity;
    const y = this.map.getY();
    const side = Math.max(1, 32 * view.simulationDistance + 16);
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.clearAreaOverlay();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y,
        dimension: 0,
        mcVersion: view.mapVersion,
        largeBiomes: false,
        features: ['geode'],
        spawnCircles: !view.modernActivity,
        spawnRadii: [128],
        areaOverlay: view.modernActivity
          ? { kind: 'rect', x: hit.x, z: hit.z, width: side, height: side, color: '#b07adf' }
          : null,
      });
    };
    requestAnimationFrame(jump);
  }

  private performRiverJump(hit: RiverHit): void {
    this.spawnCheck.checked = true;
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

  private performMonumentJump(hit: MonumentHit): void {
    const focus = monumentFocus(hit);
    this.spawnCheck.checked = hit.mode !== 2;
    const jump = () => {
      this.map.clearSpawnCircles();
      if (hit.mode === 1) {
        this.map.jumpTo({
          x: focus.x,
          z: focus.z,
          seed: hit.seed,
          y: 64,
          dimension: 0,
          mcVersion: '26.3',
          features: ['monument'],
          spawnCircles: false,
          spawnCenters: [
            { x: hit.x, z: hit.z, radii: [128] },
            { x: hit.x2, z: hit.z2, radii: [128] },
          ],
          spawnMidpoint: true,
          areaOverlay: null,
        });
        return;
      }
      if (hit.mode === 2) {
        this.map.jumpTo({
          x: focus.x,
          z: focus.z,
          seed: hit.seed,
          y: 64,
          dimension: 0,
          mcVersion: '26.3',
          features: ['monument'],
          spawnCircles: false,
          areaOverlay: {
            kind: 'rect',
            x: focus.x,
            z: focus.z,
            width: 257,
            height: 257,
            color: '#e6bf5a',
          },
        });
        return;
      }
      this.map.jumpTo({
        x: focus.x,
        z: focus.z,
        seed: hit.seed,
        y: 64,
        dimension: 0,
        mcVersion: '26.3',
        features: ['monument'],
        spawnCircles: true,
      });
    };
    requestAnimationFrame(jump);
  }

  private performFortressJump(hit: FortressHit): void {
    this.spawnCheck.checked = true;
    const radii = this.fortressTab === 'NetherFortressOverall' ? [128] : [64];
    const jump = () => {
      this.map.clearSpawnCircles();
      this.map.jumpTo({
        x: hit.x,
        z: hit.z,
        seed: hit.seed,
        y: 64,
        dimension: -1,
        mcVersion: '26.3',
        features: ['fortress'],
        spawnCircles: true,
        spawnRadii: radii,
      });
    };
    requestAnimationFrame(jump);
  }

  private renderFlower(): void {
    this.updateExportButtons();
    if (!this.flowerHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    const legacy = this.flowerVersion === 'legacy';
    this.list.innerHTML = this.flowerHits.map((hit, index) => {
      const stats = [
        `<span>${escapeText(t('flower.flowerArea', { area: hit.flowerArea }))}</span>`,
        legacy ? '' : `<span>${escapeText(t('flower.paleArea', { area: hit.paleArea }))}</span>`,
        `<span>${escapeText(t('flower.swampArea', { area: hit.swampArea }))}</span>`,
        `<span>${escapeText(t('flower.nether', { biome: biomeLabel(hit.nether) }))}</span>`,
        flowerBonusText(hit.bonus),
      ].filter(Boolean).join('');
      return `<article class="result-card result-flower" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${hit.x}, ${hit.z})</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        <div class="result-stats">${stats}</div>
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.flowerHits[Number(card.dataset.index)];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performFlowerJump(hit);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.flowerHits[Number(button.dataset.index)];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} 64 ${hit.z}`);
      });
    });
    applyI18n(this.list);
  }

  private renderTrial(): void {
    this.updateExportButtons();
    if (!this.trialHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    this.list.innerHTML = this.trialHits.map((hit, index) => {
      const stats = [
        `<span>${escapeText(t('trial.converted', { count: trialConverted(hit, this.trialRatio) }))}</span>`,
        `<span>${escapeText(t('trial.totalSpawners', { count: hit.spawners }))}</span>`,
        `<span>${escapeText(t('trial.fastSpawners', { count: hit.fastSpawners }))}</span>`,
        `<span>${escapeText(t('trial.slowSpawners', { count: hit.slowSpawners }))}</span>`,
        `<span>${escapeText(t('trial.structures', { count: hit.structures }))}</span>`,
      ].join('');
      return `<article class="result-card result-trial" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${hit.x}, ${hit.z})</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        <div class="result-stats">${stats}</div>
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.trialHits[Number(card.dataset.index)];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performTrialJump(hit);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.trialHits[Number(button.dataset.index)];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} -30 ${hit.z}`);
      });
    });
    applyI18n(this.list);
  }

  private renderGeode(): void {
    this.updateExportButtons();
    if (!this.geodeHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    const approximate = this.geodeView.prefilter > 0;
    this.list.innerHTML = this.geodeHits.map((hit, index) => {
      const verified = hit.verified
        ? ` <span class="badge">${escapeText(t('geode.card.verified'))}</span>`
        : '';
      const listed = hit.listedBudding >= 0
        ? ` (${escapeText(t('geode.card.listed', { count: hit.listedBudding }))})`
        : '';
      const approx = approximate
        ? `<span>${escapeText(t('geode.card.approximate'))}</span>`
        : '';
      return `<article class="result-card result-geode" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${hit.x}, ${hit.z})</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        <div class="result-stats">
          <span>${escapeText(t('geode.card.budding', { count: hit.budding }))}${escapeText(listed)}${verified}</span>
          <span>${escapeText(t('geode.card.geodes', { count: hit.geodes }))}</span>
          ${approx}
        </div>
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.geodeHits[Number(card.dataset.index)];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performGeodeJump(hit);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.geodeHits[Number(button.dataset.index)];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} 64 ${hit.z}`);
      });
    });
    applyI18n(this.list);
  }

  private renderMonument(): void {
    this.updateExportButtons();
    if (!this.monumentHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    const multi = this.monumentTab === 'MultiMonument';
    this.list.innerHTML = this.monumentHits.map((hit, index) => {
      const focus = monumentFocus(hit);
      const low = hit.lowEfficiency ? `<span>${escapeText(t('monument.lowEfficiency'))}</span>` : '';
      let detail: string;
      let dummies = '';
      let extra = '';
      if (!multi) {
        detail = `<span>dx=${hit.dx} dz=${hit.dz}</span>`;
      } else if (hit.mode === 1) {
        detail = `<span>${escapeText(crossingLabel(hit.count))}</span>`
          + `<span>${escapeText(t('monument.totalArea'))}=${hit.area}</span>`;
        dummies = `<div class="result-dummies">`
          + `<div>${escapeText(t('monument.dummy1'))} (${hit.x}, ${hit.z})</div>`
          + `<div>${escapeText(t('monument.dummy2'))} (${hit.x2}, ${hit.z2})</div>`
          + `</div>`;
      } else if (hit.mode === 2) {
        detail = `<span>${escapeText(crossingLabel(hit.count))}</span>`
          + `<span>${escapeText(t('monument.totalArea'))}=${hit.areaMax}</span>`;
        // 单门：主世界上限点 / 8（向下取整）就是下界门坐标；只展示，不参与跳转/复制。
        const gateX = Math.floor(hit.areaMaxX / 8);
        const gateZ = Math.floor(hit.areaMaxZ / 8);
        extra = `<div class="result-gate">${escapeText(t('monument.gate'))} (${gateX}, ${gateZ})</div>`;
      } else {
        detail = `<span>${escapeText(crossingLabel(hit.count))}</span><span>S=${hit.area}</span>`;
      }
      return `<article class="result-card result-monument" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${focus.x}, ${focus.z})</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        ${dummies}
        <div class="result-stats">
          ${detail}
          <span>${escapeText(oceanLabel(hit.oceanType))}</span>
          ${low}
        </div>
        ${extra}
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.monumentHits[Number(card.dataset.index)];
        if (!hit) return;
        const focus = monumentFocus(hit);
        this.jumpX.value = String(focus.x);
        this.jumpZ.value = String(focus.z);
        this.performMonumentJump(hit);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.monumentHits[Number(button.dataset.index)];
        if (!hit) return;
        const focus = monumentFocus(hit);
        void navigator.clipboard.writeText(`/tp ${focus.x} 64 ${focus.z}`);
      });
    });
    applyI18n(this.list);
  }

  private renderFortress(): void {
    this.updateExportButtons();
    if (!this.fortressHits.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.results.empty"></div>`;
      applyI18n(this.list);
      return;
    }
    const span = this.fortressTab === 'NetherFortressOverall';
    this.list.innerHTML = this.fortressHits.map((hit, index) => {
      const detail = span
        ? `<span>${escapeText(t('fortress.spanLabel'))} ${hit.spanX}*${hit.spanY}*${hit.spanZ}</span>`
          + `<span>${escapeText(t('fortress.areaLabel'))} ${hit.area}</span>`
        : `<span>${escapeText(crossingLabel(hit.crossings))}</span>`;
      return `<article class="result-card result-fortress" data-index="${index}">
        <div class="result-seed">${escapeText(hit.seed)}</div>
        <div class="result-coords">
          <span>(${hit.x}, ${hit.y}, ${hit.z})</span>
          <button type="button" class="icon-btn result-copy" title="copy" data-index="${index}" aria-label="copy">⧉</button>
        </div>
        <div class="result-stats">${detail}</div>
      </article>`;
    }).join('');
    this.list.querySelectorAll<HTMLElement>('.result-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        if (target.closest('.result-copy')) return;
        const hit = this.fortressHits[Number(card.dataset.index)];
        if (!hit) return;
        this.jumpX.value = String(hit.x);
        this.jumpZ.value = String(hit.z);
        this.performFortressJump(hit);
      });
    });
    this.list.querySelectorAll<HTMLButtonElement>('.result-copy').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const hit = this.fortressHits[Number(button.dataset.index)];
        if (!hit) return;
        void navigator.clipboard.writeText(`/tp ${hit.x} 64 ${hit.z}`);
      });
    });
    applyI18n(this.list);
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
    if (this.display === 'flower') {
      this.renderFlower();
      return;
    }
    if (this.display === 'trial') {
      this.renderTrial();
      return;
    }
    if (this.display === 'geode') {
      this.renderGeode();
      return;
    }
    if (this.display === 'monument') {
      this.renderMonument();
      return;
    }
    if (this.display === 'fortress') {
      this.renderFortress();
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
      this.saveGrouped(this.witchHits, 'witch-results.txt',
        (hit) => `/tp ${hit.x} ${hit.y} ${hit.z} dist=${distance(hit.x, hit.z)}`);
      return;
    }
    if (this.display === 'river') {
      this.saveGrouped(this.riverHits, 'river-results.txt',
        (hit) => `/tp ${hit.x} 64 ${hit.z} score=${hit.score} river=${hit.river} cave=${hit.cave} dist=${distance(hit.x, hit.z)}`);
      return;
    }
    if (this.display === 'slime') {
      this.saveGrouped(this.slimeHits, 'slime-results.txt',
        (hit) => `/tp ${hit.x} -64 ${hit.z} equiv=${formatArea(hit.areaEquiv)} area=${hit.area} chunks=${hit.chunks} dist=${distance(hit.x, hit.z)}`);
      return;
    }
    if (this.display === 'monument') {
      const multi = this.monumentTab === 'MultiMonument';
      this.saveGrouped(this.monumentHits, 'monument-results.txt', (hit) => {
        const focus = monumentFocus(hit);
        if (!multi) {
          const low = hit.lowEfficiency ? ' low' : '';
          return `/tp ${focus.x} 50 ${focus.z} dx=${hit.dx} dz=${hit.dz} dist=${distance(focus.x, focus.z)}`
            + ` type=${oceanTypeName(hit.oceanType)}${low}`;
        }
        const area = hit.mode === 2 ? hit.areaMax : hit.area;
        const parts = [
          `/tp ${focus.x} 50 ${focus.z}`,
          crossingLabel(hit.count),
          `S=${area}`,
          `singleArea=${hit.singleArea}`,
          `single=${hit.singleX} ${hit.singleZ}`,
          `d1=${hit.x} ${hit.z}`,
        ];
        if (hit.mode === 1) parts.push(`d2=${hit.x2} ${hit.z2}`, `dual=${hit.area}`);
        parts.push(`upper=${hit.areaMax}`);
        if (hit.mode === 2) {
          // 单门导出附带下界侧地狱门坐标（主世界 / 8 向下取整），与结果卡一致。
          parts.push(`gate=${Math.floor(hit.areaMaxX / 8)} ${Math.floor(hit.areaMaxZ / 8)}`);
        }
        parts.push(
          `dist=${distance(focus.x, focus.z)}`,
          `type=${oceanTypeName(hit.oceanType)}${hit.lowEfficiency ? ' low' : ''}`,
        );
        return parts.join(' ');
      });
      return;
    }
    if (this.display === 'fortress') {
      const span = this.fortressTab === 'NetherFortressOverall';
      this.saveGrouped(this.fortressHits, 'fortress-results.txt', (hit) => {
        if (span) {
          return `/tp ${hit.x} 48 ${hit.z} span=${hit.spanX}*${hit.spanY}*${hit.spanZ} area=${hit.area} dist=${distance(hit.x, hit.z)}`;
        }
        return `/tp ${hit.x} ${hit.y} ${hit.z} ${crossingLabel(hit.crossings)} dist=${distance(hit.x, hit.z)}`;
      });
      return;
    }
    if (this.display === 'flower') {
      this.saveGrouped(this.flowerHits, 'flower-results.txt',
        (hit) => flowerLine(hit, this.flowerVersion));
      return;
    }
    if (this.display === 'trial') {
      this.saveGrouped(this.trialHits, 'trial-results.txt', (hit) => trialLine(hit, this.trialRatio));
      return;
    }
    if (this.display === 'geode') {
      this.saveGrouped(this.geodeHits, this.geodeFileName(this.geodeHits),
        (hit) => geodeLine(hit, this.geodeView));
      return;
    }
    const showDetail = this.sourceTab !== 'LowYPitDripstoneCave';
    this.saveGrouped(this.hits, 'results.txt', (hit) => {
      const detail = showDetail
        ? ` area=${hit.total} cave=${hit.cave} river=${hit.river}`
        : ` area=${hit.total}`;
      return `/tp ${hit.x} 64 ${hit.z}${detail} dist=${distance(hit.x, hit.z)}`;
    });
  }

  private saveText(fileName: string, text: string): void {
    void window.aio.saveFile(fileName, text).then((ok) => {
      if (!ok) showNotice(t('common.error.save-failed'));
    });
  }

  private saveGrouped<T extends { seed: string }>(
    hits: T[],
    fileName: string,
    line: (hit: T) => string,
  ): void {
    if (this.listMode) {
      const groups = groupBySeed(hits);
      const text = groups
        .map((group) => `${group.seed}\n${group.hits.map(line).join('\n')}`)
        .join('\n\n');
      this.saveText(fileName, text);
      return;
    }
    this.saveText(fileName, hits.map(line).join('\n'));
  }

  private geodeFileName(hits: GeodeHit[]): string {
    const view = this.geodeView;
    const range = `x${view.minX}..${view.maxX}_z${view.minZ}..${view.maxZ}`;
    const approx = view.prefilter > 0 ? '1' : '0';
    const seed = view.listMode
      ? `seeds-${new Set(hits.map((hit) => hit.seed)).size}`
      : `seed-${hits[0]?.seed ?? '0'}`;
    return `geode_${seed}_ver-${view.version}_${range}_approx-${approx}_${exportStamp()}.txt`;
  }

  private exportSeeds(): void {
    const seedSource = this.display === 'slime' ? this.slimeHits
      : this.display === 'witch' ? this.witchHits
        : this.display === 'river' ? this.riverHits
          : this.display === 'flower' ? this.flowerHits
            : this.display === 'trial' ? this.trialHits
              : this.display === 'geode' ? this.geodeHits
                : this.display === 'monument' ? this.monumentHits
                  : this.display === 'fortress' ? this.fortressHits
                    : this.hits;
    const seeds = [...new Set(seedSource.map((hit) => hit.seed))];
    this.saveText('seeds.txt', seeds.join('\n'));
  }
}

function distance(x: number, z: number): number {
  return Math.round(Math.hypot(x, z));
}

function oceanTypeName(value: number): string {
  if (value === 1) return 'cold';
  if (value === 2) return 'frozen';
  return 'others';
}

function oceanLabel(value: number): string {
  const key = `monument.ocean.${oceanTypeName(value)}`;
  const text = t(key);
  return text === key ? oceanTypeName(value) : text;
}

/** 2/3/4 → 二联/三联/四联（英文 Double/Triple/Quadruple）。 */
function crossingLabel(count: number): string {
  const key = `common.crossing.${count}`;
  const text = t(key);
  return text === key ? String(count) : text;
}

function groupBySeed<T extends { seed: string }>(hits: T[]): Array<{ seed: string; hits: T[] }> {
  const groups = new Map<string, T[]>();
  for (const hit of hits) {
    const list = groups.get(hit.seed);
    if (list) list.push(hit);
    else groups.set(hit.seed, [hit]);
  }
  return [...groups.entries()].map(([seed, items]) => ({ seed, hits: items }));
}

function formatArea(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function flowerSide(hit: FlowerHit): string {
  return hit.sideX === hit.sideZ ? String(hit.sideX) : `${hit.sideX}x${hit.sideZ}`;
}

function flowerBonusText(bonus: string): string {
  const labels: string[] = [];
  if (bonus.includes('wildflowers')) labels.push(t('flower.bonusWildflowers'));
  if (bonus.includes('pink_petals')) labels.push(t('flower.bonusCherry'));
  if (!labels.length) return '';
  return `<span>${escapeText(t('flower.bonus'))} ${labels.map((label) => escapeText(label)).join('/')}</span>`;
}

function flowerLine(hit: FlowerHit, tier: FlowerVersionTier): string {
  let line = `/tp ${hit.x} 64 ${hit.z} side=${flowerSide(hit)} flowerArea=${hit.flowerArea}`;
  if (tier !== 'legacy') line += ` paleArea=${hit.paleArea}`;
  line += ` swampArea=${hit.swampArea} nether=${hit.nether}`;
  if (hit.bonus) line += ` bonus=${hit.bonus}`;
  return line;
}

/** Card and export share the same 2-decimal conversion value. */
function trialConverted(hit: TrialHit, ratio: number): string {
  return (hit.fastSpawners + hit.slowSpawners * ratio).toFixed(2);
}

/** Export keeps the engine's display height (-30); the card itself never shows Y. */
function trialLine(hit: TrialHit, ratio: number): string {
  return `/tp ${hit.x} -30 ${hit.z} converted=${trialConverted(hit, ratio)}`
    + ` total=${hit.spawners} fast=${hit.fastSpawners} slow=${hit.slowSpawners} count=${hit.structures}`;
}

/** 紫水晶导出：距离以矩形中点为准；不写版本/模型/复核元数据，也不加 verify 标记。 */
function geodeLine(hit: GeodeHit, view: GeodeView): string {
  const centerX = Math.trunc((view.minX + view.maxX) / 2);
  const centerZ = Math.trunc((view.minZ + view.maxZ) / 2);
  const distance = Math.round(Math.hypot(hit.x - centerX, hit.z - centerZ));
  return `/tp ${hit.x} 64 ${hit.z} budding=${hit.budding} geodes=${hit.geodes} dist=${distance}`;
}

function exportStamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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
