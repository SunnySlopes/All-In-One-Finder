#pragma once

#include <stdint.h>

#include <string>
#include <vector>

/**
 * One trial-chamber result returned by the native trial-spawner engine.
 *
 * `x`/`z` is the horizontally optimal player center; the engine does not
 * optimise Y. `spawners` is the total spawner count in the statistics area,
 * `fastSpawners` + `slowSpawners` == `spawners`, and `converted` is
 * `fast + slow * conversion_ratio` (already rounded to one decimal).
 */
struct TrialHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    int structures = 0; /* chambers that contributed spawners */
    int spawners = 0;
    int fastSpawners = 0;
    int slowSpawners = 0;
    double converted = 0.0;
};

struct TrialStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    /** Pause requested, waiting for the current shard to finish. */
    bool pausing = false;
    int phase = 0; /* 0 = prepare, 1 = shard scan/cluster, 2 = finished */
    int64_t current = 0; /* completed shards */
    int64_t total = 0;   /* total shards for the current seed */
    int64_t candidates = 0;
    int64_t layouts = 0;
    int64_t pruned = 0;
    int64_t found = 0;
    int64_t chunks = 0;
    double elapsedMs = 0;
    int seedIndex = 0;
    int seedCount = 0;
    /** At least one seed hit the per-seed limit, so results may be truncated. */
    bool truncated = false;
    /** Pause/stop asked the engine to save a checkpoint and that write failed. */
    bool checkpointFailed = false;
    std::string error;
    std::vector<TrialHit> hits;
};

struct TrialRequest {
    int generation = 3; /* 1 = 1.21~1.21.1, 2 = 1.21.2~26.2, 3 = 26.3+ */
    int threads = 8;
    /* 精确四至（闭区间）。UI 正方形边长只是快捷填充，宿主始终按四至搜索。 */
    int minX = -65536;
    int maxX = 65535;
    int minZ = -65536;
    int maxZ = 65535;
    bool fullWorld = false;
    /* 统计窗口：circle=true 用 clusterRadius；否则用长/短边（正方形窗口时两者相等）。 */
    bool clusterCircle = false;
    int clusterRadius = 160;
    int clusterLongSide = 320;
    int clusterShortSide = 320;
    int minStructures = 2;
    int minSpawners = 50;
    /** 联数上限：结果中参与统计的密室数不得超过该值；0 = 不限制。产品固定为 4。 */
    int maxStructures = 4;
    /**
     * 严格模式：只有起点距统计窗口边界至少 strictMargin 格的密室才计入结构数；
     * 贴边密室整间剔除，但笼子仍按完整窗口统计。
     */
    bool strictMode = false;
    int strictMargin = 0;
    int limit = 1000;
    double conversionRatio = 1.0 / 6.0;
    std::vector<int64_t> seeds;
};

/** Empty string on success; otherwise a message key such as `busy`. */
std::string trialStart(const TrialRequest &request);
void trialPause();
void trialResume();
void trialStop();
TrialStatus trialPoll();
