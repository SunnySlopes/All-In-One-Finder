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

export const SEARCHER_ITEMS: { id: SearcherId; enabled: boolean }[] = [
  { id: 'map', enabled: true },
  { id: 'LowYSwampHut', enabled: true },
  { id: 'River', enabled: true },
  { id: 'LowYDripstoneCave', enabled: true },
  { id: 'LowYPitDripstoneCave', enabled: true },
  { id: 'SlimeChunk', enabled: true },
  { id: 'DoubleMonument', enabled: false },
  { id: 'MultiMonument', enabled: false },
  { id: 'NetherFortressCross', enabled: false },
  { id: 'NetherFortressOverall', enabled: false },
  { id: 'TrialSpawner', enabled: false },
  { id: 'BuddingAmethyst', enabled: false },
  { id: 'FlowerFarm', enabled: false },
];

const DRIPSTONE_TABS: SearcherId[] = ['LowYDripstoneCave', 'LowYPitDripstoneCave'];

export function isDripstoneTab(id: SearcherId | null | undefined): boolean {
  return !!id && DRIPSTONE_TABS.includes(id);
}
