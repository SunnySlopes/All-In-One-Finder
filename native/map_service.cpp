#include "map_service.h"

#include "cubiomes/biomes.h"
#include "cubiomes/biomenoise.h"
#include "cubiomes/features/end_city.h"
#include "cubiomes/finders.h"
#include "cubiomes/generator.h"
#include "cubiomes/util.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>

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
    {-2, "slime_chunk", DIM_OVERWORLD},
    {-1, "spawn", DIM_OVERWORLD},
    {Fortress, "fortress", DIM_NETHER},
    {Bastion, "bastion", DIM_NETHER},
    {Ruined_Portal_N, "ruined_portal_n", DIM_NETHER},
    {End_City, "end_city", DIM_END},
    {End_Gateway, "end_gateway", DIM_END},
};

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
    Pos first = initFirstStronghold(&iter, mc, seed);
    if (first.x != 0 || first.z != 0) gStrongholds.points.push_back(first);
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
    const long long limit = cfg.regionSize <= 1 ? 192LL * 192 : 2500LL;
    int scan0x = r0x, scan1x = r1x, scan0z = r0z, scan1z = r1z;
    if (count <= 0) return;
    if (count > limit) {
        if (cfg.regionSize > 1) return;
        const int maxSide = 192;
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
            int variant = 0;
            if (type == End_City) {
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
            }
            out.push_back({type, pos.x, pos.z, variant});
        }
    }
}

void addEndGateways(std::vector<PlacedFeature> &out, int mc, uint64_t seed, int x0, int z0, int x1, int z1)
{
    // Match cubiomes-viewer: show outer-island linked gateways only (not the
    // 20 fixed main-island sources from defeating the dragon).
    if (mc <= MC_1_12) return;
    Pos fixed[20];
    getFixedEndGateways(mc, seed, fixed);
    EndNoise en{};
    setEndSeed(&en, mc, seed);
    SurfaceNoise sn{};
    initSurfaceNoise(&sn, DIM_END, seed);
    for (int i = 0; i < 20; i++) {
        Pos dst = getLinkedGatewayPos(&en, &sn, seed, fixed[i]);
        if (dst.x >= x0 && dst.x <= x1 && dst.z >= z0 && dst.z <= z1)
            out.push_back({End_Gateway, dst.x, dst.z, 0});
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

std::vector<McVersion> listMcVersions()
{
    std::vector<McVersion> out;
    out.reserve(sizeof(kVersions) / sizeof(kVersions[0]));
    for (int id : kVersions) {
        const char *name = mc2str(id);
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
        if (def.id == Stronghold || def.id == Mineshaft || def.id == End_Gateway || def.id < 0) continue;
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

    const int chunkArea = ((x1 - x0) / 16 + 2) * ((z1 - z0) / 16 + 2);
    if (dim == DIM_OVERWORLD && wanted(types, Mineshaft) && chunkArea > 0 && chunkArea <= 96 * 96) {
        const int cx = (int)std::floor(x0 / 16.0);
        const int cz = (int)std::floor(z0 / 16.0);
        const int cw = std::max(1, (x1 - x0) / 16 + 2);
        const int ch = std::max(1, (z1 - z0) / 16 + 2);
        std::vector<Pos> mines(static_cast<size_t>(cw * ch));
        int n = getMineshafts(mc, seed, cx, cz, cw, ch, mines.data(), cw * ch);
        for (int i = 0; i < n; i++) out.push_back({Mineshaft, mines[i].x, mines[i].z, 0});
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
    return out;
}
