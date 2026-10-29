#pragma once

#include <stdint.h>

#include <string>
#include <vector>

/* 海洋温度位掩码（与子模块 monument_search_core.h 的 OCEAN_MASK_* 对齐）。 */
constexpr int kOceanMaskFrozen = 0x01;
constexpr int kOceanMaskCold = 0x02;
constexpr int kOceanMaskNormal = 0x04;
constexpr int kOceanMaskLukewarm = 0x08;
constexpr int kOceanMaskWarm = 0x10;

/* 旧版单一海洋类型（0=others 1=cold 2=frozen），保留给旧消费者。 */
inline int legacyOceanType(int mask)
{
    if (mask & kOceanMaskCold) return 1;
    if (mask & kOceanMaskFrozen) return 2;
    return 0;
}

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
    int oceanType = 0; /* 0=others 1=cold 2=frozen（旧字段） */
    int oceanTypes = 0; /* 4 个检查点出现的海洋温度位掩码 */
    /* 多联三种面积口径（二联保持 0）。 */
    int x2 = 0;        /* 第二假人（双假人） */
    int z2 = 0;
    int singleX = 0;   /* 单假人最优点 */
    int singleZ = 0;
    int singleArea = 0;
    int areaMax = 0;   /* 单门 257x257 上限 */
    int areaMaxX = 0;  /* 上限 footprint 重心（主世界） */
    int areaMaxZ = 0;
    int dual = 0;      /* 1 = x2/z2 有效 */
    int mode = 0;      /* 0 单假人 / 1 双假人 / 2 单门 */
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
