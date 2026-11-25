/**
 * Overworld biome grouping for the colormap panel.
 *
 * Built-in schemes:
 * - continentalness (default): ocean / coast / inland-by-temp / mountains / caves
 * - temperature: climate bands (peaks folded into frozen; mushroom in warm; caves separate;
 *   temperate further split by humidity into woods vs other)
 * - none: flat list, locale-aware alphabetical by display name (handled in UI)
 *
 * Within-group sort:
 * - continentalness scheme → temperature ascending (ties free)
 * - temperature scheme → continentalness descending (ties free)
 */

export type BiomeGroupSchemeId = 'continentalness' | 'temperature' | 'none';

export interface BiomeGroupDef {
  id: string;
  /** i18n key under common.map.biomeGroup.* */
  labelKey: string;
  biomes: string[];
}

/** Midpoint-ish climate scores (*10000 style) for within-group sorting. */
const TEMP_SCORE: Record<string, number> = {
  // frozen / T0
  snowy_plains: -7250,
  ice_spikes: -7250,
  snowy_taiga: -7250,
  frozen_ocean: -7250,
  deep_frozen_ocean: -7250,
  frozen_river: -7250,
  snowy_beach: -7250,
  frozen_peaks: -7250,
  grove: -7250,
  snowy_slopes: -7250,
  jagged_peaks: -7250,
  stony_peaks: -7250,
  // cold / T1
  taiga: -3000,
  old_growth_pine_taiga: -3000,
  old_growth_spruce_taiga: -3000,
  cold_ocean: -3000,
  deep_cold_ocean: -3000,
  windswept_hills: -3000,
  windswept_forest: -3000,
  windswept_gravelly_hills: -3000,
  // temperate / T2
  plains: 250,
  sunflower_plains: 250,
  forest: 250,
  flower_forest: 250,
  birch_forest: 250,
  old_growth_birch_forest: 250,
  dark_forest: 250,
  river: 250,
  ocean: 250,
  deep_ocean: 250,
  beach: 250,
  stony_shore: 250,
  meadow: 250,
  cherry_grove: 250,
  pale_garden: 250,
  swamp: 250,
  mangrove_swamp: 250,
  dappled_forest: 250,
  mushroom_fields: 250,
  dripstone_caves: 250,
  lush_caves: 250,
  deep_dark: 250,
  sulfur_caves: 250,
  // lukewarm / T3
  jungle: 3750,
  sparse_jungle: 3750,
  bamboo_jungle: 3750,
  lukewarm_ocean: 3750,
  deep_lukewarm_ocean: 3750,
  savanna: 3750,
  savanna_plateau: 3750,
  windswept_savanna: 3750,
  // warm / T4
  desert: 7750,
  badlands: 7750,
  wooded_badlands: 7750,
  eroded_badlands: 7750,
  warm_ocean: 7750,
};

const CONT_SCORE: Record<string, number> = {
  // C0
  mushroom_fields: -11250,
  // C1 deep ocean
  deep_ocean: -7525,
  deep_frozen_ocean: -7525,
  deep_cold_ocean: -7525,
  deep_lukewarm_ocean: -7525,
  // C2 ocean
  ocean: -3225,
  frozen_ocean: -3225,
  cold_ocean: -3225,
  lukewarm_ocean: -3225,
  warm_ocean: -3225,
  // C3 coast
  beach: -1500,
  snowy_beach: -1500,
  stony_shore: -1500,
  // C4 near inland
  river: -400,
  frozen_river: -400,
  swamp: -400,
  mangrove_swamp: -400,
  // C5–C6 inland / mountains (mountains score as inland-high)
  plains: 1650,
  sunflower_plains: 1650,
  forest: 1650,
  flower_forest: 1650,
  birch_forest: 1650,
  old_growth_birch_forest: 1650,
  dark_forest: 1650,
  taiga: 1650,
  old_growth_pine_taiga: 1650,
  old_growth_spruce_taiga: 1650,
  snowy_plains: 1650,
  ice_spikes: 1650,
  snowy_taiga: 1650,
  desert: 1650,
  jungle: 1650,
  sparse_jungle: 1650,
  bamboo_jungle: 1650,
  savanna: 1650,
  savanna_plateau: 3000,
  windswept_savanna: 1650,
  badlands: 1650,
  wooded_badlands: 3000,
  eroded_badlands: 1650,
  windswept_hills: 1650,
  windswept_forest: 1650,
  windswept_gravelly_hills: 1650,
  meadow: 3000,
  cherry_grove: 3000,
  pale_garden: 3000,
  dappled_forest: 1650,
  jagged_peaks: 6500,
  frozen_peaks: 6500,
  stony_peaks: 6500,
  grove: 6500,
  snowy_slopes: 6500,
  // caves: treat as inland for sort
  dripstone_caves: 1650,
  lush_caves: 1650,
  deep_dark: 1650,
  sulfur_caves: 1650,
};

/** Continentalness preset groups. */
export const CONTINENTALNESS_GROUPS: BiomeGroupDef[] = [
  {
    // Mushroom + deep/shallow oceans.
    id: 'ocean',
    labelKey: 'ocean',
    biomes: [
      'mushroom_fields',
      'deep_ocean',
      'deep_frozen_ocean',
      'deep_cold_ocean',
      'deep_lukewarm_ocean',
      'ocean',
      'frozen_ocean',
      'cold_ocean',
      'lukewarm_ocean',
      'warm_ocean',
    ],
  },
  {
    // Beaches + near-inland waterways/wetlands.
    id: 'coast',
    labelKey: 'coast',
    biomes: [
      'beach',
      'snowy_beach',
      'stony_shore',
      'river',
      'frozen_river',
      'swamp',
      'mangrove_swamp',
    ],
  },
  {
    // Inland frozen + cold.
    id: 'inland_cold',
    labelKey: 'inlandCold',
    biomes: [
      'snowy_plains',
      'ice_spikes',
      'snowy_taiga',
      'taiga',
      'old_growth_pine_taiga',
      'old_growth_spruce_taiga',
      'windswept_hills',
      'windswept_forest',
      'windswept_gravelly_hills',
    ],
  },
  {
    id: 'inland_temperate',
    labelKey: 'inlandTemperate',
    biomes: [
      'plains',
      'sunflower_plains',
      'forest',
      'flower_forest',
      'birch_forest',
      'old_growth_birch_forest',
      'dark_forest',
      'pale_garden',
      'dappled_forest',
      'cherry_grove',
    ],
  },
  {
    // Inland lukewarm + warm.
    id: 'inland_warm',
    labelKey: 'inlandWarm',
    biomes: [
      'jungle',
      'sparse_jungle',
      'bamboo_jungle',
      'savanna',
      'savanna_plateau',
      'windswept_savanna',
      'desert',
      'badlands',
      'wooded_badlands',
      'eroded_badlands',
    ],
  },
  {
    id: 'mountains',
    labelKey: 'mountains',
    biomes: ['jagged_peaks', 'frozen_peaks', 'stony_peaks', 'grove', 'snowy_slopes', 'meadow'],
  },
  {
    id: 'caves',
    labelKey: 'caves',
    biomes: ['dripstone_caves', 'lush_caves', 'deep_dark', 'sulfur_caves'],
  },
];

/** Temperature scheme: peaks in frozen; mushroom in warm; caves alone. */
export const TEMPERATURE_GROUPS: BiomeGroupDef[] = [
  {
    id: 'frozen',
    labelKey: 'frozen',
    biomes: [
      'snowy_plains',
      'ice_spikes',
      'snowy_taiga',
      'frozen_ocean',
      'deep_frozen_ocean',
      'frozen_river',
      'snowy_beach',
      'frozen_peaks',
      'grove',
      'snowy_slopes',
      'jagged_peaks',
      'stony_peaks',
    ],
  },
  {
    id: 'cold',
    labelKey: 'cold',
    biomes: [
      'taiga',
      'old_growth_pine_taiga',
      'old_growth_spruce_taiga',
      'cold_ocean',
      'deep_cold_ocean',
      'windswept_hills',
      'windswept_forest',
      'windswept_gravelly_hills',
    ],
  },
  {
    // Temperate + high humidity (forests / wetlands).
    id: 'temperate_woods',
    labelKey: 'temperateWoods',
    biomes: [
      'forest',
      'flower_forest',
      'birch_forest',
      'old_growth_birch_forest',
      'dark_forest',
      'pale_garden',
      'dappled_forest',
      'cherry_grove',
      'swamp',
      'mangrove_swamp',
    ],
  },
  {
    // Temperate + lower humidity (plains / water / coast).
    id: 'temperate_other',
    labelKey: 'temperateOther',
    biomes: [
      'plains',
      'sunflower_plains',
      'meadow',
      'river',
      'ocean',
      'deep_ocean',
      'beach',
      'stony_shore',
    ],
  },
  {
    id: 'lukewarm',
    labelKey: 'lukewarm',
    biomes: [
      'jungle',
      'sparse_jungle',
      'bamboo_jungle',
      'lukewarm_ocean',
      'deep_lukewarm_ocean',
      'savanna',
      'savanna_plateau',
      'windswept_savanna',
    ],
  },
  {
    id: 'warm',
    labelKey: 'warm',
    biomes: [
      'desert',
      'badlands',
      'wooded_badlands',
      'eroded_badlands',
      'warm_ocean',
      'mushroom_fields',
    ],
  },
  {
    id: 'caves',
    labelKey: 'caves',
    biomes: ['dripstone_caves', 'lush_caves', 'deep_dark', 'sulfur_caves'],
  },
];

export const DEFAULT_SCHEME: BiomeGroupSchemeId = 'none';

export function parseBiomeGroupScheme(value: unknown): BiomeGroupSchemeId {
  if (value === 'continentalness' || value === 'temperature' || value === 'none') return value;
  return DEFAULT_SCHEME;
}

export function groupsForScheme(scheme: BiomeGroupSchemeId): BiomeGroupDef[] {
  if (scheme === 'none') return [];
  if (scheme === 'temperature') return TEMPERATURE_GROUPS;
  return CONTINENTALNESS_GROUPS;
}

export function tempScore(name: string): number {
  return TEMP_SCORE[name] ?? 0;
}

export function contScore(name: string): number {
  return CONT_SCORE[name] ?? 0;
}

/** Sort biome names inside a group for the active scheme. */
export function sortBiomesInGroup(names: string[], scheme: BiomeGroupSchemeId): string[] {
  const copy = names.slice();
  if (scheme === 'none') {
    copy.sort((a, b) => a.localeCompare(b));
  } else if (scheme === 'temperature') {
    // Continentalness descending.
    copy.sort((a, b) => contScore(b) - contScore(a) || a.localeCompare(b));
  } else {
    // Continentalness: temperature ascending.
    copy.sort((a, b) => tempScore(a) - tempScore(b) || a.localeCompare(b));
  }
  return copy;
}
