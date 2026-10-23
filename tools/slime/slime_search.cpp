/*
 * slime_farm_search.cpp — 单文件集成：SlimeRadar + SlimeOptimizer
 * ============================================================================
 *
 * 用途
 * ----
 * 在给定种子和“玩家挂机点矩形范围”内，找 24 < dist <= 128 的刷怪环中
 * 史莱姆有效面积最大的挂机点，按 64x64 方块去重后从高到低返回。
 *
 * 这是唯一新增的文件。它不修改页面、不修改两个子模块，只把它们的核心
 * 代码直接链接进一个进程内调用：
 *
 *   1) Radar 阶段（SlimeRadar）：
 *        sr_search_cpu(&p, threads, ctx, on_result, nullptr)
 *      在大范围区块坐标里找“17x17 甜甜圈”内史莱姆区块数 >= 阈值的中心。
 *      这里按 tile 切分调用 sr_search_cpu，tile 之间检查暂停/取消，
 *      因此进度和暂停是真实的（不是只暂停输出）。on_progress 传 nullptr，
 *      目的是绕过雷达内部每 100ms 的轮询睡眠；tile 自身已经提供进度粒度。
 *
 *   2) Prepare 阶段（SlimeOptimizer 的数学核心）：
 *        computeRingSpans(inner=24, outer=128)   // 刷怪环按行拆成 x 区间
 *        isSlimeChunk(seed, cx, cz)               // 史莱姆区块判定
 *      把挂机点矩形 + 外半径覆盖到的区块建成 byte/区块 的史莱姆掩码，
 *      再对每一行做 block 级前缀和。这样任意挂机点的面积可以用
 *      “每行两个前缀和相减” O(环行数) 求出，而不是逐块遍历 49640 个环块。
 *
 *   3) Optimize 阶段：
 *       Radar 命中点按 ±playerSearchRange 区块膨胀成“可搜索区块”；
 *       每个 64x64 方块格子作为独立任务，多线程扫描。面积用行前缀和，
 *       只有面积达到当前格子最优/最低要求的点才去数“触及的不同史莱姆区块”。
 *       每个 64x64 格子保留一个最优挂机点，天然完成 64x64 去重。
 *
 *   4) Finalize 阶段：按 area↓, chunks↓, x↑, z↑ 排序。
 *
 * 为什么不在热路径直接循环调用 optimizeCandidate()
 * -------------------------------------------------
 * tools/slime/slimeoptimizer/src/optimizer.cpp 的 optimizeCandidate() 是“单候选点”
 * API：每次调用都会重新建 41x41 区块的 slime map、重新 computeRingSpans、
 * 再为这个候选点开 hardware_concurrency 个线程。实测单次约 80~110ms
 * （playerSearchRange=5, outer=128），几百个热点就是几十秒，而且无法在一个
 * 进程里复用掩码/线程池。本文件仍然使用该子模块的 geometry.hpp /
 * slime_check.hpp 核心（computeRingSpans + isSlimeChunk），只把“逐候选点”
 * 换成“一次建图 + 批量扫描”，这是相同数学、更快调用方式。
 *
 * 如果只想按子模块原 API 串行调用，等价写法是：
 *
 *   SrParams rp{seed, (uint8_t)minChunks, cx0, cz0, cx1, cz1};
 *   sr_search_cpu(&rp, 0, ctx, on_radar_hit, nullptr);
 *   // 再把每个 hit 写成 Candidate，调用：
 *   Params op; op.worldSeed=seed; op.playerSearchRange=5;
 *   op.innerRadius=24; op.outerRadius=128;
 *   auto spans = computeRingSpans(24,128);
 *   Result best = optimizeCandidate(op, Candidate{hx,hz,count}, spans);
 *
 * 但那条路径慢一个数量级，且 optimizeCandidate() 固定搜索候选点 ±pr 区块，
 * 不能直接接受任意 AFK 矩形。本文件是推荐的高性能调用方式。
 *
 * 构建（MSYS2 UCRT64 GCC；只新增本文件，不改 CMake）
 * -------------------------------------------------
 *   export PATH=/c/msys64/ucrt64/bin:$PATH
 *   mkdir -p build/slimefarm
 *   gcc -std=c11 -O3 -march=native -funroll-loops -pthread -Itools/slime/slimeradar/src \
 *       -c tools/slime/slimeradar/src/cpu_search.c -o build/slimefarm/cpu_search.o
 *   gcc -std=c11 -O3 -march=native -funroll-loops -pthread -mavx2 -Itools/slime/slimeradar/src \
 *       -c tools/slime/slimeradar/src/cpu_simd_avx2.c -o build/slimefarm/cpu_simd_avx2.o
 *   g++ -std=c++17 -O3 -march=native -pthread \
 *       -Itools/slime/slimeradar/src -Itools/slime/slimeoptimizer/include \
 *       -DSLIME_FARM_STANDALONE \
 *       tools/slime/slime_search.cpp \
 *       tools/slime/slimeoptimizer/src/geometry.cpp \
 *       tools/slime/slimeoptimizer/src/slime_check.cpp \
 *       tools/slime/slimeoptimizer/src/java_random.cpp \
 *       build/slimefarm/cpu_search.o build/slimefarm/cpu_simd_avx2.o \
 *       -o slime_farm_search.exe
 *
 * 也可以把本文件直接加进 native/CMakeLists.txt（不在此次改动范围内），
 * 并把 sr_search_cpu / cpu_simd_avx2 / geometry / slime_check / java_random
 * 一起链接。头文件不是必需的：下面所有 C 接口都在本 .cpp 内声明。
 *
 * 若 addon.cpp 只想拿声明、不想把实现也编进同一个 TU：
 *   #define SLIME_FARM_DECLARATIONS_ONLY
 *   #include "tools/slime/slime_search.cpp"
 * 然后另外把本文件正常编译成一个 .o 并链接即可（已用此方式验证）。
 *
 * CLI 示例
 * --------
 *   slime_farm_search.exe SEED AFK_X0 AFK_X1 AFK_Z0 AFK_Z1 MIN_CHUNKS MIN_AREA [PLAYER_RANGE]
 *   slime_farm_search.exe 0 -512 512 -512 512 30 3000 5
 *   # MIN_CHUNKS 传 0 或 "-" 且 MIN_AREA∈[9000,15000] 时，按 tools/slime/threshold.json
 *   # 的 default 项自动填区块数（区间按相邻档位中点划分，见 slime_farm_default_chunks_for_area）。
 *   slime_farm_search.exe 0 -512 512 -512 512 - 10000 5
 *
 * 进度 / 暂停 C API
 * -----------------
 *   SlimeFarmParams p; slime_farm_params_init(&p);
 *   p.seed=...; p.afk_x0=...; ...; p.min_slime_chunks=30; p.min_slime_area=3000;
 *   // 或：p.min_slime_chunks=0; p.min_slime_area=10000; // 自动按 threshold default
 *   slime_farm_start(&p);
 *   SlimeFarmProgress pr;
 *   do { slime_farm_poll(&pr); } while (!pr.done);   // 显示 pr.stage / overall
 *   // 任意时刻：slime_farm_pause(); slime_farm_resume(); slime_farm_cancel();
 *   // 完成后：n=slime_farm_result_count(); slime_farm_get_results(buf,n);
 *
 * 注意
 * ----
 * - min_slime_chunks 同时用作 Radar 预筛阈值和最终“触及的不同史莱姆区块数”
 *   下限。若只想预筛，设置 radar_threshold 为较小值、min_slime_chunks 为
 *   最终下限即可。
 * - 64x64 去重：按 floorDiv(blockX,64), floorDiv(blockZ,64) 分格，每格保留
 *   area 最大、chunks 次大的坐标。输出坐标仍是该格内真实最优方块坐标。
 * - 本文件不依赖 CUDA；Radar 的 CPU 模式即可。若要用 CUDA，把 Radar 阶段
 *   的 sr_search_cpu 换成 sr_search_cuda(&p, 0, ...) 即可（其余不变）。
 */

#include <cstdint>

/*
 * 单文件“头 + 实现”模式：
 *   - 正常编译：得到完整实现。
 *   - 在 addon/其它 TU 里先 #define SLIME_FARM_DECLARATIONS_ONLY 再 include
 *     本文件：只得到下面的 C 结构体/函数声明，不会重复定义符号。
 *   - 实现仍由另一个 TU 正常编译本文件并链接。
 */
#ifndef SLIME_FARM_DECLARATIONS_ONLY

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

/* SlimeRadar 的公共 C API 用 C linkage 声明；cpu_search.c 也必须用 gcc 编译。 */
extern "C" {
#include "slimerander.h"
}

/* 雷达常量 / 甜甜圈掩码 / chunk_seed 数学核心（static inline，C++ 可包含）。 */
#include "slime.h"

/* SlimeOptimizer 的核心：刷怪环行区间、floorDiv、史莱姆区块判定。 */
#include "geometry.hpp"
#include "slime_check.hpp"

#endif  /* SLIME_FARM_DECLARATIONS_ONLY */

// ============================================================================
// 公开 C API
// ============================================================================

#define SLIME_FARM_API_VERSION 1

enum {
    SLIME_FARM_OK = 0,
    SLIME_FARM_ERR_PARAM = -1,
    SLIME_FARM_ERR_BUSY = -2,
    SLIME_FARM_ERR_STATE = -3,
    SLIME_FARM_ERR_ALLOC = -4,
    SLIME_FARM_ERR_RADAR = -5,
    SLIME_FARM_ERR_OVERFLOW = -6,
    SLIME_FARM_ERR_INTERNAL = -7
};

/* 阶段编号。正常搜索只有 1..4，5/6/7 是终态。 */
enum {
    SLIME_FARM_STAGE_IDLE = 0,
    SLIME_FARM_STAGE_RADAR = 1,
    SLIME_FARM_STAGE_PREPARE = 2,
    SLIME_FARM_STAGE_OPTIMIZE = 3,
    SLIME_FARM_STAGE_FINALIZE = 4,
    SLIME_FARM_STAGE_DONE = 5,
    SLIME_FARM_STAGE_CANCELLED = 6,
    SLIME_FARM_STAGE_ERROR = 7
};

typedef struct SlimeFarmParams {
    int64_t seed;

    /* 玩家挂机点矩形，方块坐标，闭区间 [x0,x1] x [z0,z1]。 */
    int32_t afk_x0, afk_x1;
    int32_t afk_z0, afk_z1;

    /*
     * 最低史莱姆区块数：
     *   - 默认作为 Radar 的甜甜圈阈值（17x17 内 1<d^2<=64 的区块数）
     *   - 同时作为最终“刷怪环触及的不同史莱姆区块数”下限。
     * 范围 1..192（甜甜圈最多 192 个区块）。
     * 传 0 表示“未指定”：若 min_slime_area ∈ [9000,15000]，则按
     * tools/slime/threshold.json 对应档位的 default 自动填入；否则报错。
     */
    int32_t min_slime_chunks;

    /* 最低有效史莱姆面积（环内落在史莱姆区块里的方块数），>=0。 */
    int64_t min_slime_area;

    /* 刷怪环：inner < dist <= outer，默认 24 / 128。 */
    int32_t inner_radius;
    int32_t outer_radius;

    /* Radar 命中点周围搜索挂机点的区块半径，默认 5（即 ±5 chunk）。 */
    int32_t player_search_range;

    /* 可选：显式 Radar 阈值；-1 表示使用 min_slime_chunks。 */
    int32_t radar_threshold;

    /* 可选：Radar tile 边长（区块）。0=按阈值自动估计；范围 256..16384。 */
    int32_t radar_tile_chunks;

    /* 0=自动（hardware_concurrency）；否则 1..256。 */
    int32_t threads;

    /* 0=返回全部；>0 只保留排序后的前 N 个。 */
    int32_t max_results;

    /* 保留，必须为 0。 */
    int32_t flags;
} SlimeFarmParams;

typedef struct SlimeFarmHit {
    int64_t x;       /* 挂机点方块 X */
    int64_t z;       /* 挂机点方块 Z */
    int64_t area;    /* 有效史莱姆面积（环内史莱姆方块数） */
    int32_t chunks;  /* 刷怪环触及的不同史莱姆区块数 */
    int32_t cell_x;  /* floorDiv(x,64)，用于 64x64 去重 */
    int32_t cell_z;  /* floorDiv(z,64) */
} SlimeFarmHit;

typedef struct SlimeFarmProgress {
    int32_t stage;             /* SLIME_FARM_STAGE_* */
    int32_t stage_count;       /* 正常阶段数 = 4 */
    int32_t stage_index;       /* 1..4；终态时为最后阶段 */
    int32_t paused;            /* 1=已请求暂停且尚未结束 */
    int32_t done;              /* 1=线程已结束（成功/取消/错误） */
    int32_t cancelled;         /* 1=已取消 */
    int32_t error;             /* 1=出错，见 message */
    int32_t overall_permille;  /* 0..1000，粗略总进度 */

    uint64_t stage_current;
    uint64_t stage_total;
    uint64_t stage_elapsed_ms;
    uint64_t elapsed_ms;
    uint64_t eta_ms;           /* UINT64_MAX=未知 */

    uint64_t radar_hits;       /* Radar 命中中心数 */
    uint64_t eligible_chunks;  /* 被热点覆盖、需要扫描的区块数 */
    uint64_t cells_done;       /* 已完成的 64x64 格子数 */
    uint64_t cells_total;      /* 总 64x64 格子数 */
    uint64_t results;          /* 当前已保留结果数（完成后为最终数） */

    char stage_name[24];
    char message[96];
} SlimeFarmProgress;

extern "C" {

/* 填默认值：seed=0, AFK=[0,0]x[0,0], chunks=0(未指定), 24/128, pr=5, radar_threshold=-1。 */
void slime_farm_params_init(SlimeFarmParams* p);

/*
 * 仅当 area ∈ [9000,15000] 时，按相邻档位中点规则映射到
 * 9000/9250/.../15000，并返回该档 threshold.default；否则返回 -1。
 * 与 tools/slime/threshold.json 保持一致（内嵌表，无需运行时读文件）。
 */
int32_t slime_farm_default_chunks_for_area(int64_t area);

/* 启动一次搜索。返回 SLIME_FARM_OK 或负错误码。 */
int slime_farm_start(const SlimeFarmParams* p);

/* 请求暂停/恢复/取消；均非阻塞。 */
int slime_farm_pause(void);
int slime_farm_resume(void);
int slime_farm_cancel(void);

/* 轮询进度。非阻塞；out 不能为空。返回 SLIME_FARM_OK。 */
int slime_farm_poll(SlimeFarmProgress* out);

/* 等待结束。timeout_ms=0 表示无限等待。0=完成，1=超时，<0=错误。 */
int slime_farm_wait(uint32_t timeout_ms);

/* 结果数量；结果已按 area↓, chunks↓ 排序。 */
int32_t slime_farm_result_count(void);

/*
 * 复制结果。capacity 为 out 能容纳的条数；返回总结果数（可能 > capacity）。
 * out 可为空（capacity=0）用于查询数量。
 */
int32_t slime_farm_get_results(SlimeFarmHit* out, int32_t capacity);

/* 取消并 join 工作线程，释放全局状态。可重复调用。 */
void slime_farm_shutdown(void);

}  // extern "C"

#ifndef SLIME_FARM_DECLARATIONS_ONLY

// ============================================================================
// 内部常量与状态
// ============================================================================

namespace {

constexpr int kDefaultInner = 24;
constexpr int kDefaultOuter = 128;
constexpr int kDefaultPlayerRange = 5;

constexpr int kDedupCell = 64;              /* 64x64 方块去重 */
constexpr int kChunksPerCell = kDedupCell / 16;  /* 64/16 = 4 */

/* 与 tools/slimeradar/src/cpu_search.c 的 SR_MAX_RESULTS 保持一致。 */
constexpr uint64_t kRadarCapacity = 1u << 20;

constexpr int kMinRadarTile = 256;
constexpr int kMaxRadarTile = 16384;
constexpr int kAutoMaxRadarTile = 8192;
constexpr int kAutoMinRadarTile = 1024;

/* 内存安全上限（可按机器调整）。 */
constexpr int64_t kMaxSlimeMaskCells = 64ll * 1024 * 1024;   /* 64M chunks */
constexpr int64_t kMaxPrefCells = 120ll * 1024 * 1024;       /* ~240MB uint16 */
constexpr int64_t kMaxHotCells = 64ll * 1024 * 1024;         /* 64M chunk grid */
constexpr int64_t kMaxDedupCells = 8ll * 1024 * 1024;        /* 8M 64x64 cells */

struct SearchState {
    SlimeFarmParams p{};

    std::atomic<int> stage{SLIME_FARM_STAGE_IDLE};
    std::atomic<uint64_t> stage_current{0};
    std::atomic<uint64_t> stage_total{0};
    std::atomic<uint64_t> stage_start_offset_ms{0};

    std::atomic<uint64_t> radar_hits{0};
    std::atomic<uint64_t> eligible_chunks{0};
    std::atomic<uint64_t> cells_done{0};
    std::atomic<uint64_t> cells_total{0};
    std::atomic<uint64_t> result_count{0};

    std::atomic<bool> done{true};
    std::atomic<bool> cancelled{false};
    std::atomic<bool> pause_requested{false};
    std::atomic<bool> failed{false};

    /* 每次 start 递增；done_generation 标记“哪一次搜索已经完成”。
     * wait() 用它避免把后一次搜索误当成前一次。 */
    std::atomic<uint64_t> generation{0};
    std::atomic<uint64_t> done_generation{0};

    std::atomic<int64_t> start_time_ms{0};

    std::mutex mutex;                 /* 保护 hits / message */
    std::condition_variable cv;       /* done 与暂停唤醒 */
    std::thread worker;

    std::vector<SlimeFarmHit> hits;
    std::string message;
};

SearchState g_s;
std::mutex g_api_mutex;   /* 串行化 start/wait/shutdown */

inline int64_t steady_now_ms() {
    using namespace std::chrono;
    return static_cast<int64_t>(
        duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
            .count());
}

inline uint64_t elapsed_ms() {
    const int64_t start =
        g_s.start_time_ms.load(std::memory_order_relaxed);
    if (start == 0) return 0;
    const int64_t now = steady_now_ms();
    return (now > start) ? static_cast<uint64_t>(now - start) : 0;
}

int resolve_threads(const SlimeFarmParams& p) {
    int n = p.threads;
    if (n <= 0) {
        unsigned hw = std::thread::hardware_concurrency();
        n = (hw == 0) ? 1 : static_cast<int>(hw);
    }
    if (n < 1) n = 1;
    if (n > 256) n = 256;
    return n;
}

/*
 * 暂停/取消检查点。返回 false 表示已取消。
 * 暂停时阻塞在条件变量上；恢复或取消时唤醒。
 */
bool checkpoint() {
    if (g_s.cancelled.load(std::memory_order_relaxed)) return false;
    if (!g_s.pause_requested.load(std::memory_order_relaxed)) return true;

    std::unique_lock<std::mutex> lock(g_s.mutex);
    g_s.cv.wait(lock, [] {
        return !g_s.pause_requested.load(std::memory_order_relaxed) ||
               g_s.cancelled.load(std::memory_order_relaxed);
    });
    return !g_s.cancelled.load(std::memory_order_relaxed);
}

void set_stage(int stage, uint64_t total) {
    g_s.stage.store(stage, std::memory_order_relaxed);
    g_s.stage_current.store(0, std::memory_order_relaxed);
    g_s.stage_total.store(total, std::memory_order_relaxed);
    g_s.stage_start_offset_ms.store(elapsed_ms(), std::memory_order_relaxed);
}

void set_failure(const char* msg) {
    {
        std::lock_guard<std::mutex> lock(g_s.mutex);
        g_s.message = msg ? msg : "internal error";
    }
    g_s.failed.store(true, std::memory_order_relaxed);
}

const char* stage_name(int stage) {
    switch (stage) {
        case SLIME_FARM_STAGE_RADAR: return "radar";
        case SLIME_FARM_STAGE_PREPARE: return "prepare";
        case SLIME_FARM_STAGE_OPTIMIZE: return "optimize";
        case SLIME_FARM_STAGE_FINALIZE: return "finalize";
        case SLIME_FARM_STAGE_DONE: return "done";
        case SLIME_FARM_STAGE_CANCELLED: return "cancelled";
        case SLIME_FARM_STAGE_ERROR: return "error";
        default: return "idle";
    }
}

int stage_index(int stage) {
    switch (stage) {
        case SLIME_FARM_STAGE_RADAR: return 1;
        case SLIME_FARM_STAGE_PREPARE: return 2;
        case SLIME_FARM_STAGE_OPTIMIZE: return 3;
        case SLIME_FARM_STAGE_FINALIZE: return 4;
        case SLIME_FARM_STAGE_DONE: return 4;
        case SLIME_FARM_STAGE_CANCELLED: return 4;
        case SLIME_FARM_STAGE_ERROR: return 4;
        default: return 0;
    }
}

/* 与 tools/slime/threshold.json 同步：档位键 9000..15000 step 250 → default 区块数。 */
constexpr int32_t kAreaThresholdFirst = 9000;
constexpr int32_t kAreaThresholdLast = 15000;
constexpr int32_t kAreaThresholdStep = 250;
constexpr int32_t kAreaThresholdCount =
    (kAreaThresholdLast - kAreaThresholdFirst) / kAreaThresholdStep + 1;

constexpr int32_t kAreaThresholdDefaults[kAreaThresholdCount] = {
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64,
};

int area_threshold_index(int64_t area) {
    if (area < kAreaThresholdFirst || area > kAreaThresholdLast) return -1;
    /* 9000..9125 → 0；9126..9375 → 1；…；14876..15000 → 最后一档。 */
    if (area <= kAreaThresholdFirst + kAreaThresholdStep / 2) return 0;
    const int64_t idx =
        ((area - (kAreaThresholdFirst + kAreaThresholdStep / 2 + 1)) /
         kAreaThresholdStep) +
        1;
    if (idx < 0) return 0;
    if (idx >= kAreaThresholdCount) return kAreaThresholdCount - 1;
    return static_cast<int>(idx);
}

void resolve_auto_chunks(SlimeFarmParams& p) {
    if (p.min_slime_chunks != 0) return;
    const int idx = area_threshold_index(p.min_slime_area);
    if (idx < 0) return;
    p.min_slime_chunks = kAreaThresholdDefaults[idx];
}

int validate_params(const SlimeFarmParams& p) {
    if (p.afk_x1 < p.afk_x0 || p.afk_z1 < p.afk_z0) return SLIME_FARM_ERR_PARAM;
    if (p.inner_radius < 0 || p.outer_radius <= p.inner_radius) return SLIME_FARM_ERR_PARAM;
    if (p.outer_radius > 4096) return SLIME_FARM_ERR_PARAM;
    if (p.player_search_range < 0 || p.player_search_range > 512) return SLIME_FARM_ERR_PARAM;
    if (p.min_slime_chunks < 1 || p.min_slime_chunks > 192) return SLIME_FARM_ERR_PARAM;
    if (p.min_slime_area < 0) return SLIME_FARM_ERR_PARAM;
    if (p.radar_threshold < -1 || p.radar_threshold > 192) {
        return SLIME_FARM_ERR_PARAM;
    }
    if (p.radar_tile_chunks != 0 &&
        (p.radar_tile_chunks < kMinRadarTile || p.radar_tile_chunks > kMaxRadarTile)) {
        return SLIME_FARM_ERR_PARAM;
    }
    if (p.threads < 0 || p.threads > 256) return SLIME_FARM_ERR_PARAM;
    if (p.max_results < 0) return SLIME_FARM_ERR_PARAM;
    if (p.flags != 0) return SLIME_FARM_ERR_PARAM;

    /* 坐标范围必须能安全落到 int32 区块坐标。 */
    const int64_t m = p.outer_radius;
    const int64_t ax0 = p.afk_x0, ax1 = p.afk_x1;
    const int64_t az0 = p.afk_z0, az1 = p.afk_z1;
    const int64_t cx0 = floorDiv(ax0 - m, 16);
    const int64_t cx1 = floorDiv(ax1 + m, 16);
    const int64_t cz0 = floorDiv(az0 - m, 16);
    const int64_t cz1 = floorDiv(az1 + m, 16);
    if (cx0 < INT32_MIN || cx1 > INT32_MAX || cz0 < INT32_MIN || cz1 > INT32_MAX) {
        return SLIME_FARM_ERR_PARAM;
    }

    /* 行前缀宽度必须能放进 uint16（也是面积上限的必要条件）。 */
    const int64_t width = ax1 - ax0 + 1;
    const int64_t height = az1 - az0 + 1;
    if (width <= 0 || height <= 0) return SLIME_FARM_ERR_PARAM;
    const int64_t pref_w = width + 2 * m + 1;
    if (pref_w > 65535) return SLIME_FARM_ERR_PARAM;
    /* 最小 band = 一个 64 行格带 + 两侧各 M 行 halo。 */
    if ((64 + 2 * m) * pref_w > kMaxPrefCells) return SLIME_FARM_ERR_PARAM;

    /* Radar 区域是 AFK 区块范围 ± pr，再各自 +1 成半开区间。 */
    const int64_t acx0 = floorDiv(ax0, 16);
    const int64_t acx1 = floorDiv(ax1, 16);
    const int64_t acz0 = floorDiv(az0, 16);
    const int64_t acz1 = floorDiv(az1, 16);
    const int64_t pr = p.player_search_range;
    const int64_t gx0 = acx0 - pr, gx1 = acx1 + pr;
    const int64_t gz0 = acz0 - pr, gz1 = acz1 + pr;
    const int64_t gw = gx1 - gx0 + 1;
    const int64_t gh = gz1 - gz0 + 1;
    if (gw <= 0 || gh <= 0) return SLIME_FARM_ERR_PARAM;
    if (gw > kMaxHotCells / gh) return SLIME_FARM_ERR_PARAM;
    if (gx0 - 1 < INT32_MIN || gx1 + 1 > INT32_MAX ||
        gz0 - 1 < INT32_MIN || gz1 + 1 > INT32_MAX) {
        return SLIME_FARM_ERR_PARAM;
    }
    return SLIME_FARM_OK;
}

/*
 * 用二项分布尾概率估计 Radar tile 边长，使一个 tile 的命中数大概率 <
 * 1M（Radar 内部结果缓冲上限）。只是性能/溢出保护，不影响结果正确性；
 * 真正溢出时 run_radar 会减半 tile 重跑。
 */
double binomial_tail(int n, double p, int k) {
    if (k <= 0) return 1.0;
    if (k > n) return 0.0;
    const double lp = std::log(p);
    const double lq = std::log1p(-p);
    double sum = 0.0;
    for (int i = k; i <= n; ++i) {
        const double logc = std::lgamma(static_cast<double>(n + 1)) -
                            std::lgamma(static_cast<double>(i + 1)) -
                            std::lgamma(static_cast<double>(n - i + 1));
        sum += std::exp(logc + i * lp + (n - i) * lq);
    }
    return std::min(1.0, sum);
}

int estimate_radar_tile(int threshold) {
    /* 17x17 甜甜圈 = 192 个区块；史莱姆概率 = 1/10。 */
    const double tail = binomial_tail(192, 0.1, threshold);
    if (!(tail > 0.0)) return kAutoMaxRadarTile;
    double side = std::sqrt(400000.0 / tail);
    int s = static_cast<int>(side);
    if (s < kAutoMinRadarTile) s = kAutoMinRadarTile;
    if (s > kAutoMaxRadarTile) s = kAutoMaxRadarTile;
    return s;
}

/* ------------------------------------------------------------------------- */
/* Radar 阶段                                                                */
/* ------------------------------------------------------------------------- */

struct RadarCtx {
    uint8_t* grid = nullptr;   /* [gz0,gz1] x [gx0,gx1] 的 chunk 位图 */
    int64_t gw = 0, gh = 0;
    int64_t gx0 = 0, gz0 = 0;
    uint64_t hits = 0;         /* 本 tile 回调次数 */
};

extern "C" void radar_result_cb(void* vp, SrResult r) {
    RadarCtx* c = static_cast<RadarCtx*>(vp);
    ++c->hits;
    const int64_t ix = static_cast<int64_t>(r.x) - c->gx0;
    const int64_t iz = static_cast<int64_t>(r.z) - c->gz0;
    if (ix >= 0 && ix < c->gw && iz >= 0 && iz < c->gh) {
        c->grid[static_cast<size_t>(iz) * static_cast<size_t>(c->gw) +
                static_cast<size_t>(ix)] = 1;
    }
}

/*
 * 跑一遍完整 Radar。返回 true=成功，false=取消或需要重试（overflow=true）。
 * hot_grid 由调用方分配并清零；本函数只在成功时保留内容。
 */
bool run_radar_attempt(const SlimeFarmParams& p, int tile_side, int threads,
                       std::vector<uint8_t>& hot_grid, int64_t gw, int64_t gh,
                       int64_t gx0, int64_t gz0,
                       int64_t radar_x0, int64_t radar_z0,
                       int64_t radar_x1, int64_t radar_z1,
                       bool& overflow) {
    overflow = false;
    uint64_t done_chunks = 0;
    uint64_t total_hits = 0;

    for (int64_t z0 = radar_z0; z0 < radar_z1; z0 += tile_side) {
        const int64_t z1 = std::min(radar_z1, z0 + tile_side);
        for (int64_t x0 = radar_x0; x0 < radar_x1; x0 += tile_side) {
            if (!checkpoint()) return false;
            const int64_t x1 = std::min(radar_x1, x0 + tile_side);

            SrParams rp{};
            rp.world_seed = p.seed;
            rp.threshold = static_cast<uint8_t>(
                p.radar_threshold >= 0 ? p.radar_threshold : p.min_slime_chunks);
            rp.x0 = static_cast<int32_t>(x0);
            rp.z0 = static_cast<int32_t>(z0);
            rp.x1 = static_cast<int32_t>(x1);
            rp.z1 = static_cast<int32_t>(z1);

            RadarCtx ctx;
            ctx.grid = hot_grid.data();
            ctx.gw = gw;
            ctx.gh = gh;
            ctx.gx0 = gx0;
            ctx.gz0 = gz0;

            const int rc = sr_search_cpu(&rp, static_cast<unsigned>(threads),
                                         &ctx, radar_result_cb, nullptr);
            if (rc != SR_OK) {
                throw std::runtime_error("sr_search_cpu failed");
            }

            total_hits += ctx.hits;
            done_chunks += static_cast<uint64_t>(x1 - x0) *
                           static_cast<uint64_t>(z1 - z0);
            g_s.stage_current.store(done_chunks, std::memory_order_relaxed);
            g_s.radar_hits.store(total_hits, std::memory_order_relaxed);

            if (ctx.hits >= kRadarCapacity) {
                /* 该 tile 的结果被 Radar 的 1M 缓冲截断；必须拆小重跑。 */
                overflow = true;
                return true;
            }
        }
    }
    return true;
}

bool run_radar(const SlimeFarmParams& p, int threads,
               std::vector<uint8_t>& hot_grid, int64_t gw, int64_t gh,
               int64_t gx0, int64_t gz0,
               int64_t radar_x0, int64_t radar_z0,
               int64_t radar_x1, int64_t radar_z1) {
    const uint64_t total = static_cast<uint64_t>(radar_x1 - radar_x0) *
                           static_cast<uint64_t>(radar_z1 - radar_z0);
    set_stage(SLIME_FARM_STAGE_RADAR, total);

    int tile_side = p.radar_tile_chunks;
    if (tile_side <= 0) tile_side = estimate_radar_tile(
        p.radar_threshold >= 0 ? p.radar_threshold : p.min_slime_chunks);

    for (int attempt = 0; attempt < 10; ++attempt) {
        std::fill(hot_grid.begin(), hot_grid.end(), 0);
        g_s.radar_hits.store(0, std::memory_order_relaxed);
        g_s.stage_current.store(0, std::memory_order_relaxed);

        bool overflow = false;
        const bool ok = run_radar_attempt(
            p, tile_side, threads, hot_grid, gw, gh, gx0, gz0,
            radar_x0, radar_z0, radar_x1, radar_z1, overflow);
        if (!ok) return false;  /* cancelled */
        if (!overflow) return true;

        /* Radar 结果缓冲不够；tile 减半重跑。256² 的 tile 最多 65k 命中，
         * 必定小于 1M，所以循环一定会在 10 次内收敛。 */
        tile_side = std::max(kMinRadarTile, tile_side / 2);
        if (tile_side == kMinRadarTile) {
            /* 理论上不会到这里；保守报错。 */
            throw std::runtime_error("radar result overflow");
        }
    }
    throw std::runtime_error("radar result overflow");
}

/* ------------------------------------------------------------------------- */
/* Prepare 阶段：slime mask + block 级行前缀和 + 热点膨胀/资格区块          */
/* ------------------------------------------------------------------------- */

/*
 * 对 rows 个独立任务并行执行 fn(row)。fn 内部自己写互不重叠的数据。
 * 返回 false 表示取消/线程异常。
 */
template <typename Fn>
bool parallel_rows(int64_t rows, int threads, Fn&& fn) {
    if (rows <= 0) return true;
    int n = threads;
    if (n > rows) n = static_cast<int>(rows);
    if (n < 1) n = 1;

    std::atomic<int64_t> next{0};
    std::atomic<bool> stop{false};
    std::atomic<bool> failed{false};

    auto work = [&]() {
        try {
            for (;;) {
                const int64_t r = next.fetch_add(1, std::memory_order_relaxed);
                if (r >= rows || stop.load(std::memory_order_relaxed)) break;
                if (!checkpoint()) {
                    stop.store(true, std::memory_order_relaxed);
                    break;
                }
                fn(r);
                g_s.stage_current.fetch_add(1, std::memory_order_relaxed);
            }
        } catch (...) {
            failed.store(true, std::memory_order_relaxed);
            stop.store(true, std::memory_order_relaxed);
        }
    };

    std::vector<std::thread> pool;
    pool.reserve(static_cast<size_t>(n - 1));
    for (int t = 0; t < n - 1; ++t) pool.emplace_back(work);
    work();
    for (auto& th : pool) th.join();

    if (failed.load() && !g_s.cancelled.load()) {
        set_failure("parallel worker failed");
    }
    return !failed.load() && !g_s.cancelled.load();
}

struct SearchGeom {
    /* AFK 矩形 */
    int64_t ax0 = 0, ax1 = 0, az0 = 0, az1 = 0;
    int64_t m = 0;  /* outer radius */

    /* slime mask 覆盖的 chunk 矩形（含外半径余量） */
    int64_t min_cx = 0, min_cz = 0;
    int64_t cw = 0, ch = 0;

    /* block 级行前缀（按 band 构建，见 run_search） */
    int64_t x_base = 0, z_base = 0;
    int64_t pref_w = 0;

    /* AFK 区块范围 */
    int64_t acx0 = 0, acx1 = 0, acz0 = 0, acz1 = 0;

    /* 热点 chunk 位图范围（AFK 区块范围 ± pr） */
    int64_t gx0 = 0, gz0 = 0, gw = 0, gh = 0;

    /* 64x64 去重格子范围 */
    int64_t cell_x0 = 0, cell_z0 = 0, cell_w = 0, cell_h = 0;
};

/* ------------------------------------------------------------------------- */
/* Optimize 阶段                                                             */
/* ------------------------------------------------------------------------- */

struct SpanTerm {
    int32_t lo = 0;
    int32_t hi1 = 0;      /* hiDx + 1 */
};

struct PairTerm {
    int32_t dz = 0;
    int32_t n = 0;
    SpanTerm pos[2];
    SpanTerm neg[2];      /* dz>0 时与 pos 相同（环对 dz 对称） */
};

struct CellBest {
    int64_t area = -1;
    int32_t chunks = -1;
    int64_t x = 0, z = 0;
};

/*
 * 扫描一个 64x64 格子。
 * stamp 是线程私有的“已访问区块”时间戳数组，避免每次清零。
 */
void scan_cell(int64_t cell_index, const SearchGeom& g,
               const SlimeFarmParams& p,
               const std::vector<uint8_t>& slime,
               const uint16_t* pref, int64_t pref_z_base,
               const std::vector<uint8_t>& eligible,
               const std::vector<RingSpan>& spans,
               const std::vector<PairTerm>& pairs,
               int stamp_dim, int stamp_k,
               std::vector<int32_t>& stamp,
               CellBest& best) {
    const int64_t cell_x = g.cell_x0 + cell_index % g.cell_w;
    const int64_t cell_z = g.cell_z0 + cell_index / g.cell_w;

    const int64_t ecw = g.acx1 - g.acx0 + 1;
    const int64_t ccx0 = std::max(g.acx0, cell_x * kChunksPerCell);
    const int64_t ccx1 = std::min(g.acx1, cell_x * kChunksPerCell + kChunksPerCell - 1);
    const int64_t ccz0 = std::max(g.acz0, cell_z * kChunksPerCell);
    const int64_t ccz1 = std::min(g.acz1, cell_z * kChunksPerCell + kChunksPerCell - 1);

    int32_t visit = 0;
    uint32_t area_row[kDedupCell];   /* 一格最多 64 个方块宽 */

    for (int64_t cz = ccz0; cz <= ccz1; ++cz) {
        /* 把该 chunk 行内连续的 eligible 区块合成 run，避免逐块重复扫描
         * 同一批 dz 前缀行。通常一个 64x64 格只有 1~4 个 run。 */
        struct Run {
            int64_t bx0 = 0;
            int64_t bx1 = 0;
        };
        Run runs[kChunksPerCell];
        int nruns = 0;

        for (int64_t cx = ccx0; cx <= ccx1;) {
            const size_t base_idx =
                static_cast<size_t>(cz - g.acz0) * ecw +
                static_cast<size_t>(cx - g.acx0);
            if (!eligible[base_idx]) {
                ++cx;
                continue;
            }
            const int64_t run_cx0 = cx;
            while (cx + 1 <= ccx1 &&
                   eligible[static_cast<size_t>(cz - g.acz0) * ecw +
                            static_cast<size_t>(cx + 1 - g.acx0)]) {
                ++cx;
            }
            const int64_t run_cx1 = cx;
            runs[nruns].bx0 = std::max(g.ax0, run_cx0 * 16);
            runs[nruns].bx1 = std::min(g.ax1, run_cx1 * 16 + 15);
            ++nruns;
            ++cx;
        }
        if (nruns == 0) continue;

        const int64_t bz0 = std::max(g.az0, cz * 16);
        const int64_t bz1 = std::min(g.az1, cz * 16 + 15);

        for (int64_t pz = bz0; pz <= bz1; ++pz) {
            if (!checkpoint()) return;

            for (int r = 0; r < nruns; ++r) {
                const int width =
                    static_cast<int>(runs[r].bx1 - runs[r].bx0 + 1);
                const int64_t off0 = runs[r].bx0 - g.x_base;

                for (int i = 0; i < width; ++i) area_row[i] = 0;

                /* 环按 ±dz 成对累加。内层沿连续 x 扫描，前缀行是顺序读取，
                 * 比“每个挂机点跳 153 行”的旧顺序缓存友好得多。 */
                for (const PairTerm& pt : pairs) {
                    const uint16_t* rp =
                        pref + static_cast<size_t>(pz + pt.dz - pref_z_base) *
                                   static_cast<size_t>(g.pref_w);
                    const uint16_t* rn =
                        pref + static_cast<size_t>(pz - pt.dz - pref_z_base) *
                                   static_cast<size_t>(g.pref_w);

                    for (int k = 0; k < pt.n; ++k) {
                        const int32_t lo = pt.pos[k].lo;
                        const int32_t hi1 = pt.pos[k].hi1;
                        for (int i = 0; i < width; ++i) {
                            area_row[i] += static_cast<uint32_t>(
                                rp[off0 + i + hi1] - rp[off0 + i + lo]);
                        }
                        if (pt.dz != 0) {
                            const int32_t nlo = pt.neg[k].lo;
                            const int32_t nhi1 = pt.neg[k].hi1;
                            for (int i = 0; i < width; ++i) {
                                area_row[i] += static_cast<uint32_t>(
                                    rn[off0 + i + nhi1] -
                                    rn[off0 + i + nlo]);
                            }
                        }
                    }
                }

                for (int i = 0; i < width; ++i) {
                    const int64_t px = runs[r].bx0 + i;
                    const uint32_t area = area_row[i];

                    if (static_cast<int64_t>(area) < p.min_slime_area) continue;
                    if (static_cast<int64_t>(area) < best.area) continue;

                    /* 只有可能赢的点才数“触及的不同史莱姆区块”。 */
                    if (++visit == INT32_MAX) {
                        std::fill(stamp.begin(), stamp.end(), -1);
                        visit = 1;
                    }
                    int chunks = 0;
                    const int64_t base_cx = floorDiv(px, 16);
                    const int64_t base_cz = floorDiv(pz, 16);

                    for (const RingSpan& sp : spans) {
                        const int64_t cz2 = floorDiv(pz + sp.dz, 16);
                        const int64_t cx0 = floorDiv(px + sp.loDx, 16);
                        const int64_t cx1 = floorDiv(px + sp.hiDx, 16);
                        const uint8_t* srow =
                            slime.data() +
                            static_cast<size_t>(cz2 - g.min_cz) *
                                static_cast<size_t>(g.cw);

                        for (int64_t cx2 = cx0; cx2 <= cx1; ++cx2) {
                            if (!srow[cx2 - g.min_cx]) continue;
                            const int si =
                                static_cast<int>((cx2 - base_cx) + stamp_k) *
                                    stamp_dim +
                                static_cast<int>((cz2 - base_cz) + stamp_k);
                            if (stamp[si] != visit) {
                                stamp[si] = visit;
                                ++chunks;
                            }
                        }
                    }

                    if (chunks < p.min_slime_chunks) continue;
                    if (static_cast<int64_t>(area) > best.area ||
                        (static_cast<int64_t>(area) == best.area &&
                         chunks > best.chunks)) {
                        best.area = static_cast<int64_t>(area);
                        best.chunks = chunks;
                        best.x = px;
                        best.z = pz;
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------------- */
/* 主搜索流程                                                                */
/* ------------------------------------------------------------------------- */

bool run_search() {
    const SlimeFarmParams p = g_s.p;

    SearchGeom g;
    g.ax0 = p.afk_x0;
    g.ax1 = p.afk_x1;
    g.az0 = p.afk_z0;
    g.az1 = p.afk_z1;
    g.m = p.outer_radius;

    g.acx0 = floorDiv(g.ax0, 16);
    g.acx1 = floorDiv(g.ax1, 16);
    g.acz0 = floorDiv(g.az0, 16);
    g.acz1 = floorDiv(g.az1, 16);

    const int64_t pr = p.player_search_range;
    g.gx0 = g.acx0 - pr;
    g.gz0 = g.acz0 - pr;
    g.gw = (g.acx1 + pr) - g.gx0 + 1;
    g.gh = (g.acz1 + pr) - g.gz0 + 1;

    const int threads = resolve_threads(p);

    /* ---- Stage 1: Radar ---- */
    std::vector<uint8_t> hot_grid(
        static_cast<size_t>(g.gw) * static_cast<size_t>(g.gh), 0);

    const int64_t radar_x0 = g.gx0;
    const int64_t radar_z0 = g.gz0;
    const int64_t radar_x1 = g.gx0 + g.gw;  /* 半开 */
    const int64_t radar_z1 = g.gz0 + g.gh;

    if (!run_radar(p, threads, hot_grid, g.gw, g.gh, g.gx0, g.gz0,
                   radar_x0, radar_z0, radar_x1, radar_z1)) {
        return false;
    }

    if (g_s.radar_hits.load() == 0) {
        /* 没有热点，直接完成（仍然给 finalize 一个完整阶段）。 */
        set_stage(SLIME_FARM_STAGE_FINALIZE, 1);
        {
            std::lock_guard<std::mutex> lock(g_s.mutex);
            g_s.hits.clear();
        }
        g_s.result_count.store(0, std::memory_order_relaxed);
        g_s.stage_current.store(1, std::memory_order_relaxed);
        return true;
    }

    /* ---- Stage 2: Prepare ---- */
    g.min_cx = floorDiv(g.ax0 - g.m, 16);
    g.min_cz = floorDiv(g.az0 - g.m, 16);
    g.cw = floorDiv(g.ax1 + g.m, 16) - g.min_cx + 1;
    g.ch = floorDiv(g.az1 + g.m, 16) - g.min_cz + 1;

    if (g.cw * g.ch > kMaxSlimeMaskCells) {
        throw std::runtime_error("slime mask too large");
    }

    std::vector<uint8_t> slime(
        static_cast<size_t>(g.cw) * static_cast<size_t>(g.ch), 0);

    g.x_base = g.ax0 - g.m;
    g.z_base = g.az0 - g.m;
    g.pref_w = (g.ax1 - g.ax0 + 1) + 2 * g.m + 1;

    if (g.pref_w > 65535 ||
        (64 + 2 * g.m) * g.pref_w > kMaxPrefCells) {
        throw std::runtime_error("row prefix too large");
    }

    const int64_t ecw = g.acx1 - g.acx0 + 1;
    const int64_t ech = g.acz1 - g.acz0 + 1;
    if (ecw <= 0 || ech <= 0 || ecw > kMaxHotCells / ech) {
        throw std::runtime_error("AFK chunk box too large");
    }
    std::vector<uint8_t> eligible(
        static_cast<size_t>(ecw) * static_cast<size_t>(ech), 0);

    const uint64_t prepare_total = static_cast<uint64_t>(g.ch) +
                                   static_cast<uint64_t>(ech);
    set_stage(SLIME_FARM_STAGE_PREPARE, prepare_total);

    /* 2.1 slime mask：1 byte / chunk，1=史莱姆区块。 */
    if (!parallel_rows(g.ch, threads, [&](int64_t zr) {
            const int32_t cz = static_cast<int32_t>(g.min_cz + zr);
            uint8_t* row = slime.data() + static_cast<size_t>(zr) *
                                               static_cast<size_t>(g.cw);
            for (int64_t xr = 0; xr < g.cw; ++xr) {
                const int32_t cx = static_cast<int32_t>(g.min_cx + xr);
                row[xr] = isSlimeChunk(p.seed, cx, cz) ? 1u : 0u;
            }
        })) {
        return false;
    }

    /* 2.2 热点膨胀：hot_grid 的 2D 前缀和 -> 每个 AFK 区块是否在某个
     *     radar hit 的 ±pr 范围内。 */
    std::vector<uint32_t> hot_prefix(
        static_cast<size_t>(g.gw + 1) * static_cast<size_t>(g.gh + 1), 0);
    const int64_t hp_stride = g.gw + 1;
    for (int64_t z = 0; z < g.gh; ++z) {
        if ((z & 63) == 0 && !checkpoint()) return false;
        uint32_t row_sum = 0;
        const uint8_t* hot_row = hot_grid.data() +
                                 static_cast<size_t>(z) *
                                     static_cast<size_t>(g.gw);
        for (int64_t x = 0; x < g.gw; ++x) {
            row_sum += hot_row[x];
            hot_prefix[static_cast<size_t>(z + 1) * hp_stride +
                       static_cast<size_t>(x + 1)] =
                hot_prefix[static_cast<size_t>(z) * hp_stride +
                           static_cast<size_t>(x + 1)] +
                row_sum;
        }
    }

    std::atomic<uint64_t> eligible_count{0};
    if (!parallel_rows(ech, threads, [&](int64_t zr) {
            const int64_t cz = g.acz0 + zr;
            const int64_t z0 = cz - pr - g.gz0;
            const int64_t z1 = cz + pr + 1 - g.gz0;
            uint64_t local = 0;

            for (int64_t cx = g.acx0; cx <= g.acx1; ++cx) {
                const int64_t x0 = cx - pr - g.gx0;
                const int64_t x1 = cx + pr + 1 - g.gx0;
                const uint32_t sum =
                    hot_prefix[static_cast<size_t>(z1) * hp_stride +
                               static_cast<size_t>(x1)] -
                    hot_prefix[static_cast<size_t>(z0) * hp_stride +
                               static_cast<size_t>(x1)] -
                    hot_prefix[static_cast<size_t>(z1) * hp_stride +
                               static_cast<size_t>(x0)] +
                    hot_prefix[static_cast<size_t>(z0) * hp_stride +
                               static_cast<size_t>(x0)];
                if (sum != 0) {
                    eligible[static_cast<size_t>(zr) *
                                 static_cast<size_t>(ecw) +
                             static_cast<size_t>(cx - g.acx0)] = 1;
                    ++local;
                }
            }
            eligible_count.fetch_add(local, std::memory_order_relaxed);
        })) {
        return false;
    }
    g_s.eligible_chunks.store(eligible_count.load(), std::memory_order_relaxed);

    /* 热点位图和它的前缀和已经用完，尽早释放以降低 optimize 阶段峰值。 */
    std::vector<uint8_t>().swap(hot_grid);
    std::vector<uint32_t>().swap(hot_prefix);

    /* 2.4 把有资格区块映射到 64x64 格子；每个格子只扫描一次。 */
    const int64_t cell_x0 = floorDiv(g.ax0, kDedupCell);
    const int64_t cell_x1 = floorDiv(g.ax1, kDedupCell);
    const int64_t cell_z0 = floorDiv(g.az0, kDedupCell);
    const int64_t cell_z1 = floorDiv(g.az1, kDedupCell);
    const int64_t cell_w = cell_x1 - cell_x0 + 1;
    const int64_t cell_h = cell_z1 - cell_z0 + 1;

    g.cell_x0 = cell_x0;
    g.cell_z0 = cell_z0;
    g.cell_w = cell_w;
    g.cell_h = cell_h;

    if (cell_w * cell_h > kMaxDedupCells) {
        throw std::runtime_error("dedup cell grid too large");
    }

    std::vector<uint8_t> cell_mark(
        static_cast<size_t>(cell_w) * static_cast<size_t>(cell_h), 0);

    for (int64_t cz = g.acz0; cz <= g.acz1; ++cz) {
        if (((cz - g.acz0) & 15) == 0 && !checkpoint()) return false;
        for (int64_t cx = g.acx0; cx <= g.acx1; ++cx) {
            if (!eligible[static_cast<size_t>(cz - g.acz0) *
                              static_cast<size_t>(ecw) +
                          static_cast<size_t>(cx - g.acx0)]) {
                continue;
            }
            const int64_t mx = floorDiv(cx, kChunksPerCell) - cell_x0;
            const int64_t mz = floorDiv(cz, kChunksPerCell) - cell_z0;
            cell_mark[static_cast<size_t>(mz) * static_cast<size_t>(cell_w) +
                      static_cast<size_t>(mx)] = 1;
        }
    }

    std::vector<int64_t> cell_list;
    cell_list.reserve(static_cast<size_t>(cell_w * cell_h));
    for (int64_t mz = 0; mz < cell_h; ++mz) {
        if ((mz & 15) == 0 && !checkpoint()) return false;
        for (int64_t mx = 0; mx < cell_w; ++mx) {
            if (cell_mark[static_cast<size_t>(mz) * static_cast<size_t>(cell_w) +
                          static_cast<size_t>(mx)]) {
                cell_list.push_back(mz * cell_w + mx);
            }
        }
    }

    /* ---- Stage 3: Optimize（按 z band 建前缀 + 扫描，控制内存/缓存） ---- */
    const int64_t cells_total = static_cast<int64_t>(cell_list.size());

    struct PrefixBand {
        int64_t mz0 = 0;
        int64_t mz1 = 0;
        size_t cell_begin = 0;
        size_t cell_end = 0;
        int64_t pz0 = 0;
        int64_t rows = 0;
    };

    const int64_t full_pref_rows = (g.az1 - g.az0 + 1) + 2 * g.m;
    const int64_t kFullPrefBudget = 64ll * 1024 * 1024;  /* bytes */
    const int64_t kBandPrefBudget = 32ll * 1024 * 1024;  /* bytes */

    int64_t band_cell_rows = cell_h;
    if (full_pref_rows * g.pref_w * 2 > kFullPrefBudget) {
        int64_t max_rows = kBandPrefBudget / (2 * g.pref_w);
        if (max_rows < 64 + 2 * g.m) max_rows = 64 + 2 * g.m;
        band_cell_rows = (max_rows - 2 * g.m) / 64;
        if (band_cell_rows < 1) band_cell_rows = 1;
    }

    std::vector<PrefixBand> bands;
    uint64_t total_pref_rows = 0;
    {
        size_t cursor = 0;
        int64_t mz = 0;
        while (mz < cell_h) {
            /* 跳过没有命中格子的空 cell 行。 */
            while (mz < cell_h &&
                   (cursor >= cell_list.size() ||
                    cell_list[cursor] / cell_w != mz)) {
                ++mz;
            }
            if (mz >= cell_h) break;

            PrefixBand b;
            b.mz0 = mz;
            b.cell_begin = cursor;

            int64_t rows_in_band = 0;
            while (mz < cell_h && rows_in_band < band_cell_rows) {
                size_t row_end = cursor;
                while (row_end < cell_list.size() &&
                       cell_list[row_end] / cell_w == mz) {
                    ++row_end;
                }
                if (row_end == cursor) break;
                cursor = row_end;
                ++mz;
                ++rows_in_band;
            }
            if (rows_in_band == 0) break;

            b.mz1 = mz - 1;
            b.cell_end = cursor;

            const int64_t band_z_first =
                std::max(g.az0, (g.cell_z0 + b.mz0) * kDedupCell);
            const int64_t band_z_last =
                std::min(g.az1, (g.cell_z0 + b.mz1 + 1) * kDedupCell - 1);
            b.pz0 = band_z_first - g.m;
            b.rows = (band_z_last - band_z_first + 1) + 2 * g.m;

            if (b.rows <= 0 || b.rows * g.pref_w > kMaxPrefCells) {
                throw std::runtime_error("prefix band too large");
            }
            total_pref_rows += static_cast<uint64_t>(b.rows);
            bands.push_back(b);
        }
    }

    set_stage(SLIME_FARM_STAGE_OPTIMIZE, total_pref_rows +
                                              static_cast<uint64_t>(cells_total));
    g_s.cells_total.store(static_cast<uint64_t>(cells_total),
                          std::memory_order_relaxed);
    g_s.cells_done.store(0, std::memory_order_relaxed);

    /* 环按 dz 建表，再配成 ±dz 对。 */
    const std::vector<RingSpan> spans =
        computeRingSpans(p.inner_radius, p.outer_radius);
    std::vector<std::vector<SpanTerm>> by_dz(
        static_cast<size_t>(2 * p.outer_radius + 1));
    for (const RingSpan& sp : spans) {
        SpanTerm t;
        t.lo = sp.loDx;
        t.hi1 = sp.hiDx + 1;
        by_dz[static_cast<size_t>(sp.dz + p.outer_radius)].push_back(t);
    }

    std::vector<PairTerm> pairs;
    pairs.reserve(static_cast<size_t>(p.outer_radius) + 1);
    for (int dz = 1; dz <= p.outer_radius; ++dz) {
        const auto& src = by_dz[static_cast<size_t>(dz + p.outer_radius)];
        if (src.empty()) continue;
        PairTerm pt;
        pt.dz = dz;
        pt.n = static_cast<int32_t>(std::min<size_t>(2, src.size()));
        for (int k = 0; k < pt.n; ++k) {
            pt.pos[k] = src[static_cast<size_t>(k)];
            pt.neg[k] = src[static_cast<size_t>(k)];
        }
        pairs.push_back(pt);
    }
    {
        const auto& src = by_dz[static_cast<size_t>(p.outer_radius)];
        if (!src.empty()) {
            PairTerm pt;
            pt.dz = 0;
            pt.n = static_cast<int32_t>(std::min<size_t>(2, src.size()));
            for (int k = 0; k < pt.n; ++k) {
                pt.pos[k] = src[static_cast<size_t>(k)];
                pt.neg[k] = src[static_cast<size_t>(k)];
            }
            pairs.push_back(pt);
        }
    }

    /* 线程私有 stamp 缓冲。 */
    const int stamp_k = static_cast<int>((p.outer_radius + 15) / 16) + 2;
    const int stamp_dim = 2 * stamp_k + 1;

    int nthreads = threads;
    if (nthreads > cells_total) nthreads = static_cast<int>(cells_total);
    if (nthreads < 1) nthreads = 1;

    std::vector<std::vector<int32_t>> stamps(static_cast<size_t>(nthreads));
    for (auto& st : stamps) {
        st.assign(static_cast<size_t>(stamp_dim) * stamp_dim, -1);
    }

    std::vector<CellBest> cell_best(static_cast<size_t>(cells_total));
    std::vector<uint8_t> cell_has(static_cast<size_t>(cells_total), 0);
    std::atomic<bool> thread_failed{false};
    std::vector<uint16_t> pref_band;

    for (const PrefixBand& b : bands) {
        if (!checkpoint()) return false;

        pref_band.assign(
            static_cast<size_t>(b.rows) * static_cast<size_t>(g.pref_w), 0);

        /* band 内 block 级行前缀：pref[z][x] = 该行 [x_base,x) 内史莱姆方块数。 */
        if (!parallel_rows(b.rows, threads, [&](int64_t zr) {
                const int64_t z = b.pz0 + zr;
                const int64_t cz = floorDiv(z, 16);
                const uint8_t* srow =
                    slime.data() + static_cast<size_t>(cz - g.min_cz) *
                                       static_cast<size_t>(g.cw);
                uint16_t* row = pref_band.data() +
                                static_cast<size_t>(zr) *
                                    static_cast<size_t>(g.pref_w);

                row[0] = 0;
                uint32_t acc = 0;
                int64_t i = 0;
                int64_t x = g.x_base;
                const int64_t x_end = g.x_base + (g.pref_w - 2);

                while (x <= x_end) {
                    const int64_t cx = floorDiv(x, 16);
                    const int64_t seg_end = std::min(x_end, cx * 16 + 15);
                    const int64_t len = seg_end - x + 1;
                    const uint32_t v = srow[cx - g.min_cx];
                    uint32_t cur = acc;
                    for (int64_t k = 0; k < len; ++k) {
                        cur += v;
                        row[++i] = static_cast<uint16_t>(cur);
                    }
                    acc += v * static_cast<uint32_t>(len);
                    x = seg_end + 1;
                }
            })) {
            return false;
        }

        const size_t band_cells = b.cell_end - b.cell_begin;
        if (band_cells == 0) continue;

        std::atomic<int64_t> next_cell{static_cast<int64_t>(b.cell_begin)};
        const int64_t cell_limit = static_cast<int64_t>(b.cell_end);

        auto worker = [&](int t) {
            try {
                auto& stamp = stamps[static_cast<size_t>(t)];
                for (;;) {
                    const int64_t idx =
                        next_cell.fetch_add(1, std::memory_order_relaxed);
                    if (idx >= cell_limit) break;
                    if (!checkpoint()) break;

                    CellBest best;
                    scan_cell(cell_list[static_cast<size_t>(idx)], g, p, slime,
                              pref_band.data(), b.pz0, eligible, spans, pairs,
                              stamp_dim, stamp_k, stamp, best);
                    if (best.area >= 0) {
                        cell_best[static_cast<size_t>(idx)] = best;
                        cell_has[static_cast<size_t>(idx)] = 1;
                    }
                    g_s.cells_done.fetch_add(1, std::memory_order_relaxed);
                    g_s.stage_current.fetch_add(1, std::memory_order_relaxed);
                }
            } catch (...) {
                thread_failed.store(true, std::memory_order_relaxed);
            }
        };

        int band_threads = nthreads;
        if (band_threads > static_cast<int>(band_cells)) {
            band_threads = static_cast<int>(band_cells);
        }
        if (band_threads < 1) band_threads = 1;

        std::vector<std::thread> pool;
        pool.reserve(static_cast<size_t>(band_threads - 1));
        for (int t = 0; t < band_threads - 1; ++t) pool.emplace_back(worker, t);
        worker(band_threads - 1);
        for (auto& th : pool) th.join();

        if (thread_failed.load()) {
            throw std::runtime_error("optimize worker failed");
        }
        if (g_s.cancelled.load()) return false;
    }

    std::vector<SlimeFarmHit> hits;
    hits.reserve(cell_list.size());
    const int32_t cxo = static_cast<int32_t>(cell_x0);
    const int32_t czo = static_cast<int32_t>(cell_z0);

    for (size_t i = 0; i < cell_list.size(); ++i) {
        if (!cell_has[i]) continue;
        const CellBest& b = cell_best[i];
        SlimeFarmHit h;
        h.x = b.x;
        h.z = b.z;
        h.area = b.area;
        h.chunks = b.chunks;
        h.cell_x = cxo + static_cast<int32_t>(cell_list[i] % cell_w);
        h.cell_z = czo + static_cast<int32_t>(cell_list[i] / cell_w);
        hits.push_back(h);
    }

    /* ---- Stage 4: Finalize（排序 + max_results） ---- */
    set_stage(SLIME_FARM_STAGE_FINALIZE, 1);
    std::sort(hits.begin(), hits.end(),
              [](const SlimeFarmHit& a, const SlimeFarmHit& b) {
                  if (a.area != b.area) return a.area > b.area;
                  if (a.chunks != b.chunks) return a.chunks > b.chunks;
                  if (a.x != b.x) return a.x < b.x;
                  return a.z < b.z;
              });

    if (p.max_results > 0 &&
        hits.size() > static_cast<size_t>(p.max_results)) {
        hits.resize(static_cast<size_t>(p.max_results));
    }

    size_t final_count = 0;
    {
        std::lock_guard<std::mutex> lock(g_s.mutex);
        g_s.hits.swap(hits);
        final_count = g_s.hits.size();
    }
    g_s.result_count.store(final_count, std::memory_order_relaxed);
    g_s.stage_current.store(1, std::memory_order_relaxed);
    return true;
}

void worker_main() {
    bool ok = false;
    try {
        ok = run_search();
    } catch (const std::bad_alloc&) {
        set_failure("out of memory");
    } catch (const std::exception& e) {
        set_failure(e.what());
    } catch (...) {
        set_failure("unknown error");
    }

    if (g_s.failed.load()) {
        g_s.stage.store(SLIME_FARM_STAGE_ERROR, std::memory_order_relaxed);
    } else if (!ok || g_s.cancelled.load()) {
        g_s.stage.store(SLIME_FARM_STAGE_CANCELLED, std::memory_order_relaxed);
    } else {
        g_s.stage.store(SLIME_FARM_STAGE_DONE, std::memory_order_relaxed);
    }

    g_s.done_generation.store(g_s.generation.load(std::memory_order_acquire),
                              std::memory_order_release);
    g_s.done.store(true, std::memory_order_release);
    g_s.cv.notify_all();
}

}  // namespace

// ============================================================================
// C API 实现
// ============================================================================

extern "C" {

void slime_farm_params_init(SlimeFarmParams* p) {
    if (!p) return;
    std::memset(p, 0, sizeof(*p));
    p->seed = 0;
    p->afk_x0 = p->afk_x1 = 0;
    p->afk_z0 = p->afk_z1 = 0;
    p->min_slime_chunks = 0; /* 0 = 未指定；start 时按面积自动填 */
    p->min_slime_area = 0;
    p->inner_radius = kDefaultInner;
    p->outer_radius = kDefaultOuter;
    p->player_search_range = kDefaultPlayerRange;
    p->radar_threshold = -1;
    p->radar_tile_chunks = 0;
    p->threads = 0;
    p->max_results = 0;
    p->flags = 0;
}

int32_t slime_farm_default_chunks_for_area(int64_t area) {
    const int idx = area_threshold_index(area);
    if (idx < 0) return -1;
    return kAreaThresholdDefaults[idx];
}

int slime_farm_start(const SlimeFarmParams* p) {
    if (!p) return SLIME_FARM_ERR_PARAM;
    SlimeFarmParams resolved = *p;
    resolve_auto_chunks(resolved);
    const int vrc = validate_params(resolved);
    if (vrc != SLIME_FARM_OK) return vrc;

    std::lock_guard<std::mutex> api_lock(g_api_mutex);

    if (g_s.worker.joinable()) {
        if (!g_s.done.load(std::memory_order_acquire)) {
            return SLIME_FARM_ERR_BUSY;
        }
        g_s.worker.join();
    }

    {
        std::lock_guard<std::mutex> lock(g_s.mutex);
        g_s.hits.clear();
        g_s.message.clear();
    }

    g_s.p = resolved;
    g_s.stage.store(SLIME_FARM_STAGE_RADAR, std::memory_order_relaxed);
    g_s.stage_current.store(0, std::memory_order_relaxed);
    g_s.stage_total.store(0, std::memory_order_relaxed);
    g_s.stage_start_offset_ms.store(0, std::memory_order_relaxed);
    g_s.radar_hits.store(0, std::memory_order_relaxed);
    g_s.eligible_chunks.store(0, std::memory_order_relaxed);
    g_s.cells_done.store(0, std::memory_order_relaxed);
    g_s.cells_total.store(0, std::memory_order_relaxed);
    g_s.result_count.store(0, std::memory_order_relaxed);
    g_s.done.store(false, std::memory_order_relaxed);
    g_s.cancelled.store(false, std::memory_order_relaxed);
    g_s.pause_requested.store(false, std::memory_order_relaxed);
    g_s.failed.store(false, std::memory_order_relaxed);
    const uint64_t new_gen =
        g_s.generation.fetch_add(1, std::memory_order_acq_rel) + 1;

    /* 给第一次 poll 一个非零的 radar 总量；worker 会再精确设置一次。 */
    {
        const int64_t acx0 = floorDiv(static_cast<int64_t>(resolved.afk_x0), 16);
        const int64_t acx1 = floorDiv(static_cast<int64_t>(resolved.afk_x1), 16);
        const int64_t acz0 = floorDiv(static_cast<int64_t>(resolved.afk_z0), 16);
        const int64_t acz1 = floorDiv(static_cast<int64_t>(resolved.afk_z1), 16);
        const int64_t pr = resolved.player_search_range;
        const int64_t gw = (acx1 + pr) - (acx0 - pr) + 1;
        const int64_t gh = (acz1 + pr) - (acz0 - pr) + 1;
        g_s.stage_total.store(static_cast<uint64_t>(gw * gh),
                              std::memory_order_relaxed);
    }
    g_s.start_time_ms.store(steady_now_ms(), std::memory_order_relaxed);

    try {
        g_s.worker = std::thread(worker_main);
    } catch (...) {
        set_failure("thread creation failed");
        g_s.stage.store(SLIME_FARM_STAGE_ERROR, std::memory_order_relaxed);
        g_s.done_generation.store(new_gen, std::memory_order_release);
        g_s.done.store(true, std::memory_order_release);
        g_s.cv.notify_all();
        return SLIME_FARM_ERR_INTERNAL;
    }
    return SLIME_FARM_OK;
}

int slime_farm_pause(void) {
    if (g_s.generation.load(std::memory_order_acquire) == 0 ||
        g_s.done.load(std::memory_order_acquire)) {
        return SLIME_FARM_ERR_STATE;
    }
    g_s.pause_requested.store(true, std::memory_order_relaxed);
    return SLIME_FARM_OK;
}

int slime_farm_resume(void) {
    if (g_s.generation.load(std::memory_order_acquire) == 0 ||
        g_s.done.load(std::memory_order_acquire)) {
        return SLIME_FARM_ERR_STATE;
    }
    g_s.pause_requested.store(false, std::memory_order_relaxed);
    g_s.cv.notify_all();
    return SLIME_FARM_OK;
}

int slime_farm_cancel(void) {
    if (g_s.generation.load(std::memory_order_acquire) == 0 ||
        g_s.done.load(std::memory_order_acquire)) {
        return SLIME_FARM_ERR_STATE;
    }
    g_s.cancelled.store(true, std::memory_order_relaxed);
    g_s.pause_requested.store(false, std::memory_order_relaxed);
    g_s.cv.notify_all();
    return SLIME_FARM_OK;
}

int slime_farm_poll(SlimeFarmProgress* out) {
    if (!out) return SLIME_FARM_ERR_PARAM;
    std::memset(out, 0, sizeof(*out));

    const int stage = g_s.stage.load(std::memory_order_relaxed);
    out->stage = stage;
    out->stage_count = 4;
    out->stage_index = stage_index(stage);
    out->done = g_s.done.load(std::memory_order_acquire) ? 1 : 0;
    out->cancelled = g_s.cancelled.load(std::memory_order_relaxed) ? 1 : 0;
    out->error = g_s.failed.load(std::memory_order_relaxed) ? 1 : 0;
    out->paused = (!out->done &&
                   g_s.pause_requested.load(std::memory_order_relaxed))
                      ? 1
                      : 0;

    out->stage_current = g_s.stage_current.load(std::memory_order_relaxed);
    out->stage_total = g_s.stage_total.load(std::memory_order_relaxed);
    out->radar_hits = g_s.radar_hits.load(std::memory_order_relaxed);
    out->eligible_chunks = g_s.eligible_chunks.load(std::memory_order_relaxed);
    out->cells_done = g_s.cells_done.load(std::memory_order_relaxed);
    out->cells_total = g_s.cells_total.load(std::memory_order_relaxed);
    out->results = g_s.result_count.load(std::memory_order_relaxed);

    const uint64_t elapsed = elapsed_ms();
    out->elapsed_ms = elapsed;

    const uint64_t stage_start =
        g_s.stage_start_offset_ms.load(std::memory_order_relaxed);
    out->stage_elapsed_ms = elapsed >= stage_start ? elapsed - stage_start : 0;

    out->eta_ms = std::numeric_limits<uint64_t>::max();
    if (!out->paused && out->stage_current > 0 &&
        out->stage_total > out->stage_current) {
        const double frac = static_cast<double>(out->stage_total -
                                                out->stage_current) /
                            static_cast<double>(out->stage_current);
        out->eta_ms = static_cast<uint64_t>(
            static_cast<double>(out->stage_elapsed_ms) * frac);
    } else if (out->stage_total > 0 &&
               out->stage_current >= out->stage_total) {
        out->eta_ms = 0;
    }

    int overall = 0;
    if (out->stage_index >= 1) {
        const int base = (out->stage_index - 1) * 1000 / 4;
        int part = 0;
        if (out->stage_total > 0) {
            uint64_t cur = out->stage_current;
            if (cur > out->stage_total) cur = out->stage_total;
            part = static_cast<int>(cur * 1000 / out->stage_total / 4);
        }
        overall = base + part;
    }
    if (stage == SLIME_FARM_STAGE_DONE) overall = 1000;
    if (overall < 0) overall = 0;
    if (overall > 1000) overall = 1000;
    out->overall_permille = overall;

    std::snprintf(out->stage_name, sizeof(out->stage_name), "%s",
                  stage_name(stage));

    {
        std::lock_guard<std::mutex> lock(g_s.mutex);
        if (!g_s.message.empty()) {
            std::snprintf(out->message, sizeof(out->message), "%s",
                          g_s.message.c_str());
        }
    }
    return SLIME_FARM_OK;
}

int slime_farm_wait(uint32_t timeout_ms) {
    const uint64_t gen = g_s.generation.load(std::memory_order_acquire);
    if (gen == 0) return SLIME_FARM_OK;

    {
        std::unique_lock<std::mutex> lock(g_s.mutex);
        const auto finished = [gen] {
            return g_s.done_generation.load(std::memory_order_acquire) >= gen;
        };
        if (timeout_ms == 0) {
            g_s.cv.wait(lock, finished);
        } else if (!g_s.cv.wait_for(
                       lock, std::chrono::milliseconds(timeout_ms), finished)) {
            return 1;
        }
    }

    /* join 时短暂持有 api 锁；等待期间不持有，因此 shutdown()/pause() 仍能
     * 从其他线程打断一个暂停中的搜索。 */
    std::lock_guard<std::mutex> api_lock(g_api_mutex);
    if (g_s.generation.load(std::memory_order_acquire) == gen &&
        g_s.worker.joinable()) {
        g_s.worker.join();
    }
    return SLIME_FARM_OK;
}

int32_t slime_farm_result_count(void) {
    std::lock_guard<std::mutex> lock(g_s.mutex);
    return static_cast<int32_t>(g_s.hits.size());
}

int32_t slime_farm_get_results(SlimeFarmHit* out, int32_t capacity) {
    std::lock_guard<std::mutex> lock(g_s.mutex);
    const int32_t total = static_cast<int32_t>(g_s.hits.size());
    if (out && capacity > 0) {
        const int32_t n = std::min(total, capacity);
        std::memcpy(out, g_s.hits.data(),
                    static_cast<size_t>(n) * sizeof(SlimeFarmHit));
    }
    return total;
}

void slime_farm_shutdown(void) {
    std::thread th;
    {
        std::lock_guard<std::mutex> api_lock(g_api_mutex);
        if (!g_s.worker.joinable()) return;
        if (!g_s.done.load(std::memory_order_acquire)) {
            g_s.cancelled.store(true, std::memory_order_relaxed);
            g_s.pause_requested.store(false, std::memory_order_relaxed);
            g_s.cv.notify_all();
        }
        th = std::move(g_s.worker);
    }
    if (th.joinable()) th.join();
}

}  // extern "C"

// ============================================================================
// 可选：独立 CLI + 暴力对拍
// ============================================================================

#if defined(SLIME_FARM_STANDALONE)

#include <cinttypes>

namespace {

void print_usage(const char* exe) {
    std::printf(
        "usage: %s SEED AFK_X0 AFK_X1 AFK_Z0 AFK_Z1 MIN_CHUNKS MIN_AREA "
        "[PLAYER_RANGE]\n"
        "  AFK_X0..AFK_X1 / AFK_Z0..AFK_Z1 are inclusive block coordinates.\n"
        "  MIN_CHUNKS is the radar donut threshold and final distinct-chunk "
        "minimum.\n"
        "  Pass 0 or '-' for MIN_CHUNKS to auto-fill from tools/slime/"
        "threshold.json defaults when MIN_AREA is in [9000,15000].\n"
        "  MIN_AREA is the minimum effective slime spawn area (blocks).\n"
        "example: %s 0 -512 512 -512 512 30 3000 5\n"
        "example: %s 0 -512 512 -512 512 - 10000 5\n",
        exe, exe, exe);
}

#if defined(SLIME_FARM_SELF_TEST)
/* 用 SlimeOptimizer 的 computeRingOffsets + isSlimeChunk 暴力重算，
 * 校核输出行的 area/chunks。只用于开发验证。 */
bool brute_check(int64_t seed, int32_t inner, int32_t outer,
                 const SlimeFarmHit& h) {
    const auto offsets = computeRingOffsets(inner, outer);
    int64_t area = 0;
    std::vector<std::pair<int32_t, int32_t>> chunks;
    chunks.reserve(256);
    for (const auto& o : offsets) {
        const int32_t cx = static_cast<int32_t>(floorDiv(h.x + o.first, 16));
        const int32_t cz = static_cast<int32_t>(floorDiv(h.z + o.second, 16));
        if (!isSlimeChunk(seed, cx, cz)) continue;
        ++area;
        chunks.emplace_back(cx, cz);
    }
    std::sort(chunks.begin(), chunks.end());
    chunks.erase(std::unique(chunks.begin(), chunks.end()), chunks.end());
    const bool ok = (area == h.area &&
                     static_cast<int32_t>(chunks.size()) == h.chunks);
    if (!ok) {
        std::fprintf(stderr,
                     "SELF-TEST FAIL at (%" PRId64 ",%" PRId64
                     "): got area=%" PRId64 " chunks=%d, want area=%" PRId64
                     " chunks=%zu\n",
                     h.x, h.z, h.area, h.chunks, area, chunks.size());
    }
    return ok;
}
#endif

}  // namespace

int main(int argc, char** argv) {
    if (argc < 8) {
        print_usage(argv[0]);
        return 1;
    }

    SlimeFarmParams p;
    slime_farm_params_init(&p);
    p.seed = std::strtoll(argv[1], nullptr, 10);
    p.afk_x0 = static_cast<int32_t>(std::strtol(argv[2], nullptr, 10));
    p.afk_x1 = static_cast<int32_t>(std::strtol(argv[3], nullptr, 10));
    p.afk_z0 = static_cast<int32_t>(std::strtol(argv[4], nullptr, 10));
    p.afk_z1 = static_cast<int32_t>(std::strtol(argv[5], nullptr, 10));
    if (std::strcmp(argv[6], "-") == 0) {
        p.min_slime_chunks = 0;
    } else {
        p.min_slime_chunks =
            static_cast<int32_t>(std::strtol(argv[6], nullptr, 10));
    }
    p.min_slime_area = std::strtoll(argv[7], nullptr, 10);
    if (argc >= 9) {
        p.player_search_range =
            static_cast<int32_t>(std::strtol(argv[8], nullptr, 10));
    }

    if (p.min_slime_chunks == 0) {
        const int32_t auto_chunks =
            slime_farm_default_chunks_for_area(p.min_slime_area);
        if (auto_chunks < 0) {
            std::fprintf(stderr,
                         "MIN_CHUNKS omitted, but MIN_AREA=%" PRId64
                         " is outside [9000,15000]; pass an explicit "
                         "MIN_CHUNKS.\n",
                         p.min_slime_area);
            return 1;
        }
        std::fprintf(stderr, "auto MIN_CHUNKS=%d for MIN_AREA=%" PRId64 "\n",
                     auto_chunks, p.min_slime_area);
    }

    const int rc = slime_farm_start(&p);
    if (rc != SLIME_FARM_OK) {
        std::fprintf(stderr, "start failed: %d\n", rc);
        return 2;
    }

    int last_stage = -1;
    for (;;) {
        SlimeFarmProgress pr;
        slime_farm_poll(&pr);

        char eta_buf[32] = "--";
        if (pr.eta_ms != std::numeric_limits<uint64_t>::max()) {
            std::snprintf(eta_buf, sizeof(eta_buf), "%.1fs",
                          static_cast<double>(pr.eta_ms) / 1000.0);
        }
        if (pr.stage != last_stage) {
            if (last_stage >= 0) std::fprintf(stderr, "\n");
            last_stage = pr.stage;
        }
        std::fprintf(stderr,
                     "\r[%3d.%d%%] %-8s %" PRIu64 "/%" PRIu64
                     "  hits=%" PRIu64 " eligible=%" PRIu64
                     " cells=%" PRIu64 "  eta=%s%s   ",
                     pr.overall_permille / 10, pr.overall_permille % 10,
                     pr.stage_name, pr.stage_current, pr.stage_total,
                     pr.radar_hits, pr.eligible_chunks, pr.cells_total,
                     eta_buf, pr.paused ? "  [paused]" : "");
        std::fflush(stderr);
        if (pr.done) {
            std::fprintf(stderr, "\n");
            if (pr.error) {
                std::fprintf(stderr, "search error: %s\n", pr.message);
                return 3;
            }
            if (pr.cancelled) return 4;
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    slime_farm_wait(0);
    const int32_t n = slime_farm_result_count();
    std::vector<SlimeFarmHit> hits(static_cast<size_t>(n));
    slime_farm_get_results(hits.data(), n);

    std::printf("x,z,area,chunks,cell_x,cell_z\n");
    for (const auto& h : hits) {
        std::printf("%" PRId64 ",%" PRId64 ",%" PRId64 ",%d,%d,%d\n",
                    h.x, h.z, h.area, h.chunks, h.cell_x, h.cell_z);
    }
    std::printf("# %d result(s)\n", n);

#if defined(SLIME_FARM_SELF_TEST)
    bool ok = true;
    for (size_t i = 0; i < hits.size() && i < 32; ++i) {
        ok = brute_check(p.seed, p.inner_radius, p.outer_radius, hits[i]) && ok;
    }
    std::fprintf(stderr, "self-test: %s\n", ok ? "OK" : "FAILED");
    if (!ok) return 5;
#endif

    slime_farm_shutdown();
    return 0;
}

#endif  /* SLIME_FARM_STANDALONE */

#endif  /* SLIME_FARM_DECLARATIONS_ONLY */
