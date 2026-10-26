#pragma once

#include <stdint.h>

#include <string>
#include <vector>

/** One verified flower-farm window returned by the native CTS engine. */
struct FlowerHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    int sideX = 0;
    int sideZ = 0;
    int flowerArea = 0;
    int paleArea = 0;
    int swampArea = 0;
    int flowerX = 0;
    int flowerY = 0;
    int flowerZ = 0;
    int paleX = 0;
    int paleZ = 0;
    int swampX = 0;
    int swampZ = 0;
    char orient = 0; /* 'X', 'Z' or 0 for a square window */
    std::string nether;
    std::string bonus;
};

struct FlowerStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int phase = 0; /* 0 = prepare, 1 = climate screen, 2 = verify */
    int64_t current = 0;
    int64_t total = 0;
    int64_t phaseCurrent = 0;
    int64_t phaseTotal = 0;
    int64_t overallCurrent = 0;
    int64_t overallTotal = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<FlowerHit> hits;
};

struct FlowerRequest {
    int mc = 0;
    int threads = 1;
    int minX = 0;
    int maxX = 0;
    int minZ = 0;
    int maxZ = 0;
    int longSide = 640;
    int shortSide = 320;
    bool squareOnly = false;
    bool fastMode = true;
    std::vector<int64_t> seeds;
};

std::string flowerStart(const FlowerRequest &request);
void flowerPause();
void flowerResume();
void flowerStop();
FlowerStatus flowerPoll();
