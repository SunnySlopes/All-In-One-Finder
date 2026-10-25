#pragma once

#include <stdint.h>

#include <string>
#include <vector>

struct FortressHit {
    int64_t seed = 0;
    int x = 0;
    int y = 0;
    int z = 0;
    int crossings = 0; /* 2/3/4；大范围模式为 0 */
    int spanX = 0;
    int spanY = 0;
    int spanZ = 0;
    int area = 0; /* 大范围模式：spanX * spanZ */
};

struct FortressStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int64_t current = 0;
    int64_t total = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<FortressHit> hits;
};

struct FortressRequest {
    int mc = 0;
    int threads = 1;
    int mode = 0; /* 0=十字路口 1=大范围 */
    int crossFilter = 2;
    int minLong = 0;
    int minShort = 0;
    int minHeight = 0;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    std::vector<int64_t> seeds;
};

std::string fortressStart(const FortressRequest &request);
void fortressPause();
void fortressResume();
void fortressStop();
FortressStatus fortressPoll();
