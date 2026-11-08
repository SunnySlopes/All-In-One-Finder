import type { ThemeId } from './theme';

export interface MapSessionData {
  kind: 'aio-session';
  version: 1;
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
  /** 每个搜索器当前填写的条件（form + 面板私有状态）。 */
  searchers?: Record<string, unknown>;
  /**
   * 界面主题。写进存档后，下次启动（含换会话打开同一存档）会沿用，
   * 而不是重新跟随系统。旧 session 缺省为 undefined，由调用方决定回退策略。
   */
  theme?: ThemeId;
}

export function parseSessionFile(text: string): MapSessionData | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw) as Partial<MapSessionData>;
      return normalize(data);
    } catch {
      return null;
    }
  }
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

function normalize(data: Partial<MapSessionData> & { version?: number | string }): MapSessionData | null {
  const seed = typeof data.seed === 'string' ? data.seed.trim() : '';
  if (!seed) return null;
  const dim = Number(data.dim);
  const y = Number(data.y);
  const named = typeof data.version === 'string' && !/^\d+$/.test(data.version) ? data.version : '';
  const terrain = data.terrain === true;
  /* 地图中心：旧 session 没有这两个字段，缺省 0,0（保持旧行为）。 */
  const x = Number(data.x);
  const z = Number(data.z);
  return {
    kind: 'aio-session',
    version: 1,
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
    searchers: data.searchers && typeof data.searchers === 'object' ? data.searchers : undefined,
    theme: data.theme === 'dark' || data.theme === 'light' ? data.theme : undefined,
  };
}
