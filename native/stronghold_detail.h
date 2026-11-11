#pragma once

#include <stdint.h>

#include <utility>
#include <vector>

/**
 * Portal / layout details for one stronghold, as consumed by the map overlay.
 *
 * Backed by geode's embedded 1.18+ stronghold simulator
 * (tools/geode/src/stronghold_118), which ports vanilla's StrongholdPieces and
 * reproduces the vertical placement (`moveBelowSeaLevel`).
 *
 * Y is EXACT. Vanilla's `moveBelowSeaLevel(seaLevel=63, minY=-64, random, 10)`
 * runs unconditionally after layout and depends only on those constants plus
 * the layout RNG state — it never queries the terrain heightmap. The module
 * therefore reports real world Y, not a nominal anchor.
 */
struct StrongholdPortalInfo {
    int x = 0;          // echo of the requested stronghold start (icon point)
    int z = 0;
    int chunkX = 0;
    int chunkZ = 0;
    bool ok = false;        // portal room found
    bool truncated = false; // piece cap hit before finding it
    int pieces = 0;

    // The 3x3 end_portal area, inclusive bounds. Exact.
    int frameMinX = 0;
    int frameMinZ = 0;
    int frameMaxX = 0;
    int frameMaxZ = 0;
    int portalX = 0;   // centre of that 3x3 area
    int portalZ = 0;

    /**
     * World Y of the portal room floor / the 3x3 portal frame. Exact.
     * `portalY` is the Y where the portal blocks sit (frame bottom + 1 in
     * vanilla terms); `roomMinY`/`roomMaxY` bound the whole portal room.
     */
    int portalY = 0;
    int roomMinY = 0;
    int roomMaxY = 0;
    /** True when Y came from the exact vertical-placement model. */
    bool yExact = false;

    // Filled eye frames (0..12), or -1 when the version has no salt config.
    int eyes = -1;

    // Whole-stronghold planar coverage (union of every piece).
    int footprintMinX = 0;
    int footprintMinZ = 0;
    int footprintMaxX = 0;
    int footprintMaxZ = 0;
    int footprintArea = 0;
};

/**
 * Compute portal info for the requested stronghold start points.
 *
 * `starts` holds (x, z) pairs as produced by `featuresInView` for the
 * Stronghold type. Results are cached per (mc, seed); repeated calls for the
 * same stronghold (pan/zoom) are served from memory.
 */
std::vector<StrongholdPortalInfo> strongholdPortals(
    int mc, uint64_t seed, const std::vector<std::pair<int, int> > &starts);
