#pragma once

#include <stdint.h>

#include <utility>
#include <vector>

#include "map_service.h" // Box3i

/** One host-room frame: a generated piece that contains at least one trial cage. */
struct TrialFrame {
    Box3i box; // already padded horizontally by kFramePad
    int spawners = 0;
    int slowSpawners = 0;
};

/** One trial spawner cage; `slow` marks spawners from the slow-spawner pool. */
struct TrialSpawner {
    int x = 0;
    int y = 0;
    int z = 0;
    bool slow = false;
};

/**
 * Per-chamber map overlay data. `x`/`z` echo the requested block position (a
 * chunk corner from `featuresInView`), while the cache is keyed by `chunkX`/`chunkZ`.
 */
struct TrialChamberInfo {
    int x = 0;
    int z = 0;
    int chunkX = 0;
    int chunkZ = 0;
    int pieces = 0;
    bool exists = false;
    /** Outermost extent of every generated piece, horizontally padded by one block. */
    Box3i bounds;
    /** Only host rooms with cages, horizontally padded by one block. */
    std::vector<TrialFrame> frames;
    std::vector<TrialSpawner> spawners;
};

/** cubiomes MC version id → trial generation (1/2/3), or 0 when trial chambers do not exist. */
int trialGenerationForMc(int mc);

/**
 * Generate host-room frames and cage positions for the requested chambers.
 *
 * The layout engine and the per-chunk results are cached on (generation, seed);
 * callers may ask for the same chamber repeatedly (pan/zoom) without paying the
 * ~0.6 ms layout cost again. Unknown/unsupported versions return an empty list.
 */
std::vector<TrialChamberInfo> trialChambers(int mc, uint64_t seed, const std::vector<std::pair<int, int> > &chambers);
