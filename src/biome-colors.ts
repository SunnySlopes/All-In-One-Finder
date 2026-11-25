import { parseCoords } from './coords';
import { ask, escapeText, showNotice } from './dialog';
import { applyI18n, biomeLabel, onLocale, t } from './i18n';
import type { MapView } from './map';
import { call } from './native';
import { packSharedSeedForSession } from './search-seeds';
import {
  isSessionFromNewerApp,
  parseSessionFile,
  serializeSession,
  type MapSessionData,
} from './session';
import {
  DEFAULT_SCHEME,
  groupsForScheme,
  parseBiomeGroupScheme,
  sortBiomesInGroup,
  type BiomeGroupDef,
  type BiomeGroupSchemeId,
} from './biome-groups';

/** Sibling of map.json; cubiomes-viewer uses the same ".colormap" text format. */
const COLORMAP_NAME = 'colormap.colormap';

export interface BiomeColorRow {
  id: number;
  name: string;
  r: number;
  g: number;
  b: number;
}

function toHex(r: number, g: number, b: number): string {
  const byte = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function fromHex(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * cubiomes-viewer colormap text:
 *   ;optional title
 *   biome_name R G B
 */
function colorsToViewerText(rows: BiomeColorRow[], title = 'All-In-One Finder'): string {
  const lines = [`;${title}`];
  for (const row of rows) {
    lines.push(`${row.name} ${row.r | 0} ${row.g | 0} ${row.b | 0}`);
  }
  return `${lines.join('\n')}\n`;
}

function looksLikeViewerColormap(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('{')) return false;
  return /(?:^|\n)\s*[a-z_]+[^;\n]*\d/i.test(trimmed) || trimmed.startsWith(';');
}

function groupLabel(group: BiomeGroupDef): string {
  const key = `common.map.biomeGroup.${group.labelKey}`;
  const text = t(key);
  return text === key ? group.id : text;
}

export class BiomeColorPanel {
  readonly root: HTMLElement;
  private readonly map: MapView;
  private readonly onImportSession: (data: MapSessionData) => void;
  private jumpX!: HTMLInputElement;
  private jumpZ!: HTMLInputElement;
  private parseText!: HTMLTextAreaElement;
  private parseError!: HTMLElement;
  private filterInput!: HTMLInputElement;
  private list!: HTMLElement;
  private schemeBar!: HTMLElement;
  private groupsHost!: HTMLElement;
  private rows: BiomeColorRow[] = [];
  private saveTimer = 0;
  private loaded = false;
  private scheme: BiomeGroupSchemeId = DEFAULT_SCHEME;
  private highlighted = new Set<string>();
  /** Collapsed group ids (both schemes). */
  private collapsed = new Set<string>();

  constructor(map: MapView, onImportSession: (data: MapSessionData) => void) {
    this.map = map;
    this.onImportSession = onImportSession;
    this.root = document.createElement('aside');
    this.root.id = 'biome-colors';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="results-jump stack">
        <div class="row jump-coords">
          <label data-i18n="common.map.coordX"></label>
          <input id="bc-x" type="number" value="0" />
          <label data-i18n="common.map.coordZ"></label>
          <input id="bc-z" type="number" value="0" />
          <button type="button" id="bc-go" class="btn ghost sm" data-i18n="common.map.goto"></button>
        </div>
        <label data-i18n="common.map.parseText"></label>
        <div class="row">
          <textarea id="bc-parse" rows="2" data-i18n-placeholder="common.map.parseHint"></textarea>
          <button type="button" id="bc-parse-btn" class="btn ghost sm" data-i18n="common.map.parse"></button>
        </div>
        <div class="hint" id="bc-parse-error"></div>
      </div>
      <div class="biome-color-tools stack">
        <div class="row biome-color-actions">
          <button type="button" id="bc-default" class="btn ghost sm" data-i18n="common.map.allToDefault"></button>
          <button type="button" id="bc-dimmed" class="btn ghost sm" data-i18n="common.map.allToDimmed"></button>
        </div>
        <input id="bc-filter" type="search" data-i18n-placeholder="common.map.filterBiomes" />
      </div>
      <div id="bc-groups" class="biome-group-host"></div>
      <div id="bc-list" class="biome-color-list"></div>
      <div class="row biome-scheme-bar" id="bc-scheme-bar">
        <span class="biome-scheme-label" data-i18n="common.map.schemePreset"></span>
        <button type="button" class="btn ghost sm scheme-btn" data-scheme="continentalness" data-i18n="common.map.schemeContinentalness"></button>
        <button type="button" class="btn ghost sm scheme-btn" data-scheme="temperature" data-i18n="common.map.schemeTemperature"></button>
        <button type="button" class="btn ghost sm scheme-btn" data-scheme="none" data-i18n="common.map.schemeNone"></button>
      </div>
    `;
    this.jumpX = this.root.querySelector('#bc-x')!;
    this.jumpZ = this.root.querySelector('#bc-z')!;
    this.parseText = this.root.querySelector('#bc-parse')!;
    this.parseError = this.root.querySelector('#bc-parse-error')!;
    this.filterInput = this.root.querySelector('#bc-filter')!;
    this.list = this.root.querySelector('#bc-list')!;
    this.schemeBar = this.root.querySelector('#bc-scheme-bar')!;
    this.groupsHost = this.root.querySelector('#bc-groups')!;

    this.root.querySelector('#bc-go')!.addEventListener('click', () => this.jumpFromInputs());
    const jumpOnEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.jumpFromInputs();
    };
    this.jumpX.addEventListener('keydown', jumpOnEnter);
    this.jumpZ.addEventListener('keydown', jumpOnEnter);
    this.root.querySelector('#bc-parse-btn')!.addEventListener('click', () => this.parse());
    this.root.querySelector('#bc-default')!.addEventListener('click', () => void this.resetAll());
    this.root.querySelector('#bc-dimmed')!.addEventListener('click', () => void this.dimAll());
    this.filterInput.addEventListener('input', () => this.paintList());
    this.schemeBar.querySelectorAll<HTMLButtonElement>('.scheme-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const next = button.dataset.scheme as BiomeGroupSchemeId;
        void this.setScheme(next);
      });
    });
    onLocale(() => this.refresh());
    const previousDimChange = this.map.onDimensionChange;
    this.map.onDimensionChange = (dim) => {
      previousDimChange(dim);
      void this.reloadRows();
    };
    this.refresh();
  }

  async load(): Promise<void> {
    try {
      const raw = await window.aio?.readSession?.(COLORMAP_NAME);
      const trimmed = raw?.trim() ?? '';
      if (looksLikeViewerColormap(trimmed)) {
        const result = await call<{ mapped: number }>('applyBiomeColorText', { text: trimmed });
        if ((result?.mapped ?? 0) > 0) this.map.invalidateBiomeColors();
      }
    } catch {
      /* keep defaults */
    }
    await this.reloadRows();
    this.loaded = true;
    await this.applyHighlightToMap();
  }

  refresh(): void {
    applyI18n(this.root);
    const parseHint = this.parseText.getAttribute('data-i18n-placeholder');
    if (parseHint) this.parseText.placeholder = t(parseHint);
    const filterHint = this.filterInput.getAttribute('data-i18n-placeholder');
    if (filterHint) this.filterInput.placeholder = t(filterHint);
    this.syncSchemeButtons();
    this.paintList();
  }

  private async reloadRows(): Promise<void> {
    this.rows = await call<BiomeColorRow[]>('listBiomeColors', { dim: this.map.getDim() });
    this.paintList();
    await this.applyHighlightToMap();
  }

  private overworldGrouping(): boolean {
    return this.map.getDim() === 0;
  }

  private usingGroups(): boolean {
    return this.overworldGrouping() && this.scheme !== 'none';
  }

  private activeGroups(): BiomeGroupDef[] {
    return groupsForScheme(this.scheme);
  }

  private syncSchemeButtons(): void {
    const showBar = this.overworldGrouping();
    this.schemeBar.hidden = !showBar;
    this.groupsHost.hidden = !this.usingGroups();
    this.schemeBar.querySelectorAll<HTMLButtonElement>('.scheme-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.scheme === this.scheme);
    });
  }

  getScheme(): BiomeGroupSchemeId {
    return this.scheme;
  }

  /** Restore grouping preset from the main session (built-in presets only). */
  applyScheme(scheme: BiomeGroupSchemeId | undefined): void {
    this.scheme = parseBiomeGroupScheme(scheme);
    this.highlighted.clear();
    this.syncSchemeButtons();
    this.paintList();
    void this.applyHighlightToMap();
  }

  private async setScheme(scheme: BiomeGroupSchemeId): Promise<void> {
    this.scheme = scheme;
    this.highlighted.clear();
    this.syncSchemeButtons();
    this.paintList();
    await this.applyHighlightToMap();
    this.map.saveNow();
  }

  private paintList(): void {
    this.syncSchemeButtons();
    const needle = this.filterInput.value.trim().toLowerCase();
    const byName = new Map(this.rows.map((row) => [row.name, row]));

    if (!this.usingGroups()) {
      this.groupsHost.innerHTML = '';
      this.paintFlatRows(
        this.rows
          .map((row) => ({ row, label: biomeLabel(row.name) }))
          .filter(({ row, label }) => {
            if (!needle) return true;
            return label.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle);
          })
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
      );
      return;
    }

    const groups = this.activeGroups();
    const assigned = new Set<string>();
    const sections: Array<{ group: BiomeGroupDef; rows: BiomeColorRow[] }> = [];
    for (const group of groups) {
      const ordered = sortBiomesInGroup(group.biomes, this.scheme);
      const rows: BiomeColorRow[] = [];
      for (const name of ordered) {
        const row = byName.get(name);
        if (!row) continue;
        assigned.add(name);
        if (needle) {
          const label = biomeLabel(name);
          if (!label.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) continue;
        }
        rows.push(row);
      }
      if (rows.length || !needle) sections.push({ group, rows });
    }

    const leftovers = this.rows.filter((row) => !assigned.has(row.name));
    if (leftovers.length) {
      const filtered = leftovers.filter((row) => {
        if (!needle) return true;
        const label = biomeLabel(row.name);
        return label.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle);
      });
      if (filtered.length || !needle) {
        sections.push({
          group: { id: '__other__', labelKey: 'other', biomes: filtered.map((row) => row.name) },
          rows: sortBiomesInGroup(
            filtered.map((row) => row.name),
            this.scheme,
          )
            .map((name) => byName.get(name)!)
            .filter(Boolean),
        });
      }
    }

    this.groupsHost.innerHTML = sections
      .map(({ group }) => {
        const checked = this.highlighted.has(group.id) ? 'checked' : '';
        return `<label class="biome-group-toggle">
          <input type="checkbox" data-group="${escapeText(group.id)}" ${checked} />
          <span>${escapeText(groupLabel(group))}</span>
        </label>`;
      })
      .join('');

    this.groupsHost.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.dataset.group || '';
        if (input.checked) this.highlighted.add(id);
        else this.highlighted.delete(id);
        void this.applyHighlightToMap();
      });
    });

    const blocks: string[] = [];
    for (const { group, rows } of sections) {
      if (!rows.length && needle) continue;
      // While filtering, keep matching groups expanded so hits stay visible.
      const isCollapsed = !needle && this.collapsed.has(group.id);
      const label = groupLabel(group);
      blocks.push(`<div class="biome-group-section${isCollapsed ? ' collapsed' : ''}" data-group="${escapeText(group.id)}">
        <button type="button" class="biome-group-heading" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${escapeText(label)}">
          <span class="biome-group-chevron" aria-hidden="true"></span>
          <span class="biome-group-title">${escapeText(label)}</span>
          <span class="biome-group-count">${rows.length}</span>
        </button>
        <div class="biome-group-body">
          ${rows.map((row) => this.rowHtml(row)).join('')}
        </div>
      </div>`);
    }
    if (!blocks.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.map.noBiomes"></div>`;
      applyI18n(this.list);
      return;
    }
    this.list.innerHTML = blocks.join('');
    this.bindGroupCollapse();
    this.bindRowEditors();
  }

  private bindGroupCollapse(): void {
    this.list.querySelectorAll<HTMLButtonElement>('.biome-group-heading').forEach((button) => {
      button.addEventListener('click', () => {
        const section = button.closest<HTMLElement>('.biome-group-section');
        if (!section) return;
        const id = section.dataset.group || '';
        const next = !section.classList.contains('collapsed');
        section.classList.toggle('collapsed', next);
        button.setAttribute('aria-expanded', next ? 'false' : 'true');
        if (next) this.collapsed.add(id);
        else this.collapsed.delete(id);
      });
    });
  }

  private paintFlatRows(items: Array<{ row: BiomeColorRow; label: string }>): void {
    if (!items.length) {
      this.list.innerHTML = `<div class="hint results-empty" data-i18n="common.map.noBiomes"></div>`;
      applyI18n(this.list);
      return;
    }
    this.list.innerHTML = items.map(({ row }) => this.rowHtml(row)).join('');
    this.bindRowEditors();
  }

  private rowHtml(row: BiomeColorRow): string {
    const label = biomeLabel(row.name);
    return `<div class="biome-color-row" data-id="${row.id}">
      <input type="color" class="biome-color-swatch" data-id="${row.id}" value="${toHex(row.r, row.g, row.b)}" aria-label="${escapeText(label)}" title="${escapeText(label)}" />
      <span class="biome-color-name" title="${escapeText(row.name)}">${escapeText(label)}</span>
    </div>`;
  }

  private bindRowEditors(): void {
    // Hex entry lives in the native color UI (under RGB); only commit when the picker closes.
    this.list.querySelectorAll<HTMLInputElement>('input[type="color"].biome-color-swatch').forEach((input) => {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.id);
        const rgb = fromHex(input.value);
        if (!Number.isFinite(id) || !rgb) return;
        void this.setOne(id, rgb.r, rgb.g, rgb.b);
      });
    });
  }

  private async applyHighlightToMap(): Promise<void> {
    if (!this.usingGroups() || this.highlighted.size === 0) {
      await this.map.setBiomeHighlight([]);
      return;
    }
    const byName = new Map(this.rows.map((row) => [row.name, row.id]));
    const ids: number[] = [];
    for (const group of this.activeGroups()) {
      if (!this.highlighted.has(group.id)) continue;
      for (const name of group.biomes) {
        const id = byName.get(name);
        if (id != null) ids.push(id);
      }
    }
    if (this.highlighted.has('__other__')) {
      const assigned = new Set(this.activeGroups().flatMap((group) => group.biomes));
      for (const row of this.rows) {
        if (!assigned.has(row.name)) ids.push(row.id);
      }
    }
    await this.map.setBiomeHighlight(ids);
  }

  private async setOne(id: number, r: number, g: number, b: number): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row && row.r === r && row.g === g && row.b === b) return;
    await call('setBiomeColor', { id, r, g, b });
    if (row) {
      row.r = r;
      row.g = g;
      row.b = b;
    }
    const swatch = this.list.querySelector<HTMLInputElement>(`input[type="color"].biome-color-swatch[data-id="${id}"]`);
    if (swatch) swatch.value = toHex(r, g, b);
    this.map.invalidateBiomeColors();
    this.persistColors();
  }

  private async resetAll(): Promise<void> {
    await call('resetBiomeColors');
    await this.reloadRows();
    this.map.invalidateBiomeColors();
    this.persistColors();
  }

  private async dimAll(): Promise<void> {
    await call('dimBiomeColors');
    await this.reloadRows();
    this.map.invalidateBiomeColors();
    this.persistColors();
  }

  private persistColors(): void {
    if (!this.loaded) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.writeColormap(), 200);
  }

  private async writeColormap(): Promise<void> {
    const text = colorsToViewerText(this.rows);
    try {
      await window.aio?.writeSession?.(COLORMAP_NAME, text);
    } catch {
      /* ignore */
    }
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
    requestAnimationFrame(() => {
      this.map.jumpTo({ x, z });
    });
  }

  async exportSession(): Promise<void> {
    const snapshot = this.map.exportSnapshot();
    const packed = await packSharedSeedForSession({
      seedMode: snapshot.seedMode === 'list' ? 'list' : 'single',
      seedText: snapshot.seedText || '',
      seedListPath: snapshot.seedListPath || '',
    });
    snapshot.seedMode = packed.seedMode;
    snapshot.seedText = packed.seedText || undefined;
    snapshot.seedListPath = packed.seedListPath || undefined;
    const text = serializeSession(snapshot, true);
    const ok = await window.aio.saveFile('map.json', text, 'session');
    if (!ok) showNotice(t('common.error.save-failed'));
  }

  async importSession(): Promise<void> {
    const text = await window.aio.openFile('session');
    if (text == null) return;
    if (isSessionFromNewerApp(text)) {
      const choice = await ask(t('common.map.sessionTooNew'), [
        { id: 'continue', key: 'common.dialog.continue' },
      ]);
      if (choice !== 'continue') return;
    }
    const data = parseSessionFile(text);
    if (!data) {
      showNotice(t('common.map.badSession'));
      return;
    }
    this.onImportSession(data);
  }

  async exportColormap(): Promise<void> {
    const text = colorsToViewerText(this.rows);
    const ok = await window.aio.saveFile('colormap.colormap', text, 'colormap');
    if (!ok) showNotice(t('common.error.save-failed'));
  }

  async importColormap(): Promise<void> {
    const text = await window.aio.openFile('colormap');
    if (text == null) return;
    const trimmed = text.trim();
    if (!looksLikeViewerColormap(trimmed)) {
      showNotice(t('common.map.badColormap'));
      return;
    }
    try {
      const result = await call<{ mapped: number }>('applyBiomeColorText', { text: trimmed });
      if ((result?.mapped ?? 0) <= 0) {
        showNotice(t('common.map.badColormap'));
        return;
      }
    } catch {
      showNotice(t('common.map.badColormap'));
      return;
    }
    await this.reloadRows();
    this.map.invalidateBiomeColors();
    this.persistColors();
  }
}
