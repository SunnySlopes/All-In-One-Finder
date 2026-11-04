#pragma once

#include <stdint.h>

#include <string>
#include <vector>

/*
 * 河流搜索器宿主 ABI。
 *
 * 内核已从 RiverFinder JNI 的 river_finder.cpp 替换为
 * DrownedCombinedFinder（原 river-native，GPL-3.0-only），位于 tools/river。
 * 本头文件是唯一与 addon.cpp / aio_capi 的契约；
 * 全部语义映射集中在 river_host.cpp。
 */

struct RiverHit {
    int64_t seed = 0;
    int x = 0;
    int z = 0;
    /* 地图跳转高度：采样窗口（yMin..yMax）的中线，便于跳图后查看整段窗口。 */
    int sampleY = 0;
    /* 等效河流面积（计入折算的口径，用于百分比与导出）。 */
    int river = 0;
    /* 等效溶洞面积：caveVolume 按 caveConversion 折算成河流层当量（S1）。 */
    int cave = 0;
    /* 真实河流面积：统计窗口内的普通河流格数，未做任何折算（结果卡展示用）。 */
    int rawRiver = 0;
    /* 真实溶洞面积：统计窗口内的溶洞格数（caveVolume），未做任何折算（结果卡展示用）。 */
    int64_t rawCave = 0;
    /* 实际统计层数（挂机Y±24 裁剪后的层数），前端用于说明原始量口径。 */
    int layers = 1;
    /* 等效总分（格/层）：(4880*riverVolume + caveWeight*caveVolume) / (4880*layers)。 */
    int score = 0;
    /* 是否统计溶洞：只看搜索条件（采样最低 Y < 60 且挂机Y < 85），与该点实际有无溶洞无关。
     * 为 true 时 cave/rawCave 是统计值（可能为 0）；为 false 时保持 0。
     * 前端四个面积项始终输出。 */
    bool hasCave = false;
};

enum RiverWarningCode {
    kRiverWarnNone = 0,
    kRiverWarnSpanGt24 = 1,    /* 「高度范围超过24格」 */
    kRiverWarnYMinGtNeg58 = 2, /* 「最低高度高于-58」 */
    kRiverWarnAreaOver100 = 3, /* 纯河流等效面积超过 49640（>100%） */
};

struct RiverWarning {
    /* 稳定错误码，前端按 code 取文案，不比对引擎返回的中文串。 */
    int code = 0;
    std::string text;
};

struct RiverStatus {
    bool running = false;
    bool done = false;
    bool paused = false;
    int stage = 0;       /* 1 = 粗筛，2 = 精确计算 */
    int64_t current = 0; /* 阶段内进度 */
    int64_t total = 0;
    int seedIndex = 0;
    int seedCount = 0;
    std::string error;
    std::vector<RiverHit> hits;
    /* 显示分母：本配置下（已按挂机Y±24 裁剪）的球壳层均格数。
     * 前端用它算百分比，替代硬编码的 RIVER_FULL_RING = 49659。 */
    int fullArea = 49659;
    /* 引擎 validate() 产生的提示（高度超 24 格等），首轮 search 后填一次。 */
    std::vector<RiverWarning> warnings;
    /* 本次搜索实际使用的河流/溶洞折算系数（默认 4880/7011）。
     * 前端结果卡按"等效溶洞面积 = 溶洞 + 系数 × 河流"统一口径时使用。 */
    double caveConversion = 4880.0 / 7011.0;
    /* 本次搜索是否是纯河流模式：溶洞模式结果卡第一行显示"等效溶洞面积"，
     * 纯河流模式显示"等效河流面积"。 */
    bool pureRiver = false;
};

struct RiverRequest {
    int mc = 0; /* cubiomes MC_* 常量，由前端版本下拉框给出 */
    int threads = 1;

    /* ---- 门槛（三字段，S1/S3）----
     * 等效河流面积 = R + 1.43668 * C。
     * minScore 作为"等效总面积"直传；若 minRiverArea/minCaveArea >= 0 则走三字段。 */
    int minScore = 0;
    int minRiverArea = -1;
    int minCaveArea = -1;
    /* 河流/溶洞折算系数：等效溶洞面积 = caveVolume * caveConversion / layers。
     * <= 0 表示未传，宿主填入默认 4880/7011。 */
    double caveConversion = 0.0;

    /* ---- Y 窗口 ---- 前端已按挂机Y±24 裁剪后再传。 */
    int yMin = -63;
    int yMax = -51;
    int y = -40; /* 挂机 Y（playerY） */

    /* true = 河流模式（不统计溶洞），false = 溶洞模式。 */
    bool pureRiver = false;
    /* 与 pureRiver 互补，保留旧字段名以兼容既有调用方。 */
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

/* 版本枚举：前端"版本"下拉框按高到低倒排渲染。 */
struct RiverVersionEntry {
    const char *label = nullptr; /* "26.3" */
    int mc = 0;                  /* MC_26_3 */
};
std::vector<RiverVersionEntry> riverVersions();

/* 由 mc 常量反查 label；找不到返回空串。 */
std::string riverVersionLabel(int mc);
/* 由 label 反查 mc 常量；找不到返回 -1。 */
int riverVersionMc(const std::string &label);

/* Y 窗口裁剪（挂机Y ±24），纯函数，供前端/调试核对。 */
void riverClampYWindow(int yMin, int yMax, int playerY, int *outMin, int *outMax,
                       int *outLayers);
