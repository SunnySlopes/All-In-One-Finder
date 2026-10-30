import './style.css';
import { escapeText, showNotice } from './dialog';
import { applyI18n, locale, onLocale, setLocale, t, type LocaleId } from './i18n';
import { MapView } from './map';
import { FlowerPanel } from './flower';
import { FortressPanel } from './fortress';
import { GeodePanel } from './geode';
import { MonumentPanel } from './monument';
import { call, type FeatureInfo, type McVersion } from './native';
import { ResultsColumn } from './results';
import { RiverPanel } from './river';
import { SearchPanel } from './search';
import { SlimePanel } from './slime';
import { TrialPanel } from './trial';
import { WitchPanel } from './witch';
import { SEARCHER_ITEMS, type SearcherId } from './searchers';
import { parseSessionFile, type MapSessionData } from './session';

const app = document.querySelector('#app')!;
app.innerHTML = `
  <header id="menubar">
    <nav id="searcher-bar" class="searcher-bar" aria-label="searchers"></nav>
    <label class="menu-lang flat-lang">
      <span data-i18n="common.menu.language"></span>
      <select id="language">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
  </header>
  <div id="workspace">
    <aside id="sidebar"><div id="panel"></div></aside>
    <div class="col-resizer" data-resize="sidebar" title="resize"></div>
    <div id="results-host"></div>
    <div class="col-resizer" data-resize="results" title="resize"></div>
    <div id="stage"></div>
  </div>
  <div id="modal"><div id="dialog"></div></div>
`;

const panel = document.querySelector('#panel')!;
const resultsHost = document.querySelector<HTMLElement>('#results-host')!;
const searcherBar = document.querySelector('#searcher-bar')!;
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
  return map.exportSnapshot();
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

/** 地图种子变化时，只同步到当前为“单种子”来源的搜索 tab。 */
function pushSeedToSingleTabs(seed: string): void {
  const value = seed.trim();
  if (!value) return;
  search.setSeedFromMap(value);
  slime.setSeedFromMap(value);
  witch.setSeedFromMap(value);
  flower.setSeedFromMap(value);
  trial.setSeedFromMap(value);
  geode.setSeedFromMap(value);
  river.setSeedFromMap(value);
  fortressCross.setSeedFromMap(value);
  fortressSpan.setSeedFromMap(value);
  monumentDouble.setSeedFromMap(value);
  monumentMulti.setSeedFromMap(value);
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
  searcherBar.innerHTML = SEARCHER_ITEMS.map((item) =>
    `<button type="button" data-searcher="${item.id}" ${item.enabled ? '' : 'disabled'} class="searcher-chip ${item.id === current ? 'active' : ''}">${searcherIcon(item.icon)}<span data-i18n="common.searcher.${item.id}"></span></button>`,
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

const language = document.querySelector<HTMLSelectElement>('#language')!;
language.value = locale();
language.addEventListener('change', () => {
  setLocale(language.value as LocaleId);
  setWindowTitle();
  paintSearcherBar();
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
  if (which === 'map') {
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
  if (which === 'map') map.refreshText();
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
  else search.refresh();
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
  setWindowTitle();
});

window.aio?.onShowAbout?.(() => showAbout());
window.aio?.onSessionExport?.(() => {
  void window.aio.exportSession(sessionSnapshot()).then((ok) => {
    if (!ok) showNotice(t('common.error.save-failed'));
  });
});
window.aio?.onSessionImport?.((text) => {
  const data = parseSessionFile(text);
  if (!data) {
    showNotice(t('common.map.badSession'));
    return;
  }
  map.applySnapshot(data);
  search.setSeedFromMap(data.seed);
  slime.setSeedFromMap(data.seed);
  witch.setSeedFromMap(data.seed);
  flower.setSeedFromMap(data.seed);
  trial.setSeedFromMap(data.seed);
  geode.setSeedFromMap(data.seed);
  river.setSeedFromMap(data.seed);
  fortressCross.setSeedFromMap(data.seed);
  fortressSpan.setSeedFromMap(data.seed);
  monumentDouble.setSeedFromMap(data.seed);
  monumentMulti.setSeedFromMap(data.seed);
  applySearcherStates(data.searchers);
  show('map');
});

setupColumnResize();
paintSearcherBar();
show('map');
applyI18n();
window.addEventListener('load', () => setWindowTitle());
setWindowTitle();

void Promise.all([
  call<McVersion[]>('versions'),
  call<FeatureInfo[]>('features'),
]).then(([versions, features]) => {
  void map.load(versions, features).then((session) => {
    search.setSeedFromMap(map.getSeed());
    slime.setSeedFromMap(map.getSeed());
    witch.setSeedFromMap(map.getSeed());
    flower.setSeedFromMap(map.getSeed());
    trial.setSeedFromMap(map.getSeed());
    geode.setSeedFromMap(map.getSeed());
    river.setSeedFromMap(map.getSeed());
    fortressCross.setSeedFromMap(map.getSeed());
    fortressSpan.setSeedFromMap(map.getSeed());
    monumentDouble.setSeedFromMap(map.getSeed());
    monumentMulti.setSeedFromMap(map.getSeed());
    applySearcherStates(session?.searchers);
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
}).catch((error) => {
  panel.insertAdjacentHTML('afterbegin', `<div class="hint">${t('common.error.native')} ${String(error)}</div>`);
});
