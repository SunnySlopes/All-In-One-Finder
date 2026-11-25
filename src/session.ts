import type { BiomeGroupSchemeId } from './biome-groups';
import { parseBiomeGroupScheme } from './biome-groups';
import { APP_VERSION } from './i18n';
import {
  liftSharedSeedFromSearchers,
  stripAllSearcherSeedFields,
  type SeedMode,
} from './search-seeds';
import type { ThemeId } from './theme';

/** Reduced session schema marker (shared seed fields at top level). */
export const SESSION_FORMAT_VERSION = 2;

export interface MapSessionData {
  kind: 'aio-session';
  /**
   * Program version that wrote this file (package.json), e.g. "1.2.0".
   * Not Minecraft version — that is `mcVersion`.
   */
  version: string;
  seed: string;
  mcVersion: string;
  dim: number;
  y: number;
  /**
   * 地图中心坐标（方块）。旧 session 没有这两项，缺省回落到 0,0。
   * 跨 session 打开时会恢复到这个位置。
   */
  x?: number;
  z?: number;
  largeBiomes: boolean;
  grid: boolean;
  /**
   * 主世界地形叠加层（默认关闭，旧 session 缺省即关闭）。
   * 0.9.0 的独立 `caves` 开关已并入这里，旧文件里的 `caves=` 直接忽略。
   */
  terrain?: boolean;
  features: string[];
  /**
   * 战利品类别筛选（杂项/模板/唱片/陶片）。旧 session 缺省为四类全开。
   */
  lootFilters?: { misc: boolean; template: boolean; disc: boolean; sherd: boolean };
  /** 每个搜索器当前填写的条件（form + 面板私有状态；不含重复的 seed 字段）。 */
  searchers?: Record<string, unknown>;
  /**
   * 搜索器用的种子来源模式（各页运行时仍可不同；存档只保留一份）。
   * 旧 session 可能缺省，由 liftSharedSeedFromSearchers 从 searchers 提升。
   */
  seedMode?: SeedMode;
  /** 种子列表正文（小列表内嵌；过大时改存 seedListPath）。 */
  seedText?: string;
  /** 种子列表文件绝对路径，或 session:seed-list.txt。 */
  seedListPath?: string;
  /**
   * 界面主题。写进存档后，下次启动（含换会话打开同一存档）会沿用，
   * 而不是重新跟随系统。旧 session 缺省为 undefined，由调用方决定回退策略。
   */
  theme?: ThemeId;
  /**
   * 界面语言。写进存档后，启动时优先于本地记录恢复；
   * 旧 session 缺省为 undefined，由调用方回退到本地记录/系统语言。
   */
  locale?: 'zh' | 'en';
  /**
   * 群系颜色面板的分组预设（大陆性 / 温度 / 不分组）。
   * 只写主 session；分组内容始终来自内置预设，不另存分类文件。
   * 旧 session 缺省为不分组。
   */
  biomeGroupScheme?: BiomeGroupSchemeId;
}

/**
 * Canonical reduced session JSON.
 * `version` is the program version that wrote the file; `formatVersion` marks the schema.
 */
export function serializeSession(data: MapSessionData, pretty = false): string {
  const searchers = stripAllSearcherSeedFields(data.searchers);
  const body: Record<string, unknown> = {
    kind: 'aio-session',
    version: APP_VERSION,
    formatVersion: SESSION_FORMAT_VERSION,
    seed: data.seed,
    mcVersion: data.mcVersion,
    dim: data.dim,
    y: data.y,
    x: data.x ?? 0,
    z: data.z ?? 0,
    largeBiomes: !!data.largeBiomes,
    grid: data.grid !== false,
    terrain: data.terrain === true,
    features: Array.isArray(data.features) ? data.features : [],
    lootFilters: normalizeLootFilters(data.lootFilters),
    seedMode: data.seedMode === 'list' ? 'list' : 'single',
  };
  const seedText = typeof data.seedText === 'string' ? data.seedText : '';
  const seedListPath = typeof data.seedListPath === 'string' ? data.seedListPath.trim() : '';
  if (seedText) body.seedText = seedText;
  if (seedListPath) body.seedListPath = seedListPath;
  if (searchers && Object.keys(searchers).length > 0) body.searchers = searchers;
  if (data.theme === 'dark' || data.theme === 'light') body.theme = data.theme;
  if (data.locale === 'zh' || data.locale === 'en') body.locale = data.locale;
  if (data.biomeGroupScheme) body.biomeGroupScheme = data.biomeGroupScheme;
  return pretty ? `${JSON.stringify(body, null, 2)}\n` : JSON.stringify(body);
}

/** Compare dotted versions (e.g. 1.2.0); returns -1 / 0 / 1. */
export function compareAppVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .split(/[.+-]/)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const da = left[i] ?? 0;
    const db = right[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * Program version recorded in the session file, or null if the file predates that field
 * (legacy schema number / MC name in `version`).
 */
export function peekSessionAppVersion(text: string): string | null {
  const raw = text.trim();
  if (!raw.startsWith('{')) return null;
  try {
    const data = JSON.parse(raw) as {
      version?: unknown;
      mcVersion?: unknown;
      formatVersion?: unknown;
    };
    if (typeof data.version !== 'string') return null;
    const value = data.version.trim();
    if (!value || /^\d+$/.test(value)) return null;
    // New files always pair program `version` with `mcVersion` and/or `formatVersion`.
    if (typeof data.mcVersion === 'string' || typeof data.formatVersion === 'number') return value;
    // Three-part x.y.z without mcVersion: treat as program version.
    if (/^\d+\.\d+\.\d+/.test(value)) return value;
    return null;
  } catch {
    return null;
  }
}

/** True when the file was written by a newer app build than this process. */
export function isSessionFromNewerApp(text: string): boolean {
  const fileVersion = peekSessionAppVersion(text);
  if (!fileVersion) return false;
  return compareAppVersions(fileVersion, APP_VERSION) > 0;
}

export function parseSessionFile(text: string): MapSessionData | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw) as Partial<MapSessionData> & Record<string, unknown>;
      // Import / export format is JSON aio-session (v1 legacy or v2 reduced).
      if (data.kind != null && data.kind !== 'aio-session') return null;
      return normalize(data);
    } catch {
      return null;
    }
  }
  // Legacy key=value map dumps (map-only); still accepted for import.
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  if (!map.has('seed') && !map.has('mcVersion')) return null;
  const features = (map.get('features') || '')
    .split(/[, ]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return normalize({
    seed: map.get('seed') || '',
    mcVersion: map.get('mcVersion') || map.get('versionName') || '',
    dim: Number(map.get('dim') || 0),
    y: Number(map.get('y') || 256),
    x: map.has('x') ? Number(map.get('x')) : undefined,
    z: map.has('z') ? Number(map.get('z')) : undefined,
    largeBiomes: map.get('largeBiomes') === 'true' || map.get('largeBiomes') === '1',
    grid: map.get('grid') !== 'false' && map.get('grid') !== '0',
    terrain: map.get('terrain') === 'true' || map.get('terrain') === '1',
    features,
  });
}

function normalizeLootFilters(
  value: Partial<Record<'misc' | 'template' | 'disc' | 'sherd', boolean>> | undefined,
): { misc: boolean; template: boolean; disc: boolean; sherd: boolean } {
  return {
    misc: value?.misc !== false,
    template: value?.template !== false,
    disc: value?.disc !== false,
    sherd: value?.sherd !== false,
  };
}

function normalize(
  data: Partial<MapSessionData> & { version?: number | string; formatVersion?: unknown },
): MapSessionData | null {
  const seed = typeof data.seed === 'string' ? data.seed.trim() : '';
  if (!seed) return null;
  const dim = Number(data.dim);
  const y = Number(data.y);
  // Legacy: `version` held an MC name when `mcVersion` was absent and it was not a schema int.
  const hasMc = typeof data.mcVersion === 'string' && !!data.mcVersion;
  const hasFormat = typeof data.formatVersion === 'number';
  const named =
    !hasMc &&
    !hasFormat &&
    typeof data.version === 'string' &&
    !/^\d+$/.test(data.version) &&
    !/^\d+\.\d+\.\d+/.test(data.version)
      ? data.version
      : '';
  const appVersion =
    typeof data.version === 'string' && (hasMc || hasFormat || /^\d+\.\d+\.\d+/.test(data.version))
      ? data.version.trim()
      : APP_VERSION;
  const terrain = data.terrain === true;
  /* 地图中心：旧 session 没有这两个字段，缺省 0,0（保持旧行为）。 */
  const x = Number(data.x);
  const z = Number(data.z);
  const searchersRaw =
    data.searchers && typeof data.searchers === 'object' ? data.searchers : undefined;
  const lifted = liftSharedSeedFromSearchers(
    searchersRaw,
    {
      seedMode: data.seedMode === 'single' || data.seedMode === 'list' ? data.seedMode : undefined,
      seedText: typeof data.seedText === 'string' ? data.seedText : undefined,
      seedListPath: typeof data.seedListPath === 'string' ? data.seedListPath : undefined,
    },
    seed,
  );
  // Always keep in-memory searchers in reduced form (no per-searcher seed copies).
  const searchers = stripAllSearcherSeedFields(searchersRaw);
  return {
    kind: 'aio-session',
    version: appVersion || APP_VERSION,
    seed,
    mcVersion: typeof data.mcVersion === 'string' && data.mcVersion ? data.mcVersion : named,
    dim: dim === -1 || dim === 1 ? dim : 0,
    y: Number.isFinite(y) ? y : 256,
    x: Number.isFinite(x) ? Math.round(x) : 0,
    z: Number.isFinite(z) ? Math.round(z) : 0,
    largeBiomes: !!data.largeBiomes,
    grid: data.grid !== false,
    terrain,
    features: Array.isArray(data.features)
      ? data.features.filter((item): item is string => typeof item === 'string')
      : [],
    lootFilters: normalizeLootFilters(data.lootFilters),
    searchers,
    seedMode: lifted.seedMode,
    seedText: lifted.seedText,
    seedListPath: lifted.seedListPath,
    theme: data.theme === 'dark' || data.theme === 'light' ? data.theme : undefined,
    locale: data.locale === 'zh' || data.locale === 'en' ? data.locale : undefined,
    biomeGroupScheme: parseBiomeGroupScheme(data.biomeGroupScheme),
  };
}
