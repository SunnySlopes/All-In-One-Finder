#pragma once

#include <stdint.h>

#include <string>
#include <vector>

struct WitchHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    int y = 0;       /* avg_y：footprint 平均高度 */
    int dir = 0;     /* 0=N 1=E 2=S 3=W */
    int sizeX = 0;
    int sizeZ = 0;
    int wet = 0;     /* footprint 在 y=62 的灌水列数（0..63） */
    int flooded = 0;
    int reject = 0;
};

struct WitchStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int64_t current = 0; /* 已扫描 region 数（当前种子） */
    int64_t total = 0;   /* 当前种子的 region 总数 */
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<WitchHit> hits;
};

struct WitchRequest {
    int versionGroup = 2;      /* 0 = 1.18.x，1 = 1.19.x~26.1，2 = 26.2+ */
    bool largeBiomes = false;  /* 开始搜索时地图勾选的快照 */
    bool singleBiome = false;  /* UI 不开放，恒为 false */
    int threads = 1;
    int maxY = -40;            /* 阶段 2 的最终门槛（avg_y <= maxY） */
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    std::vector<int64_t> seeds;
};

std::string witchStart(const WitchRequest &request);
void witchPause();
void witchResume();
void witchStop();
WitchStatus witchPoll();
