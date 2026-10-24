#pragma once

#include <stdint.h>

#include <string>
#include <vector>

struct SlimeHit {
    int64_t seed = 0;
    int64_t x = 0;
    int64_t z = 0;
    int64_t area = 0;
    double areaEquiv = 0.0;
    int chunks = 0;
};

struct SlimeStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int stage = 0;
    uint64_t current = 0;
    uint64_t total = 0;
    uint64_t tilesDone = 0;
    uint64_t tilesTotal = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<SlimeHit> hits;
};

struct SlimeRequest {
    int mc = 0;
    int versionRule = 2;
    int threads = 1;
    int64_t minSlimeArea = 9000;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    bool convert = true;
    std::vector<int64_t> seeds;
};

bool slimeSupports(int mc);
std::string slimeStart(const SlimeRequest &request);
void slimePause();
void slimeResume();
void slimeStop();
SlimeStatus slimePoll();
