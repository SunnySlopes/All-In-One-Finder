#pragma once

#include <stdint.h>

#include <string>
#include <vector>

/* 神殿结果（二联/多联共用）。count：2=二联，3/4=多联。 */
struct MonumentHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    int dx = 0;
    int dz = 0;
    int count = 2;
    int area = 0;
    int lowEfficiency = 0;
    int oceanType = 0; /* 0=others 1=cold 2=frozen */
};

struct MonumentStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int64_t current = 0;
    int64_t total = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<MonumentHit> hits;
};

/* 原点 (0,0) 的平方距离。 */
inline int64_t originDist2(int x, int z)
{
    return static_cast<int64_t>(x) * x + static_cast<int64_t>(z) * z;
}
