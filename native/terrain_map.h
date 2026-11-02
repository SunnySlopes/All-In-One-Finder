#pragma once

#include <cstdint>
#include <vector>

#include "map_service.h"

/*
 * Map layers beyond the classic biome colouring.
 *
 *   MAP_LAYER_BIOME            existing `renderTiles` path (unchanged)
 *   MAP_LAYER_TERRAIN          1:1 relief from the cave-free cubiomes
 *                              `sloped_cheese` density, biome colours underneath
 *   MAP_LAYER_TERRAIN_CAVES    1:1 relief from the full `final_density` field
 *                              (caves carve the surface) plus the surface
 *                              openings of cheese caves (dry/water/lava)
 *
 * Only 1:1 renders terrain; 1:4 and coarser always stay on the biome map. The
 * layer travels with the tile key on the front end, so terrain tiles and biome
 * tiles never overwrite each other.
 */
enum MapLayer {
    MAP_LAYER_BIOME = 0,
    MAP_LAYER_TERRAIN = 1,
    MAP_LAYER_TERRAIN_CAVES = 2,
};

/**
 * Render terrain tiles. `layer` must be MAP_LAYER_TERRAIN or
 * MAP_LAYER_TERRAIN_CAVES; `layer == MAP_LAYER_BIOME` is handled by
 * `renderTiles` in map_service.cpp and must not reach this function.
 *
 * Only the overworld and MC 1.18+ use the real density field; any other
 * dimension/version falls back to plain biome colours (with the terrain
 * payload zero-filled) so the wire layout stays identical.
 */
void renderTerrainTiles(int mc, uint64_t seed, int dim, uint32_t flags, int blockY,
                        int layer, const std::vector<TileSpec> &tiles,
                        std::vector<TileImage> &out);
