export type SearcherId =
  | 'map'
  | 'LowYSwampHut'
  | 'River'
  | 'LowYDripstoneCave'
  | 'LowYPitDripstoneCave'
  | 'SlimeChunk'
  | 'DoubleMonument'
  | 'MultiMonument'
  | 'NetherFortressCross'
  | 'NetherFortressOverall'
  | 'TrialSpawner'
  | 'BuddingAmethyst'
  | 'FlowerFarm';

export interface SearcherItem {
  id: SearcherId;
  enabled: boolean;
  /**
   * Icon file under `public/icons` (name only, no extension). Items without an icon keep an
   * empty slot in the searcher bar so the layout stays stable.
   */
  icon?: string;
}

export const SEARCHER_ITEMS: SearcherItem[] = [
  { id: 'map', enabled: true, icon: 'spawn' },
  { id: 'LowYSwampHut', enabled: true, icon: 'hut' },
  { id: 'River', enabled: true, icon: 'drowned' },
  { id: 'LowYDripstoneCave', enabled: true, icon: 'drowned' },
  { id: 'LowYPitDripstoneCave', enabled: true, icon: 'drowned' },
  { id: 'SlimeChunk', enabled: true, icon: 'slime_face' },
  { id: 'DoubleMonument', enabled: true, icon: 'guardian' },
  { id: 'MultiMonument', enabled: true, icon: 'guardian' },
  { id: 'NetherFortressCross', enabled: true, icon: 'blaze' },
  { id: 'NetherFortressOverall', enabled: true, icon: 'blaze' },
  { id: 'TrialSpawner', enabled: false, icon: 'chambers' },
  { id: 'BuddingAmethyst', enabled: false, icon: 'geode' },
  { id: 'FlowerFarm', enabled: false, icon: 'torchflower' },
];

const DRIPSTONE_TABS: SearcherId[] = ['LowYDripstoneCave', 'LowYPitDripstoneCave'];

export function isDripstoneTab(id: SearcherId | null | undefined): boolean {
  return !!id && DRIPSTONE_TABS.includes(id);
}
