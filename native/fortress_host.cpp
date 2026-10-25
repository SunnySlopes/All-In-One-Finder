#include "fortress_host.h"

#include "search_gate.h"

/*
 * 要塞内核来自 tools/fortress。上游与 dripstonecave / 多联内核存在同名全局符号
 * （Progress / ThreadSafeResults / ThreadPool / SearchConfig / FortressHit），
 * 这里在 host TU 内用局部宏改名，上游源码与独立工具都不需要修改。
 */
#define Progress FortressProgress
#define SearchConfig FortressConfig
#define FortressHit FfHit
#define ThreadSafeResults FfResults
#define ThreadPool FfPool
#include "../tools/fortress/fortress_finder_JNI.cpp"
#undef Progress
#undef SearchConfig
#undef FortressHit
#undef ThreadSafeResults
#undef ThreadPool

#include <algorithm>
#include <atomic>
#include <chrono>
#include <exception>
#include <mutex>
#include <thread>
#include <vector>

namespace {

constexpr int kMaxThreads = 256;
constexpr int kOutputLimit = 1000;
constexpr int kWorldLimit = 30000000;
constexpr long long kMaxArea = 30000000LL * 30000000LL;

std::mutex gMu;
std::thread gThread;
FortressStatus gStatus;
FortressProgress gProgress;

int64_t originDist2(int x, int z)
{
    return static_cast<int64_t>(x) * x + static_cast<int64_t>(z) * z;
}

void publish(std::vector<FortressHit> hits, bool running, bool done, const std::string &error)
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

bool hitLess(const FortressHit &a, const FortressHit &b, int mode)
{
    if (mode == 0) {
        if (a.crossings != b.crossings) return a.crossings > b.crossings;
    } else {
        if (a.area != b.area) return a.area > b.area;
    }
    const int64_t da = originDist2(a.x, a.z);
    const int64_t db = originDist2(b.x, b.z);
    if (da != db) return da < db;
    if (a.x != b.x) return a.x < b.x;
    return a.z < b.z;
}

void job(FortressRequest request)
{
    std::vector<FortressHit> all;
    std::string error;

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

            FortressConfig cfg{};
            cfg.mode = request.mode;
            cfg.mc = request.mc;
            cfg.seed = static_cast<uint64_t>(seed);

            const long long width = static_cast<long long>(request.maxX) - request.minX + 1;
            const long long height = static_cast<long long>(request.maxZ) - request.minZ + 1;
            const int centerX = static_cast<int>((static_cast<long long>(request.minX) + request.maxX) / 2);
            const int centerZ = static_cast<int>((static_cast<long long>(request.minZ) + request.maxZ) / 2);
            long long r = std::max(static_cast<long long>(centerX) - request.minX,
                                   static_cast<long long>(request.maxX) - centerX);
            r = std::max(r, static_cast<long long>(centerZ) - request.minZ);
            r = std::max(r, static_cast<long long>(request.maxZ) - centerZ);
            cfg.centerX = centerX;
            cfg.centerZ = centerZ;
            cfg.r = static_cast<int>(r);
            cfg.crossFilter = request.crossFilter;
            cfg.minLong = request.minLong;
            cfg.minShort = request.minShort > 0 ? request.minShort : request.minLong;
            cfg.minHeight = request.minHeight;

            gProgress.current.store(0);
            gProgress.total.store(0);
            gProgress.phase1.store(0);

            FfResults<FfHit> results;
            runFortressSearch(cfg, &gProgress, results, request.threads);

            if (gProgress.try_stop.load()) break;

            auto hits = results.getAllResults();
            for (const FfHit &hit : hits) {
                FortressHit item;
                item.seed = seed;
                item.x = hit.outX;
                item.y = hit.outY;
                item.z = hit.outZ;
                if (request.mode == 0) {
                    item.crossings = hit.shapeCode == 1 ? 2
                        : hit.shapeCode == 2 ? 3
                        : hit.shapeCode == 3 ? 4
                        : 2;
                } else {
                    item.spanX = hit.longEdge;
                    item.spanY = hit.heightEdge;
                    item.spanZ = hit.shortEdge;
                    item.area = item.spanX > 0 && item.spanZ > 0 ? item.spanX * item.spanZ : 0;
                }
                all.push_back(item);
            }
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::exception &ex) {
        error = ex.what();
    } catch (...) {
        error = "fortress-search-failed";
    }

    std::sort(all.begin(), all.end(), [&](const FortressHit &a, const FortressHit &b) {
        return hitLess(a, b, request.mode);
    });
    if (gProgress.try_stop.load()) all.clear();
    if (all.size() > static_cast<size_t>(kOutputLimit)) all.resize(kOutputLimit);

    publish(std::move(all), false, true, error);
    searchGateRelease(SearchOwner::Fortress);
}

} // namespace

std::string fortressStart(const FortressRequest &request)
{
    if (request.seeds.empty()) return "no-seeds";
    if (request.mc < MC_1_18 || request.mc > MC_NEWEST) return "unsupported-version";
    if (request.threads < 1 || request.threads > kMaxThreads) return "bad-bounds";
    if (request.mode != 0 && request.mode != 1) return "bad-bounds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    if (request.minX < -kWorldLimit || request.maxX > kWorldLimit ||
        request.minZ < -kWorldLimit || request.maxZ > kWorldLimit) {
        return "area-too-large";
    }

    const long long width = static_cast<long long>(request.maxX) - request.minX + 1;
    const long long height = static_cast<long long>(request.maxZ) - request.minZ + 1;
    const long long rectArea = width * height;
    if (rectArea <= 0) return "bad-bounds";

    const int centerX = static_cast<int>((static_cast<long long>(request.minX) + request.maxX) / 2);
    const int centerZ = static_cast<int>((static_cast<long long>(request.minZ) + request.maxZ) / 2);
    long long r = std::max(static_cast<long long>(centerX) - request.minX,
                           static_cast<long long>(request.maxX) - centerX);
    r = std::max(r, static_cast<long long>(centerZ) - request.minZ);
    r = std::max(r, static_cast<long long>(request.maxZ) - centerZ);
    const long long side = 2 * r + 1;
    if (side > 30000000LL || side * side > kMaxArea) return "area-too-large";

    if (request.mode == 0) {
        if (request.crossFilter < 2 || request.crossFilter > 4) return "bad-level";
    } else {
        if (request.minLong < 0 || request.minLong > 260) return "bad-span-edge";
        const int shortEdge = request.minShort > 0 ? request.minShort : request.minLong;
        if (shortEdge < 0 || shortEdge > 260) return "bad-span-edge";
        if (request.minHeight < 0 || request.minHeight > 40) return "bad-span-height";
    }

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Fortress)) return "busy";

    gProgress.current.store(0);
    gProgress.total.store(0);
    gProgress.phase1.store(0);
    gProgress.chunkInRunning.store(0);
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
        searchGateRelease(SearchOwner::Fortress);
        return "fortress-start-failed";
    }
    return "";
}

void fortressPause()
{
    gProgress.try_pause.store(true);
}

void fortressResume()
{
    gProgress.try_pause.store(false);
}

void fortressStop()
{
    gProgress.try_stop.store(true);
}

FortressStatus fortressPoll()
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
