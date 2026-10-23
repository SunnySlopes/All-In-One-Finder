/** Normalize full-width punctuation and whitespace for coordinate text. */
function normalizeCoordText(text: string): string {
  return text
    .trim()
    .replace(/[\uFF08（]/g, '(')
    .replace(/[\uFF09）]/g, ')')
    .replace(/[\uFF0C，]/g, ',')
    .replace(/[\u3000\s]+/g, ' ');
}

/**
 * Parse coordinate text into block X/Z.
 * Supports:
 * - /tp [target] x y z
 * - x z | x y z
 * - (x, z) | (x, y, z) with half/full-width brackets and commas
 */
export function parseCoords(text: string): { x: number; z: number } | null {
  const raw = normalizeCoordText(text);
  if (!raw) return null;

  const tp = raw.match(/^\/?tp(?:\s+@[^\s]+)?\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/i);
  if (tp) {
    const x = Number(tp[1]);
    const z = Number(tp[3]);
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  }

  const paren = raw.match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?\s*\)$/);
  if (paren) {
    const x = Number(paren[1]);
    const z = Number(paren[3] != null ? paren[3] : paren[2]);
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  }

  const spaced = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = spaced.split(' ').filter(Boolean);
  if (parts.length === 2 || parts.length === 3) {
    const x = Number(parts[0]);
    const z = Number(parts[parts.length === 2 ? 1 : 2]);
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  }
  return null;
}
