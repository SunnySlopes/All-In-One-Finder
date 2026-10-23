export interface MapSessionData {
  kind: 'aio-session';
  version: 1;
  seed: string;
  mcVersion: string;
  dim: number;
  y: number;
  largeBiomes: boolean;
  grid: boolean;
  features: string[];
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
    largeBiomes: map.get('largeBiomes') === 'true' || map.get('largeBiomes') === '1',
    grid: map.get('grid') !== 'false' && map.get('grid') !== '0',
    features,
  });
}

function normalize(data: Partial<MapSessionData> & { version?: number | string }): MapSessionData | null {
  const seed = typeof data.seed === 'string' ? data.seed.trim() : '';
  if (!seed) return null;
  const dim = Number(data.dim);
  const y = Number(data.y);
  const named = typeof data.version === 'string' && !/^\d+$/.test(data.version) ? data.version : '';
  return {
    kind: 'aio-session',
    version: 1,
    seed,
    mcVersion: typeof data.mcVersion === 'string' && data.mcVersion ? data.mcVersion : named,
    dim: dim === -1 || dim === 1 ? dim : 0,
    y: Number.isFinite(y) ? y : 256,
    largeBiomes: !!data.largeBiomes,
    grid: data.grid !== false,
    features: Array.isArray(data.features)
      ? data.features.filter((item): item is string => typeof item === 'string')
      : [],
  };
}
