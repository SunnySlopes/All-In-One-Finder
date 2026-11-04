/**
 * Shell-model geometry shared with lowydripstonecavefinder.h.
 *
 * The precise pass scores the 24 < r <= 128 shell around (x, afkY, z); the
 * display denominator is the per-layer average of the shell cell counts over
 * the sampled layer window.  Keeping the same integer math here lets the panel
 * convert ratio <-> area synchronously, before any engine round trip.
 */
export const AFK_OFFSET_FROM_Y_MIN = 23;
export const AFK_Y_LIMIT_MIN = -64;
export const AFK_Y_LIMIT_MAX = 320;

/** AFK Y of a layer window: lowest layer + 23, clamped like the engine. */
export function caveDefaultAfkY(yMin: number): number {
  const derived = yMin + AFK_OFFSET_FROM_Y_MIN;
  return Math.min(AFK_Y_LIMIT_MAX, Math.max(AFK_Y_LIMIT_MIN, derived));
}

function isqrtFloor(value: number): number {
  if (value <= 0) return 0;
  let root = Math.floor(Math.sqrt(value));
  while ((root + 1) * (root + 1) <= value) root++;
  while (root * root > value) root--;
  return root;
}

/** Block centres inside the 24..128 shell at vertical offset dy. */
export function caveShellLayerCellCount(dy: number): number {
  const dy2 = dy * dy;
  const outer2 = 128 * 128;
  if (dy2 > outer2) return 0;
  let total = 0;
  for (let dz = -128; dz <= 128; dz++) {
    const out2 = outer2 - dy2 - dz * dz;
    if (out2 < 0) continue;
    total += 2 * isqrtFloor(out2) + 1;
    const in2 = 24 * 24 - dy2 - dz * dz;
    if (in2 >= 0) total -= 2 * isqrtFloor(in2) + 1;
  }
  return total;
}

/** Display denominator: mean shell cell count over the sampled layers. */
export function caveFullShellArea(yMin: number, yMax: number, afkY: number): number {
  const layers = Math.min(48, Math.max(1, yMax - yMin + 1));
  let sum = 0;
  for (let layer = 0; layer < layers; layer++) {
    sum += caveShellLayerCellCount(yMin + layer - afkY);
  }
  return Math.floor((sum + Math.floor(layers / 2)) / layers);
}
