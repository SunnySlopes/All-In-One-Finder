#include "river_host.h"

#include "search_gate.h"

/*
 * tools/river 只有 river_finder.cpp 一份实现（没有单独的头文件），上游的
 * JNI 桥与 riverFinderLib.cpp 都是直接 include 它。这里沿用同一做法：
 * 只在本宿主 TU 里包含一次，避免和独立的 river_finder.cpp 目标重复符号。
 * 方案 4.7 里"不要同时编译 riverFinderLib.cpp 和 river_finder.cpp"同理。
 */
#include "../tools/river/river_finder.cpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <exception>
#include <mutex>
#include <thread>
#include <unordered_set>
#include <vector>

namespace {

constexpr int kRingOuter = 128;
constexpr int kRefineRadius = 160; /* 上游: x-128-32, 256+64 */
constexpr int kRefineSize = 320;
constexpr double kRefineThreshold = 0.9;
constexpr int kOutputLimit = 1000;
constexpr int64_t kOutputCell = 64;
constexpr int kMaxThreads = 256;

std::mutex gMu;
std::thread gThread;
RiverStatus gStatus;
riverfinder::Progress gProgress;

riverfinder::ThreadSafeResults<riverfinder::Res> gResults;

int floorDiv(int value, int divisor)
{
    int q = value / divisor;
    int r = value % divisor;
    if (r != 0 && ((r < 0) != (divisor < 0))) --q;
    return q;
}

void publish(const std::vector<RiverHit> &hits, bool running, bool done, const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.hits = hits;
    gStatus.running = running;
    gStatus.done = done;
    gStatus.error = error;
    gStatus.paused = gProgress.try_pause.load();
}

void setStage(int stage, int64_t total, int64_t current)
{
    gProgress.phase1.store(stage);
    gProgress.total.store(static_cast<int>(total));
    gProgress.current.store(static_cast<int>(current));
    gProgress.chunkInRunning.store(0);
}

void waitWhilePaused()
{
    while (gProgress.try_pause.load() && !gProgress.try_stop.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

/*
 * 输出过滤：每个 64×64 方块格子只保留分数最高的一个点，按分数降序。
 * 上游会合并邻近结果，这里保持同样的"每格唯一 + 1000 条上限"。
 */
std::vector<riverfinder::Res> filterByCell(std::vector<riverfinder::Res> hits)
{
    std::ranges::sort(hits, [](const riverfinder::Res &a, const riverfinder::Res &b) {
        return a.score > b.score;
    });
    std::vector<riverfinder::Res> out;
    out.reserve(hits.size());
    std::unordered_set<uint64_t> cells;
    cells.reserve(hits.size());
    for (const riverfinder::Res &hit : hits) {
        const int cellX = floorDiv(hit.point.x, static_cast<int>(kOutputCell));
        const int cellZ = floorDiv(hit.point.y, static_cast<int>(kOutputCell));
        const uint64_t key = (static_cast<uint64_t>(static_cast<uint32_t>(cellX)) << 32)
            | static_cast<uint32_t>(cellZ);
        if (!cells.insert(key).second) continue;
        out.push_back(hit);
        if (out.size() >= static_cast<size_t>(kOutputLimit)) break;
    }
    return out;
}

void job(RiverRequest request)
{
    std::vector<RiverHit> all;
    std::string error;

    const double caveFactor = request.calcCave ? 1.0 : 0.0;
    const long long rawWidth = static_cast<long long>(request.maxX) - request.minX + 1;
    const long long rawHeight = static_cast<long long>(request.maxZ) - request.minZ + 1;
    const int startX = request.minX - kRingOuter;
    const int startZ = request.minZ - kRingOuter;
    const int width = static_cast<int>(rawWidth + 2LL * kRingOuter);
    const int height = static_cast<int>(rawHeight + 2LL * kRingOuter);

    std::vector<RiverHit> seedHits;

    try {
        Generator generator;
        setupGenerator(&generator, request.mc, FORCE_OCEAN_VARIANTS);

        for (size_t index = 0; index < request.seeds.size(); index++) {
            if (gProgress.try_stop.load()) break;
            {
                std::lock_guard<std::mutex> lock(gMu);
                gStatus.seedIndex = static_cast<int>(index);
            }
            waitWhilePaused();
            if (gProgress.try_stop.load()) break;

            const int64_t seed = request.seeds[index];
            applySeed(&generator, DIM_OVERWORLD, static_cast<uint64_t>(seed));

            gResults.clear();
            setStage(1, 0, 0);

            riverfinder::findBiggestRiverParallelPool(
                gResults, &generator, startX, startZ, width, height, request.y,
                request.minScore, caveFactor, &gProgress, request.threads);

            if (gProgress.try_stop.load()) break;

            auto coarse = gResults.getAllResults();
            std::ranges::sort(coarse, [](const riverfinder::Res &a, const riverfinder::Res &b) {
                return a.score > b.score;
            });

            setStage(2, static_cast<int64_t>(coarse.size()), 0);

            int maxScore = 0;
            int64_t current = 0;
            std::vector<riverfinder::Res> accepted;
            accepted.reserve(coarse.size());

            for (const riverfinder::Res &candidate : coarse) {
                if (gProgress.try_stop.load()) break;
                waitWhilePaused();
                if (gProgress.try_stop.load()) break;

                auto refined = riverfinder::findBiggestRiver<1>(
                    &generator,
                    candidate.point.x - kRefineRadius,
                    candidate.point.y - kRefineRadius,
                    kRefineSize,
                    kRefineSize,
                    request.y,
                    1,
                    1.0,
                    caveFactor);

                ++current;
                gProgress.current.store(static_cast<int>(current));

                if (!refined.empty() && refined[0].score > maxScore * kRefineThreshold) {
                    accepted.push_back(refined[0]);
                    if (refined[0].score > maxScore) maxScore = refined[0].score;
                } else {
                    /* 上游同款提前结束：后续候选不可能再翻盘。 */
                    gProgress.total.store(static_cast<int>(current));
                    break;
                }
            }

            if (gProgress.try_stop.load()) break;

            auto filtered = filterByCell(std::move(accepted));
            seedHits.clear();
            seedHits.reserve(filtered.size());
            for (const riverfinder::Res &hit : filtered) {
                RiverHit item;
                item.seed = seed;
                item.x = hit.point.x;
                item.z = hit.point.y;
                item.sampleY = request.y;
                item.river = hit.riverArea;
                item.cave = hit.caveArea;
                item.score = hit.score;
                seedHits.push_back(item);
            }
            all.insert(all.end(), seedHits.begin(), seedHits.end());
            if (gProgress.try_stop.load()) break;
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::exception &ex) {
        error = ex.what();
    }

    setStage(-1, 0, 0);
    if (gProgress.try_stop.load()) {
        all.clear();
    } else {
        std::ranges::sort(all, [](const RiverHit &a, const RiverHit &b) {
            if (a.score != b.score) return a.score > b.score;
            const int64_t da = static_cast<int64_t>(a.x) * a.x + static_cast<int64_t>(a.z) * a.z;
            const int64_t db = static_cast<int64_t>(b.x) * b.x + static_cast<int64_t>(b.z) * b.z;
            if (da != db) return da < db;
            if (a.x != b.x) return a.x < b.x;
            return a.z < b.z;
        });
        if (all.size() > static_cast<size_t>(kOutputLimit)) all.resize(kOutputLimit);
    }
    publish(all, false, true, error);
    searchGateRelease(SearchOwner::River);
}

} // namespace

std::string riverStart(const RiverRequest &request)
{
    if (request.mc < MC_1_18 || request.mc > MC_NEWEST) return "unsupported-version";
    if (request.seeds.empty()) return "no-seeds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    if (request.minX < -30000000 || request.maxX > 30000000 ||
        request.minZ < -30000000 || request.maxZ > 30000000) {
        return "area-too-large";
    }
    const long long width = static_cast<long long>(request.maxX) - request.minX + 1;
    const long long height = static_cast<long long>(request.maxZ) - request.minZ + 1;
    if (width <= 0 || height <= 0) return "bad-bounds";
    if (width > 60000001LL || height > 60000001LL) return "area-too-large";
    if (request.minScore < 0) return "bad-bounds";
    if (request.y < -64 || request.y > 320) return "bad-bounds";
    if (request.threads < 1 || request.threads > kMaxThreads) return "bad-bounds";

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::River)) return "busy";

    gProgress.try_pause.store(false);
    gProgress.try_stop.store(false);
    gProgress.phase1.store(0);
    gProgress.current.store(0);
    gProgress.total.store(0);
    gProgress.chunkInRunning.store(0);
    gResults.clear();

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
        searchGateRelease(SearchOwner::River);
        return "river-start-failed";
    }
    return "";
}

void riverPause()
{
    gProgress.try_pause.store(true);
}

void riverResume()
{
    gProgress.try_pause.store(false);
}

void riverStop()
{
    gProgress.try_stop.store(true);
}

RiverStatus riverPoll()
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
    gStatus.stage = gProgress.phase1.load();
    gStatus.current = gProgress.current.load();
    gStatus.total = gProgress.total.load();
    gStatus.paused = gProgress.try_pause.load();
    return gStatus;
}
