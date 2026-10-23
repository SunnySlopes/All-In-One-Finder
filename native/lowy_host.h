#pragma once

#include <stdint.h>

#include <string>
#include <vector>

struct LowyHit {
    int64_t seed;
    int x;
    int z;
    int total;
    int cave;
    int river;
};

struct LowyStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int phase = 0;
    int current = 0;
    int total = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<LowyHit> hits;
};

struct LowyRequest {
    int mode = 0;
    int mc = 0;
    int threads = 1;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    bool fastMode = true;
    float ratioPercent = 60.f;
    float riverWeight = 0.75f;
    std::vector<int64_t> seeds;
};

bool lowySupports(int mc);
float lowyWeirdness(int64_t seed);
std::string lowyStart(const LowyRequest &request);
void lowyPause();
void lowyResume();
void lowyStop();
LowyStatus lowyPoll();
