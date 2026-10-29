#include "multi_monument_host.h"

#include "multi_monument_results.h"

#include "search_gate.h"

#include "cubiomes/biomes.h"

/*
 * 多联神殿内核来自 tools/multimonument。上游的 Progress / PairHit /
 * ThreadSafeResults / ThreadPool 与 dripstonecave、要塞内核同名，这里在 host TU
 * 内用局部宏改名，不改上游源码。
 *
 * 结果收集器换成 host 侧的 MmResults（top-K，满员淘汰最差），避免上游队列满后
 * 丢弃后扫到的更大结果；ThreadPool 仍用上游实现。先带着改名把 Thread.h 引进来，
 * 防止和 dripstonecave 的同名 ThreadPool 形成 ODR 冲突。
 */
#define ThreadSafeResults MmUpstreamResults
#define ThreadPool MmPool
#include "../tools/multimonument/Thread.h"
#undef ThreadSafeResults
#undef ThreadPool

#define Progress MultiProgress
#define PairHit MultiPairHit
#define MonumentSearchConfig MultiMonumentConfig
#define ThreadSafeResults MmResults
#define ThreadPool MmPool
#define runMonumentSearch runMultiMonumentSearch
#include "../tools/multimonument/monument_search.cpp"
#undef Progress
#undef PairHit
#undef MonumentSearchConfig
#undef ThreadSafeResults
#undef ThreadPool
#undef runMonumentSearch

#include <algorithm>
#include <atomic>
#include <chrono>
#include <exception>
#include <mutex>
#include <thread>
#include <unordered_set>
#include <vector>

namespace {

constexpr int kMaxThreads = 256;
constexpr int kOutputLimit = 1000;
constexpr int kQueueLimit = 20000;
constexpr int kWorldLimit = 30000000;
constexpr int kRegionSize = 512;

std::mutex gMu;
std::thread gThread;
MonumentStatus gStatus;
MultiProgress gProgress;

int floorDiv(int value, int divisor)
{
    int q = value / divisor;
    int r = value % divisor;
    if (r != 0 && ((r < 0) != (divisor < 0))) --q;
    return q;
}

void publish(std::vector<MonumentHit> hits, bool running, bool done, const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.hits = std::move(hits);
    gStatus.running = running;
    gStatus.done = done;
    gStatus.error = error;
}

void waitWhilePaused()
{
    while (gProgress.try_pause.load() && !gProgress.try_stop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

int64_t hitFocusDist2(const MonumentHit &hit)
{
    // 同面积时按结果展示点排序：双假人用中点，单门用上限重心，单假人用挂机点。
    if (hit.mode == 1) {
        return originDist2((hit.x + hit.x2) / 2, (hit.z + hit.z2) / 2);
    }
    if (hit.mode == 2) {
        return originDist2(hit.areaMaxX, hit.areaMaxZ);
    }
    return originDist2(hit.x, hit.z);
}

bool hitLess(const MonumentHit &a, const MonumentHit &b)
{
    const int aa = a.mode == 2 ? a.areaMax : a.area;
    const int ab = b.mode == 2 ? b.areaMax : b.area;
    if (aa != ab) return aa > ab;
    const int64_t da = hitFocusDist2(a);
    const int64_t db = hitFocusDist2(b);
    if (da != db) return da < db;
    if (a.x != b.x) return a.x < b.x;
    return a.z < b.z;
}

/*
 * 按上游 4 点（+-64）规则检查一片挂机区域：以 3x3 个中心各调用一次上游分类器，
 * 每个中心内部再由上游采样 4 点，合计覆盖 257x257 的方块范围；返回所有温度类型位掩码。
 */
int classifyOceanAreaMask(MonumentGenerator *gen, int mc, int centerX, int centerZ)
{
    int mask = 0;
    for (int dx = -1; dx <= 1; dx++) {
        for (int dz = -1; dz <= 1; dz++) {
            mask |= monument_classify_ocean_types_g(gen, mc, centerX + dx * 64,
                                                     centerZ + dz * 64);
        }
    }
    return mask;
}

void classifyOceanTypes(std::vector<MonumentHit> &hits, int mc)
{
    std::unordered_set<int64_t> seeds;
    seeds.reserve(hits.size());
    for (const MonumentHit &hit : hits) seeds.insert(hit.seed);

    for (int64_t seed : seeds) {
        MonumentGenerator *gen = monument_generator_alloc();
        if (!gen) continue;
        monument_init_generator(gen, mc, static_cast<uint64_t>(seed));
        for (MonumentHit &hit : hits) {
            if (hit.seed != seed) continue;
            int mask;
            if (hit.mode == 1) {
                mask = classifyOceanAreaMask(gen, mc, hit.x, hit.z)
                     | classifyOceanAreaMask(gen, mc, hit.x2, hit.z2);
            } else if (hit.mode == 2) {
                mask = classifyOceanAreaMask(gen, mc, hit.areaMaxX, hit.areaMaxZ);
            } else {
                mask = monument_classify_ocean_types_g(gen, mc, hit.x, hit.z);
            }
            hit.oceanTypes = mask;
            hit.oceanType = legacyOceanType(mask);
        }
        monument_generator_free(gen);
    }
}

void job(MultiMonumentRequest request)
{
    std::vector<MonumentHit> all;
    std::string error;

    const int regMinX = floorDiv(request.minX, kRegionSize);
    const int regMaxX = floorDiv(request.maxX, kRegionSize) + 1;
    const int regMinZ = floorDiv(request.minZ, kRegionSize);
    const int regMaxZ = floorDiv(request.maxZ, kRegionSize) + 1;

    try {
        for (size_t index = 0; index < request.seeds.size(); index++) {
            if (gProgress.try_stop.load()) break;

            {
                std::lock_guard<std::mutex> lock(gMu);
                gStatus.seedIndex = static_cast<int>(index);
            }
            waitWhilePaused();
            if (gProgress.try_stop.load()) break;

            const int64_t seed = request.seeds[index];

            MultiMonumentConfig cfg{};
            cfg.seed = static_cast<uint64_t>(seed);
            cfg.minX = regMinX;
            cfg.maxX = regMaxX;
            cfg.minZ = regMinZ;
            cfg.maxZ = regMaxZ;
            cfg.mc = request.mc;
            cfg.pauseOnPairFound = false;
            cfg.pairLevel = request.level;
            cfg.biomeCheck = request.biomeCheck;
            cfg.minGroupArea = request.minGroupArea;
            cfg.searchModes = (request.searchModes & 7) != 0 ? (request.searchModes & 7) : 1;
            cfg.filterMode = (request.filterMode >= 0 && request.filterMode <= 2)
                                 ? request.filterMode
                                 : 0;

            gProgress.current.store(0);
            gProgress.total.store(0);
            gProgress.status.store(0);

            MmResults<MultiPairHit> results;
            results.setLimit(kQueueLimit);
            results.setScoreMode(request.filterMode);
            runMultiMonumentSearch(cfg, &gProgress, results, request.threads);

            if (gProgress.try_stop.load()) break;

            auto hits = results.getAllResults();
            for (const MultiPairHit &hit : hits) {
                MonumentHit item;
                item.seed = seed;
                item.x = hit.x;
                item.z = hit.z;
                item.dx = hit.dx;
                item.dz = hit.dz;
                item.count = hit.count;
                item.area = hit.area;
                item.x2 = hit.x2;
                item.z2 = hit.z2;
                item.singleX = hit.singleX;
                item.singleZ = hit.singleZ;
                item.singleArea = hit.singleArea;
                item.areaMax = hit.areaMax;
                item.areaMaxX = hit.areaMaxX;
                item.areaMaxZ = hit.areaMaxZ;
                item.dual = hit.dual ? 1 : 0;
                item.mode = request.filterMode;
                all.push_back(item);
            }
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::exception &ex) {
        error = ex.what();
    } catch (...) {
        error = "multi-monument-search-failed";
    }

    std::stable_sort(all.begin(), all.end(), hitLess);
    if (gProgress.try_stop.load()) all.clear();
    if (all.size() > static_cast<size_t>(kOutputLimit)) all.resize(kOutputLimit);
    if (error.empty()) classifyOceanTypes(all, request.mc);

    publish(std::move(all), false, true, error);
    searchGateRelease(SearchOwner::MultiMonument);
}

} // namespace

std::string multiMonumentStart(const MultiMonumentRequest &request)
{
    if (request.seeds.empty()) return "no-seeds";
    if (request.mc < MC_1_18 || request.mc > MC_NEWEST) return "unsupported-version";
    if (request.threads < 1 || request.threads > kMaxThreads) return "bad-bounds";
    if (request.level != 3 && request.level != 4) return "bad-level";
    if (request.minGroupArea < 6728 || request.minGroupArea > 13455) return "bad-monument-area";
    if ((request.searchModes & 7) == 0) return "bad-search-modes";
    if (request.filterMode < 0 || request.filterMode > 2) return "bad-filter-mode";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    if (request.minX < -kWorldLimit || request.maxX > kWorldLimit ||
        request.minZ < -kWorldLimit || request.maxZ > kWorldLimit) {
        return "area-too-large";
    }

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::MultiMonument)) return "busy";

    gProgress.current.store(0);
    gProgress.total.store(0);
    gProgress.status.store(0);
    gProgress.try_pause.store(false);
    gProgress.try_stop.store(false);

    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus = {};
        gStatus.running = true;
        gStatus.seedCount = static_cast<int>(request.seeds.size());
    }
    try {
        gThread = std::thread(job, request);
    } catch (const std::exception &) {
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus = {};
        }
        searchGateRelease(SearchOwner::MultiMonument);
        return "multi-monument-start-failed";
    }
    return "";
}

void multiMonumentPause()
{
    gProgress.try_pause.store(true);
}

void multiMonumentResume()
{
    gProgress.try_pause.store(false);
}

void multiMonumentStop()
{
    gProgress.try_stop.store(true);
}

MonumentStatus multiMonumentPoll()
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
    gStatus.current = gProgress.current.load();
    gStatus.total = gProgress.total.load();
    gStatus.paused = gProgress.try_pause.load();
    return gStatus;
}
