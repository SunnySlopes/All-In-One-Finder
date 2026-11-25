/** Shared search-seed fields for session save/load (deduped at top level). */

export type SeedMode = 'single' | 'list';

export const SEED_INLINE_MAX_CHARS = 8192;
export const SEED_INLINE_MAX_LINES = 500;
/** Sidecar written via writeSession when a large list has no filesystem path. */
export const SEED_LIST_SESSION_NAME = 'seed-list.txt';
export const SEED_LIST_SESSION_REF = `session:${SEED_LIST_SESSION_NAME}`;

const SEED_FORM_KEY = /(^|-)seed(-mode)?$/i;

export interface SharedSearchSeed {
  seedMode: SeedMode;
  /** Inline list body when small enough (or after resolve). */
  seedText: string;
  /** Absolute path, or `session:seed-list.txt`. */
  seedListPath: string;
}

export interface PanelSeedSnapshot {
  seedMode?: SeedMode;
  seed?: string;
  seedText?: string;
  seedListPath?: string;
}

export function seedLineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

export function shouldInlineSeedText(text: string): boolean {
  if (!text) return true;
  if (text.length > SEED_INLINE_MAX_CHARS) return false;
  return seedLineCount(text) <= SEED_INLINE_MAX_LINES;
}

export function isSeedFormKey(key: string): boolean {
  return SEED_FORM_KEY.test(key);
}

/** Remove per-searcher seed fields before writing searchers into the session. */
export function stripSearcherSeedFields(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== 'object') return {};
  const raw = state as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'seed' || key === 'seedMode' || key === 'seedText' || key === 'seedListPath') continue;
    if (key === 'form' && value && typeof value === 'object') {
      const form: Record<string, unknown> = {};
      for (const [fk, fv] of Object.entries(value as Record<string, unknown>)) {
        if (isSeedFormKey(fk)) continue;
        form[fk] = fv;
      }
      out.form = form;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function stripAllSearcherSeedFields(
  searchers: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!searchers) return undefined;
  const out: Record<string, unknown> = {};
  for (const [id, state] of Object.entries(searchers)) {
    out[id] = stripSearcherSeedFields(state);
  }
  return out;
}

function asSeedMode(value: unknown): SeedMode | undefined {
  return value === 'single' || value === 'list' ? value : undefined;
}

function readPanelSeed(state: unknown): PanelSeedSnapshot {
  if (!state || typeof state !== 'object') return {};
  const s = state as Record<string, unknown>;
  const form =
    s.form && typeof s.form === 'object' ? (s.form as Record<string, unknown>) : undefined;
  let seedMode = asSeedMode(s.seedMode);
  let seed = typeof s.seed === 'string' ? s.seed : undefined;
  const seedText = typeof s.seedText === 'string' ? s.seedText : undefined;
  const seedListPath = typeof s.seedListPath === 'string' ? s.seedListPath : undefined;
  if (form) {
    for (const [key, value] of Object.entries(form)) {
      if (typeof value !== 'string') continue;
      if (/seed-mode$/i.test(key) && !seedMode) seedMode = asSeedMode(value);
      else if (/-seed$/i.test(key) && !/seed-mode$/i.test(key) && seed == null) seed = value;
    }
  }
  return { seedMode, seed, seedText, seedListPath };
}

/** Merge live panel snapshots into one shared seed record for the session file. */
export function collectSharedSearchSeed(
  panels: Iterable<PanelSeedSnapshot>,
  fallbackSeed = '',
): SharedSearchSeed {
  let seedMode: SeedMode = 'single';
  let seedText = '';
  let seedListPath = '';
  for (const panel of panels) {
    if (panel.seedMode === 'list') seedMode = 'list';
    if (typeof panel.seedText === 'string' && panel.seedText.length > seedText.length) {
      seedText = panel.seedText;
    }
    if (typeof panel.seedListPath === 'string' && panel.seedListPath.trim()) {
      seedListPath = panel.seedListPath.trim();
    }
  }
  if (!seedText && seedMode === 'single' && fallbackSeed) {
    // single mode: list body unused; keep empty
  }
  return { seedMode, seedText, seedListPath };
}

/**
 * Old sessions stored seedMode/seed/seedText on every searcher.
 * Prefer top-level fields; fill gaps by scanning searchers.
 */
export function liftSharedSeedFromSearchers(
  searchers: Record<string, unknown> | undefined,
  top: Partial<SharedSearchSeed> | undefined,
  _mapSeed: string,
): SharedSearchSeed {
  const hasTopMode = top?.seedMode === 'single' || top?.seedMode === 'list';
  const hasTopText = typeof top?.seedText === 'string';
  const hasTopPath = typeof top?.seedListPath === 'string' && top.seedListPath.trim() !== '';

  if (hasTopMode || hasTopText || hasTopPath) {
    return {
      seedMode: hasTopMode && top?.seedMode ? top.seedMode : 'single',
      seedText: hasTopText && typeof top?.seedText === 'string' ? top.seedText : '',
      seedListPath: hasTopPath && typeof top?.seedListPath === 'string' ? top.seedListPath.trim() : '',
    };
  }

  let seedMode: SeedMode = 'single';
  let seedText = '';
  let seedListPath = '';
  if (searchers) {
    for (const state of Object.values(searchers)) {
      const panel = readPanelSeed(state);
      if (panel.seedMode === 'list') seedMode = 'list';
      if (typeof panel.seedText === 'string' && panel.seedText.length > seedText.length) {
        seedText = panel.seedText;
      }
      if (typeof panel.seedListPath === 'string' && panel.seedListPath.trim()) {
        seedListPath = panel.seedListPath.trim();
      }
    }
  }
  return { seedMode, seedText, seedListPath };
}

/**
 * Sync pack for exportSnapshot / close flush.
 * Large lists with a real filesystem path drop the body; otherwise keep inline
 * until async packSharedSeedForSession spills to session/seed-list.txt.
 */
export function packSharedSeedSync(
  shared: SharedSearchSeed,
): Pick<SharedSearchSeed, 'seedMode' | 'seedText' | 'seedListPath'> {
  const seedMode = shared.seedMode;
  const seedText = shared.seedText || '';
  const seedListPath = (shared.seedListPath || '').trim();
  if (shouldInlineSeedText(seedText)) {
    return { seedMode, seedText, seedListPath };
  }
  if (seedListPath && seedListPath !== SEED_LIST_SESSION_REF && seedListPath !== SEED_LIST_SESSION_NAME) {
    return { seedMode, seedText: '', seedListPath };
  }
  // Keep body for sync/close safety; async write will spill + clear.
  return { seedMode, seedText, seedListPath };
}

/**
 * Prepare shared seed fields for the session JSON.
 * Large lists without a path are spilled to session/seed-list.txt.
 */
export async function packSharedSeedForSession(
  shared: SharedSearchSeed,
): Promise<Pick<SharedSearchSeed, 'seedMode' | 'seedText' | 'seedListPath'>> {
  const seedMode = shared.seedMode;
  const seedText = shared.seedText || '';
  const seedListPath = (shared.seedListPath || '').trim();

  if (shouldInlineSeedText(seedText)) {
    return { seedMode, seedText, seedListPath };
  }

  if (seedListPath && seedListPath !== SEED_LIST_SESSION_REF && seedListPath !== SEED_LIST_SESSION_NAME) {
    return { seedMode, seedText: '', seedListPath };
  }

  // Too large without a user path: spill beside the session file.
  const ok = await window.aio?.writeSession?.(SEED_LIST_SESSION_NAME, seedText);
  if (ok) return { seedMode, seedText: '', seedListPath: SEED_LIST_SESSION_REF };
  // Spill failed: keep inline so the session stays usable.
  return { seedMode, seedText, seedListPath: '' };
}

/** Load seed list body from seedListPath; clear path+text if missing. */
export async function resolveSharedSeed(shared: SharedSearchSeed): Promise<SharedSearchSeed> {
  const seedMode = shared.seedMode;
  const seedText = shared.seedText || '';
  const seedListPath = (shared.seedListPath || '').trim();

  if (!seedListPath) {
    return { seedMode, seedText, seedListPath: '' };
  }

  let loaded: string | null = null;
  if (seedListPath === SEED_LIST_SESSION_REF || seedListPath === SEED_LIST_SESSION_NAME) {
    loaded = (await window.aio?.readSession?.(SEED_LIST_SESSION_NAME)) ?? null;
  } else if (window.aio?.readPath) {
    loaded = await window.aio.readPath(seedListPath);
  }

  if (loaded == null) {
    return { seedMode, seedText: '', seedListPath: '' };
  }
  return { seedMode, seedText: loaded, seedListPath };
}

/** Merge shared seed into a searcher state object for importState. */
export function injectSharedSeed(
  state: unknown,
  shared: SharedSearchSeed,
  mapSeed: string,
): Record<string, unknown> {
  const base =
    state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  base.seedMode = shared.seedMode;
  base.seed = mapSeed;
  base.seedText = shared.seedText;
  base.seedListPath = shared.seedListPath;
  return base;
}

export async function pickSeedListFile(): Promise<{ text: string; path: string } | null> {
  if (window.aio?.openFileWithPath) {
    return window.aio.openFileWithPath();
  }
  const text = await window.aio.openFile();
  if (text == null) return null;
  return { text, path: '' };
}
