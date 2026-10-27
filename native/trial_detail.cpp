#include "trial_detail.h"

#include "cubiomes/biomes.h"

#include "layout.hpp"

#include <algorithm>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace {

/** Cached chamber details are tiny (~10 frames); 1024 entries cap the map session. */
constexpr size_t kMaxCachedChambers = 1024;
/** 房间框水平外扩 1 格，覆盖挂在墙外的支架与笼点；Y 不变。 */
constexpr int kFramePad = 1;

std::mutex gMu;
std::unique_ptr<trial::LayoutEngine> gEngine;
int gEngineGeneration = -1;
uint64_t gEngineSeed = 0;

std::unordered_map<uint64_t, TrialChamberInfo> gCache;
int gCacheGeneration = -1;
uint64_t gCacheSeed = 0;

uint64_t cacheKey(int chunkX, int chunkZ)
{
    return (static_cast<uint64_t>(static_cast<uint32_t>(chunkX)) << 32)
        | static_cast<uint32_t>(chunkZ);
}

TrialChamberInfo computeChamber(int chunkX, int chunkZ)
{
    TrialChamberInfo detail;
    detail.chunkX = chunkX;
    detail.chunkZ = chunkZ;

    std::vector<trial::PieceBox> boxes;
    const trial::Chamber chamber = gEngine->generate(chunkX, chunkZ, &boxes);
    detail.exists = chamber.exists;
    detail.pieces = chamber.pieces;

    // 只保留含笼房间（宿主房间），并把框水平外扩 1 格；连廊/空房间/挂件都不输出。
    detail.frames.reserve(boxes.size());
    for (const trial::PieceBox &piece : boxes) {
        if (piece.spawners <= 0) continue;
        TrialFrame frame;
        frame.box = {piece.box.lo.x - kFramePad, piece.box.lo.y, piece.box.lo.z - kFramePad,
                     piece.box.hi.x + kFramePad, piece.box.hi.y, piece.box.hi.z + kFramePad};
        frame.spawners = piece.spawners;
        frame.slowSpawners = piece.slow_spawners;
        detail.frames.push_back(frame);
    }

    // Layout returns both cage lists sorted and de-duplicated; slow cages are a subset.
    detail.spawners.reserve(chamber.spawners.size());
    for (const trial::Vec3 &p : chamber.spawners) {
        const bool slow = std::binary_search(chamber.slow_spawners.begin(), chamber.slow_spawners.end(), p);
        detail.spawners.push_back({p.x, p.y, p.z, slow});
    }
    return detail;
}

} // namespace

int trialGenerationForMc(int mc)
{
    // 1.21/1.21.1 share the legacy layout table; 1.21.2+ (first data version 1.21.3)
    // share the modern table; 26.3 adds its own climate. Older versions have no trial chambers.
    if (mc < MC_1_21_1) return 0;
    if (mc <= MC_1_21_1) return 1;
    if (mc >= MC_26_3) return 3;
    return 2;
}

std::vector<TrialChamberInfo> trialChambers(int mc, uint64_t seed,
                                            const std::vector<std::pair<int, int> > &chambers)
{
    std::vector<TrialChamberInfo> out;
    const int generation = trialGenerationForMc(mc);
    if (generation == 0 || chambers.empty()) return out;

    std::lock_guard<std::mutex> lock(gMu);
    if (gCacheGeneration != generation || gCacheSeed != seed) {
        gCache.clear();
        gCacheGeneration = generation;
        gCacheSeed = seed;
        gEngine.reset();
    }
    if (!gEngine || gEngineGeneration != generation || gEngineSeed != seed) {
        // Constructing the engine builds the biome generator (and 26.3 climate), so it is
        // cached for the whole seed/version session rather than per request.
        gEngine = std::make_unique<trial::LayoutEngine>(generation, seed);
        gEngineGeneration = generation;
        gEngineSeed = seed;
    }

    out.reserve(chambers.size());
    for (const auto &position : chambers) {
        const int chunkX = trial::floor_div(position.first, 16);
        const int chunkZ = trial::floor_div(position.second, 16);
        const uint64_t key = cacheKey(chunkX, chunkZ);
        auto found = gCache.find(key);
        if (found == gCache.end()) {
            if (gCache.size() >= kMaxCachedChambers) gCache.clear();
            found = gCache.emplace(key, computeChamber(chunkX, chunkZ)).first;
        }
        TrialChamberInfo detail = found->second;
        detail.x = position.first;
        detail.z = position.second;
        out.push_back(std::move(detail));
    }
    return out;
}
