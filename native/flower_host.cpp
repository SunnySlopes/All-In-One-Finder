#include "flower_host.h"

#include "FlowerFarmSearch.h"
#include "search_gate.h"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <exception>
#include <mutex>
#include <new>
#include <thread>

namespace {

constexpr int kMaxThreads = 256;
constexpr int kMaxHits = 1000;
constexpr int kMinWindow = 256;
constexpr int kMaxWindow = 1024;
constexpr int kWorldMin = -30000000;
constexpr int kWorldMax = 30000000;
constexpr int64_t kMaxSpan = 60000001;

std::mutex gMu;
std::thread gThread;
FlowerStatus gStatus;
std::vector<FlowerHit> gCollected;

std::atomic_bool gPause{false};
std::atomic_bool gStop{false};
std::atomic_int gPhase{0};
std::atomic_int gCurrent{0};
std::atomic_int gTotal{0};
std::atomic_int gPhaseCurrent{0};
std::atomic_int gPhaseTotal{0};
std::atomic_int gOverallCurrent{0};
std::atomic_int gOverallTotal{0};
std::atomic_int gStage{0};

void resetControl()
{
    gPhase.store(0);
    gCurrent.store(0);
    gTotal.store(0);
    gPhaseCurrent.store(0);
    gPhaseTotal.store(0);
    gOverallCurrent.store(0);
    gOverallTotal.store(0);
    gStage.store(0);
}

void publishHits()
{
    gStatus.hits = gCollected;
}

void publishDone(const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    if (gStop.load()) {
        gCollected.clear();
        gStatus.hits.clear();
    } else {
        if (gCollected.size() > static_cast<size_t>(kMaxHits)) gCollected.resize(kMaxHits);
        publishHits();
    }
    gStatus.running = false;
    gStatus.done = true;
    gStatus.error = error;
    gStatus.paused = gPause.load();
}

FlowerHit convert(const FlowerRow &row, int64_t seed)
{
    FlowerHit hit;
    hit.seed = seed;
    hit.x = row.cx;
    hit.z = row.cz;
    hit.sideX = row.sideX;
    hit.sideZ = row.sideZ;
    hit.flowerArea = row.flowerArea;
    hit.paleArea = row.paleArea;
    hit.swampArea = row.swampArea;
    hit.flowerX = row.flowerX;
    hit.flowerY = row.flowerY;
    hit.flowerZ = row.flowerZ;
    hit.paleX = row.paleX;
    hit.paleZ = row.paleZ;
    hit.swampX = row.swampX;
    hit.swampZ = row.swampZ;
    hit.orient = row.orient;
    hit.nether = row.nether;
    hit.bonus = row.bonus;
    return hit;
}

void job(FlowerRequest request)
{
    std::string error;
    FlowerSearchControl control{&gCurrent, &gTotal, &gPhase, &gPause, &gStop,
                                &gPhaseCurrent, &gPhaseTotal, &gOverallCurrent, &gOverallTotal,
                                &gStage};
    const int frameStep = request.fastMode ? 16 : 4;

    for (size_t index = 0; index < request.seeds.size(); index++) {
        if (gStop.load()) break;
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus.seedIndex = static_cast<int>(index);
            gStatus.current = 0;
            gStatus.total = 0;
        }
        resetControl();
        while (gPause.load() && !gStop.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        if (gStop.load()) break;

        const int64_t seed = request.seeds[index];
        std::vector<FlowerRow> rows;
        FlowerSearchOptions options;
        options.requireBothWildflowers = request.bothWildflowers;
        options.requireBasaltDeltas = request.requireBasalt;
        options.orientation = request.orientation;
        options.flowerCenterMargin = request.flowerCenterMargin;
        try {
            rows = runFlowerFarmSearchRows(
                static_cast<uint64_t>(seed), request.mc,
                request.minX, request.minZ, request.maxX, request.maxZ,
                request.longSide, request.shortSide, request.squareOnly,
                frameStep, request.threads, control, options);
        } catch (const std::bad_alloc &) {
            error = "out-of-memory";
            break;
        } catch (const std::exception &) {
            error = "flower-start-failed";
            break;
        }

        if (gStop.load()) break;
        std::lock_guard<std::mutex> lock(gMu);
        for (const FlowerRow &row : rows) gCollected.push_back(convert(row, seed));
        if (gCollected.size() > static_cast<size_t>(kMaxHits)) gCollected.resize(kMaxHits);
        publishHits();
    }

    publishDone(error);
    searchGateRelease(SearchOwner::Flower);
}

bool validWindow(const FlowerRequest &request)
{
    if (request.orientation < 0 || request.orientation > 2) return false;
    if (request.flowerCenterMargin < 0) return false;
    if (request.longSide < kMinWindow || request.longSide > kMaxWindow) return false;
    if (request.squareOnly) return true;
    return request.shortSide >= kMinWindow && request.shortSide <= kMaxWindow &&
           request.shortSide <= request.longSide;
}

} // namespace

std::string flowerStart(const FlowerRequest &request)
{
    if (request.mc <= 0) return "unsupported-version";
    if (request.seeds.empty()) return "no-seeds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    if (request.minX < kWorldMin || request.maxX > kWorldMax ||
        request.minZ < kWorldMin || request.maxZ > kWorldMax) {
        return "area-too-large";
    }
    const int64_t spanX = static_cast<int64_t>(request.maxX) - request.minX + 1;
    const int64_t spanZ = static_cast<int64_t>(request.maxZ) - request.minZ + 1;
    if (spanX > kMaxSpan || spanZ > kMaxSpan) return "area-too-large";
    if (!validWindow(request)) return "bad-bounds";

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Flower)) return "busy";

    gPause.store(false);
    gStop.store(false);
    resetControl();
    FlowerRequest normalized = request;
    normalized.threads = std::max(1, std::min(kMaxThreads, normalized.threads));
    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus = {};
        gCollected.clear();
        gStatus.running = true;
        gStatus.seedCount = static_cast<int>(normalized.seeds.size());
    }
    try {
        gThread = std::thread(job, normalized);
    } catch (const std::exception &) {
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus = {};
        }
        searchGateRelease(SearchOwner::Flower);
        return "flower-start-failed";
    }
    return "";
}

void flowerPause()
{
    gPause.store(true);
}

void flowerResume()
{
    gPause.store(false);
}

void flowerStop()
{
    gStop.store(true);
}

FlowerStatus flowerPoll()
{
    bool running = false;
    {
        std::lock_guard<std::mutex> lock(gMu);
        running = gStatus.running;
    }
    if (!running && gThread.joinable()) gThread.join();

    std::lock_guard<std::mutex> lock(gMu);
    const int rawPhase = gPhase.load();
    /* The engine's merge/cluster tail (stage=1) is phase 2; verification is
     * phase 3 in the submodule's phase order. */
    gStatus.phase = (rawPhase == 1 && gStage.load() != 0) ? 2 : rawPhase;
    gStatus.current = gCurrent.load();
    gStatus.total = gTotal.load();
    /* phaseCurrent/phaseTotal mirror the live phase counters: phase 1 gets its
     * concrete totals from the engine (not the 1-unit placeholder). */
    gStatus.phaseCurrent = gStatus.current;
    gStatus.phaseTotal = gStatus.total;
    gStatus.overallCurrent = gOverallCurrent.load();
    gStatus.overallTotal = gOverallTotal.load();
    gStatus.paused = gPause.load();
    return gStatus;
}
