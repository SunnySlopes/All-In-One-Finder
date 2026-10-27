#include "trial_host.h"

#include "search.hpp"
#include "search_gate.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

constexpr int kMaxThreads = 32;
constexpr int kMaxLimit = 1000;
constexpr int kMaxClusterRadius = 8192;
constexpr int kMaxWindowSide = 16384;
constexpr int kWorldMin = -30000000;
constexpr int kWorldMax = 29999999;

std::mutex gMu;
std::thread gThread;
TrialStatus gStatus;
TrialRequest gRequest;
int gResumeSeed = 0;
std::vector<TrialHit> gCollected;
std::shared_ptr<trial::Control> gControl;

std::atomic_bool gStop{false};
std::atomic_bool gPauseRequested{false};
std::atomic_bool gPausing{false};
std::atomic_bool gCancelIssued{false};
std::atomic<uint64_t> gPauseBaseline{0};
std::atomic<uint64_t> gCompleted{0};
std::atomic<uint64_t> gTotal{0};
std::atomic<uint64_t> gCandidates{0};
std::atomic<uint64_t> gLayouts{0};
std::atomic<uint64_t> gPruned{0};
std::atomic<uint64_t> gFound{0};
std::atomic<uint64_t> gChunks{0};
std::atomic<int64_t> gElapsedMs{0};
std::atomic_int gPhase{0};
std::atomic_bool gTruncated{false};

#ifdef _WIN32
/** The engine stores checkpoint_directory as a narrow std::string; hand it the ANSI path form. */
std::string ansiPath(const std::filesystem::path &path)
{
    const std::wstring wide = path.wstring();
    const int length = WideCharToMultiByte(CP_ACP, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (length <= 1) return path.string();
    std::string out(static_cast<size_t>(length - 1), '\0');
    WideCharToMultiByte(CP_ACP, 0, wide.c_str(), -1, out.data(), length, nullptr, nullptr);
    return out;
}
#else
std::string ansiPath(const std::filesystem::path &path)
{
    return path.string();
}
#endif

std::filesystem::path utf8Path(const char *text)
{
    return std::filesystem::path(reinterpret_cast<const char8_t *>(text));
}

std::filesystem::path checkpointDirectory()
{
    if (const char *explicitDir = std::getenv("AIO_TRIAL_CHECKPOINTS"); explicitDir && *explicitDir)
        return utf8Path(explicitDir);
    if (const char *dataDir = std::getenv("AIO_DATA_DIR"); dataDir && *dataDir)
        return utf8Path(dataDir) / "checkpoints" / "trial-native";
    std::error_code ec;
    const auto temp = std::filesystem::temp_directory_path(ec);
    if (ec) return {};
    return temp / "aio-trial-checkpoints";
}

std::string checkpointDirectoryText()
{
    const auto dir = checkpointDirectory();
    return dir.empty() ? std::string() : ansiPath(dir);
}

void clearCheckpoints()
{
    const auto dir = checkpointDirectory();
    if (dir.empty()) return;
    std::error_code ec;
    if (!std::filesystem::exists(dir, ec)) return;
    for (const auto &entry : std::filesystem::directory_iterator(dir, ec)) {
        const std::string name = entry.path().filename().string();
        if (name.rfind("native-v5-", 0) != 0) continue;
        std::error_code removeEc;
        std::filesystem::remove(entry.path(), removeEc);
    }
}

void removeCheckpointFile(const std::string &path)
{
    if (path.empty()) return;
    std::error_code ec;
    // checkpoint_path came back from the engine as a native narrow path (ANSI on Windows).
    std::filesystem::remove(std::filesystem::path(path), ec);
}

void resetProgress()
{
    gCompleted.store(0);
    gTotal.store(0);
    gCandidates.store(0);
    gLayouts.store(0);
    gPruned.store(0);
    gFound.store(0);
    gChunks.store(0);
    gElapsedMs.store(0);
}

std::shared_ptr<trial::Control> currentControl()
{
    std::lock_guard<std::mutex> lock(gMu);
    return gControl;
}

trial::Options optionsFor(const TrialRequest &request, int64_t seed, const std::string &checkpointDir)
{
    trial::Options options;
    options.seed = static_cast<uint64_t>(seed);
    options.seed_text = std::to_string(seed);
    options.generation = request.generation;
    if (request.fullWorld) {
        options.full_world = true;
        options.center_x = 0;
        options.center_z = 0;
        options.radius = 100000;
    } else {
        options.search_rect = true;
        options.min_x = request.minX;
        options.max_x = request.maxX;
        options.min_z = request.minZ;
        options.max_z = request.maxZ;
        // 精确四至的排名中心取矩形中点；分片调度也使用同一个中心。
        options.center_x = static_cast<int>((int64_t(request.minX) + request.maxX) / 2);
        options.center_z = static_cast<int>((int64_t(request.minZ) + request.maxZ) / 2);
        options.radius = std::max(request.maxX - request.minX, request.maxZ - request.minZ) / 2 + 1;
    }
    options.search_square = true;
    if (request.clusterCircle) {
        options.cluster_square = false;
        options.cluster_radius = request.clusterRadius;
    } else {
        options.cluster_rect = true;
        options.cluster_long = request.clusterLongSide;
        options.cluster_short = request.clusterShortSide;
        options.cluster_radius = std::max(request.clusterLongSide, request.clusterShortSide) / 2;
        options.cluster_square = false;
    }
    options.min_structures = request.minStructures;
    options.min_spawners = request.minSpawners;
    options.threads = request.threads;
    options.result_limit = request.limit;
    options.conversion_ratio = request.conversionRatio;
    options.shard_size = 0;
    options.checkpoint_directory = checkpointDir;
    return options;
}

TrialHit convert(const trial::Result &result, int64_t seed, double ratio)
{
    TrialHit hit;
    hit.seed = seed;
    hit.x = result.x;
    hit.z = result.z;
    hit.structures = result.count;
    hit.spawners = result.spawners;
    hit.fastSpawners = result.fast_spawners;
    hit.slowSpawners = result.slow_spawners;
    const double converted = trial::converted_spawners(result, ratio);
    hit.converted = std::round(converted * 10.0) / 10.0;
    return hit;
}

void job(TrialRequest request, int startSeed)
{
    const std::string checkpointDir = checkpointDirectoryText();
    const auto control = std::make_shared<trial::Control>();
    {
        std::lock_guard<std::mutex> lock(gMu);
        gControl = control;
    }
    const double ratio = request.conversionRatio;
    std::string error;
    int runningSeed = startSeed;
    int index = startSeed;
    const int seedCount = static_cast<int>(request.seeds.size());

    for (; index < seedCount; ++index) {
        runningSeed = index;
        if (gStop.load()) break;
        if (gPauseRequested.load()) break;
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus.seedIndex = index;
        }
        resetProgress();
        gPhase.store(1);

        trial::Options options = optionsFor(request, request.seeds[index], checkpointDir);
        trial::SearchOutput output;
        bool cancelled = false;
        bool finishedSeed = false;
        try {
            output = trial::search(options, *control, [&](const trial::Progress &progress) {
                gCompleted.store(progress.completed);
                gTotal.store(progress.total);
                gCandidates.store(progress.candidates);
                gLayouts.store(progress.layouts);
                gPruned.store(progress.pruned);
                gFound.store(progress.found);
                gChunks.store(progress.chunks);
                gElapsedMs.store(static_cast<int64_t>(std::llround(progress.elapsed_ms)));
                // P2 safe-point pause: let the in-flight shard finish, then cancel. The engine
                // saves the checkpoint (forced) before rethrowing Cancelled.
                if (!gStop.load() && gPauseRequested.load() && !gCancelIssued.load() &&
                    progress.completed > gPauseBaseline.load()) {
                    gCancelIssued.store(true);
                    control->cancel();
                }
            });
            finishedSeed = true;
        } catch (const trial::Cancelled &) {
            cancelled = true;
        } catch (const std::bad_alloc &) {
            error = "out-of-memory";
        } catch (const std::exception &) {
            error = "trial-start-failed";
        }

        if (finishedSeed) {
            {
                std::lock_guard<std::mutex> lock(gMu);
                for (const auto &result : output.results)
                    gCollected.push_back(convert(result, request.seeds[index], ratio));
                if (request.limit > 0 && output.results.size() >= static_cast<size_t>(request.limit))
                    gTruncated.store(true);
                gStatus.hits = gCollected;
            }
            gFound.store(output.results.size());
            removeCheckpointFile(output.checkpoint_path);
            continue;
        }
        if (cancelled) {
            if (!gStop.load() && !gPauseRequested.load()) error = "trial-start-failed";
            break;
        }
        break;
    }

    const bool stopped = gStop.load();
    const bool allSeedsDone = index >= seedCount;
    const bool paused = !stopped && !allSeedsDone && gPauseRequested.load();
    const int finalPhase = paused ? 1 : 2;
    gPhase.store(finalPhase);
    gPausing.store(false);
    if (paused) {
        runningSeed = std::min(runningSeed, seedCount - 1);
    } else if (allSeedsDone) {
        runningSeed = seedCount > 0 ? seedCount - 1 : 0;
    }

    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus.running = false;
        gStatus.done = !paused;
        gStatus.paused = paused;
        gStatus.pausing = false;
        gStatus.phase = finalPhase;
        gStatus.error = error;
        if (stopped) {
            gCollected.clear();
            gStatus.hits.clear();
            gTruncated.store(false);
        }
        if (paused) {
            gResumeSeed = runningSeed;
            gStatus.seedIndex = runningSeed;
        }
        gControl.reset();
    }
    if (stopped) clearCheckpoints();
    searchGateRelease(SearchOwner::Trial);
}

bool validRequest(const TrialRequest &request, std::string &error)
{
    if (request.generation < 1 || request.generation > 3) {
        error = "unsupported-version";
        return false;
    }
    if (request.seeds.empty()) {
        error = "no-seeds";
        return false;
    }
    if (!request.fullWorld) {
        if (request.minX > request.maxX || request.minZ > request.maxZ) {
            error = "bad-bounds";
            return false;
        }
        if (request.minX < kWorldMin || request.maxX > kWorldMax || request.minZ < kWorldMin ||
            request.maxZ > kWorldMax) {
            error = "bad-bounds";
            return false;
        }
    }
    if (request.clusterCircle) {
        if (request.clusterRadius < 1 || request.clusterRadius > kMaxClusterRadius) {
            error = "bad-bounds";
            return false;
        }
    } else if (request.clusterLongSide < 1 || request.clusterLongSide > kMaxWindowSide ||
               request.clusterShortSide < 1 || request.clusterShortSide > kMaxWindowSide ||
               request.clusterShortSide > request.clusterLongSide) {
        error = "bad-bounds";
        return false;
    }
    if (request.minStructures < 1 || request.minSpawners < 0) {
        error = "bad-bounds";
        return false;
    }
    return true;
}

} // namespace

std::string trialStart(const TrialRequest &request)
{
    std::string error;
    if (!validRequest(request, error)) return error;
    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Trial)) return "busy";

    TrialRequest normalized = request;
    normalized.threads = std::max(1, std::min(kMaxThreads, normalized.threads));
    // 产品固定每种子 1,000 条；该值不再由 UI 传入。
    normalized.limit = kMaxLimit;
    normalized.conversionRatio = std::max(0.0, std::min(1.0, normalized.conversionRatio));
    normalized.minSpawners = std::max(0, normalized.minSpawners);
    normalized.minStructures = std::max(1, normalized.minStructures);
    normalized.clusterRadius = std::max(1, std::min(kMaxClusterRadius, normalized.clusterRadius));
    normalized.clusterLongSide = std::max(1, std::min(kMaxWindowSide, normalized.clusterLongSide));
    normalized.clusterShortSide =
        std::max(1, std::min(normalized.clusterLongSide, normalized.clusterShortSide));

    // A fresh start always discards old checkpoints: only the explicit resume path may
    // continue from a partially finished search.
    clearCheckpoints();
    gStop.store(false);
    gPauseRequested.store(false);
    gPausing.store(false);
    gCancelIssued.store(false);
    gPauseBaseline.store(0);
    gTruncated.store(false);
    gPhase.store(0);
    resetProgress();

    {
        std::lock_guard<std::mutex> lock(gMu);
        gRequest = normalized;
        gResumeSeed = 0;
        gCollected.clear();
        gStatus = {};
        gStatus.running = true;
        gStatus.seedCount = static_cast<int>(normalized.seeds.size());
    }
    try {
        gThread = std::thread(job, normalized, 0);
    } catch (const std::exception &) {
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus = {};
            gStatus.done = true;
            gStatus.phase = 2;
            gStatus.error = "trial-start-failed";
        }
        gPhase.store(2);
        searchGateRelease(SearchOwner::Trial);
        return "trial-start-failed";
    }
    return "";
}

void trialPause()
{
    std::lock_guard<std::mutex> lock(gMu);
    if (!gStatus.running || gStatus.paused) return;
    gPauseRequested.store(true);
    gPausing.store(true);
    gStatus.pausing = true;
    gPauseBaseline.store(gCompleted.load());
}

void trialResume()
{
    TrialRequest request;
    int start = 0;
    {
        std::lock_guard<std::mutex> lock(gMu);
        if (!gStatus.paused || gStatus.running) return;
        request = gRequest;
        start = gResumeSeed;
    }
    if (start < 0 || start >= static_cast<int>(request.seeds.size())) return;
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Trial)) {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus.paused = false;
        gStatus.done = true;
        gStatus.phase = 2;
        gStatus.error = "busy";
        return;
    }

    gStop.store(false);
    gPauseRequested.store(false);
    gPausing.store(false);
    gCancelIssued.store(false);
    gPauseBaseline.store(0);
    resetProgress();
    gPhase.store(1);
    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus.running = true;
        gStatus.done = false;
        gStatus.paused = false;
        gStatus.pausing = false;
        gStatus.phase = 1;
        gStatus.error = "";
        gStatus.seedIndex = start;
    }
    try {
        gThread = std::thread(job, request, start);
    } catch (const std::exception &) {
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus.running = false;
            gStatus.done = true;
            gStatus.paused = false;
            gStatus.pausing = false;
            gStatus.phase = 2;
            gStatus.error = "trial-start-failed";
        }
        gPhase.store(2);
        searchGateRelease(SearchOwner::Trial);
    }
}

void trialStop()
{
    bool clearPaused = false;
    {
        std::lock_guard<std::mutex> lock(gMu);
        if (!gStatus.running) {
            if (!gStatus.paused) return;
            gStatus.paused = false;
            gStatus.pausing = false;
            gStatus.done = true;
            gStatus.phase = 2;
            gStatus.error = "";
            gCollected.clear();
            gStatus.hits.clear();
            gResumeSeed = 0;
            gPauseRequested.store(false);
            gPausing.store(false);
            gTruncated.store(false);
            gPhase.store(2);
            clearPaused = true;
        }
    }
    if (clearPaused) {
        clearCheckpoints();
        return;
    }
    gStop.store(true);
    const auto control = currentControl();
    if (control) control->cancel();
}

TrialStatus trialPoll()
{
    {
        bool running = false;
        {
            std::lock_guard<std::mutex> lock(gMu);
            running = gStatus.running;
        }
        if (!running && gThread.joinable()) gThread.join();
    }

    std::lock_guard<std::mutex> lock(gMu);
    gStatus.phase = gPhase.load();
    gStatus.current = static_cast<int64_t>(gCompleted.load());
    gStatus.total = static_cast<int64_t>(gTotal.load());
    gStatus.candidates = static_cast<int64_t>(gCandidates.load());
    gStatus.layouts = static_cast<int64_t>(gLayouts.load());
    gStatus.pruned = static_cast<int64_t>(gPruned.load());
    gStatus.found = static_cast<int64_t>(gFound.load());
    gStatus.chunks = static_cast<int64_t>(gChunks.load());
    gStatus.elapsedMs = static_cast<double>(gElapsedMs.load());
    gStatus.truncated = gTruncated.load();
    gStatus.pausing = gPausing.load();
    if (gStatus.pausing) gStatus.paused = false;
    // Stop may race with the worker's final publish; once the thread is gone, force the
    // terminal "stopped" state so the UI never remains stuck in "pausing".
    if (gStop.load() && !gStatus.running) {
        gStatus.done = true;
        gStatus.paused = false;
        gStatus.pausing = false;
        gStatus.phase = 2;
        gCollected.clear();
        gStatus.hits.clear();
    }
    return gStatus;
}
