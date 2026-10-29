#include "double_monument_host.h"

#include "double_monument_compat.h"
#include "search_gate.h"

#include "cubiomes/biomes.h"

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
constexpr int kWorldLimit = 30000000;
constexpr int kRegionSize = 512;
constexpr int kSingleSideLimit = 262144;
constexpr int kListSideLimit = 131072;

std::mutex gMu;
std::thread gThread;
MonumentStatus gStatus;
DoubleProgress gProgress;

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

bool hitLess(const MonumentHit &a, const MonumentHit &b)
{
    if (a.lowEfficiency != b.lowEfficiency) return a.lowEfficiency < b.lowEfficiency;
    const int64_t da = originDist2(a.x, a.z);
    const int64_t db = originDist2(b.x, b.z);
    if (da != db) return da < db;
    if (a.x != b.x) return a.x < b.x;
    return a.z < b.z;
}

void classifyOceanTypes(std::vector<MonumentHit> &hits, int mc)
{
    std::unordered_set<int64_t> seeds;
    seeds.reserve(hits.size());
    for (const MonumentHit &hit : hits) seeds.insert(hit.seed);

    for (int64_t seed : seeds) {
        DmMonumentGenerator *gen = dm_monument_generator_alloc();
        if (!gen) continue;
        dm_monument_init_generator(gen, mc, static_cast<uint64_t>(seed));
        for (MonumentHit &hit : hits) {
            if (hit.seed != seed) continue;
            hit.oceanTypes = dm_monument_classify_ocean_types_g(gen, mc, hit.x, hit.z);
            hit.oceanType = legacyOceanType(hit.oceanTypes);
        }
        dm_monument_generator_free(gen);
    }
}

void job(DoubleMonumentRequest request)
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

            DoubleMonumentConfig cfg{};
            cfg.seed = static_cast<uint64_t>(seed);
            cfg.minX = regMinX;
            cfg.maxX = regMaxX;
            cfg.minZ = regMinZ;
            cfg.maxZ = regMaxZ;
            cfg.mc = request.mc;
            cfg.pauseOnPairFound = false;

            gProgress.current.store(0);
            gProgress.total.store(0);
            gProgress.status.store(0);

            DoubleResults<DoublePairHit> results;
            runDoubleMonumentSearch(cfg, &gProgress, results, request.threads);

            if (gProgress.try_stop.load()) break;

            auto hits = results.getAllResults();
            for (const DoublePairHit &hit : hits) {
                MonumentHit item;
                item.seed = seed;
                item.x = hit.hangX;
                item.z = hit.hangZ;
                item.dx = hit.dx;
                item.dz = hit.dz;
                item.count = 2;
                item.lowEfficiency = hit.lowEfficiency != 0 ? 1 : 0;
                all.push_back(item);
            }
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::exception &ex) {
        error = ex.what();
    } catch (...) {
        error = "double-monument-search-failed";
    }

    std::sort(all.begin(), all.end(), hitLess);
    if (gProgress.try_stop.load()) all.clear();
    if (all.size() > static_cast<size_t>(kOutputLimit)) all.resize(kOutputLimit);
    if (error.empty()) classifyOceanTypes(all, request.mc);

    publish(std::move(all), false, true, error);
    searchGateRelease(SearchOwner::DoubleMonument);
}

} // namespace

std::string doubleMonumentStart(const DoubleMonumentRequest &request)
{
    if (request.seeds.empty()) return "no-seeds";
    if (request.mc < MC_1_18 || request.mc > MC_NEWEST) return "unsupported-version";
    if (request.threads < 1 || request.threads > kMaxThreads) return "bad-bounds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    if (request.minX < -kWorldLimit || request.maxX > kWorldLimit ||
        request.minZ < -kWorldLimit || request.maxZ > kWorldLimit) {
        return "area-too-large";
    }

    const int sideLimit = request.seeds.size() > 1 ? kListSideLimit : kSingleSideLimit;
    const long long width = static_cast<long long>(request.maxX) - request.minX + 1;
    const long long height = static_cast<long long>(request.maxZ) - request.minZ + 1;
    if (width > sideLimit || height > sideLimit) return "range-too-large";

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::DoubleMonument)) return "busy";

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
        searchGateRelease(SearchOwner::DoubleMonument);
        return "double-monument-start-failed";
    }
    return "";
}

void doubleMonumentPause()
{
    gProgress.try_pause.store(true);
}

void doubleMonumentResume()
{
    gProgress.try_pause.store(false);
}

void doubleMonumentStop()
{
    gProgress.try_stop.store(true);
}

MonumentStatus doubleMonumentPoll()
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
