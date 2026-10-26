import './style.css';
import { escapeText, showNotice } from './dialog';
import { applyI18n, locale, onLocale, setLocale, t, type LocaleId } from './i18n';
import { MapView } from './map';
import { FlowerPanel } from './flower';
import { FortressPanel } from './fortress';
import { MonumentPanel } from './monument';
import { call, type FeatureInfo, type McVersion } from './native';
import { ResultsColumn } from './results';
import { RiverPanel } from './river';
import { SearchPanel } from './search';
import { SlimePanel } from './slime';
import { WitchPanel } from './witch';
import { SEARCHER_ITEMS, type SearcherId } from './searchers';
import { parseSessionFile } from './session';

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
river.bindResults(results);
fortressCross.bindResults(results);
fortressSpan.bindResults(results);
monumentDouble.bindResults(results);
monumentMulti.bindResults(results);
map.mountCanvas(document.querySelector('#stage')!);
search.onNavigate = (id) => show(id);
river.onNavigate = (id) => show(id);
results.onShowMap = () => show('map');
witch.getLargeBiomes = () => map.getLargeBiomes();
map.onSeedChange = (seed) => {
  search.setSeedFromMap(seed);
  slime.setSeedFromMap(seed);
  witch.setSeedFromMap(seed);
  flower.setSeedFromMap(seed);
  river.setSeedFromMap(seed);
  fortressCross.setSeedFromMap(seed);
  fortressSpan.setSeedFromMap(seed);
  monumentDouble.setSeedFromMap(seed);
  monumentMulti.setSeedFromMap(seed);
};

let current: SearcherId = 'map';

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
  void window.aio.exportSession(map.exportSnapshot());
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
  river.setSeedFromMap(data.seed);
  fortressCross.setSeedFromMap(data.seed);
  fortressSpan.setSeedFromMap(data.seed);
  monumentDouble.setSeedFromMap(data.seed);
  monumentMulti.setSeedFromMap(data.seed);
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
  void map.load(versions, features).then(() => {
    search.setSeedFromMap(map.getSeed());
    slime.setSeedFromMap(map.getSeed());
    witch.setSeedFromMap(map.getSeed());
    flower.setSeedFromMap(map.getSeed());
    river.setSeedFromMap(map.getSeed());
    fortressCross.setSeedFromMap(map.getSeed());
    fortressSpan.setSeedFromMap(map.getSeed());
    monumentDouble.setSeedFromMap(map.getSeed());
    monumentMulti.setSeedFromMap(map.getSeed());
  });
  search.load(versions);
  slime.load(versions);
  witch.load(versions);
  flower.load(versions);
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
