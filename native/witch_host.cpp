#include "witch_host.h"

#include "search_gate.h"

/*
 * lysh-c 是纯 C 库：头文件里的函数没有 C++ linkage 标记，必须整组放进
 * extern "C" 里包含。include 路径用相对路径，避免把 lysh-c/src 加进
 * allinone 的全局 include 路径（那会把 lysh 的 noise.h / biomes.h 名字
 * 暴露给所有源文件）。见方案 3.8 的说明。
 */
extern "C" {
#include "../tools/lowyswamphut/lysh-c/src/eval.h"
#include "../tools/lowyswamphut/lysh-c/src/search.h"
}

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <mutex>
#include <thread>

namespace {

constexpr int kRegionBlocks = 512;
constexpr int kWorldRegionMin = -58594; /* region 下标 -58594..58593 */
constexpr int kWorldRegionMax = 58594;  /* 开区间上界 */
constexpr int kMaxAxisSpan = 250000;
constexpr int64_t kMaxRegions = 20000000000LL;
constexpr int kMaxBands = 256;
constexpr int kMaxThreads = 256;

std::mutex gMu;
std::thread gThread;
WitchStatus gStatus;
std::atomic<bool> gPause{false};
std::atomic<bool> gStop{false};

/** 向下取整的整数除法（C 的 / 向零截断，负数会算错）。 */
int floorDiv(int value, int divisor)
{
    int q = value / divisor;
    int r = value % divisor;
    if (r != 0 && ((r < 0) != (divisor < 0))) --q;
    return q;
}

/** 生产代码的 phase1CheckHeight：阶段 1 选 -50/-54 时一律按 -50。 */
int phase1Height(int maxY)
{
    return maxY < -50 ? -50 : maxY;
}

bool validMaxY(int maxY)
{
    switch (maxY) {
    case 0:
    case -10:
    case -20:
    case -30:
    case -40:
    case -50:
    case -54:
        return true;
    default:
        return false;
    }
}

bool regionRange(const WitchRequest &request, int &rx0, int &rx1, int &rz0, int &rz1)
{
    rx0 = floorDiv(request.minX, kRegionBlocks);
    rx1 = floorDiv(request.maxX, kRegionBlocks) + 1;
    rz0 = floorDiv(request.minZ, kRegionBlocks);
    rz1 = floorDiv(request.maxZ, kRegionBlocks) + 1;

    if (rx0 < kWorldRegionMin) rx0 = kWorldRegionMin;
    if (rx1 > kWorldRegionMax) rx1 = kWorldRegionMax;
    if (rz0 < kWorldRegionMin) rz0 = kWorldRegionMin;
    if (rz1 > kWorldRegionMax) rz1 = kWorldRegionMax;
    return rx1 > rx0 && rz1 > rz0;
}

struct WitchHookArg {
    int maxY;
    int64_t seed;
};

int witchHook(void *user, lysh_search_ctx *ctx, int rx, int rz, int hutX, int hutZ)
{
    (void)rx;
    (void)rz;
    if (gStop.load()) return 0;
    /* 暂停时直接跳过阶段 2 评估；C 内核没有带内停止钩子。 */
    if (gPause.load()) return 0;

    const WitchHookArg *arg = static_cast<const WitchHookArg *>(user);
    lysh_hut_result result = lysh_eval_hut(ctx, hutX, hutZ, arg->maxY);
    if (!result.ok) return 0;

    WitchHit hit;
    hit.seed = arg->seed;
    hit.x = result.hut_x;
    hit.z = result.hut_z;
    hit.y = result.avg_y;
    hit.dir = result.dir;
    hit.sizeX = result.size_x;
    hit.sizeZ = result.size_z;
    hit.wet = result.wet_columns;
    hit.flooded = result.flooded;
    hit.reject = result.reject;

    /* 搜到即输出：不缓冲、不排序、不截断。 */
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.hits.push_back(hit);
    return 1;
}

void publishProgress(int64_t current, int64_t total)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.current = current;
    gStatus.total = total;
    gStatus.paused = gPause.load();
}

void publishDone(const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.running = false;
    gStatus.done = true;
    gStatus.error = error;
    gStatus.paused = gPause.load();
}

void freeCtxPool(std::vector<lysh_search_ctx *> &pool)
{
    for (lysh_search_ctx *ctx : pool) {
        if (!ctx) continue;
        lysh_search_ctx_free(ctx);
        std::free(ctx);
    }
    pool.clear();
}

void job(WitchRequest request)
{
    std::string error;

    int rx0 = 0;
    int rx1 = 0;
    int rz0 = 0;
    int rz1 = 0;
    if (!regionRange(request, rx0, rx1, rz0, rz1)) {
        error = "bad-bounds";
        publishDone(error);
        searchGateRelease(SearchOwner::Witch);
        return;
    }

    const int totalX = rx1 - rx0;
    const int totalZ = rz1 - rz0;
    const int64_t totalRegions = static_cast<int64_t>(totalX) * totalZ;

    lysh_phase1_opts opts;
    std::memset(&opts, 0, sizeof(opts));
    opts.mc_1_18_2 = request.versionGroup == 0 ? 1 : 0;
    /* pre_26_2 是反向开关：0（全零默认）就是 26.2 语义。 */
    opts.pre_26_2 = request.versionGroup <= 1 ? 1 : 0;
    opts.single_biome = request.singleBiome ? 1 : 0;
    opts.large_biomes = request.largeBiomes ? 1 : 0;

    const int maxHeight = phase1Height(request.maxY);
    int threads = request.threads;
    if (threads < 1) threads = 1;
    if (threads > kMaxThreads) threads = kMaxThreads;
    const int bands = totalZ < kMaxBands ? totalZ : kMaxBands;
    const int bandZ = (totalZ + bands - 1) / bands;

    for (size_t index = 0; index < request.seeds.size(); index++) {
        if (gStop.load()) break;
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus.seedIndex = static_cast<int>(index);
            gStatus.current = 0;
            gStatus.total = totalRegions;
        }

        while (gPause.load() && !gStop.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        if (gStop.load()) break;

        const int64_t seed = request.seeds[index];

        std::vector<lysh_search_ctx *> pool(static_cast<size_t>(threads), nullptr);
        bool poolOk = true;
        for (int i = 0; i < threads; i++) {
            pool[i] = static_cast<lysh_search_ctx *>(std::calloc(1, sizeof(lysh_search_ctx)));
            if (!pool[i]) {
                poolOk = false;
                break;
            }
            lysh_search_ctx_init(pool[i], static_cast<uint64_t>(seed), &opts, maxHeight);
        }
        if (!poolOk) {
            freeCtxPool(pool);
            error = "out-of-memory";
            break;
        }

        WitchHookArg hookArg;
        hookArg.maxY = request.maxY;
        hookArg.seed = seed;

        lysh_scan_opts scanOpts;
        std::memset(&scanOpts, 0, sizeof(scanOpts));
        scanOpts.seed = static_cast<uint64_t>(seed);
        scanOpts.opts = opts;
        scanOpts.max_height = maxHeight;
        scanOpts.salt = 0; /* 0 = 内核默认 1.13+ 女巫小屋 salt */
        scanOpts.threads = threads;
        scanOpts.phase2_hook = witchHook;
        scanOpts.phase2_user = &hookArg;
        scanOpts.phase2_ctx_init = nullptr; /* 钩子直接写 gStatus.hits（持锁） */
        scanOpts.phase2_ctx_pool = pool.data();

        int64_t current = 0;
        for (int z = rz0; z < rz1; z += bandZ) {
            if (gStop.load()) break;
            while (gPause.load() && !gStop.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            if (gStop.load()) break;

            const int zEnd = (z + bandZ < rz1) ? z + bandZ : rz1;
            lysh_scan_result result;
            const int rc = lysh_scan_rect(&scanOpts, rx0, rx1, z, zEnd, &result);
            if (rc != 0) {
                error = "out-of-memory";
                break;
            }
            current += result.scanned;
            publishProgress(current, totalRegions);
        }

        freeCtxPool(pool);
        if (!error.empty() || gStop.load()) break;
    }

    publishDone(error);
    searchGateRelease(SearchOwner::Witch);
}

} // namespace

std::string witchStart(const WitchRequest &request)
{
    if (request.versionGroup < 0 || request.versionGroup > 2) return "unsupported-version";
    if (request.seeds.empty()) return "no-seeds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    if (request.minX < -30000000 || request.maxX > 30000000 ||
        request.minZ < -30000000 || request.maxZ > 30000000) {
        return "area-too-large";
    }
    if (!validMaxY(request.maxY)) return "bad-bounds";

    int rx0 = 0;
    int rx1 = 0;
    int rz0 = 0;
    int rz1 = 0;
    if (!regionRange(request, rx0, rx1, rz0, rz1)) return "bad-bounds";
    const int64_t spanX = static_cast<int64_t>(rx1) - rx0;
    const int64_t spanZ = static_cast<int64_t>(rz1) - rz0;
    if (spanX > kMaxAxisSpan || spanZ > kMaxAxisSpan) return "area-too-large";
    if (spanX * spanZ > kMaxRegions) return "area-too-large";

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Witch)) return "busy";

    gPause.store(false);
    gStop.store(false);
    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus = {};
        gStatus.running = true;
        gStatus.total = spanX * spanZ;
        gStatus.seedCount = static_cast<int>(request.seeds.size());
    }
    try {
        gThread = std::thread(job, request);
    } catch (const std::exception &) {
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus = {};
        }
        searchGateRelease(SearchOwner::Witch);
        return "witch-start-failed";
    }
    return "";
}

void witchPause()
{
    gPause.store(true);
}

void witchResume()
{
    gPause.store(false);
}

void witchStop()
{
    gStop.store(true);
}

WitchStatus witchPoll()
{
    bool running = false;
    {
        std::lock_guard<std::mutex> lock(gMu);
        running = gStatus.running;
    }
    if (!running && gThread.joinable()) {
        gThread.join();
    }
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.paused = gPause.load();
    return gStatus;
}
