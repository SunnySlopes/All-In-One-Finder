#pragma once

#include <stdint.h>

#include <string>
#include <vector>

struct RiverHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    int sampleY = 0; /* 本次搜索的群系取样 Y，用于地图跳转 */
    int river = 0;
    int cave = 0;
    int score = 0;
};

struct RiverStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int stage = 0;      /* 1 = 粗筛，2 = 精化 */
    int64_t current = 0; /* 阶段内进度 */
    int64_t total = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<RiverHit> hits;
};

struct RiverRequest {
    int mc = 0; /* 产品固定 MC_26_3 */
    int threads = 1;
    int minScore = 0;
    int y = -64;
    bool calcCave = false;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    std::vector<int64_t> seeds;
};

std::string riverStart(const RiverRequest &request);
void riverPause();
void riverResume();
void riverStop();
RiverStatus riverPoll();
