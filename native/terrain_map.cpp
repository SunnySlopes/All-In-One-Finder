/*
 * Terrain and cheese-cave map layers (map tab -> overworld, Java 1.18+).
 *
 * The heavy lifting lives in cubiomes' `terrainnoise.c`: it exposes the full
 * 1.18+ overworld density field. Two layers are built on top of it, and they
 * are deliberately *different terrain*:
 *
 *   layer 1  cave-free relief: the cubiomes `sloped_cheese` density run through
 *            the same postProcess/slide steps as vanilla, i.e. the plain
 *            surface with no cave carving. Hill shading is painted over the
 *            existing biome colours (no contour or boundary lines).
 *   layer 2  the same idea but from the full `final_density` field, where
 *            noise caves do carve the surface, plus the surface openings of
 *            cheese caves classified as dry / water / lava by a small
 *            self-contained aquifer implementation (see `Aquifer` below).
 *
 * Columns whose topmost solid block is below the lava level (-54) are painted
 * flat lava: vanilla floods everything under that level, and columns where
 * cubiomes finds no solid block at all are part of the same lava sea.
 *
 * Only 1:1 renders terrain; every coarser zoom level uses the biome map.
 * Everything in this file is additive: layer 0 keeps using the untouched
 * `renderTiles` path in map_service.cpp.
 *
 * Known precision limits (also documented in the plan / README):
 *   - the density field includes noise caves but not carvers (ravines,
 *     canyons), mineshafts or trial chambers;
 *   - the aquifer only classifies the fluid at a cave opening; it does not
 *     build a full 3D water model;
 *   - the 26.x surface estimate reuses the 1.18 preliminary-surface formula,
 *     which is an approximation for MC 26.1+.
 */

#include "terrain_map.h"

#include "cubiomes/biomenoise.h"
#include "cubiomes/biomes.h"
#include "cubiomes/generator.h"
#include "cubiomes/noise.h"
#include "cubiomes/rng.h"
#include "cubiomes/terrainnoise.h"
#include "cubiomes/util.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

// --- tile geometry -------------------------------------------------------
constexpr int kCellSize = 4;      // vanilla XZ noise cell
constexpr int kCellHeight = 8;    // vanilla Y noise cell
constexpr int kMaxRows = 49;      // y = -64 .. 319 (cell indices 0..48)
constexpr int kMinRows = 8;
constexpr float kShadeMin = 0.5f;
constexpr float kShadeMax = 1.5f;
constexpr float kShadeGain = 0.25f;      // light = 1 + (d1 - d0) * kShadeGain
/** Vanilla floods everything below the lava level (-54) with lava; top lava block is -55. */
constexpr int kLavaLevel = -54;
constexpr int kLavaTopBlock = kLavaLevel - 1;
constexpr uint8_t kLavaSeaR = 255, kLavaSeaG = 112, kLavaSeaB = 26;

// --- layer policy --------------------------------------------------------
// Only 1:1 ever renders terrain; 1:4 and coarser stay on the biome map.

// --- cave / cheese tuning ------------------------------------------------
constexpr int kCheeseMinVol = 64;
constexpr int kCheeseHugeVol = 256;
constexpr int kCheeseSamples = 16;
constexpr int kFluidScanStep = 8;
constexpr int kNoFluidY = -32512;

// --- aquifer -------------------------------------------------------------
constexpr int kAquiferMinY = -64;
constexpr int kWaterY = 63;
constexpr int kLavaY = -54;

unsigned char gColors[256][3];
std::once_flag gColorsOnce;

void ensureColors()
{
    std::call_once(gColorsOnce, []() {
        std::memset(gColors, 0, sizeof(gColors));
        initBiomeColors(gColors);
    });
}

int verticalFor(int scale, int blockY)
{
    int y = blockY;
    if (y < -64) y = -64;
    if (y > 320) y = 320;
    return scale == 1 ? y : y >> 2;
}

inline int yForRow(int row) { return kAquiferMinY + row * kCellHeight; }

/** Highest fluid level in a column, matching vanilla's global fluid picker. */
struct FluidStatus {
    int level;
    int type;  // 1 = water, 2 = lava
};

inline FluidStatus globalFluid(int y)
{
    return y < kLavaY ? FluidStatus{kLavaY, 2} : FluidStatus{kWaterY, 1};
}

/**
 * Minimal re-implementation of the 1.18+ noise-based aquifer, limited to
 * `computeFluid` (see the plan, section 5.5.5). Only four noises and the
 * version rules are needed because the map only asks "which liquid, if any,
 * reaches this cave opening, and at what level".
 *
 * Sources used as *reference only* (no linking, no submodule edits):
 *   - cubiomes `terrainnoise.c` for the noise primitives and the preliminary
 *     surface level,
 *   - the algorithm/version branches of the volume's own terrain reference
 *     dumps (13 surface offsets, floodedness/spread/lava, deep-dark gate).
 */
class Aquifer {
public:
    bool init(int mc, uint64_t seed, TerrainNoise *tn);
    FluidStatus computeFluid(int x, int y, int z);

private:
    int surface(int x, int z);
    bool deepDarkExcluded(int x, int y, int z);

    DoublePerlinNoise mBarrier{};
    DoublePerlinNoise mFlood{};
    DoublePerlinNoise mSpread{};
    DoublePerlinNoise mLava{};
    PerlinNoise mOct[8]{};
    TerrainNoise *mTn = nullptr;
    bool mUses118 = false;
    bool mReady = false;
    std::unordered_map<int64_t, int> mSurface;
};

bool Aquifer::init(int mc, uint64_t seed, TerrainNoise *tn)
{
    mTn = tn;
    mUses118 = mc <= MC_1_18_2;
    if (!tn) return false;

    Xoroshiro world;
    xSetSeed(&world, seed);
    const uint64_t lo = xNextLong(&world);
    const uint64_t hi = xNextLong(&world);

    // md5 hashes of minecraft:aquifer_* from the vanilla noise registry.
    static const uint64_t kBarrier[2] = {0xe170fda6c51d093fULL, 0x134f3e4bc3f40b0cULL};
    static const uint64_t kFlood[2] = {0x1b5d4f85fdc2d89eULL, 0x22c7e3e611bf67c6ULL};
    static const uint64_t kSpread[2] = {0x8f136f47cd9aaa2ULL, 0x3666182f5fa0ac6fULL};
    static const uint64_t kLava[2] = {0xe5121277ab51b72ULL, 0x2724d8c56aa005baULL};
    static const double amp[1] = {1.0};

    int n = 0;
    Xoroshiro s;
    s.lo = lo ^ kBarrier[0];
    s.hi = hi ^ kBarrier[1];
    n += xDoublePerlinInit(&mBarrier, &s, mOct + n, amp, -3, 1, -1);
    s.lo = lo ^ kFlood[0];
    s.hi = hi ^ kFlood[1];
    n += xDoublePerlinInit(&mFlood, &s, mOct + n, amp, -7, 1, -1);
    s.lo = lo ^ kSpread[0];
    s.hi = hi ^ kSpread[1];
    n += xDoublePerlinInit(&mSpread, &s, mOct + n, amp, -5, 1, -1);
    s.lo = lo ^ kLava[0];
    s.hi = hi ^ kLava[1];
    n += xDoublePerlinInit(&mLava, &s, mOct + n, amp, -1, 1, -1);
    if (n > static_cast<int>(sizeof(mOct) / sizeof(mOct[0]))) return false;

    mReady = true;
    return true;
}

int Aquifer::surface(int x, int z)
{
    const int cx = floordiv(x, kCellSize) * kCellSize;
    const int cz = floordiv(z, kCellSize) * kCellSize;
    const int64_t key = (static_cast<int64_t>(static_cast<uint32_t>(cx)) << 32)
        | static_cast<uint32_t>(cz);
    auto found = mSurface.find(key);
    if (found != mSurface.end()) return found->second;
    // `preliminary_surface_level` is a cell-2D density function: sample it on
    // the 4-block grid like vanilla does.
    int height = samplePreliminarySurfaceLevel(mTn, cx, cz);
    if (mSurface.size() > 8192) mSurface.clear();
    mSurface.emplace(key, height);
    return height;
}

bool Aquifer::deepDarkExcluded(int x, int y, int z)
{
    // erosion < -0.225 && depth > 0.9, the overworld deep-dark gate that is
    // shared by 1.19.4 .. 26.x (26.x folds the same test into one node).
    float np[4];
    sampleNoiseParameters(&mTn->g.bn, floordiv(x, kCellSize), floordiv(z, kCellSize), np);
    const double erosion = np[1];
    const double offset = static_cast<double>(getSpline(mTn->g.bn.sp, np)) - 0.50375F;
    const double depth = offset + clampedMap(y, -64, 320, 1.5, -1.5);
    return erosion < -0.22499999403953552 && depth > 0.8999999761581421;
}

FluidStatus Aquifer::computeFluid(int x, int y, int z)
{
    FluidStatus result = globalFluid(y);
    if (!mReady) return result;

    static const int kOffsets[13][2] = {
        {0, 0}, {-2, -1}, {-1, -1}, {0, -1}, {1, -1}, {-3, 0}, {-2, 0},
        {-1, 0}, {1, 0}, {-2, 1}, {-1, 1}, {0, 1}, {1, 1},
    };

    int lowest = 2147483647;
    bool underWater = false;
    for (const auto &offset : kOffsets) {
        const bool center = offset[0] == 0 && offset[1] == 0;
        const int px = x + offset[0] * 16;
        const int pz = z + offset[1] * 16;
        const int height = surface(px, pz);
        const int top = height + 8;
        if (center && y - 12 > top) return result;
        const bool reaches = y + 12 > top;
        if (reaches || center) {
            const FluidStatus other = globalFluid(top);
            if (top < other.level) {
                if (center) underWater = true;
                if (reaches) return other;
            }
        }
        lowest = std::min(lowest, height);
    }

    double wet = -1.0;
    double full = -1.0;
    if (!deepDarkExcluded(x, y, z)) {
        const double water = underWater
            ? 1.0 - clamp((lowest + 8 - y) / 64.0, 0.0, 1.0)
            : 0.0;
        const double noise = clamp(sampleDoublePerlin(&mFlood, x * 1.0, y * 0.67, z * 1.0), -1.0, 1.0);
        // Thresholds are lerp(1 - water, ...) with the floodedness noise on the
        // same scale: wet > 0 means "this cell is flooded", full > 0 means
        // "flooded to the global fluid level".
        const double wetThreshold = -0.8 + (1.0 - water) * 1.2;
        const double fullThreshold = -0.3 + (1.0 - water) * 1.1;
        wet = noise - wetThreshold;
        full = noise - fullThreshold;
    }

    int level = kNoFluidY;
    int spreadLevel = kNoFluidY;
    if (full > 0) {
        level = result.level;
    } else if (wet > 0) {
        const int gx = floordiv(x, 16);
        const int gy = floordiv(y, 40);
        const int gz = floordiv(z, 16);
        const double spread = sampleDoublePerlin(&mSpread, gx * 1.0, gy * 0.7142857142857143, gz * 1.0) * 10.0;
        spreadLevel = gy * 40 + 20 + static_cast<int>(std::floor(spread / 3.0)) * 3;
        level = std::min(lowest, spreadLevel);
    }

    // 1.18 picks the lava replacement level from the spread level; later
    // versions use the final level.
    const int lavaLevel = mUses118 ? spreadLevel : level;
    if (lavaLevel <= -10 && lavaLevel != kNoFluidY && result.type != 2) {
        const double lava = sampleDoublePerlin(&mLava, floordiv(x, 64) * 1.0, floordiv(y, 40) * 1.0,
                                               floordiv(z, 64) * 1.0);
        if (std::fabs(lava) > 0.3) result.type = 2;
    }
    result.level = level;
    return result;
}

// --- worker scratch ------------------------------------------------------

struct TerrainWorker {
    Generator gen{};
    std::unique_ptr<TerrainNoise> tn;
    std::unique_ptr<Aquifer> aquifer;
    std::vector<double> corner;  // cornersX * cornersZ * rows
    std::vector<float> prelim;   // cornersX * cornersZ
    std::vector<int16_t> height; // sx * sz
    std::vector<uint8_t> air;    // cellW * cellH * levels
    std::vector<uint8_t> reach;
    std::vector<uint8_t> sky;
    std::vector<int16_t> topSolid;  // cellW * cellH
    std::vector<uint16_t> label;
    std::vector<int> biomes;
};

struct ComponentStat {
    int volume = 0;
    int sampled = 0;
    int cheeseHits = 0;
};

/** final_density based cheese test for one sampled cave volume point. */
bool cheeseTermNegative(TerrainNoise *tn, int x, int y, int z)
{
    float np[4];
    sampleNoiseParameters(&tn->g.bn, floordiv(x, kCellSize), floordiv(z, kCellSize), np);
    const double depth = static_cast<double>(getSpline(tn->g.bn.sp, np)) - 0.50375F;
    const double factor = static_cast<double>(getSpline(tn->factorSpline, np));
    double jagged = sampleDoublePerlin(&tn->noises[OTP_JAGGED], x * 1500.0, 0.0, z * 1500.0);
    if (jagged < 0.0) jagged *= 0.5;
    jagged *= static_cast<double>(getSpline(tn->jaggednessSpline, np));
    const double sloped = sampleSlopedCheese(tn, x, y, z, depth, factor, jagged);
    const double term = sampleCaveLayer(tn, x, y, z) + sampleCaveCheese(tn, x, y, z, sloped);
    return term < 0.0;
}

/**
 * Terrain density *without* the noise caves: exactly the cubiomes
 * `sloped_cheese` term the vanilla density function starts from
 * (`final_density = min(sloped_cheese, ...cave terms...)`).
 *
 * The terrain-only layer (caves off) uses this, so the relief shows the plain
 * cubiomes surface; the cave layer keeps using `sampleNoiseColumn`, whose
 * `final_density` includes the cave carving that exposes cave openings.
 */
/**
 * Terrain density *without* the noise caves.
 *
 * This reproduces cubiomes' `final_density` pipeline with the cave terms left
 * out: the `sloped_cheese` base density goes through the same `postProcess`
 * and `slideOverworld` steps as vanilla, which is what makes the world top and
 * bottom solid. `final_density` is `min(postProcess(slideOverworld(b)), noodle)`
 * where `b <= sloped_cheese` once entrances/underground carving is removed, so
 * these columns are an upper bound of the real density and the cave layer
 * keeps using `sampleNoiseColumn`.
 */
inline double postProcessDensity(double density)
{
    // Same squeeze as cubiomes `postProcess`.
    const double clamped = clamp(density * 0.64, -1.0, 1.0);
    return clamped / 2.0 - clamped * clamped * clamped / 24.0;
}

inline double slideOverworldDensity(double density, int y)
{
    // Same as cubiomes `slideOverworld` (minY -64, height 384, top 80/64,
    // bottom 0/24), spelled out so this file stays independent of internals.
    const double top = clampedMap(y, 240, 256, 1.0, 0.0);
    const double topBlend = lerp(top, -0.078125, density);
    const double bottom = clampedMap(y, -64, -40, 0.0, 1.0);
    return lerp(bottom, 0.1171875, topBlend);
}

void sampleCheeseColumn(TerrainNoise *tn, int cellX, int cellZ, int colYMin, int colYMax, double *column)
{
    const int x = cellX * kCellSize;
    const int z = cellZ * kCellSize;
    float np[4];
    sampleNoiseParameters(&tn->g.bn, cellX, cellZ, np);
    const double depth = static_cast<double>(getSpline(tn->g.bn.sp, np)) - 0.50375F;
    const double factor = static_cast<double>(getSpline(tn->factorSpline, np));
    double jagged = sampleDoublePerlin(&tn->noises[OTP_JAGGED], x * 1500.0, 0.0, z * 1500.0);
    if (jagged < 0.0) jagged *= 0.5;
    jagged *= static_cast<double>(getSpline(tn->jaggednessSpline, np));
    for (int i = colYMin; i <= colYMax; i++) {
        const int y = yForRow(i);
        const double sloped = sampleSlopedCheese(tn, x, y, z, depth, factor, jagged);
        column[i - colYMin] = postProcessDensity(slideOverworldDensity(sloped, y));
    }
}

bool genTileBiomes(Generator *gen, const TileSpec &tile, int blockY, std::vector<int> &biomes)
{    Range range{};
    range.scale = tile.scale;
    range.x = tile.x;
    range.z = tile.z;
    range.sx = tile.sx;
    range.sz = tile.sz;
    range.y = verticalFor(tile.scale, blockY);
    range.sy = 1;
    const size_t cells = static_cast<size_t>(tile.sx) * static_cast<size_t>(tile.sz);
    const size_t cacheLen = getMinCacheSize(gen, tile.scale, tile.sx, 1, tile.sz);
    if (cacheLen < cells) return false;
    biomes.assign(cacheLen, 0);
    return genBiomes(gen, biomes.data(), range) == 0;
}

inline bool waterBiome(int id)
{
    return isOceanic(id) || id == river || id == frozen_river;
}

void paintFlat(TileImage &out, const std::vector<int> &biomes, int sx, int sz)
{
    out.rgba.assign(static_cast<size_t>(sx) * sz * 4, 0);
    const size_t cells = static_cast<size_t>(sx) * sz;
    for (size_t i = 0; i < cells; i++) {
        const int id = biomes[i];
        unsigned char r = 0, g = 0, b = 0;
        if (id >= 0 && id < 256) {
            r = gColors[id][0];
            g = gColors[id][1];
            b = gColors[id][2];
        }
        out.rgba[i * 4] = r;
        out.rgba[i * 4 + 1] = g;
        out.rgba[i * 4 + 2] = b;
        out.rgba[i * 4 + 3] = 255;
    }
}

/**
 * Paint the biome base colour multiplied by hill shading only.
 * `height` is indexed [iz * sx + ix] and holds the topmost solid block; columns
 * whose top solid is below the lava level are painted as the lava sea (vanilla
 * floods everything under y=-54 with lava), including columns where cubiomes
 * found no solid block at all (height == -64).
 */
void paintShaded(TileImage &out, const std::vector<int> &biomes, const std::vector<int16_t> &height,
                 int sx, int sz, float gain)
{
    out.rgba.assign(static_cast<size_t>(sx) * sz * 4, 0);
    for (int iz = 0; iz < sz; iz++) {
        const int zPrev = iz > 0 ? iz - 1 : iz;
        const int zNext = iz + 1 < sz ? iz + 1 : iz;
        for (int ix = 0; ix < sx; ix++) {
            const int xPrev = ix > 0 ? ix - 1 : ix;
            const int xNext = ix + 1 < sx ? ix + 1 : ix;
            const size_t index = static_cast<size_t>(iz) * sx + ix;
            const int id = biomes[index];
            const int h = height[index];
            if (h <= kLavaTopBlock) {
                // Below the lava level the visible surface is the lava sea; this
                // also covers columns where cubiomes returned no solid block.
                out.rgba[index * 4] = kLavaSeaR;
                out.rgba[index * 4 + 1] = kLavaSeaG;
                out.rgba[index * 4 + 2] = kLavaSeaB;
                out.rgba[index * 4 + 3] = 255;
                continue;
            }
            float light = 1.0f;
            if (!waterBiome(id)) {
                const int left = height[static_cast<size_t>(iz) * sx + xPrev];
                const int up = height[static_cast<size_t>(zPrev) * sx + ix];
                const int right = height[static_cast<size_t>(iz) * sx + xNext];
                const int down = height[static_cast<size_t>(zNext) * sx + ix];
                const double d0 = static_cast<double>(left) + static_cast<double>(up);
                const double d1 = static_cast<double>(right) + static_cast<double>(down);
                light = static_cast<float>(1.0 + (d1 - d0) * gain);
                light = std::min(kShadeMax, std::max(kShadeMin, light));
            }
            unsigned char r = 0, g = 0, b = 0;
            if (id >= 0 && id < 256) {
                r = gColors[id][0];
                g = gColors[id][1];
                b = gColors[id][2];
            }
            const float scale = light;
            out.rgba[index * 4] = static_cast<uint8_t>(std::min(255.0f, r * scale));
            out.rgba[index * 4 + 1] = static_cast<uint8_t>(std::min(255.0f, g * scale));
            out.rgba[index * 4 + 2] = static_cast<uint8_t>(std::min(255.0f, b * scale));
            out.rgba[index * 4 + 3] = 255;
        }
    }
}

/**
 * Build one 1:1 terrain tile.
 *
 * `withCaves == false` uses the cave-free `sloped_cheese` columns, so the
 * relief is the plain cubiomes surface. `withCaves == true` samples the full
 * `final_density` field instead, reusing the same corner columns for a 4x4x8
 * air grid, a sky flood fill and the cheese-cave opening mask.
 */
void buildTerrainTile(TerrainWorker &worker, const TileSpec &tile, int blockY, bool withCaves, TileImage &out)
{
    TerrainNoise *tn = worker.tn.get();
    const int sx = tile.sx;
    const int sz = tile.sz;
    const int cellW = sx / kCellSize;
    const int cellH = sz / kCellSize;
    const int blockX0 = tile.x * tile.scale;
    const int blockZ0 = tile.z * tile.scale;

    if (!tn || !genTileBiomes(&worker.gen, tile, blockY, worker.biomes)) {
        out.rgba.assign(static_cast<size_t>(sx) * sz * 4, 0);
        return;
    }

    const int cellX0 = floordiv(blockX0, kCellSize);
    const int cellZ0 = floordiv(blockZ0, kCellSize);
    const int cornersX = floordiv(blockX0 + sx - 1, kCellSize) - cellX0 + 2;
    const int cornersZ = floordiv(blockZ0 + sz - 1, kCellSize) - cellZ0 + 2;

    // 1) row count from the (cheap) preliminary surface, then the real columns.
    worker.prelim.resize(static_cast<size_t>(cornersX) * cornersZ);
    int maxPrelim = -64;
    for (int j = 0; j < cornersZ; j++) {
        for (int i = 0; i < cornersX; i++) {
            const int px = (cellX0 + i) * kCellSize;
            const int pz = (cellZ0 + j) * kCellSize;
            const int height = samplePreliminarySurfaceLevel(tn, px, pz);
            worker.prelim[static_cast<size_t>(j) * cornersX + i] = static_cast<float>(height);
            maxPrelim = std::max(maxPrelim, height);
        }
    }
    auto rowsFor = [](int prelim) {
        const int rows = static_cast<int>(std::ceil((prelim + 48 + 64) / static_cast<double>(kCellHeight))) + 1;
        return std::min(kMaxRows, std::max(kMinRows, rows));
    };
    int rows = rowsFor(maxPrelim);

    worker.height.assign(static_cast<size_t>(sx) * sz, -64);
    const int interp = INTERP_1_18;

    for (int attempt = 0; attempt < 2; attempt++) {
        worker.corner.assign(static_cast<size_t>(cornersX) * cornersZ * rows, 0.0);
        for (int j = 0; j < cornersZ; j++) {
            for (int i = 0; i < cornersX; i++) {
                double *column = worker.corner.data()
                    + (static_cast<size_t>(j) * cornersX + i) * rows;
                if (withCaves)
                    sampleNoiseColumn(tn, cellX0 + i, cellZ0 + j, 0, rows - 1, column);
                else
                    sampleCheeseColumn(tn, cellX0 + i, cellZ0 + j, 0, rows - 1, column);
            }
        }
        // The sampled range must reach above the highest solid cell, otherwise a
        // column would look empty (and be painted as the lava sea). Retry once
        // with the full column height.
        if (rows < kMaxRows) {
            bool clipped = false;
            for (int j = 0; j < cornersZ && !clipped; j++) {
                for (int i = 0; i < cornersX; i++) {
                    const double *column = worker.corner.data()
                        + (static_cast<size_t>(j) * cornersX + i) * rows;
                    if (column[rows - 1] > 0.0 || column[rows - 2] > 0.0) {
                        clipped = true;
                        break;
                    }
                }
            }
            if (clipped) {
                rows = kMaxRows;
                continue;
            }
        }
        // 2) column tops per block.
        for (int iz = 0; iz < sz; iz++) {
            const int bz = blockZ0 + iz;
            const int cz = floordiv(bz, kCellSize) - cellZ0;
            const double percentZ = (bz - (cellZ0 + cz) * kCellSize) / static_cast<double>(kCellSize);
            for (int ix = 0; ix < sx; ix++) {
                const int bx = blockX0 + ix;
                const int cx = floordiv(bx, kCellSize) - cellX0;
                const double percentX = (bx - (cellX0 + cx) * kCellSize) / static_cast<double>(kCellSize);
                auto columnAt = [&](int di, int dj) {
                    return worker.corner.data()
                        + (static_cast<size_t>(cz + dj) * cornersX + (cx + di)) * rows;
                };
                const int above = generateColumn(nullptr, columnAt(0, 0), columnAt(0, 1),
                                                 columnAt(1, 0), columnAt(1, 1), 0, rows - 1,
                                                 kCellHeight, percentX, percentZ, interp,
                                                 kAquiferMinY, 1);
                worker.height[static_cast<size_t>(iz) * sx + ix] =
                    static_cast<int16_t>(above <= kAquiferMinY ? kAquiferMinY : above - 1);
            }
        }

        if (!withCaves) break;

        const int levels = rows - 1;
        const size_t cells = static_cast<size_t>(cellW) * cellH;
        worker.air.assign(cells * levels, 0);
        worker.topSolid.assign(cells, -1);

        // 3) 4x4x8 air cells: the 8 corner densities averaged (trilinear at 0.5).
        for (int cj = 0; cj < cellH; cj++) {
            for (int ci = 0; ci < cellW; ci++) {
                int top = -1;
                for (int k = 0; k < levels; k++) {
                    double sum = 0.0;
                    for (int dj = 0; dj < 2; dj++) {
                        for (int di = 0; di < 2; di++) {
                            const double *column = worker.corner.data()
                                + (static_cast<size_t>(cj + dj) * cornersX + (ci + di)) * rows;
                            sum += column[k] + column[k + 1];
                        }
                    }
                    const bool solid = (sum / 8.0) > 0.0;
                    const size_t index = (static_cast<size_t>(k) * cellH + cj) * cellW + ci;
                    worker.air[index] = solid ? 0 : 1;
                    if (solid) top = k;
                }
                worker.topSolid[static_cast<size_t>(cj) * cellW + ci] = static_cast<int16_t>(top);
            }
        }

        // 4) flood fill the sky from the topmost layer.
        worker.reach.assign(cells * levels, 0);
        std::vector<int> stack;
        stack.reserve(1024);
        for (int cj = 0; cj < cellH; cj++) {
            for (int ci = 0; ci < cellW; ci++) {
                const size_t index = (static_cast<size_t>(levels - 1) * cellH + cj) * cellW + ci;
                if (worker.air[index]) {
                    worker.reach[index] = 1;
                    stack.push_back(static_cast<int>(index));
                }
            }
        }
        while (!stack.empty()) {
            const int index = stack.back();
            stack.pop_back();
            const int ci = index % cellW;
            const int t = index / cellW;
            const int cj = t % cellH;
            const int k = t / cellH;
            static const int kDirs[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
            for (const auto &dir : kDirs) {
                const int nx = ci + dir[0];
                const int nz = cj + dir[1];
                const int ny = k + dir[2];
                if (nx < 0 || nx >= cellW || nz < 0 || nz >= cellH || ny < 0 || ny >= levels) continue;
                const size_t next = (static_cast<size_t>(ny) * cellH + nz) * cellW + nx;
                if (!worker.air[next] || worker.reach[next]) continue;
                worker.reach[next] = 1;
                stack.push_back(static_cast<int>(next));
            }
        }

        // 5) sky vs. underground, then label the underground components.
        worker.sky.assign(cells * levels, 0);
        worker.label.assign(cells * levels, 0);
        for (int cj = 0; cj < cellH; cj++) {
            for (int ci = 0; ci < cellW; ci++) {
                const int top = worker.topSolid[static_cast<size_t>(cj) * cellW + ci];
                for (int k = 0; k < levels; k++) {
                    const size_t index = (static_cast<size_t>(k) * cellH + cj) * cellW + ci;
                    if (!worker.reach[index]) continue;
                    if (k <= top) continue;
                    worker.sky[index] = 1;
                }
            }
        }

        std::vector<uint16_t> componentOf(cells * levels, 0);
        uint16_t componentCount = 0;
        std::vector<ComponentStat> stats;
        std::vector<int> pending;
        for (int cj = 0; cj < cellH; cj++) {
            for (int ci = 0; ci < cellW; ci++) {
                const int top = worker.topSolid[static_cast<size_t>(cj) * cellW + ci];
                for (int k = 0; k <= top; k++) {
                    const size_t index = (static_cast<size_t>(k) * cellH + cj) * cellW + ci;
                    if (!worker.reach[index] || !worker.air[index]) continue;
                    if (componentOf[index]) continue;
                    if (componentCount == 0xFFFF) continue;
                    const uint16_t label = ++componentCount;
                    stats.emplace_back();
                    ComponentStat &stat = stats.back();
                    pending.clear();
                    pending.push_back(static_cast<int>(index));
                    componentOf[index] = label;
                    while (!pending.empty()) {
                        const int current = pending.back();
                        pending.pop_back();
                        stat.volume++;
                        const int cx = current % cellW;
                        const int t = current / cellW;
                        const int cz = t % cellH;
                        const int ck = t / cellH;
                        static const int kDirs2[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
                        for (const auto &dir : kDirs2) {
                            const int nx = cx + dir[0];
                            const int nz = cz + dir[1];
                            const int ny = ck + dir[2];
                            if (nx < 0 || nx >= cellW || nz < 0 || nz >= cellH || ny < 0 || ny >= levels)
                                continue;
                            const size_t next = (static_cast<size_t>(ny) * cellH + nz) * cellW + nx;
                            if (!worker.air[next] || !worker.reach[next]) continue;
                            const int neighborTop = worker.topSolid[static_cast<size_t>(nz) * cellW + nx];
                            if (ny > neighborTop) continue;
                            if (componentOf[next]) continue;
                            componentOf[next] = label;
                            pending.push_back(static_cast<int>(next));
                        }
                    }
                }
            }
        }
        worker.label.swap(componentOf);

        // 6) cheese test per component, sampling up to kCheeseSamples cells.
        std::vector<int> seen(stats.size(), 0);
        for (int cj = 0; cj < cellH; cj++) {
            for (int ci = 0; ci < cellW; ci++) {
                const int top = worker.topSolid[static_cast<size_t>(cj) * cellW + ci];
                for (int k = 0; k <= top; k++) {
                    const size_t index = (static_cast<size_t>(k) * cellH + cj) * cellW + ci;
                    const uint16_t label = worker.label[index];
                    if (!label) continue;
                    ComponentStat &stat = stats[label - 1];
                    const int step = std::max(1, stat.volume / kCheeseSamples);
                    const int seenCount = ++seen[label - 1];
                    if (stat.sampled >= kCheeseSamples || seenCount % step != 0) continue;
                    const int wx = blockX0 + ci * kCellSize + kCellSize / 2;
                    const int wz = blockZ0 + cj * kCellSize + kCellSize / 2;
                    const int wy = yForRow(k) + kCellHeight / 2;
                    stat.sampled++;
                    if (cheeseTermNegative(tn, wx, wy, wz)) stat.cheeseHits++;
                }
            }
        }
        std::vector<uint8_t> isCheese(stats.size(), 0);
        for (size_t i = 0; i < stats.size(); i++) {
            const bool cheese = (stats[i].volume >= kCheeseMinVol && stats[i].cheeseHits >= 1)
                || stats[i].volume >= kCheeseHugeVol;
            isCheese[i] = cheese ? 1 : 0;
        }

        // 7) openings: underground cells with a direct sky neighbour.
        out.cave.assign(cells, 0);
        out.floodY.assign(cells, static_cast<int16_t>(kNoFluidY));
        for (int cj = 0; cj < cellH; cj++) {
            for (int ci = 0; ci < cellW; ci++) {
                const size_t cellIndex = static_cast<size_t>(cj) * cellW + ci;
                if (out.cave[cellIndex]) continue;
                const int top = worker.topSolid[cellIndex];
                for (int k = top; k >= 0; k--) {
                    const size_t index = (static_cast<size_t>(k) * cellH + cj) * cellW + ci;
                    const uint16_t label = worker.label[index];
                    if (!label || !isCheese[label - 1]) continue;
                    bool opening = false;
                    static const int kDirs3[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
                    for (const auto &dir : kDirs3) {
                        const int nx = ci + dir[0];
                        const int nz = cj + dir[1];
                        const int ny = k + dir[2];
                        if (nx < 0 || nx >= cellW || nz < 0 || nz >= cellH || ny < 0 || ny >= levels)
                            continue;
                        if (worker.sky[(static_cast<size_t>(ny) * cellH + nz) * cellW + nx]) {
                            opening = true;
                            break;
                        }
                    }
                    if (!opening) continue;

                    const int wx = blockX0 + ci * kCellSize + kCellSize / 2;
                    const int wz = blockZ0 + cj * kCellSize + kCellSize / 2;
                    const int cellY = yForRow(k) + kCellHeight / 2;

                    // Classify the fluid *at the opening*: `computeFluid`
                    // already returns "no fluid" (kNoFluidY) for columns the
                    // aquifer does not flood, so `y < level` is exactly the
                    // vanilla `FluidStatus.at(y)` test. Scanning the whole
                    // column instead would report water for nearly every
                    // opening below sea level, because the floodedness noise
                    // is sampled independently at each scan step.
                    int floodY = kNoFluidY;
                    int type = 0;
                    if (worker.aquifer) {
                        const FluidStatus fluid = worker.aquifer->computeFluid(wx, cellY, wz);
                        if (fluid.level != kNoFluidY && cellY < fluid.level) {
                            floodY = fluid.level;
                            type = fluid.type;
                        }
                    }
                    if (type != 0 && cellY < floodY) {
                        out.cave[cellIndex] = static_cast<uint8_t>(type == 2 ? 3 : 2);
                        out.floodY[cellIndex] = static_cast<int16_t>(floodY);
                    } else {
                        out.cave[cellIndex] = 1;
                    }
                    break;
                }
            }
        }
        break;
    }

    out.height.assign(worker.height.begin(), worker.height.end());
    paintShaded(out, worker.biomes, worker.height, sx, sz, kShadeGain);
    if (!withCaves) {
        out.cave.clear();
        out.floodY.clear();
    }
}

bool terrainSupported(int mc, int dim)
{
    return dim == DIM_OVERWORLD && mc >= MC_1_18;
}

void fillFallback(TileImage &out, const std::vector<int> &biomes, int sx, int sz, int layer, int scale)
{
    paintFlat(out, biomes, sx, sz);
    const size_t cells = static_cast<size_t>(sx) * sz;
    if (layer > 0 && scale == 1) out.height.assign(cells, static_cast<int16_t>(-64));
    else out.height.clear();
    if (layer == 2 && scale == 1) {
        const size_t caveCells = static_cast<size_t>(sx / kCellSize) * (sz / kCellSize);
        out.cave.assign(caveCells, 0);
        out.floodY.assign(caveCells, static_cast<int16_t>(kNoFluidY));
    } else {
        out.cave.clear();
        out.floodY.clear();
    }
}

} // namespace

void renderTerrainTiles(int mc, uint64_t seed, int dim, uint32_t flags, int blockY,
                        int layer, const std::vector<TileSpec> &tiles,
                        std::vector<TileImage> &out)
{
    out.assign(tiles.size(), TileImage{});
    if (tiles.empty()) return;
    ensureColors();

    const bool supported = terrainSupported(mc, dim);
    unsigned workers = std::thread::hardware_concurrency();
    if (workers < 1) workers = 1;
    if (workers > 16) workers = 16;
    if (workers > tiles.size()) workers = static_cast<unsigned>(tiles.size());
    std::atomic<size_t> cursor{0};

    auto work = [&]() {
        TerrainWorker worker;
        setupGenerator(&worker.gen, mc, flags);
        applySeed(&worker.gen, dim, seed);
        const bool buildTerrain = supported && layer > 0;
        if (buildTerrain) {
            worker.tn = std::make_unique<TerrainNoise>();
            setupTerrainNoise(worker.tn.get(), mc, flags);
            initTerrainNoise(worker.tn.get(), seed, DIM_OVERWORLD);
            if (layer == MAP_LAYER_TERRAIN_CAVES) {
                worker.aquifer = std::make_unique<Aquifer>();
                if (!worker.aquifer->init(mc, seed, worker.tn.get())) worker.aquifer.reset();
            }
        }
        while (true) {
            const size_t index = cursor.fetch_add(1);
            if (index >= tiles.size()) break;
            const TileSpec &tile = tiles[index];
            TileImage &image = out[index];
            if (!buildTerrain || tile.sx < kCellSize || tile.sz < kCellSize
                || tile.sx % kCellSize != 0 || tile.sz % kCellSize != 0
                || tile.sx > 1024 || tile.sz > 1024) {
                std::vector<int> biomes;
                if (genTileBiomes(&worker.gen, tile, blockY, biomes)) {
                    fillFallback(image, biomes, tile.sx, tile.sz, layer, tile.scale);
                } else {
                    image.rgba.assign(static_cast<size_t>(std::max(tile.sx, 0))
                        * static_cast<size_t>(std::max(tile.sz, 0)) * 4, 0);
                }
                continue;
            }
            const bool withCaves = layer == MAP_LAYER_TERRAIN_CAVES && tile.scale == 1;
            if (tile.scale == 1) {
                buildTerrainTile(worker, tile, blockY, withCaves, image);
            } else {
                // Only 1:1 uses the density field; every other zoom level stays
                // on the plain biome map (no approximate relief).
                std::vector<int> biomes;
                if (genTileBiomes(&worker.gen, tile, blockY, biomes)) {
                    fillFallback(image, biomes, tile.sx, tile.sz, layer, tile.scale);
                } else {
                    image.rgba.assign(static_cast<size_t>(tile.sx) * tile.sz * 4, 0);
                }
            }
        }
    };

    std::vector<std::thread> pool;
    pool.reserve(workers);
    for (unsigned i = 0; i < workers; i++) pool.emplace_back(work);
    for (std::thread &thread : pool) thread.join();
}
