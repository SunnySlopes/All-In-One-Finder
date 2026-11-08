import './style.css';
import { escapeText } from './dialog';
import { applyI18n, locale, onLocale, setLocale, t } from './i18n';
import { MapView } from './map';
import { FlowerPanel } from './flower';
import { FortressPanel } from './fortress';
import { GeodePanel } from './geode';
import { MonumentPanel } from './monument';
import { call, type FeatureInfo, type McVersion } from './native';
import {
  applyThemeToDom,
  storeTheme,
  storedTheme,
  systemTheme,
  type ThemeId,
} from './theme';
import { ResultsColumn } from './results';
import { RiverPanel } from './river';
import { SearchPanel } from './search';
import { SlimePanel } from './slime';
import { TrialPanel } from './trial';
import { WitchPanel } from './witch';
import { onRunLockChange, runLockOwner } from './run-lock';
import { SEARCHER_ITEMS, type SearcherId } from './searchers';
import { type MapSessionData } from './session';

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header id="menubar">
    <button type="button" class="brand-mark" id="map-home" data-i18n-title="common.searcher.map" data-i18n-aria-label="common.searcher.map"><img src="/icon.png" alt="" draggable="false" /></button>
    <nav id="searcher-bar" class="app-tabs" role="tablist" data-i18n-aria-label="common.map.searchersLabel"></nav>
    <div class="topbar-actions">
      <button type="button" class="mini-btn" id="theme-toggle" aria-label="theme"></button>
      <button type="button" class="mini-btn" id="lang-toggle" aria-label="language"></button>
      <button type="button" class="mini-btn" id="about-toggle" data-i18n-title="common.about.title"></button>
    </div>
  </header>
  <div id="workspace">
    <aside id="sidebar"><div id="panel"></div></aside>
    <div class="col-resizer" data-resize="sidebar" data-i18n-title="common.map.resize"></div>
    <div id="results-host"></div>
    <div class="col-resizer" data-resize="results" data-i18n-title="common.map.resize"></div>
    <div id="stage"></div>
  </div>
  <div id="modal"><div id="dialog"></div></div>
  <div id="toast-host" class="toast-host"></div>
`;

const panel = document.querySelector('#panel')!;
const resultsHost = document.querySelector<HTMLElement>('#results-host')!;
const searcherBar = document.querySelector('#searcher-bar')!;
/** 顶栏左侧的品牌图标：点击回到地图（地图不再占用独立 Tab）。 */
const mapHome = document.querySelector<HTMLButtonElement>('#map-home')!;
const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const map = new MapView();
const search = new SearchPanel();
const slime = new SlimePanel();
const witch = new WitchPanel();
const flower = new FlowerPanel();
const trial = new TrialPanel();
const geode = new GeodePanel();
const river = new RiverPanel();
const fortressCross = new FortressPanel('cross');
const fortressSpan = new FortressPanel('span');
const monumentDouble = new MonumentPanel('double');
const monumentMulti = new MonumentPanel('multi');
const results = new ResultsColumn(map);
resultsHost.append(results.root);
search.bindResults(results);
slime.bindResults(results);
witch.bindResults(results);
flower.bindResults(results);
trial.bindResults(results);
geode.bindResults(results);
river.bindResults(results);
fortressCross.bindResults(results);
fortressSpan.bindResults(results);
monumentDouble.bindResults(results);
monumentMulti.bindResults(results);
map.mountCanvas(document.querySelector('#stage')!);
search.onNavigate = (id) => show(id);
river.onNavigate = (id) => show(id);
witch.getLargeBiomes = () => map.getLargeBiomes();

let current: SearcherId = 'map';

// 全局“仅一个搜索”占用释放时，重新渲染当前页以恢复 Start 按钮。
// 占用开始时不需要刷新：开始搜索的页就是当前页，其它页里的 Start 在 show() 时
// 已经按占用状态渲染成 disabled。
let hadRunLock = false;
onRunLockChange(() => {
  const owned = runLockOwner() !== null;
  if (hadRunLock && !owned) refreshPanel(current);
  hadRunLock = owned;
});

/** 存档中一并保存每个搜索器当前填写的条件。 */
function collectSearcherStates(): Record<string, unknown> {
  return {
    ...search.exportStates(),
    SlimeChunk: slime.exportState(),
    LowYSwampHut: witch.exportState(),
    FlowerFarm: flower.exportState(),
    TrialSpawner: trial.exportState(),
    BuddingAmethyst: geode.exportState(),
    River: river.exportState(),
    NetherFortressCross: fortressCross.exportState(),
    NetherFortressOverall: fortressSpan.exportState(),
    DoubleMonument: monumentDouble.exportState(),
    MultiMonument: monumentMulti.exportState(),
  };
}

function sessionSnapshot(): MapSessionData {
  // 主题随存档一起落盘：换会话/重开程序时沿用用户上次的选择，
  // 而不是重新跟随系统。旧存档没有该字段时保持原行为（跟随系统/本地记录）。
  return { ...map.exportSnapshot(), theme: currentTheme };
}

function applySearcherStates(states: unknown): void {
  if (!states || typeof states !== 'object') return;
  const saved = states as Record<string, unknown>;
  search.importStates(saved);
  slime.importState(saved.SlimeChunk);
  witch.importState(saved.LowYSwampHut);
  flower.importState(saved.FlowerFarm);
  trial.importState(saved.TrialSpawner);
  geode.importState(saved.BuddingAmethyst);
  river.importState(saved.River);
  fortressCross.importState(saved.NetherFortressCross);
  fortressSpan.importState(saved.NetherFortressOverall);
  monumentDouble.importState(saved.DoubleMonument);
  monumentMulti.importState(saved.MultiMonument);
}

map.setSearcherStateProvider(collectSearcherStates);

/**
 * 每个搜索 tab 共用同一套种子同步接口；集中列出一次，
 * 避免在“地图改种子 / 载入存档 / 启动恢复”三处各抄一份 11 行调用。
 */
const SEED_SYNC_PANELS = [
  search,
  slime,
  witch,
  flower,
  trial,
  geode,
  river,
  fortressCross,
  fortressSpan,
  monumentDouble,
  monumentMulti,
] as const;

/** 地图种子变化时，只同步到当前为“单种子”来源的搜索 tab。 */
function pushSeedToSingleTabs(seed: string): void {
  const value = seed.trim();
  if (!value) return;
  for (const panel of SEED_SYNC_PANELS) panel.setSeedFromMap(value);
}

map.onSeedChange = (seed) => pushSeedToSingleTabs(seed);

// 原生宿主在关闭窗口前调用它，把当前地图状态同步落盘，避免异步 session 写入被关闭流程截断。
window.__AIO_SESSION_B64__ = () => {
  if (!map.hasLoaded()) return '';
  const bytes = new TextEncoder().encode(JSON.stringify(sessionSnapshot()));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// 单种子页面改种子：失焦或回车后，同步地图画布和其他所有单种子 tab。
panel.addEventListener('change', (event) => {
  if (current === 'map') return; // 地图自己的 onSeedChange 已处理
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.id.endsWith('-seed')) return;
  const mode = panel.querySelector<HTMLSelectElement>('select[id$="-seed-mode"]');
  if (mode && mode.value !== 'single') return;
  const seed = input.value.trim();
  if (!seed) return;
  map.setSeed(seed, false);
  pushSeedToSingleTabs(seed);
});

panel.addEventListener('keydown', (event) => {
  if (current === 'map') return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.id.endsWith('-seed')) return;
  if ((event as KeyboardEvent).key !== 'Enter') return;
  event.preventDefault();
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

// 输入过程中先同步到 session；用户不按回车直接关窗口也不会丢掉新种子。
panel.addEventListener('input', (event) => {
  if (current === 'map') return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.id.endsWith('-seed')) return;
  const mode = panel.querySelector<HTMLSelectElement>('select[id$="-seed-mode"]');
  if (mode && mode.value !== 'single') return;
  const seed = input.value.trim();
  if (seed) map.setSeedDraft(seed);
});

function setWindowTitle(): void {
  const title = t('common.app.title');
  document.title = title;
  window.aio?.setTitle(title);
}

function searcherIcon(icon: string | undefined): string {
  if (!icon) return '<span class="searcher-icon searcher-icon-empty" aria-hidden="true"></span>';
  return `<img class="searcher-icon" src="/icons/${icon}.png" alt="" draggable="false" />`;
}

function paintSearcherBar(): void {
  searcherBar.innerHTML = SEARCHER_ITEMS.map(
    (item) =>
      `<button type="button" data-searcher="${item.id}" role="tab" aria-selected="${item.id === current}" ${item.enabled ? '' : 'disabled'} class="tab ${item.id === current ? 'active' : ''}">${searcherIcon(item.icon)}<span data-i18n="common.searcher.${item.id}"></span></button>`,
  ).join('');
  searcherBar.querySelectorAll<HTMLButtonElement>('[data-searcher]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.searcher as SearcherId;
      const meta = SEARCHER_ITEMS.find((item) => item.id === id);
      if (!meta?.enabled) return;
      show(id);
    });
  });
  applyI18n(searcherBar);
}

/* ---- 语言切换：单按钮循环（参考项目的 syncLangLabel 风格） ---- */
const langToggle = document.querySelector<HTMLButtonElement>('#lang-toggle')!;
function syncLangLabel(): void {
  // 按钮显示"将要切换到的语言"，与参考项目一致
  langToggle.textContent = locale() === 'zh' ? 'EN' : '中文';
  langToggle.dataset.i18nTitle = 'common.menu.language';
  langToggle.title = t('common.menu.language');
}
langToggle.addEventListener('click', () => {
  setLocale(locale() === 'zh' ? 'en' : 'zh');
  syncLangLabel();
  syncAboutLabel();
  setWindowTitle();
  paintSearcherBar();
});

/* ---- About 按钮：放在语言切换右侧（原生菜单栏移除后由它承担）---- */
const aboutToggle = document.querySelector<HTMLButtonElement>('#about-toggle')!;
function syncAboutLabel(): void {
  aboutToggle.textContent = '?';
  aboutToggle.title = t('common.about.title');
  aboutToggle.setAttribute('aria-label', t('common.about.title'));
}
aboutToggle.addEventListener('click', () => showAbout());

/* ---- 明暗主题切换（决策 6、12） ---- */
const themeToggle = document.querySelector<HTMLButtonElement>('#theme-toggle')!;

/** 当前主题。既写 DOM，也写 localStorage，供本次运行与下次启动使用。 */
let currentTheme: ThemeId = storedTheme() ?? systemTheme();

function paintThemeButton(theme: ThemeId): void {
  // 按钮显示"将要切换到的主题"
  themeToggle.textContent = theme === 'dark' ? '☀' : '☾';
  themeToggle.title = theme === 'dark' ? 'Light' : 'Dark';
  themeToggle.setAttribute('aria-label', themeToggle.title);
}

function applyTheme(theme: ThemeId): void {
  currentTheme = theme;
  applyThemeToDom(theme);
  paintThemeButton(theme);
}

function setTheme(theme: ThemeId): void {
  applyTheme(theme);
  storeTheme(theme);
}

/** 供存档读写：当前主题。 */
export function getTheme(): ThemeId {
  return currentTheme;
}

/** 由存档恢复主题（跨 session 沿用用户上次的选择）。 */
export function adoptSessionTheme(theme: ThemeId | undefined): void {
  if (theme === 'dark' || theme === 'light') setTheme(theme);
}

applyTheme(currentTheme);
themeToggle.addEventListener('click', () => {
  const next: ThemeId =
    document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  setTheme(next);
});

function showAbout(): void {
  const modal = document.querySelector<HTMLElement>('#modal')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  dialog.innerHTML = `
    <strong>${escapeText(t('common.about.title'))}</strong>
    <div class="about-body">${escapeText(t('common.about.body')).replaceAll('\n', '<br>')}</div>
    <div class="row"><button type="button" id="about-close" data-i18n="common.dialog.close"></button></div>
  `;
  applyI18n(dialog);
  modal.classList.add('show');
  const close = () => {
    modal.classList.remove('show');
    modal.onclick = null;
  };
  dialog.querySelector('#about-close')!.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });
  modal.onclick = (event) => {
    if (event.target === modal) close();
  };
}

function show(which: SearcherId): void {
  current = which;
  // Tab 主题色入口（决策 1）：CSS 用 #app[data-searcher] 覆盖 --accent*。
  app.dataset.searcher = which;
  // 地图不再占 Tab，改由品牌图标承载；这里同步它的激活态。
  mapHome.classList.toggle('active', which === 'map');
  if (which === 'map') {
    map.commitDraft();
    panel.replaceChildren(map.root);
  } else if (which === 'LowYDripstoneCave' || which === 'LowYPitDripstoneCave') {
    search.setSeedFromMap(map.getSeed());
    search.setSearcher(which);
    panel.replaceChildren(search.root);
  } else if (which === 'SlimeChunk') {
    slime.setSeedFromMap(map.getSeed());
    panel.replaceChildren(slime.root);
  } else if (which === 'LowYSwampHut') {
    witch.setSeedFromMap(map.getSeed());
    panel.replaceChildren(witch.root);
  } else if (which === 'FlowerFarm') {
    flower.setSeedFromMap(map.getSeed());
    panel.replaceChildren(flower.root);
  } else if (which === 'TrialSpawner') {
    trial.setSeedFromMap(map.getSeed());
    panel.replaceChildren(trial.root);
  } else if (which === 'BuddingAmethyst') {
    geode.setSeedFromMap(map.getSeed());
    panel.replaceChildren(geode.root);
  } else if (which === 'River') {
    river.setSeedFromMap(map.getSeed());
    panel.replaceChildren(river.root);
  } else if (which === 'NetherFortressCross') {
    fortressCross.setSeedFromMap(map.getSeed());
    panel.replaceChildren(fortressCross.root);
  } else if (which === 'NetherFortressOverall') {
    fortressSpan.setSeedFromMap(map.getSeed());
    panel.replaceChildren(fortressSpan.root);
  } else if (which === 'DoubleMonument') {
    monumentDouble.setSeedFromMap(map.getSeed());
    panel.replaceChildren(monumentDouble.root);
  } else if (which === 'MultiMonument') {
    monumentMulti.setSeedFromMap(map.getSeed());
    panel.replaceChildren(monumentMulti.root);
  } else {
    return;
  }
  results.setViewTab(which);
  paintSearcherBar();
  applyI18n();
  results.refresh();
  refreshPanel(which);
}

/** 重新渲染某个搜索器的页脚/表单；用于切 Tab 和全局占用状态变化。 */
function refreshPanel(which: SearcherId): void {
  if (which === 'map') map.refreshText();
  else if (which === 'LowYDripstoneCave' || which === 'LowYPitDripstoneCave') search.refresh();
  else if (which === 'SlimeChunk') slime.refresh();
  else if (which === 'LowYSwampHut') witch.refresh();
  else if (which === 'FlowerFarm') flower.refresh();
  else if (which === 'TrialSpawner') trial.refresh();
  else if (which === 'BuddingAmethyst') geode.refresh();
  else if (which === 'River') river.refresh();
  else if (which === 'NetherFortressCross') fortressCross.refresh();
  else if (which === 'NetherFortressOverall') fortressSpan.refresh();
  else if (which === 'DoubleMonument') monumentDouble.refresh();
  else if (which === 'MultiMonument') monumentMulti.refresh();
}

function setupColumnResize(): void {
  const widths = loadColumnWidths();
  sidebar.style.width = `${widths.sidebar}px`;
  resultsHost.style.width = `${widths.results}px`;

  document.querySelectorAll<HTMLElement>('.col-resizer').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const target = handle.dataset.resize === 'sidebar' ? sidebar : resultsHost;
      const startX = event.clientX;
      const startW = target.getBoundingClientRect().width;
      handle.classList.add('active');
      const onMove = (move: PointerEvent) => {
        const next = Math.round(startW + (move.clientX - startX));
        const clamped = Math.min(560, Math.max(180, next));
        target.style.width = `${clamped}px`;
      };
      const onUp = () => {
        handle.classList.remove('active');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        saveColumnWidths();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  });
}

function loadColumnWidths(): { sidebar: number; results: number } {
  try {
    const raw = localStorage.getItem('aio.columns');
    if (raw) {
      const data = JSON.parse(raw) as { sidebar?: number; results?: number };
      return {
        sidebar: clampWidth(data.sidebar, 300),
        results: clampWidth(data.results, 300),
      };
    }
  } catch {
    /* ignore */
  }
  return { sidebar: 300, results: 300 };
}

function saveColumnWidths(): void {
  const data = {
    sidebar: Math.round(sidebar.getBoundingClientRect().width),
    results: Math.round(resultsHost.getBoundingClientRect().width),
  };
  localStorage.setItem('aio.columns', JSON.stringify(data));
}

function clampWidth(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(560, Math.max(180, Number(value)));
}

onLocale(() => {
  applyI18n();
  map.refreshText();
  search.refresh();
  slime.refresh();
  witch.refresh();
  flower.refresh();
  trial.refresh();
  geode.refresh();
  river.refresh();
  fortressCross.refresh();
  fortressSpan.refresh();
  monumentDouble.refresh();
  monumentMulti.refresh();
  results.refresh();
  paintSearcherBar();
  syncLangLabel();
  syncAboutLabel();
  setWindowTitle();
});

window.aio?.onShowAbout?.(() => showAbout());

mapHome.addEventListener('click', () => show('map'));

setupColumnResize();
paintSearcherBar();
syncLangLabel();
syncAboutLabel();
show('map');
applyI18n();
window.addEventListener('load', () => setWindowTitle());
setWindowTitle();

void Promise.all([call<McVersion[]>('versions'), call<FeatureInfo[]>('features')])
  .then(([versions, features]) => {
    void map.load(versions, features).then((session) => {
      pushSeedToSingleTabs(map.getSeed());
      applySearcherStates(session?.searchers);
      // 存档里带了主题就沿用它（跨 session 记住用户上次的选择）；
      // 旧存档没有该字段时保留本次启动已确定的主题（本地记录或系统）。
      adoptSessionTheme((session as { theme?: ThemeId } | null)?.theme);
    });
    search.load(versions);
    slime.load(versions);
    witch.load();
    flower.load(versions);
    trial.load();
    geode.load(versions);
    river.load(versions);
    fortressCross.load(versions);
    fortressSpan.load(versions);
    monumentDouble.load(versions);
    monumentMulti.load(versions);
    applyI18n();
    map.refreshText();
    results.refresh();
  })
  .catch((error) => {
    panel.insertAdjacentHTML('afterbegin', `<div class="hint">${t('common.error.native')} ${String(error)}</div>`);
  });
