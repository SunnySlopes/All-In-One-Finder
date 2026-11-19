#include "map_service.h"

#include "cubiomes/biomes.h"
#include "cubiomes/biomenoise.h"
#include "cubiomes/features/end_city.h"
#include "cubiomes/features/fortress.h"
#include "cubiomes/features/stronghold.h"
#include "cubiomes/finders.h"
#include "cubiomes/generator.h"
#include "cubiomes/util.h"

#include "loots/bastion.h"
#include "loots/outpost.h"
#include "loots/shipwreck.h"
#include "loots/trail_ruins.h"
#include "loots/ocean_ruin.h"
#include "loots/woodland_mansion.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>

// lowyswamphut: hut orientation (footprint 7(x)x9(z) or 9(x)x7(z)). The low-Y
// hut searcher shares this recipe; the map draws an oriented footprint frame.
extern "C" int lysh_hut_orientation(uint64_t world_seed, int hut_x, int hut_z);

// loots stores Minecraft version ids as plain integers (it has no cubiomes
// headers). Assert them against cubiomes' enum here so a cubiomes update that
// renumbers versions fails the build instead of silently mis-tiering.
static_assert(MC_1_19_2 == 23 && MC_1_19_4 == 24 && MC_1_20_6 == 25 &&
              MC_1_21_6 == 30 && MC_1_21_11 == 32 && MC_26_1 == 33,
              "cubiomes MC_* ids changed - update tools/loots/src/version.cpp");

namespace {

std::mutex gMu;
Generator gGen;
bool gGenReady = false;
int gMc = -1;
int gDim = 999;
uint32_t gFlags = 0;
uint64_t gSeed = 0;
unsigned char gColors[256][3];
bool gColorsReady = false;

struct StrongholdCache {
    int mc = -1;
    uint64_t seed = 0;
    uint32_t flags = 0;
    std::vector<Pos> points;
};

StrongholdCache gStrongholds;

/** Piece-level fortress frames are reused while the seed/version stays unchanged. */
std::mutex gFrameMu;
std::unordered_map<uint64_t, FortressBounds> gFrameCache;
int gFrameMc = -1;
uint64_t gFrameSeed = 0;
uint32_t gFrameFlags = 0;

uint64_t frameKey(int x, int z)
{
    return (static_cast<uint64_t>(static_cast<uint32_t>(x)) << 32)
        | static_cast<uint32_t>(z);
}

bool cachedFortressBounds(int mc, uint64_t seed, uint32_t flags, int blockX, int blockZ,
                          FortressBounds &out)
{
    const uint64_t key = frameKey(blockX, blockZ);
    {
        std::lock_guard<std::mutex> lock(gFrameMu);
        if (gFrameMc != mc || gFrameSeed != seed || gFrameFlags != flags) {
            gFrameCache.clear();
            gFrameMc = mc;
            gFrameSeed = seed;
            gFrameFlags = flags;
        } else {
            auto found = gFrameCache.find(key);
            if (found != gFrameCache.end()) {
                out = found->second;
                return true;
            }
        }
    }

    FortressBounds computed;
    if (!fortressBounds(mc, seed, blockX, blockZ, computed)) return false;

    {
        std::lock_guard<std::mutex> lock(gFrameMu);
        if (gFrameMc != mc || gFrameSeed != seed || gFrameFlags != flags) {
            gFrameCache.clear();
            gFrameMc = mc;
            gFrameSeed = seed;
            gFrameFlags = flags;
        }
        if (gFrameCache.size() > 2048) gFrameCache.clear();
        auto inserted = gFrameCache.emplace(key, std::move(computed));
        out = inserted.first->second;
    }
    return true;
}

Pos gSpawn{};
int gSpawnMc = -1;
uint64_t gSpawnSeed = 0;
uint32_t gSpawnFlags = 0;
bool gSpawnReady = false;

const int kVersions[] = {
    MC_B1_7,    MC_B1_8,    MC_1_0_0,   MC_1_1_0,   MC_1_2_5,   MC_1_3_2,
    MC_1_4_7,   MC_1_5_2,   MC_1_6_4,   MC_1_7_10,  MC_1_8_9,   MC_1_9_4,
    MC_1_10_2,  MC_1_11_2,  MC_1_12_2,  MC_1_13_2,  MC_1_14_4,  MC_1_15_2,
    MC_1_16_1,  MC_1_16_5,  MC_1_17_1,  MC_1_18_2,  MC_1_19_2,  MC_1_19_4,
    MC_1_20_6,  MC_1_21_1,  MC_1_21_3,  MC_1_21_4,  MC_1_21_5,  MC_1_21_6,
    MC_1_21_9,  MC_1_21_11, MC_26_1,    MC_26_2,    MC_26_3,
};

struct FeatureDef {
    int id;
    const char *key;
    int dim;
};

const FeatureDef kFeatures[] = {
    {Desert_Pyramid, "desert_pyramid", DIM_OVERWORLD},
    {Jungle_Temple, "jungle_temple", DIM_OVERWORLD},
    {Swamp_Hut, "swamp_hut", DIM_OVERWORLD},
    {Igloo, "igloo", DIM_OVERWORLD},
    {Village, "village", DIM_OVERWORLD},
    {Ocean_Ruin, "ocean_ruin", DIM_OVERWORLD},
    {Shipwreck, "shipwreck", DIM_OVERWORLD},
    {Monument, "monument", DIM_OVERWORLD},
    {Mansion, "mansion", DIM_OVERWORLD},
    {Outpost, "outpost", DIM_OVERWORLD},
    {Ruined_Portal, "ruined_portal", DIM_OVERWORLD},
    {Ancient_City, "ancient_city", DIM_OVERWORLD},
    {Treasure, "treasure", DIM_OVERWORLD},
    {Mineshaft, "mineshaft", DIM_OVERWORLD},
    {Desert_Well, "desert_well", DIM_OVERWORLD},
    {Geode, "geode", DIM_OVERWORLD},
    {Trail_Ruins, "trail_ruins", DIM_OVERWORLD},
    {Trial_Chambers, "trial_chambers", DIM_OVERWORLD},
    {Abandoned_Camp, "abandoned_camp", DIM_OVERWORLD},
    {Stronghold, "stronghold", DIM_OVERWORLD},
    // Ancient-city ward/silence/swift-sneak/golden-apple are no longer separate
    // checkboxes; they all live under the single "show loot" switch (dim = -1).
    {110, "loot_markers", -1},
    {-2, "slime_chunk", DIM_OVERWORLD},
    {-1, "spawn", DIM_OVERWORLD},
    {Fortress, "fortress", DIM_NETHER},
    {Bastion, "bastion", DIM_NETHER},
    {Ruined_Portal_N, "ruined_portal_n", DIM_NETHER},
    {End_City, "end_city", DIM_END},
    {End_Gateway, "end_gateway", DIM_END},
};

/**
 * Full-resolution biome check for structure types with a narrow biome set.
 * cubiomes samples biomes at 1:4, which lets structures through at biome
 * borders where the game refuses to place them (verified: desert pyramid
 * (3872,-5808) of seed -5474371961803057987 is a river at 1:1 and does not
 * generate in game or in cubiomes-viewer).
 */
static bool biomeAllowsStructure(int type, Generator *gen, int x, int z)
{
    const int id = getBiomeAt(gen, 1, x, 63, z);
    if (id < 0) return true;
    switch (type) {
    case Desert_Pyramid:
        return id == desert;
    case Jungle_Temple:
        return id == jungle || id == jungle_hills || id == jungle_edge ||
               id == modified_jungle || id == bamboo_jungle ||
               id == bamboo_jungle_hills || id == sparse_jungle;
    default:
        return true;
    }
}

void ensureColors()
{
    if (!gColorsReady) {
        std::memset(gColors, 0, sizeof(gColors));
        initBiomeColors(gColors);
        gColorsReady = true;
    }
}

void ensureGenerator(int mc, uint64_t seed, int dim, uint32_t flags)
{
    if (!gGenReady || gMc != mc || gFlags != flags) {
        setupGenerator(&gGen, mc, flags);
        gGenReady = true;
        gMc = mc;
        gFlags = flags;
        gDim = 999;
        gSeed = ~0ull;
    }
    if (gDim != dim || gSeed != seed) {
        applySeed(&gGen, dim, seed);
        gDim = dim;
        gSeed = seed;
    }
}

int verticalFor(int scale, int blockY)
{
    if (blockY < -64) blockY = -64;
    if (blockY > 320) blockY = 320;
    if (scale == 1) return blockY;
    return blockY >> 2;
}

int32_t hashJava(const std::string &text)
{
    int32_t h = 0;
    const unsigned char *s = reinterpret_cast<const unsigned char *>(text.data());
    size_t i = 0;
    while (i < text.size()) {
        uint32_t cp = s[i];
        size_t need = 1;
        if ((cp & 0x80u) == 0) need = 1;
        else if ((cp & 0xE0u) == 0xC0u) need = 2;
        else if ((cp & 0xF0u) == 0xE0u) need = 3;
        else if ((cp & 0xF8u) == 0xF0u) need = 4;
        if (i + need > text.size()) break;
        if (need == 2) cp = ((s[i] & 0x1Fu) << 6) | (s[i + 1] & 0x3Fu);
        else if (need == 3) cp = ((s[i] & 0x0Fu) << 12) | ((s[i + 1] & 0x3Fu) << 6) | (s[i + 2] & 0x3Fu);
        else if (need == 4) cp = ((s[i] & 0x07u) << 18) | ((s[i + 1] & 0x3Fu) << 12) | ((s[i + 2] & 0x3Fu) << 6) | (s[i + 3] & 0x3Fu);
        i += need;
        if (cp >= 0x10000u) {
            cp -= 0x10000u;
            uint16_t hi = static_cast<uint16_t>(0xD800u + (cp >> 10));
            uint16_t lo = static_cast<uint16_t>(0xDC00u + (cp & 0x3FFu));
            h = 31 * h + hi;
            h = 31 * h + lo;
        } else {
            h = 31 * h + static_cast<int32_t>(cp);
        }
    }
    return h;
}

bool wanted(const std::vector<int> &types, int id)
{
    return std::find(types.begin(), types.end(), id) != types.end();
}

void ensureStrongholds(int mc, uint64_t seed, uint32_t flags)
{
    if (gStrongholds.mc == mc && gStrongholds.seed == seed && gStrongholds.flags == flags) return;
    ensureGenerator(mc, seed, DIM_OVERWORLD, flags);
    gStrongholds.points.clear();
    StrongholdIter iter;
    // initFirstStronghold() only provides an approximate first-stronghold
    // position (+/-112 blocks). It is not a real structure location, so keep
    // it out of the map overlay; nextStronghold() below yields the accurate
    // first stronghold (and every following one).
    initFirstStronghold(&iter, mc, seed);
    for (int i = 0; i < 128; i++) {
        if (nextStronghold(&iter, &gGen) <= 0) break;
        gStrongholds.points.push_back(iter.pos);
    }
    gStrongholds.mc = mc;
    gStrongholds.seed = seed;
    gStrongholds.flags = flags;
    gDim = 999;
}

auto divFloor = [](int v, int d) {
    int q = v / d;
    if (v < 0 && v % d) q--;
    return q;
};

bool campHasCopperChest(const Piece *pieces, int count)
{
    for (int i = 0; i < count; i++) {
        for (int c = 0; c < pieces[i].chestCount; c++) {
            if (pieces[i].lootTables[c] && std::strstr(pieces[i].lootTables[c], "abandoned_camp_secret_chest"))
                return true;
        }
    }
    return false;
}

bool endCityHasShip(const Piece *pieces, int count)
{
    for (int i = 0; i < count; i++) {
        if (pieces[i].type == END_SHIP) return true;
    }
    return false;
}

void addGeneric(std::vector<PlacedFeature> &out, int type, int mc, uint64_t seed, int dim, uint32_t flags,
                int x0, int z0, int x1, int z1)
{
    StructureConfig cfg;
    if (!getStructureConfig(type, mc, &cfg)) return;
    if (cfg.dim != dim || cfg.regionSize <= 0) return;
    const int regionBlocks = cfg.regionSize * 16;
    const int r0x = divFloor(x0, regionBlocks);
    const int r1x = divFloor(x1, regionBlocks);
    const int r0z = divFloor(z0, regionBlocks);
    const int r1z = divFloor(z1, regionBlocks);
    long long count = (long long)(r1x - r0x + 1) * (r1z - r0z + 1);
    // Chunk-scale decorators (regionSize 1) are expensive on huge views.
    // Raise the budget so zoomed-in maps still show geodes / treasure / wells,
    // and when the view is still too large, scan only the center window.
    //
    // The End is special: its only decorator is the natural end gateway
    // (rarity 1/700, end_highlands), and players look for those across the whole
    // outer-island ring. A 192x192 chunk window (3072 blocks) covers too little
    // there, so use a wider window. The scan is cheap because the per-chunk work
    // is one rarity RNG draw and the biome check only runs on the rare hits.
    // The End is matched to the end-city coverage: end cities use regionSize 32
    // with a 2500-region budget (= 25,600 blocks across). A gateway chunk covers
    // 16 blocks, so 1024 chunks (= 16,384 blocks) is the closest affordable window
    // (about 80 ms worst case; typical viewports are far smaller and never clamp).
    // The End is matched to the end-city coverage on purpose: end cities use
    // regionSize 20 (320 blocks) with a 2500-region budget, so they stop being
    // computed once the view exceeds ~15,680 blocks across. Gateways use the same
    // cutoff, otherwise the map would show gateways long after the cities vanished.
    if (dim == DIM_END && cfg.regionSize <= 1) {
        const int span = (x1 - x0 > z1 - z0 ? x1 - x0 : z1 - z0);
        if (span > 15680) return;
    }
    const int maxSide = (dim == DIM_END) ? 1024 : 192;
    const long long limit = cfg.regionSize <= 1 ? (long long)maxSide * maxSide : 2500LL;
    int scan0x = r0x, scan1x = r1x, scan0z = r0z, scan1z = r1z;
    if (count <= 0) return;
    if (count > limit) {
        if (cfg.regionSize > 1) return;
        const int midX = (r0x + r1x) / 2;
        const int midZ = (r0z + r1z) / 2;
        scan0x = midX - maxSide / 2;
        scan1x = scan0x + maxSide - 1;
        scan0z = midZ - maxSide / 2;
        scan1z = scan0z + maxSide - 1;
        if (scan0x < r0x) scan0x = r0x;
        if (scan1x > r1x) scan1x = r1x;
        if (scan0z < r0z) scan0z = r0z;
        if (scan1z > r1z) scan1z = r1z;
        count = (long long)(scan1x - scan0x + 1) * (scan1z - scan0z + 1);
        if (count <= 0 || count > limit) return;
    }
    ensureGenerator(mc, seed, dim, flags);
    SurfaceNoise endNoise{};
    bool endNoiseReady = false;
    const bool detailVariants = count <= 400;
    int checks = 0;
    for (int rz = scan0z; rz <= scan1z; rz++) {
        for (int rx = scan0x; rx <= scan1x; rx++) {
            if (++checks > limit) return;
            Pos pos;
            if (!getStructurePos(type, mc, seed, rx, rz, &pos)) continue;
            if (pos.x < x0 || pos.x > x1 || pos.z < z0 || pos.z > z1) continue;
            int id = isViableStructurePos(type, &gGen, pos.x, pos.z, 0);
            if (!id) continue;
            if (!biomeAllowsStructure(type, &gGen, pos.x, pos.z)) continue;
            int variant = 0;
            if (type == Village) {
                StructureVariant sv{};
                getVariant(&sv, Village, mc, seed, pos.x, pos.z, id);
                if (sv.abandoned) variant = 1;
            } else if (type == End_City) {
                if (!endNoiseReady) {
                    initSurfaceNoise(&endNoise, DIM_END, seed);
                    endNoiseReady = true;
                }
                if (!isViableEndCityTerrain(&gGen, &endNoise, pos.x, pos.z)) continue;
                // Always distinguish cities with ships (cubiomes-viewer style).
                Piece pieces[END_CITY_PIECES_MAX];
                int n = getEndCityPieces(pieces, seed, pos.x >> 4, pos.z >> 4);
                if (endCityHasShip(pieces, n)) variant = 1;
            } else if (type == Abandoned_Camp) {
                StructureVariant sv{};
                getVariant(&sv, Abandoned_Camp, mc, seed, pos.x, pos.z, -1);
                int cx = pos.x >> 4, cz = pos.z >> 4;
                int sampleX = (cx * 32 + 2 * sv.x + sv.sx - 1) / 2 >> 2;
                int sampleZ = (cz * 32 + 2 * sv.z + sv.sz - 1) / 2 >> 2;
                id = getBiomeAt(&gGen, 4, sampleX, sv.y >> 2, sampleZ);
                if (id < 0 || !isViableFeatureBiome(mc, Abandoned_Camp, id)) continue;
                if (detailVariants) {
                    getVariant(&sv, Abandoned_Camp, mc, seed, pos.x, pos.z, id);
                    StructureSaltConfig ssconf{};
                    if (getStructureSaltConfig(Abandoned_Camp, mc, id, &ssconf)) {
                        Piece pieces[8];
                        int n = getStructurePieces(pieces, 8, Abandoned_Camp, ssconf, &sv, mc, seed, pos.x, pos.z);
                        if (n > 0 && campHasCopperChest(pieces, n)) variant = 1;
                    }
                }
            } else if (type == Bastion) {
                // Bastion remnants: four start pools selected by structure RNG
                // (cubiomes getVariant):
                //   start 0 = units/air_base          -> housing
                //   start 1 = hoglin_stable/air_base  -> stables
                //   start 2 = treasure/big_air_full   -> treasure
                StructureVariant sv{};
                getVariant(&sv, Bastion, mc, seed, pos.x, pos.z, -1);
                variant = sv.start & 3;
            } else if (type == Igloo) {
                // Igloo basement: cubiomes' StructureVariant.basement is one
                // nextDouble() < 0.5 draw (finders.c getVariant), independent of
                // blocks, so evaluating it once per hut is cheap.
                StructureVariant sv{};
                getVariant(&sv, Igloo, mc, seed, pos.x, pos.z, id);
                if (sv.basement) variant = 1;
            }
            out.push_back({type, pos.x, pos.z, variant});
        }
    }
}

void addEndGateways(std::vector<PlacedFeature> &out, int mc, uint64_t seed, int x0, int z0, int x1, int z1)
{
    // Three marker variants:
    //   0 = natural central-island source gate (2nd..20th dragon kill)
    //   1 = first gateway (1st kill; getFixedEndGateways writes it first)
    //   2 = outer-island landing (linked destination of a source gate)
    // Only the End has these; the overworld produces no markers.
    if (mc <= MC_1_12) return;
    // Same visible range as end cities (see the matching note in addGeneric).
    if (x1 - x0 > 15680 || z1 - z0 > 15680) return;
    Pos fixed[20];
    getFixedEndGateways(mc, seed, fixed);
    EndNoise en{};
    setEndSeed(&en, mc, seed);
    SurfaceNoise sn{};
    initSurfaceNoise(&sn, DIM_END, seed);
    for (int i = 0; i < 20; i++) {
        // Only emit outer-island landing points. The 20 central source gates
        // collapse into one blob on the icon map, so (matching cubiomes-viewer)
        // they are not separate markers. variant 1 = first gateway, 2 = rest.
        Pos dst = getLinkedGatewayPos(&en, &sn, seed, fixed[i]);
        if (dst.x < x0 || dst.x > x1 || dst.z < z0 || dst.z > z1) continue;
        out.push_back({End_Gateway, dst.x, dst.z, i == 0 ? 1 : 2});
    }
}

/* ------------------------------------------------------------------------- */
/* Loot-layer backends                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Stronghold library/corridor chests: cubiomes reproduces the piece graph and
 * their LootTableSeed. Keep chests with the eye trim or any music disc
 * (Otherside lives in `chests/stronghold_corridor`).
 */
void strongholdLootChests(int mc, uint64_t seed, int startX, int startZ,
                          std::vector<LootChest> &out)
{
    StructureSaltConfig ssconf{};
    if (!getStructureSaltConfig(Stronghold, mc, plains, &ssconf)) return;

    static thread_local Piece pieces[400];
    const int n = getStrongholdLoot(pieces, 400, ssconf, mc, seed, startX >> 4, startZ >> 4);
    for (int i = 0; i < n; i++) {
        for (int c = 0; c < pieces[i].chestCount && c < 4; c++) {
            const char *table = pieces[i].lootTables[c];
            if (!table) continue;
            const loots::ChestReward reward =
                loots::evaluateChest(table, pieces[i].lootSeeds[c], mc);
            if (!reward.evaluated) continue;
            const bool eye = reward.hasTrim(loots::TrimKind::eye);
            if (!eye && reward.discKinds == 0) continue;
            LootChest chest;
            chest.x = pieces[i].chestPoses[c].x;
            chest.z = pieces[i].chestPoses[c].z;
            chest.trim = eye;
            chest.trimKinds = reward.trimKinds;
            chest.discKinds = reward.discKinds;
            chest.discFragments = reward.discFragments;
            chest.miscKinds = reward.miscKinds;
            out.push_back(chest);
        }
    }
}

} // namespace

bool parseSeedText(const std::string &text, uint64_t *out, bool allowTextHash)
{
    std::string s = text;
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.erase(s.begin());
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r')) s.pop_back();
    if (s.empty()) return false;
    char *end = nullptr;
    errno = 0;
    long long value = std::strtoll(s.c_str(), &end, 10);
    if (end && *end == '\0' && errno != ERANGE) {
        *out = static_cast<uint64_t>(value);
        return true;
    }
    if (!allowTextHash) return false;
    *out = static_cast<uint64_t>(static_cast<int64_t>(hashJava(s)));
    return true;
}

/**
 * Display name for the version dropdown.
 *
 * cubiomes keeps an alias per generation profile (MC_1_18 == MC_1_18_2,
 * MC_1_19 == MC_1_19_4, MC_1_20 == MC_1_20_6), so mc2str() reports the base
 * name ("1.18"/"1.19"/"1.20"). The app lists one entry per cubiomes id and
 * should show the concrete profile version instead.
 */
const char *versionDisplayName(int id)
{
    switch (id) {
    case MC_1_18_2: return "1.18.2";
    case MC_1_19_2: return "1.19.2";
    case MC_1_19_4: return "1.19.4";
    case MC_1_20_6: return "1.20.1";
    default: return nullptr;
    }
}

std::vector<McVersion> listMcVersions()
{    std::vector<McVersion> out;
    out.reserve(sizeof(kVersions) / sizeof(kVersions[0]));
    for (int id : kVersions) {
        const char *name = versionDisplayName(id);
        if (!name) name = mc2str(id);
        if (!name || name[0] == '?') continue;
        out.push_back({id, name});
    }
    return out;
}

std::vector<FeatureEntry> listFeatures()
{
    std::vector<FeatureEntry> out;
    for (const auto &item : kFeatures) out.push_back({item.id, item.key, item.dim});
    return out;
}

std::vector<LootChestInfo> lootChests(int mc, uint64_t seed,
                                      const std::vector<std::pair<int, int>> &structures,
                                      const std::vector<int> &types)
{
    auto addChest = [](LootChestInfo &info, const loots::StructureChest &c) {
        // Unknown loot table (evaluated=false): skip it rather than reporting
        // "no loot".
        if (!c.reward.evaluated) return;
        LootChest chest;
        chest.x = c.x;
        chest.y = c.y;
        chest.z = c.z;
        chest.trim = c.reward.trim;
        chest.silence = c.reward.hasTrim(loots::TrimKind::silence);
        chest.ward = c.reward.hasTrim(loots::TrimKind::ward);
        chest.netheriteUpgrade = c.reward.netheriteUpgrade;
        chest.goldenApples = c.reward.goldenApples;
        chest.snifferEgg = c.reward.snifferEgg;
        chest.piglinBanner = c.reward.hasItem(loots::LootItem_PiglinBanner);
        chest.trimKinds = c.reward.trimKinds;
        chest.discKinds = c.reward.discKinds;
        chest.miscKinds = c.reward.miscKinds;
        chest.sherdKinds = c.reward.sherdKinds;
        chest.discFragments = c.reward.discFragments;
        chest.container = static_cast<int>(c.container);
        chest.approximate = c.approximate;
        chest.swiftSneakLevels = c.reward.swiftSneakLevels;
        info.chests.push_back(std::move(chest));
    };

    auto summarize = [](LootChestInfo &info) {
        bool misc = false;
        bool templ = false;
        bool disc = false;
        bool sherd = false;
        for (const auto &c : info.chests) {
            const bool trim = c.trim || c.ward || c.silence;
            if (trim) {
                info.hasTrim = true;
                templ = true;
            }
            info.trimKinds |= c.trimKinds;
            info.discKinds |= c.discKinds;
            info.miscKinds |= c.miscKinds;
            info.sherdKinds |= c.sherdKinds;
            if (c.discFragments > 0) info.discFragments += c.discFragments;
            if (c.netheriteUpgrade) {
                info.hasNetherite = true;
                templ = true;
            }
            if (c.snifferEgg) {
                info.hasSnifferEgg = true;
                misc = true;
            }
            if (c.goldenApples > 0) {
                info.hasGoldenApple = true;
                misc = true;
            }
            if (c.piglinBanner) {
                info.hasPiglinBanner = true;
                misc = true;
            }
            if (!c.swiftSneakLevels.empty()) misc = true;
            if (c.discKinds != 0 || c.discFragments > 0) disc = true;
            if (c.sherdKinds != 0) sherd = true;
            if (c.approximate) info.approximate = true;
        }
        info.categoryMask =
            (misc ? loots::LootCategory_Misc : 0u) |
            (templ ? loots::LootCategory_Template : 0u) |
            (disc ? loots::LootCategory_Disc : 0u) |
            (sherd ? loots::LootCategory_Sherd : 0u);
        if (info.hasTrim) {
            info.hasLoot = true;
            info.lootKind = 1;
        } else if (info.hasNetherite) {
            info.hasLoot = true;
            info.lootKind = 2;
        } else if (info.hasSnifferEgg) {
            info.hasLoot = true;
            info.lootKind = 3;
        } else if (info.hasGoldenApple) {
            info.hasLoot = true;
            info.lootKind = 4;
        } else if (info.hasPiglinBanner) {
            info.hasLoot = true;
            info.lootKind = 5;
        } else if (disc) {
            info.hasLoot = true;
            info.lootKind = 6;
        } else if (sherd) {
            info.hasLoot = true;
            info.lootKind = 7;
        }
    };

    std::vector<LootChestInfo> out;
    out.reserve(structures.size());
    for (const auto &s : structures) {
        for (int type : types) {
            LootChestInfo info;
            info.type = type;
            info.x = s.first;
            info.z = s.second;

            // Outpost: exact shared jigsaw assembly (tower chest + allay cage);
            // hint only, no chest coordinates.
            if (type == Outpost) {
                OutpostLoot ol{};
                if (pillagerOutpostLoot(mc, seed, s.first, s.second, ol)) {
                    info.exists = true;
                    info.hasAllay = ol.allayEvaluated && ol.hasAllay;
                    info.allayCages = ol.allayEvaluated ? ol.allayCages : 0;
                    info.pieces = ol.pieces;
                    for (const auto &c : ol.chests) {
                        StructureChest cc = c;
                        cc.reward = loots::evaluateChest(cc.lootTable.c_str(), cc.lootSeed, mc);
                        if (cc.reward.trim) {
                            info.hasLoot = true;
                            info.hasTrim = true;
                            info.lootKind = 1;
                            info.trimKinds |= cc.reward.trimKinds;
                        }
                    }
                    info.categoryMask = (info.hasAllay ? loots::LootCategory_Misc : 0u) |
                                        (info.hasTrim ? loots::LootCategory_Template : 0u);
                }
                out.push_back(std::move(info));
                continue;
            }

            if (type == Ancient_City) {
                const auto cities = ancientCityChests(
                    mc, seed, 0, {std::make_pair(s.first, s.second)});
                if (!cities.empty()) {
                    const auto &city = cities.front();
                    info.exists = city.exists;
                    info.pieces = city.pieces;
                    for (const auto &c : city.chests) {
                        if (c.silence == 0 && c.ward == 0 && c.swiftSneakLevels.empty() &&
                            c.enchantedGoldenApples == 0 && c.discKinds == 0 &&
                            c.discFragments == 0)
                            continue;
                        LootChest chest;
                        chest.x = c.x;
                        chest.y = c.y;
                        chest.z = c.z;
                        chest.trim = c.silence != 0 || c.ward != 0;
                        chest.silence = c.silence != 0;
                        chest.ward = c.ward != 0;
                        chest.goldenApples = c.enchantedGoldenApples;
                        chest.swiftSneakLevels = c.swiftSneakLevels;
                        chest.discKinds = c.discKinds;
                        chest.miscKinds = c.miscKinds;
                        chest.discFragments = c.discFragments;
                        chest.container = 0;
                        if (chest.silence) chest.trimKinds |= 1u << static_cast<unsigned>(loots::TrimKind::silence);
                        if (chest.ward) chest.trimKinds |= 1u << static_cast<unsigned>(loots::TrimKind::ward);
                        info.chests.push_back(std::move(chest));
                    }
                    summarize(info);
                }
                out.push_back(std::move(info));
                continue;
            }

            if (type == Stronghold) {
                info.exists = true;
                strongholdLootChests(mc, seed, s.first, s.second, info.chests);
                summarize(info);
                out.push_back(std::move(info));
                continue;
            }

            if (type == Ocean_Ruin) {
                loots::StructureLoot sl;
                if (mc >= MC_1_20 &&
                    oceanRuinLoot(mc, seed, s.first, s.second, sl)) {
                    sl.evaluate(mc);
                    info.exists = sl.exists;
                    info.pieces = sl.pieces;
                    for (const auto &c : sl.suspicious) addChest(info, c);
                    summarize(info);
                } else {
                    // Archaeology / suspicious-block generation starts in 1.20.
                    info.exists = true;
                    info.reliable = false;
                }
                out.push_back(std::move(info));
                continue;
            }

            loots::StructureLoot sl;
            bool ok = false;
            if (type == Fortress) ok = netherFortressLoot(mc, seed, s.first, s.second, sl);
            else if (type == End_City) ok = endCityLoot(mc, seed, s.first, s.second, sl);
            else if (type == Desert_Pyramid) ok = desertPyramidLoot(mc, seed, s.first, s.second, sl);
            else if (type == Jungle_Temple) ok = jungleTempleLoot(mc, seed, s.first, s.second, sl);
            else if (type == Shipwreck) ok = shipwreckLoot(mc, seed, s.first, s.second, sl);
            else if (type == Bastion) ok = bastionLoot(mc, seed, s.first, s.second, sl);
            else if (type == Mansion) ok = woodlandMansionLoot(mc, seed, s.first, s.second, sl);
            else if (type == Mineshaft) ok = loots::mineshaftLoot(mc, seed, s.first, s.second, sl);
            else if (type == Trail_Ruins) {
                ok = loots::trailRuinsLoot(mc, seed, s.first, s.second, sl);
            }
            if (!ok) {
                // Structure missing or layer unsupported on this version: stay
                // silent instead of writing an empty result.
                if (type == Trail_Ruins || type == Mansion) continue;
                out.push_back(std::move(info));
                continue;
            }

            sl.evaluate(mc);
            info.exists = sl.exists;
            info.pieces = sl.pieces;
            info.chests.reserve(sl.chests.size());
            for (const auto &c : sl.chests) addChest(info, c);
            for (const auto &c : sl.suspicious) addChest(info, c);
            summarize(info);
            if (type == Mineshaft && info.approximate) {
                // Only the pre-1.21.11 cubiomes fallback marks chests as
                // approximate; the 1.21.11+ block-state replay is exact.
                info.reliable = false;
            }
            // 1.19.2 has no armor-trim templates. Its mansion loot seed is
            // also not supported, so suppress both template flags and chests.
            if (type == Mansion && mc <= MC_1_19_2) {
                info.chests.clear();
                info.hasLoot = false;
                info.hasTrim = false;
                info.hasNetherite = false;
                info.hasSnifferEgg = false;
                info.hasGoldenApple = false;
                info.trimKinds = 0;
                info.reliable = true;
            }

            // Single-piece structures: presence only, no coordinates (Y depends
            // on the surface height).
            if (type == Desert_Pyramid || type == Jungle_Temple || type == Shipwreck) {
                info.chests.clear();
            }
            out.push_back(std::move(info));
        }
    }
    return out;
}

bool paintBiomes(Generator *gen, int scale, int x, int z, int sx, int sz, int blockY,
                 std::vector<uint8_t> &rgba, std::string &error)
{
    if (scale != 1 && scale != 4 && scale != 16 && scale != 64 && scale != 256) {
        error = "bad-scale";
        return false;
    }
    if (sx < 1 || sz < 1 || sx > 1024 || sz > 1024) {
        error = "bad-size";
        return false;
    }
    Range range{};
    range.scale = scale;
    range.x = x;
    range.z = z;
    range.sx = sx;
    range.sz = sz;
    range.y = verticalFor(scale, blockY);
    range.sy = 1;
    const size_t cells = static_cast<size_t>(sx) * static_cast<size_t>(sz);
    // At 1:1 (scale 1) cubiomes expands the result with a larger temporary
    // Voronoi source buffer that is written *after* the visible cells:
    //   genBiomeNoiseScaled() -> src = out + siz; genBiomeNoise3D(..., src, ...)
    // Allocating only cells here overflows the heap for every 1:1 tile, which
    // is exactly the finest zoom level (and the reason the map appeared to
    // stop rendering once the user zoomed in far enough). Keep the requested
    // size from cubiomes instead of assuming it equals sx*sz.
    const size_t cacheLen = getMinCacheSize(gen, scale, sx, 1, sz);
    if (cacheLen < cells) {
        error = "bad-cache";
        return false;
    }
    std::vector<int> biomes(cacheLen);
    if (genBiomes(gen, biomes.data(), range) != 0) {
        error = "gen-failed";
        return false;
    }
    rgba.assign(cells * 4, 255);
    for (size_t i = 0; i < cells; i++) {
        int id = biomes[i];
        unsigned char r = 0, g = 0, b = 0;
        if (id >= 0 && id < 256) {
            r = gColors[id][0];
            g = gColors[id][1];
            b = gColors[id][2];
        }
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = 255;
    }
    return true;
}

bool renderBiomeTile(int mc, uint64_t seed, int dim, uint32_t flags, int scale,
                      int x, int z, int sx, int sz, int blockY,
                      std::vector<uint8_t> &rgba, std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    ensureColors();
    ensureGenerator(mc, seed, dim, flags);
    return paintBiomes(&gGen, scale, x, z, sx, sz, blockY, rgba, error);
}

void renderTiles(int mc, uint64_t seed, int dim, uint32_t flags, int blockY,
                 const std::vector<TileSpec> &tiles, std::vector<TileImage> &out)
{
    out.assign(tiles.size(), TileImage{});
    if (tiles.empty()) return;
    {
        std::lock_guard<std::mutex> lock(gMu);
        ensureColors();
        ensureGenerator(mc, seed, dim, flags);
    }
    unsigned workers = std::thread::hardware_concurrency();
    if (workers < 1) workers = 1;
    if (workers > 16) workers = 16;
    if (workers > tiles.size()) workers = static_cast<unsigned>(tiles.size());
    std::atomic<size_t> cursor{0};
    auto work = [&]() {
        Generator gen;
        setupGenerator(&gen, mc, flags);
        applySeed(&gen, dim, seed);
        while (true) {
            const size_t index = cursor.fetch_add(1);
            if (index >= tiles.size()) break;
            const TileSpec &tile = tiles[index];
            std::string error;
            if (!paintBiomes(&gen, tile.scale, tile.x, tile.z, tile.sx, tile.sz, blockY, out[index].rgba, error))
                out[index].rgba.assign(static_cast<size_t>(std::max(tile.sx, 0)) * static_cast<size_t>(std::max(tile.sz, 0)) * 4, 0);
        }
    };
    std::vector<std::thread> pool;
    pool.reserve(workers);
    for (unsigned i = 0; i < workers; i++) pool.emplace_back(work);
    for (std::thread &thread : pool) thread.join();
}

void slimeMask(uint64_t seed, int chunkX, int chunkZ, int width, int height, std::vector<uint8_t> &out)
{
    if (width < 1 || height < 1) {
        out.clear();
        return;
    }
    out.assign(static_cast<size_t>(width) * static_cast<size_t>(height), 0);
    for (int z = 0; z < height; z++) {
        for (int x = 0; x < width; x++) {
            if (isSlimeChunk(seed, chunkX + x, chunkZ + z))
                out[static_cast<size_t>(z) * static_cast<size_t>(width) + static_cast<size_t>(x)] = 1;
        }
    }
}

int biomeAt(int mc, uint64_t seed, int dim, uint32_t flags, int blockX, int blockY, int blockZ)
{
    std::lock_guard<std::mutex> lock(gMu);
    ensureGenerator(mc, seed, dim, flags);
    return getBiomeAt(&gGen, 1, blockX, blockY, blockZ);
}

std::vector<PlacedFeature> featuresInView(int mc, uint64_t seed, int dim, uint32_t flags,
                                          int x0, int z0, int x1, int z1,
                                          const std::vector<int> &types)
{
    if (x1 < x0) std::swap(x0, x1);
    if (z1 < z0) std::swap(z0, z1);
    std::vector<PlacedFeature> out;
    std::lock_guard<std::mutex> lock(gMu);

    for (const auto &def : kFeatures) {
        if (def.dim != dim || !wanted(types, def.id)) continue;
        // End_Gateway uses addGeneric below: in this cubiomes it is a per-chunk
        // decorator feature (getStructurePos rarity branch, 1/700, end_highlands),
        // i.e. the End's natural gateway distribution; the 20 dragon-kill gates
        // are emitted by addEndGateways instead.
        if (def.id == Stronghold || def.id == Mineshaft || def.id < 0) continue;
        addGeneric(out, def.id, mc, seed, dim, flags, x0, z0, x1, z1);
    }

    if (dim == DIM_END && wanted(types, End_Gateway))
        addEndGateways(out, mc, seed, x0, z0, x1, z1);

    if (dim == DIM_OVERWORLD && wanted(types, Stronghold)) {
        ensureStrongholds(mc, seed, flags);
        for (const Pos &pos : gStrongholds.points) {
            if (pos.x >= x0 && pos.x <= x1 && pos.z >= z0 && pos.z <= z1)
                out.push_back({Stronghold, pos.x, pos.z, 0});
        }
    }

    if (dim == DIM_OVERWORLD && wanted(types, -1)) {
        if (!(gSpawnReady && gSpawnMc == mc && gSpawnSeed == seed && gSpawnFlags == flags)) {
            ensureGenerator(mc, seed, DIM_OVERWORLD, flags);
            gSpawn = getSpawn(&gGen);
            gSpawnMc = mc;
            gSpawnSeed = seed;
            gSpawnFlags = flags;
            gSpawnReady = true;
            gDim = 999;
        }
        if (gSpawn.x >= x0 && gSpawn.x <= x1 && gSpawn.z >= z0 && gSpawn.z <= z1)
            out.push_back({-1, gSpawn.x, gSpawn.z, 0});
    }

    const long long chunkArea =
        (long long)((x1 - x0) / 16 + 2) * (long long)((z1 - z0) / 16 + 2);
    // Mineshafts are chunk decorators and must be scanned chunk by chunk. The
    // old 96x96 cap hid them at every zoom except the closest one; 640x640 still
    // bounds the scan while covering normal 1:4 and 1:8 viewports.
    if (dim == DIM_OVERWORLD && wanted(types, Mineshaft) && chunkArea > 0 &&
        chunkArea <= 640LL * 640LL) {
        const int cx = (int)std::floor(x0 / 16.0);
        const int cz = (int)std::floor(z0 / 16.0);
        const int cw = std::max(1, (x1 - x0) / 16 + 2);
        const int ch = std::max(1, (z1 - z0) / 16 + 2);
        std::vector<Pos> mines(static_cast<size_t>(cw * ch));
        // Cubiomes' getMineshafts takes an inclusive chunk rectangle
        // (x0,z0,x1,z1), not a width/height pair. Passing cw/ch here made the
        // scan empty whenever the view was east/south of the origin.
        int n = getMineshafts(mc, seed, cx, cz, cx + cw - 1, cz + ch - 1,
                              mines.data(), cw * ch);
        for (int i = 0; i < n; i++) {
            // getMineshafts works per chunk and can report positions outside the
            // requested area; keep only what belongs to this view.
            const Pos &p = mines[i];
            if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
            out.push_back({Mineshaft, p.x, p.z, 0});
        }
    }

    if (dim == DIM_OVERWORLD && wanted(types, -2) && chunkArea > 0 && chunkArea <= 80 * 80) {
        const int cx0 = (int)std::floor(x0 / 16.0);
        const int cz0 = (int)std::floor(z0 / 16.0);
        const int cx1 = (int)std::floor(x1 / 16.0);
        const int cz1 = (int)std::floor(z1 / 16.0);
        for (int cz = cz0; cz <= cz1; cz++) {
            for (int cx = cx0; cx <= cx1; cx++) {
                if (isSlimeChunk(seed, cx, cz))
                    out.push_back({-2, cx * 16 + 8, cz * 16 + 8, 0});
            }
        }
    }

    if (dim == DIM_NETHER && wanted(types, Fortress)) {
        for (PlacedFeature &item : out) {
            if (item.type != Fortress) continue;
            FortressBounds bounds;
            if (!cachedFortressBounds(mc, seed, flags, item.x, item.z, bounds)) continue;
            item.hasFrame = true;
            item.large = bounds.large;
            item.pieces = std::move(bounds.pieces);
        }
    }

    if (dim == DIM_OVERWORLD && wanted(types, Swamp_Hut)) {
        // The hut origin is the structure start (chunkX*16, chunkZ*16); the
        // orientation decides whether the footprint is 7x9 or 9x7.
        for (PlacedFeature &item : out) {
            if (item.type != Swamp_Hut) continue;
            const int dir = lysh_hut_orientation(seed, item.x, item.z);
            const bool axisZ = dir == 0 || dir == 2;
            item.hasFrame = true;
            item.large = {};
            item.large.minX = item.x;
            item.large.maxX = item.x + (axisZ ? 7 : 9) - 1;
            item.large.minY = 0;
            item.large.maxY = 0;
            item.large.minZ = item.z;
            item.large.maxZ = item.z + (axisZ ? 9 : 7) - 1;
        }
    }

    return out;
}

bool fortressBounds(int mc, uint64_t seed, int blockX, int blockZ, FortressBounds &out)
{
    Piece pieces[400];
    const int n = getFortressPieces(pieces, 400, mc, seed, blockX >> 4, blockZ >> 4);
    if (n <= 0) return false;

    out = {};
    auto toBox = [](const Piece &piece) {
        Box3i box;
        box.minX = piece.bb0.x;
        box.minY = piece.bb0.y;
        box.minZ = piece.bb0.z;
        box.maxX = piece.bb1.x;
        box.maxY = piece.bb1.y;
        box.maxZ = piece.bb1.z;
        return box;
    };

    out.start = toBox(pieces[0]);
    out.large = out.start;
    out.pieces.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; i++) {
        const Piece &p = pieces[i];
        Box3i box = toBox(p);
        out.pieces.push_back(box);
        out.large.minX = std::min(out.large.minX, box.minX);
        out.large.minY = std::min(out.large.minY, box.minY);
        out.large.minZ = std::min(out.large.minZ, box.minZ);
        out.large.maxX = std::max(out.large.maxX, box.maxX);
        out.large.maxY = std::max(out.large.maxY, box.maxY);
        out.large.maxZ = std::max(out.large.maxZ, box.maxZ);
    }
    return true;
}
