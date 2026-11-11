#include "stronghold_detail.h"

#include <mutex>
#include <unordered_map>

#include "sh1_18.h"

namespace {

/**
 * The layout computation is a pure function of (mc, seed, chunkX, chunkZ): it
 * needs no Generator and touches no shared cubiomes state. A dedicated mutex
 * therefore only guards the cache, so portal lookups never block the (much
 * heavier) biome tile rendering.
 */
std::mutex gMu;
std::unordered_map<uint64_t, StrongholdPortalInfo> gCache;
int gCacheMc = -1;
uint64_t gCacheSeed = 0;

/** ~128 strongholds per seed; keep a little slack for a few seeds of panning. */
constexpr size_t kMaxCached = 512;

/** Reused piece buffer; the layout is sensitive to the cap, so keep it fixed. */
Sh118Piece gPieces[SH118_PIECE_CAPACITY];

uint64_t cacheKey(int chunkX, int chunkZ)
{
    return (static_cast<uint64_t>(static_cast<uint32_t>(chunkX)) << 32)
        | static_cast<uint32_t>(chunkZ);
}

StrongholdPortalInfo computeOne(int mc, uint64_t seed, int chunkX, int chunkZ)
{
    StrongholdPortalInfo info;
    info.chunkX = chunkX;
    info.chunkZ = chunkZ;
    info.x = (chunkX << 4) + 4;
    info.z = (chunkZ << 4) + 4;

    Sh118Stronghold p;
    const int generated = sh118_compute(&p, gPieces, SH118_PIECE_CAPACITY,
                                       mc, seed, chunkX, chunkZ);
    if (generated <= 0) return info;

    info.pieces = p.pieces;
    info.truncated = p.truncated != 0;
    info.ok = p.ok != 0;
    // Prefer the library's authoritative start point when it produced one.
    if (p.startX != 0 || p.startZ != 0) {
        info.x = p.startX;
        info.z = p.startZ;
    }
    if (!info.ok) return info;

    info.portalX = p.portalX;
    info.portalZ = p.portalZ;
    info.frameMinX = p.frameMinX;
    info.frameMinZ = p.frameMinZ;
    info.frameMaxX = p.frameMaxX;
    info.frameMaxZ = p.frameMaxZ;
    info.eyes = p.eyes;
    info.footprintMinX = p.footprintMinX;
    info.footprintMinZ = p.footprintMinZ;
    info.footprintMaxX = p.footprintMaxX;
    info.footprintMaxZ = p.footprintMaxZ;
    info.footprintArea = p.footprintArea;

    // Portal room vertical bounds in real world Y (module already applied dy).
    info.roomMinY = p.roomNominalMinY;
    info.roomMaxY = p.roomNominalMaxY;

    // The 3x3 portal frame sits on the room floor: vanilla's portal room has
    // the frame bottom one block above the room's lowest layer, so the portal
    // blocks themselves occupy that plane.
    info.portalY = p.roomNominalMinY + 1;
    info.yExact = p.dyExact != 0;

    return info;
}

} // namespace

std::vector<StrongholdPortalInfo> strongholdPortals(
    int mc, uint64_t seed, const std::vector<std::pair<int, int> > &starts)
{
    std::vector<StrongholdPortalInfo> out;
    out.reserve(starts.size());
    if (starts.empty()) return out;
    if (!sh118_versionSupported(mc)) return out;

    std::lock_guard<std::mutex> lock(gMu);
    if (gCacheMc != mc || gCacheSeed != seed) {
        gCache.clear();
        gCacheMc = mc;
        gCacheSeed = seed;
    }

    for (const auto &start : starts) {
        // The map hands us the stronghold start block position, which vanilla
        // pins to (4, 4) inside its chunk.
        const int chunkX = start.first >> 4;
        const int chunkZ = start.second >> 4;
        const uint64_t key = cacheKey(chunkX, chunkZ);

        auto found = gCache.find(key);
        if (found != gCache.end()) {
            out.push_back(found->second);
            continue;
        }

        StrongholdPortalInfo info = computeOne(mc, seed, chunkX, chunkZ);
        // Keep the caller's exact coordinates: the info card shows the icon
        // point the user actually sees on the map.
        info.x = start.first;
        info.z = start.second;

        if (gCache.size() >= kMaxCached) gCache.clear();
        gCache.emplace(key, info);
        out.push_back(info);
    }
    return out;
}
