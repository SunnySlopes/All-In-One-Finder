#pragma once

#include <stdint.h>

#include <string>
#include <vector>

/**
 * One budding-amethyst (geode) result returned by the native geode engine.
 *
 * `x`/`z` is the horizontally optimal player center; the engine never infers Y.
 * `budding` is the primary ranking key (expected active budding amethyst), and
 * `geodes` is the number of geode origins whose activity area covers the point.
 */
struct GeodeHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    int budding = 0;
    int geodes = 0;
    /** True when the host recomputed this point with geode::evaluate(). */
    bool verified = false;
    /** Engine leaderboard value before verification; -1 when verification matched. */
    int listedBudding = -1;
    int listedGeodes = -1;
};

struct GeodeStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    /** Pause requested; waiting for the current work unit to reach a checkpoint. */
    bool pausing = false;
    bool stopping = false;
    /** The user stopped this run; hits were cleared but a full-map checkpoint remains. */
    bool stopped = false;
    /** At least one seed returned 1,000 hits, so its list may be truncated. */
    bool truncated = false;
    /** "scan" | "simulate" | "rank" | "verify" | "done". */
    std::string phase = "scan";
    int phaseIndex = 0; /* 1..phaseCount */
    int phaseCount = 3; /* single seed with verification: 4 */
    int64_t current = 0;
    int64_t total = 0;
    int64_t verifyDone = 0;
    int64_t verifyTotal = 0;
    int verified = 0;
    int verifyMismatch = 0;
    int seedIndex = 0;
    int seedCount = 0;
    /** Auto budget switch as sent by the UI. */
    bool autoBudget = true;
    /** Candidate budget actually passed to the engine. */
    int prefilter = 0;
    /** Whether this run resumed from a region checkpoint. */
    bool resumed = false;
    /** Full-map ETA in seconds; -1 while calculating. */
    double etaSeconds = -1;
    std::string scanBackend = "cpu"; /* "cpu" | "gpu" */
    bool approximate = false;        /* prefilter > 0 */
    std::string backend = "cpu";
    /** Why the GPU scan was skipped: "no-opencl" | "no-device" | "" when it ran. */
    std::string gpuReason;
    /** CL_DEVICE_NAME when the GPU ran the scan. */
    std::string gpuDevice;
    double elapsedMs = 0;
    std::string error;
    std::vector<GeodeHit> hits;
};

struct GeodeRequest {
    std::string version = "26.3";
    int threads = 8;
    /** "terrain" (default) or "stone" (comparison only). */
    std::string model = "terrain";
    /* 精确四至（闭区间）；正方形只是 UI 快捷填充，宿主始终按四至搜索。 */
    int minX = -16384;
    int maxX = 16383;
    int minZ = -16384;
    int maxZ = 16383;
    bool fullWorld = false;
    int tickRadius = 128;
    int simulationDistance = 10;
    int minGeodes = 1;
    int minBudding = 1;
    bool autoBudget = true;
    int budget = 0; /* manual budget when autoBudget == false */
    int verifyTop = 20; /* single seed only; list mode forces 0 */
    bool allowGpu = true;
    bool resume = true;
    std::vector<int64_t> seeds;
};

/** Empty string on success; otherwise a message key such as `busy`. */
std::string geodeStart(const GeodeRequest &request);
void geodePause();
void geodeResume();
void geodeStop();
GeodeStatus geodePoll();

/** One geode structure icon's in-model budding-amethyst count. */
struct GeodeChunkSummary {
    bool exists = false;
    int budding = 0;
};

/** Generate one geode chunk for the map's structure info card. */
GeodeChunkSummary geodeChunkSummary(const std::string &version, int64_t seed, int x, int z);
