import { ask, showNotice } from './dialog';
import { applyI18n, t } from './i18n';
import {
  call,
  type McVersion,
  type RiverStatus,
  type RiverVersion,
  type RiverWarning,
  RIVER_WARN_SPAN_GT_24,
  RIVER_WARN_YMIN_GT_NEG58,
} from './native';
import { escapeAttr, formatDuration, messageOf, applyRunLock, RunTimer, applyForm, captureForm } from './panel-utils';
import type { ResultsColumn } from './results';
import type { SearcherId } from './searchers';

export const RIVER_MAP_VERSION = '26.3';

type SeedMode = 'single' | 'list';
/** 模式：河流（不统计溶洞）/ 溶洞（河流+溶洞）。 */
type RiverMode = 'river' | 'cave';

/** 24 < r <= 128 的完整环面积：π × (128² − 24²) ≈ 49662，与上游一致。 */
const FULL_RING = 49662;
const MIN_RATIO = 50;
const MAX_RATIO = 95;
const DEFAULT_RATIO = 70;
const MIN_AREA = 24831;
const MAX_AREA = 47178;
const DEFAULT_AREA = 34763;
/** 最低等效溶洞占比/面积的上游约束。 */
/**
 * 溶洞门槛在上游的允许区间（60~95 / ≥29784）。
 * 仅作文档参考：本页**不据此校验**——溶洞默认值是"河流默认 × 折算系数"，
 * 天然可能低于这些下限，按约定原样填入并允许用户修改。
 */
// 溶洞等效面积占比 60~95%，等效面积 ≥ 29784（上游 49640 的 60%）。
/** 河流/溶洞折算系数默认值（上游 4880/7011）。 */
const DEFAULT_CONVERSION = '4880/7011';
/**
 * 溶洞默认值 = 河流默认值 × 折算系数（70% × 4880/7011 ≈ 48.72% / 24197）。
 * 注意：这会低于溶洞自身的允许区间（60~95 / ≥29784），但按约定仍原样填入，
 * 且不做越界校验或提示——由用户自行调整。
 */
const CAVE_DEFAULT_RATIO = round2(DEFAULT_RATIO * (4880 / 7011));
const CAVE_DEFAULT_AREA = Math.round(DEFAULT_AREA * (4880 / 7011));
/** 球壳半径：任一 Y 与挂机Y 差值超过它一定搜不到。 */
const SHELL_RADIUS = 128;
/** 计算范围只取挂机Y ±24。 */
const CLAMP_HALF = 24;
/** 预设：空置域农场 / 地表农场（yMin, yMax, 挂机Y）。挂机Y默认值 = -40。 */
const PRESET_EMPTY = { yMin: -63, yMax: -51, playerY: -40 } as const;
const PRESET_SURFACE = { yMin: 64, yMax: 191, playerY: 191 } as const;

/** 默认搜索范围照抄上游：单种子 131072，种子列表 8192。 */
const DEFAULT_SINGLE_SIDE = 131072;
const DEFAULT_LIST_SIDE = 8192;
const WORLD_SIDE = 60000001;
const MAX_SIDE = 60000001;
const WORLD_COORD = 30000000;
/** 河流范围大于这个等效面积时，提示改去溶洞页搜索。 */
const CAVE_HINT_AREA = 2000001 * 2000001;
/** 停止请求发出后，等待引擎回报 done 的兜底上限。 */
const STOP_GUARD_MS = 30000;

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/** 百分比统一保留 2 位小数（用于显示与联动回填）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 把数值格式化为固定 2 位小数的字符串（输入框用）。 */
function fixed2(value: number): string {
  return round2(value).toFixed(2);
}

/** 该输入框是"占比"（两位小数）还是"面积"（整数）。 */
function isRatioField(id: string): boolean {
  return id === 'rv-ratio' || id === 'rv-cave-ratio';
}

/**
 * 解析折算系数："0.7" 或 "4880/7011"。
 * 空串返回 0（表示未传，由宿主取上游默认 4880/7011）。
 * 非法或越界返回 null。
 */
function parseConversion(text: string): number | null {
  const raw = text.trim();
  if (!raw) return 0;
  let value: number;
  const slash = raw.indexOf('/');
  if (slash >= 0) {
    const num = Number(raw.slice(0, slash).trim());
    const den = Number(raw.slice(slash + 1).trim());
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    value = num / den;
  } else {
    value = Number(raw);
  }
  if (!Number.isFinite(value) || value <= 0 || value > 1) return null;
  return value;
}

/** 引擎 warning code → 本地化文案。 */
function warningText(w: RiverWarning): string {
  if (w.code === RIVER_WARN_SPAN_GT_24) return t('river.warnSpanGt24');
  if (w.code === RIVER_WARN_YMIN_GT_NEG58) return t('river.warnYMinGtNeg58');
  return w.text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveRiverMc(versions: McVersion[]): number | null {
  const modern = versions.find((item) => item.name === '26.3');
  if (modern) return modern.id;
  const fallback = versions.find((item) => item.name === '26.2') || versions[versions.length - 1];
  return fallback ? fallback.id : null;
}

export class RiverPanel {
  readonly root: HTMLElement;
  private footer!: HTMLElement;
  private threads!: HTMLInputElement;
  private minRatio!: HTMLInputElement;
  private minArea!: HTMLInputElement;
  private caveRatio!: HTMLInputElement;
  private caveArea!: HTMLInputElement;
  /* 门槛输入框的标签：模式切换时与输入框一起隐藏，保持网格对齐。 */
  private minRatioLabel!: HTMLLabelElement;
  private minAreaLabel!: HTMLLabelElement;
  private caveRatioLabel!: HTMLLabelElement;
  private caveAreaLabel!: HTMLLabelElement;
  private conversion!: HTMLInputElement;
  private yMin!: HTMLInputElement;
  private yMax!: HTMLInputElement;
  private sampleY!: HTMLInputElement;
  private modeSelect!: HTMLSelectElement;
  private versionSelect!: HTMLSelectElement;
  private riverVersions: RiverVersion[] = [];
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
  /**
   * 「停止」进行中：已发请求、等引擎真正返回 done。
   * 与 search.ts 同名同语义——防止重复点击，并让按钮立刻显示"正在停止"。
   */
  private stopping = false;
  /** 门槛越界的即时提示文本（空 = 无），由 validateThresholds 维护。 */
  private rangeHint = '';
  /** 停止请求已发出但引擎迟迟不结束时的兜底计时器。 */
  private stopGuard = 0;
  private pollTimer = 0;
  private readonly timer = new RunTimer();
  private lastStage = Number.NaN;
  private lastStatus: RiverStatus | null = null;
  /** 本次搜索是否为纯河流模式（引擎回报缺失时兜底，供结果卡选择第一行口径）。 */
  private lastPureRiver = true;
  /** 本次搜索的折算系数（引擎回报缺失时兜底）。 */
  private lastConversion = 4880 / 7011;
  private shownError = '';
  /** 大面积跳转溶洞页时携带的参数，由外层消费后清空。 */
  pendingCave: Record<string, string | number> | null = null;
  /** 已提示过的引擎 warning code，避免每帧重复弹。 */
  private shownWarnings = new Set<number>();
  onNavigate: (id: SearcherId) => void = () => {};

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'stack search-panel';
    this.root.innerHTML = `
      <div class="search-panel-body" id="rv-form">
        <div class="grid">
          <label data-i18n="common.search.seedMode"></label>
          <select id="rv-seed-mode">
            <option value="single" data-i18n="common.search.seedModeSingle"></option>
            <option value="list" data-i18n="common.search.seedModeList"></option>
          </select>
        </div>
        <div id="rv-seed-block"></div>
        <div class="grid">
          <label data-i18n="common.search.version"></label>
          <select id="rv-version"><option>1.18~26.3+</option></select>
          <label data-i18n="common.search.threads"></label><input id="rv-threads" type="number" min="1" max="256" value="8" />
          <label data-i18n="common.search.minX"></label><input id="rv-minx" type="number" value="-65536" />
          <label data-i18n="common.search.maxX"></label><input id="rv-maxx" type="number" value="65535" />
          <label data-i18n="common.search.minZ"></label><input id="rv-minz" type="number" value="-65536" />
          <label data-i18n="common.search.maxZ"></label><input id="rv-maxz" type="number" value="65535" />
        </div>
        <div class="square-row">
          <label class="feature"><input id="rv-square" type="checkbox" checked /><span data-i18n="common.search.square"></span></label>
          <input id="rv-side" type="number" value="${DEFAULT_SINGLE_SIDE}" />
        </div>
        <div class="row">
          <button id="rv-reset" type="button" data-i18n="common.search.reset"></button>
          <button id="rv-border" type="button" data-i18n="common.search.border"></button>
        </div>
        <div class="grid">
          <label data-i18n="river.mode"></label>
          <select id="rv-mode">
            <option value="river" data-i18n="river.modeRiver" selected></option>
            <option value="cave" data-i18n="river.modeCave"></option>
          </select>
          <label id="rv-ratio-label" data-i18n="river.minRatio"></label>
          <input id="rv-ratio" type="number" min="${MIN_RATIO}" max="${MAX_RATIO}" step="0.01" value="${fixed2(DEFAULT_RATIO)}" />
          <label id="rv-area-label" data-i18n="river.minArea"></label>
          <input id="rv-area" type="number" min="${MIN_AREA}" max="${MAX_AREA}" step="1" value="${DEFAULT_AREA}" />
          <label id="rv-cave-ratio-label" data-i18n="river.minCaveRatio"></label>
          <input id="rv-cave-ratio" type="number" step="0.01" value="${fixed2(CAVE_DEFAULT_RATIO)}" />
          <label id="rv-cave-area-label" data-i18n="river.minCaveArea"></label>
          <input id="rv-cave-area" type="number" step="1" value="${CAVE_DEFAULT_AREA}" />
          <label data-i18n="river.conversion"></label>
          <input id="rv-conversion" type="text" value="${DEFAULT_CONVERSION}" />
          <label data-i18n="river.yMax"></label>
          <input id="rv-ymax" type="number" min="-64" max="320" step="1" value="${PRESET_EMPTY.yMax}" />
          <label data-i18n="river.yMin"></label>
          <input id="rv-ymin" type="number" min="-64" max="320" step="1" value="${PRESET_EMPTY.yMin}" />
          <label data-i18n="river.playerY"></label>
          <input id="rv-y" type="number" min="-64" max="320" step="1" value="${PRESET_EMPTY.playerY}" />
        </div>
        <div class="row">
          <button id="rv-preset-empty" type="button" data-i18n="river.presetEmpty"></button>
          <button id="rv-preset-surface" type="button" data-i18n="river.presetSurface"></button>
        </div>
        <div class="hint" data-i18n="river.help"></div>
      </div>
      <div class="search-panel-footer" id="rv-footer"></div>
    `;
    this.footer = this.root.querySelector('#rv-footer')!;
    this.threads = this.root.querySelector('#rv-threads')!;
    this.minRatio = this.root.querySelector('#rv-ratio')!;
    this.minArea = this.root.querySelector('#rv-area')!;
    this.caveRatio = this.root.querySelector('#rv-cave-ratio')!;
    this.caveArea = this.root.querySelector('#rv-cave-area')!;
    this.minRatioLabel = this.root.querySelector('#rv-ratio-label')!;
    this.minAreaLabel = this.root.querySelector('#rv-area-label')!;
    this.caveRatioLabel = this.root.querySelector('#rv-cave-ratio-label')!;
    this.caveAreaLabel = this.root.querySelector('#rv-cave-area-label')!;
    this.conversion = this.root.querySelector('#rv-conversion')!;
    this.yMin = this.root.querySelector('#rv-ymin')!;
    this.yMax = this.root.querySelector('#rv-ymax')!;
    this.sampleY = this.root.querySelector('#rv-y')!;
    this.modeSelect = this.root.querySelector('#rv-mode')!;
    this.versionSelect = this.root.querySelector('#rv-version')!;
    this.minX = this.root.querySelector('#rv-minx')!;
    this.maxX = this.root.querySelector('#rv-maxx')!;
    this.minZ = this.root.querySelector('#rv-minz')!;
    this.maxZ = this.root.querySelector('#rv-maxz')!;
    this.square = this.root.querySelector('#rv-square')!;
    this.side = this.root.querySelector('#rv-side')!;
    this.seedModeSelect = this.root.querySelector('#rv-seed-mode')!;
    this.threads.value = String(Math.min(32, navigator.hardwareConcurrency || 8));
    this.square.addEventListener('change', () => this.applySquare());
    this.side.addEventListener('input', () => this.applySquare());
    /* 四框联动：只在失焦/回车（change）时触发，输入过程中不改写。 */
    for (const el of [this.minRatio, this.minArea, this.caveRatio, this.caveArea]) {
      el.addEventListener('change', () => this.syncThresholds(el.id, true));
    }
    this.root.querySelector('#rv-reset')!.addEventListener('click', () => this.resetDefaultArea());
    this.root.querySelector('#rv-border')!.addEventListener('click', () => this.resetWorldBorder());
    this.root.querySelector('#rv-preset-empty')!.addEventListener('click', () => this.applyPreset(PRESET_EMPTY));
    this.root.querySelector('#rv-preset-surface')!.addEventListener('click', () => this.applyPreset(PRESET_SURFACE));
    this.modeSelect.addEventListener('change', () => this.applyMode());
    this.seedModeSelect.addEventListener('change', () => {
      this.seedMode = this.seedModeSelect.value as SeedMode;
      this.resetDefaultArea();
    });
    this.applySquare();
    this.applyMode();
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
    };
  }

  importState(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    if (s.seedMode === 'single' || s.seedMode === 'list') this.seedMode = s.seedMode;
    if (typeof s.seed === 'string') this.seed = s.seed;
    if (typeof s.seedText === 'string') this.seedText = s.seedText;
    applyForm(this.root, s);
    this.render();
    applyForm(this.root, s);
  }

  setSeedFromMap(seed: string): void {
    // 只有“单种子”来源的 tab 才跟随地图/其他单种子页面的种子。
    if (this.seedMode !== 'single') return;
    if (!seed.trim()) return;
    this.seed = seed.trim();
    const input = this.root.querySelector<HTMLInputElement>('#rv-seed');
    if (input) input.value = this.seed;
  }

  load(versions: McVersion[]): void {
    this.versions = versions;
    this.loadVersions();
    this.render();
  }

  /**
   * 版本下拉：由引擎的 riverVersions() 填充，按版本号从高到低倒排，默认 26.3。
   * 引擎不可用时回退到 versions 列表里的 26.3 / 26.2。
   */
  private loadVersions(): void {
    const apply = (list: RiverVersion[]) => {
      this.riverVersions = list;
      this.versionSelect.innerHTML = list
        .map((v) => `<option value="${v.mc}">${escapeAttr(v.label)}</option>`)
        .join('');
      const preferred = list.find((v) => v.label === '26.3') ?? list[0];
      if (preferred) this.versionSelect.value = String(preferred.mc);
    };
    void call<RiverVersion[]>('riverVersions')
      .then((list) => {
        if (Array.isArray(list) && list.length) {
          // 引擎返回的是升序（1.18 → 26.3），这里倒排成从高到低。
          apply([...list].reverse());
        } else {
          this.applyFallbackVersions();
        }
      })
      .catch(() => this.applyFallbackVersions());
  }

  private applyFallbackVersions(): void {
    const order = ['26.3', '26.2', '26.1', '26.1.2', '26.1.1'];
    const list: RiverVersion[] = [];
    for (const label of order) {
      const hit = this.versions.find((v) => v.name === label);
      if (hit) list.push({ label: hit.name, mc: hit.id });
    }
    this.riverVersions = list;
    this.versionSelect.innerHTML = list.map((v) => `<option value="${v.mc}">${escapeAttr(v.label)}</option>`).join('');
    if (list.length) this.versionSelect.value = String(list[0].mc);
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

  /**
   * 四个门槛框全联动：任意一项改动，其余三项同步更新。
   *
   * 换算关系（同组内）：
   *   面积 = round(占比 / 100 × FULL_RING)     占比 = round2(面积 / FULL_RING × 100)
   * 跨组（河流 ↔ 溶洞）按当前折算系数换算：
   *   溶洞值 = 河流值 × conv                河流值 = 溶洞值 / conv
   *
   * conv 取自"河流/溶洞折算系数"输入框（支持 0.7 或 4880/7011）；解析失败时退回默认值。
   *
   * 触发：change（失焦 / 回车）。`userEdit` 决定是否做越界提示，被动填充静默。
   */
  private syncThresholds(sourceId: string, userEdit = false): void {
    const conv = parseConversion(this.conversion.value) || (4880 / 7011);
    if (!(conv > 0)) return;

    // 1) 先把"触发源"归一成该组的占比
    let baseRatio = Number.NaN;
    let isCave = false;
    if (sourceId === 'rv-ratio') {
      baseRatio = Number(this.minRatio.value);
    } else if (sourceId === 'rv-area') {
      const a = Number(this.minArea.value);
      if (Number.isFinite(a)) baseRatio = (a / FULL_RING) * 100;
    } else if (sourceId === 'rv-cave-ratio') {
      baseRatio = Number(this.caveRatio.value);
      isCave = true;
    } else if (sourceId === 'rv-cave-area') {
      const ca = Number(this.caveArea.value);
      if (Number.isFinite(ca)) baseRatio = (ca / FULL_RING) * 100;
      isCave = true;
    }

    if (!Number.isFinite(baseRatio)) {
      this.validateThresholds(userEdit ? sourceId : null);
      return;
    }

    // 2) 换算到另一组
    const otherRatio = isCave ? baseRatio / conv : baseRatio * conv;

    // 3) 写回其余三项（都不动触发源本身）
    const writePair = (ratioEl: HTMLInputElement, areaEl: HTMLInputElement, pct: number) => {
      ratioEl.value = fixed2(pct);
      areaEl.value = String(Math.round((pct / 100) * FULL_RING));
    };
    if (isCave) {
      writePair(this.minRatio, this.minArea, otherRatio);   // 河流组
      // 溶洞组：仅补对偶那一项
      if (sourceId === 'rv-cave-ratio') this.caveArea.value = String(Math.round((baseRatio / 100) * FULL_RING));
      else this.caveRatio.value = fixed2(baseRatio);
    } else {
      writePair(this.caveRatio, this.caveArea, otherRatio);  // 溶洞组
      // 河流组：仅补对偶那一项
      if (sourceId === 'rv-ratio') this.minArea.value = String(Math.round((baseRatio / 100) * FULL_RING));
      else this.minRatio.value = fixed2(baseRatio);
    }

    // 越界提示只针对用户主动编辑的那一框。
    this.validateThresholds(userEdit ? sourceId : null);
  }

  /**
   * 校验并在越界时提示。
   * `activeId` 为本次用户主动操作的框；为 null 表示被动填充，只清标记不提示。
   */
  private validateThresholds(activeId: string | null): void {
    // 先清掉所有标记，再按需重新标。
    for (const el of [this.minRatio, this.minArea, this.caveRatio, this.caveArea]) {
      el.classList.remove('invalid');
    }
    if (!activeId) return;

    const rules: Record<string, [number, number, string]> = {
      'rv-ratio': [MIN_RATIO, MAX_RATIO, 'river.rangeRiverRatio'],
      'rv-area': [MIN_AREA, MAX_AREA, 'river.rangeRiverArea'],
      'rv-cave-ratio': [60, 95, 'river.rangeCaveRatio'],
      'rv-cave-area': [29784, FULL_RING, 'river.rangeCaveArea'],
    };
    const rule = rules[activeId];
    if (!rule) return;
    const [min, max, key] = rule;
    const el = document.getElementById(activeId) as HTMLInputElement | null;
    const v = Number(el?.value);
    if (Number.isFinite(v) && (v < min || v > max)) {
      el?.classList.add('invalid');
      this.rangeHint = t(key, { min, max, value: el?.value ?? '' });
    } else {
      this.rangeHint = '';
    }
  }
  /**
   * 模式切换。
   *
   * 两种模式各自只显示自己那一组门槛输入框：
   *  - 河流模式：只显示「最低河流等效占比 / 面积」，溶洞两项**隐藏**；
   *  - 溶洞模式：只显示「最低等效溶洞占比 / 面积」，河流两项**隐藏**。
   *
   * 隐藏而不是置灰：这两组字段互斥，另一组的值保留在 DOM 里
   * （切换回来时不丢），但不参与当前模式的判分与校验。
   */
  private applyMode(): void {
    // 保留默认值：若两框为空则补上，避免切换后留白。
    if (!this.caveRatio.value.trim()) this.caveRatio.value = fixed2(CAVE_DEFAULT_RATIO);
    if (!this.caveArea.value.trim()) this.caveArea.value = String(CAVE_DEFAULT_AREA);
    const riverMode = this.modeSelect.value === 'river';
    // 河流模式隐藏溶洞两项；溶洞模式隐藏河流两项。
    const showRiverFields = riverMode;
    this.setPairHidden(this.minRatioLabel, this.minRatio, !showRiverFields);
    this.setPairHidden(this.minAreaLabel, this.minArea, !showRiverFields);
    this.setPairHidden(this.caveRatioLabel, this.caveRatio, showRiverFields);
    this.setPairHidden(this.caveAreaLabel, this.caveArea, showRiverFields);
    // 隐藏的项同时置灰，避免键盘 Tab 仍能聚焦到不可见输入框。
    this.minRatio.disabled = !showRiverFields;
    this.minArea.disabled = !showRiverFields;
    this.caveRatio.disabled = showRiverFields;
    this.caveArea.disabled = showRiverFields;
  }

  /** 同时隐藏/显示一个"标签 + 输入框"对，并把它从 Tab 顺序里摘掉。 */
  private setPairHidden(
    label: HTMLLabelElement,
    input: HTMLInputElement,
    hidden: boolean,
  ): void {
    label.hidden = hidden;
    input.hidden = hidden;
    if (hidden) input.tabIndex = -1;
    else input.removeAttribute('tabindex');
  }

  /** 预设按钮：一次性写入 yMin / yMax / 挂机Y。 */
  private applyPreset(preset: { yMin: number; yMax: number; playerY: number }): void {
    this.yMin.value = String(preset.yMin);
    this.yMax.value = String(preset.yMax);
    this.sampleY.value = String(preset.playerY);
  }

  private renderSeedBlock(): void {
    const host = this.root.querySelector('#rv-seed-block')!;
    if (this.seedMode === 'single') {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seed"></label><input id="rv-seed" value="${escapeAttr(this.seed)}" />
      </div>`;
    } else {
      host.innerHTML = `<div class="grid">
        <label data-i18n="common.search.seeds"></label><button id="rv-file" type="button" data-i18n="common.search.pickFile"></button>
      </div><div class="hint" id="rv-file-name"></div>`;
      const fileName = host.querySelector('#rv-file-name');
      if (fileName && this.seedText) {
        fileName.textContent = String(this.seedText.split(/\r?\n/).filter((line) => line.trim()).length);
      }
      host.querySelector('#rv-file')?.addEventListener('click', () => void this.pickFile());
    }
    applyI18n(host);
  }

  private render(): void {
    this.seedModeSelect.value = this.seedMode;
    this.renderSeedBlock();
    this.footer.innerHTML = `
      <div class="row">
        <button id="rv-start" type="button" data-i18n="common.search.start" ${this.running ? 'disabled' : ''}></button>
        <button id="rv-pause" type="button" data-i18n="${this.paused ? 'common.search.resume' : 'common.search.pause'}" ${this.running ? '' : 'disabled'}></button>
        <button id="rv-stop" type="button" data-i18n="${this.stopping ? 'common.search.stopping' : 'common.search.stop'}" ${this.running && !this.stopping ? '' : 'disabled'}></button>
      </div>
      <div class="progress-track"><div class="progress-fill" id="rv-bar"></div></div>
      <div id="rv-progress" class="hint"></div>
      <div id="rv-elapsed" class="hint"></div>
      <div id="rv-eta" class="hint"></div>
    `;
    this.footer.querySelector('#rv-start')?.addEventListener('click', () => void this.start());
    this.footer.querySelector('#rv-pause')?.addEventListener('click', () => void this.togglePause());
    this.footer.querySelector('#rv-stop')?.addEventListener('click', () => void this.stop());
    applyI18n(this.root);
    applyRunLock(this.root, this.running, this.paused);
    // applyRunLock 会统一改写 disabled；解锁后必须重新套用模式锁定，
    // 否则"未参与当前模式的两项不可编辑"会在每次搜索结束后失效。
    this.applyMode();
    if (this.lastStatus) this.paintStatus(this.lastStatus);
  }

  private readFields(): void {
    const seed = this.root.querySelector<HTMLInputElement>('#rv-seed');
    if (seed) this.seed = seed.value.trim();
  }

  private async pickFile(): Promise<void> {
    const text = await window.aio.openFile();
    if (text == null) return;
    this.seedText = text;
    const count = text.split(/\r?\n/).filter((line: string) => line.trim()).length;
    const node = this.root.querySelector('#rv-file-name');
    if (node) node.textContent = String(count);
  }

  private async start(): Promise<void> {
    this.readFields();
    const listMode = this.seedMode === 'list';

    if (this.square.checked) {
      const side = Math.floor(Number(this.side.value) || 0);
      if (side < 1 || side > MAX_SIDE) {
        showNotice(t('common.error.bad-bounds'));
        return;
      }
      this.applySquare();
    }

    const minX = Number(this.minX.value);
    const maxX = Number(this.maxX.value);
    const minZ = Number(this.minZ.value);
    const maxZ = Number(this.maxZ.value);
    if (
      ![minX, maxX, minZ, maxZ].every(Number.isFinite) ||
      maxX < minX ||
      maxZ < minZ ||
      minX < -WORLD_COORD ||
      maxX > WORLD_COORD ||
      minZ < -WORLD_COORD ||
      maxZ > WORLD_COORD
    ) {
      showNotice(t('common.error.bad-bounds'));
      return;
    }

    // 范围过大时先问要不要改去溶洞页；选“是”直接切 Tab，不启动本次搜索。
    const area = (maxX - minX + 1) * (maxZ - minZ + 1);
    if (area > CAVE_HINT_AREA) {
      const choice = await ask(t('river.largeAreaToCave'), [
        { id: 'yes', key: 'common.dialog.yes' },
        { id: 'no', key: 'common.dialog.no' },
        { id: 'dismiss', key: 'common.dialog.close' },
      ]);
      if (choice === 'yes') {
        this.handoffToCave();
        return;
      }
      if (choice !== 'no') return;
    }

    const y = Math.round(Number(this.sampleY.value));
    if (!Number.isFinite(y) || y < -64 || y > 320) {
      showNotice(t('common.error.bad-bounds'));
      return;
    }

    const rawYMin = Math.round(Number(this.yMin.value));
    const rawYMax = Math.round(Number(this.yMax.value));
    if (!Number.isFinite(rawYMin) || !Number.isFinite(rawYMax) || rawYMin < -64 || rawYMax > 320 || rawYMax < rawYMin) {
      showNotice(t('common.error.bad-bounds'));
      return;
    }

    // F10 强控：任一 Y 与挂机Y 差值 > 128（球壳半径）直接拒，不允许开搜。
    const dyMax = Math.max(Math.abs(rawYMin - y), Math.abs(rawYMax - y));
    if (dyMax > SHELL_RADIUS) {
      showNotice(t('river.yOutOfShell', { dy: dyMax }));
      return;
    }

    // F9 裁剪：实际计算只取挂机Y ±24。
    const lo = Math.max(rawYMin, y - CLAMP_HALF);
    const hi = Math.min(rawYMax, y + CLAMP_HALF);
    if (hi < lo) {
      // 空集：提示改用上下限中点，选「是」重算后继续。
      const mid = Math.floor((rawYMin + rawYMax) / 2);
      const choice = await ask(t('river.badPlayerY', { mid }), [
        { id: 'yes', key: 'common.dialog.yes' },
        { id: 'no', key: 'common.dialog.no' },
      ]);
      if (choice !== 'yes') return;
      this.sampleY.value = String(mid);
      return this.start();
    }

    const seeds = listMode ? this.seedText : this.seed;
    if (!seeds.trim()) {
      showNotice(t('common.error.bad-seed'));
      return;
    }

    const mc = this.resolveMc();
    if (mc == null) {
      showNotice(t('common.error.unsupported-version'));
      return;
    }

    // 河流占比必须能解析成数；区间校验放到下面按模式统一处理（主动超限 → 提示可继续）。
    const ratio = Number(this.minRatio.value);
    if (!Number.isFinite(ratio)) {
      await showNotice(t('common.error.bad-ratio'));
      return;
    }
    const minScore = clamp(Math.round((ratio / 100) * FULL_RING), MIN_AREA, MAX_AREA);
    this.minRatio.value = fixed2(ratio);
    this.minArea.value = String(minScore);
    const threads = Math.max(1, Math.min(256, Number(this.threads.value) || 1));

    // 折算系数：支持 "0.7" 与 "4880/7011"；<=0 表示未传，由宿主填默认。
    const conversion = parseConversion(this.conversion.value);
    if (conversion == null) {
      showNotice(t('river.badConversion'));
      return;
    }

    const mode = this.modeSelect.value as RiverMode;
    const pureRiver = mode === 'river';
    // 三字段门槛：溶洞模式且溶洞两项都填了才启用。
    const caveRatio = Number(this.caveRatio.value);
    const caveArea = Number(this.caveArea.value);
    // 三字段门槛只取决于是否溶洞模式。两框恒有值（默认=河流默认×折算系数），
    // 因此不再用"是否留空"作为开关；越界值也原样下发，由引擎决定处理方式。
    const useCave =
      !pureRiver && Number.isFinite(caveRatio) && Number.isFinite(caveArea);

    // 点开始时的门槛校验：**只看当前模式对应的那一个百分比**，另一个不校验。
    // 校验不通过 → 直接拒绝开跑（不再提供"是否继续"）。
    if (pureRiver) {
      // 河流模式：只看河流等效占比（50~95%）。
      if (!inRange(ratio, MIN_RATIO, MAX_RATIO)) {
        await showNotice(
          t('river.rangeRiverRatio', { min: MIN_RATIO, max: MAX_RATIO, value: this.minRatio.value }),
        );
        return;
      }
    } else {
      // 溶洞模式：只看溶洞等效占比（60~95%）。
      if (!inRange(caveRatio, 60, 95)) {
        await showNotice(
          t('river.rangeCaveRatio', { min: 60, max: 95, value: this.caveRatio.value }),
        );
        return;
      }
    }

    try {
      await call('riverSearchStart', {
        mc,
        threads,
        // 门槛：两种模式各自只按本模式的字段走，绝不相加。
        //  - 河流模式：只用 minScore（= 河流占比 × 满球），溶洞字段传 -1 不参与。
        //  - 溶洞模式：只用 minCaveArea，河流字段传 -1 不参与。
        // 引擎会把 minRiverArea + ⌈7011·minCaveArea/4880⌉ 相加成 minArea；
        // 若两个都传，溶洞模式的门槛会变成"河流门槛 + 溶洞门槛"，直接超过理论满分，
        // 表现为"溶洞怎么放宽要求都搜不出结果"。
        minScore: pureRiver ? minScore : 0,
        minRiverArea: pureRiver ? minScore : -1,
        minCaveArea: useCave ? Math.round(caveArea) : -1,
        caveConversion: conversion,
        yMin: lo,
        yMax: hi,
        y,
        pureRiver,
        calcCave: !pureRiver,
        minX,
        maxX,
        minZ,
        maxZ,
        seeds,
      });
      /* 记下本次搜索的模式与折算系数：结果卡第一行的等效面积口径随之切换。 */
      this.lastPureRiver = pureRiver;
      this.lastConversion = conversion > 0 ? conversion : 4880 / 7011;
      this.results?.clearRiver(listMode);
      this.running = true;
      this.paused = false;
      this.stopping = false;
      this.shownError = '';
      this.lastStatus = null;
      this.timer.start();
      this.lastStage = Number.NaN;
      this.render();
      this.poll();
    } catch (error) {
      showNotice(messageOf(error));
    }
  }

  /** 由版本下拉框取 mc；下拉框尚未填充时回退到 resolveRiverMc。 */
  private resolveMc(): number | null {
    const picked = Number(this.versionSelect.value);
    if (Number.isFinite(picked) && picked > 0) return picked;
    return resolveRiverMc(this.versions);
  }

  /** 大面积提示选「是」：带参数切到溶洞页。 */
  private handoffToCave(): void {
    const yMin = Math.round(Number(this.yMin.value));
    const yMax = Math.round(Number(this.yMax.value));
    const height = Number.isFinite(yMax) && Number.isFinite(yMin) ? yMax - yMin + 1 : 0;
    const mc = this.resolveMc();
    // 版本：<=26.1 走 pre(1.18~26.1)，否则 sulfur(26.2+)，与溶洞页的两个入口一致。
    const preMc = this.riverVersions.find((v) => v.label === '26.1')?.mc;
    const uiVersion = mc != null && preMc != null && mc <= preMc ? 'pre' : 'sulfur';
    this.onNavigate('LowYDripstoneCave');
    this.pendingCave = {
      uiVersion,
      minX: Number(this.minX.value),
      maxX: Number(this.maxX.value),
      minZ: Number(this.minZ.value),
      maxZ: Number(this.maxZ.value),
      // yMin > -58 → -63；高度 > 24 → yMax = -40
      yMin: Number.isFinite(yMin) && yMin > -58 ? '-63' : String(yMin),
      yMax: height > 24 ? '-40' : String(yMax),
    };
  }

  private async togglePause(): Promise<void> {
    if (this.paused) {
      await call('riverSearchResume');
      this.paused = false;
      this.timer.resume();
    } else {
      await call('riverSearchPause');
      this.paused = true;
      this.timer.pause();
    }
    this.render();
  }

  /**
   * 停止搜索。
   *
   * 以前这里是裸调用 `call('riverSearchStop')`：请求发出后界面毫无反馈，
   * 引擎取消 + 线程回收 + 结果打包这段窗口里按钮仍停在可点击状态，
   * 进度条也不动，看起来像"点了没反应"。这里对齐 search.ts 的做法：
   * 先置 stopping → 立刻重渲染 → 再发请求 → 失败回滚。
   */
  private async stop(): Promise<void> {
    if (!this.running || this.stopping) return;
    this.stopping = true;
    this.render();
    // 兜底：引擎若因极端情况未在期限内回报 done，也要解除 UI。
    window.clearTimeout(this.stopGuard);
    this.stopGuard = window.setTimeout(() => {
      if (!this.stopping) return;
      this.stopping = false;
      this.running = false;
      this.paused = false;
      window.clearInterval(this.pollTimer);
      this.render();
    }, STOP_GUARD_MS);
    try {
      await call('riverSearchStop');
    } catch (error) {
      this.stopping = false;
      window.clearTimeout(this.stopGuard);
      this.render();
      showNotice(messageOf(error));
    }
  }

  private poll(): void {
    window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(async () => {
      try {
        const status = await call<RiverStatus>('riverSearchPoll');
        this.lastStatus = status;
        this.running = status.running;
        this.paused = status.paused;
        if (status.stage !== this.lastStage) {
          this.lastStage = status.stage;
          this.timer.markPhase();
        }
        this.paintStatus(status);
        this.results?.setRiverHits(
          status.hits,
          status.fullArea,
          // 溶洞模式结果卡第一行显示等效溶洞面积，纯河流模式显示等效河流面积。
          typeof status.pureRiver === 'boolean' ? status.pureRiver : this.lastPureRiver,
          typeof status.caveConversion === 'number' && status.caveConversion > 0
            ? status.caveConversion
            : this.lastConversion,
        );
        // 引擎 validate() 的提示（高度超 24 格等）逐条弹窗，选「否」即停止本次搜索。
        if (status.warnings?.length) await this.showWarnings(status.warnings);
        // 收尾条件：引擎报 done；或已请求停止且引擎报 !running。
        // 后者是安全网——宿主正常路径下 running/done 同时翻转，但若真出现
        // running=false 而 done 未置位的形态，也必须在退出轮询前解除 UI。
        if (status.done || (this.stopping && !status.running)) {
          window.clearInterval(this.pollTimer);
          window.clearTimeout(this.stopGuard);
          const finished = status.done;
          this.running = false;
          this.paused = false;
          this.stopping = false;
          if (finished && status.error && status.error !== this.shownError) {
            this.shownError = status.error;
            showNotice(messageOf(status.error));
          }
          this.render();
        }
      } catch {
        window.clearInterval(this.pollTimer);
        window.clearTimeout(this.stopGuard);
        this.running = false;
        this.stopping = false;
      }
    }, 100);
  }

  /** 状态写入页脚；render() 重建页脚后再用它恢复进度（含完成时的 100%）。 */
  private paintStatus(status: RiverStatus): void {
    const progress = this.footer.querySelector('#rv-progress');
    const eta = this.footer.querySelector('#rv-eta');
    const elapsed = this.footer.querySelector('#rv-elapsed');
    const bar = this.footer.querySelector<HTMLElement>('#rv-bar');
    if (progress) progress.textContent = this.progressText(status);
    if (eta) eta.textContent = this.etaText(status);
    if (elapsed) {
      elapsed.textContent = t('common.searchExtra.elapsed', {
        time: formatDuration(this.timer.elapsed()),
      });
    }
    if (bar) {
      // 两段独立：粗筛跑满 100% 后进入精算，进度条归零重新从 0 算起。
      // 这里只反映"当前阶段内"的进度，不做跨阶段加权。
      const pct = status.done ? 100 : status.total > 0 ? Math.min(100, (status.current / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
    }
  }

  /** 逐条展示引擎 warning；任一条选「否」即停止当前搜索。 */
  private async showWarnings(warnings: RiverWarning[]): Promise<void> {
    const fresh = warnings.filter((w) => !this.shownWarnings.has(w.code));
    if (!fresh.length) return;
    for (const w of fresh) this.shownWarnings.add(w.code);
    const choice = await ask(fresh.map((w) => warningText(w)).join('\n'), [
      { id: 'yes', key: 'common.dialog.yes' },
      { id: 'no', key: 'common.dialog.no' },
    ]);
    if (choice !== 'yes') {
      // 走与「停止」按钮同一路径，避免这里再次出现裸调用导致的 UI 卡顿。
      this.stopping = true;
      this.render();
      await call('riverSearchStop');
    }
  }

  private progressText(status: RiverStatus): string {
    const seeds =
      status.seedCount > 1
        ? `${t('common.search.seedOf', { index: status.seedIndex + 1, count: status.seedCount })} `
        : '';
    if (status.done && !status.error) return `${seeds}${t('common.search.completed')}`;
    const stage =
      status.stage === 1
        ? t('river.stage.scan')
        : status.stage === 2
          ? t('river.stage.refine')
          : t('common.search.working');
    const pct = status.total > 0 ? Math.min(100, Math.round((status.current / status.total) * 100)) : 0;
    // 暂停状态已由下方 ETA 显示“已暂停”，进度行不再追加“正在暂停”。
    const error = status.error ? ` ${messageOf(status.error)}` : '';
    return `${seeds}${stage} ${status.current}/${status.total} (${pct}%)${error}`;
  }

  private etaText(status: RiverStatus): string {
    // 已点停止 → 明确告知正在等待引擎收尾，而不是继续显示剩余时间。
    if (this.stopping) return t('common.search.stoppingEta');
    if (status.done) return t('common.search.eta.completed');
    if (status.paused) return t('common.search.eta.paused');
    if (!(status.current > 0 && status.total > status.current)) return t('common.search.eta.calculating');
    const elapsed = this.timer.phaseElapsed();
    const remaining = elapsed * ((status.total - status.current) / status.current);
    if (!(remaining > 0) || !Number.isFinite(remaining)) return t('common.search.eta.calculating');
    return t('common.search.eta.remaining', { time: formatDuration(remaining) });
  }
}
