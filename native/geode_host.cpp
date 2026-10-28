#include "geode_host.h"

// 试炼与紫水晶的引擎头文件同名（search.hpp），因此这里用 tools/ 相对路径，
// 避免 include 路径顺序把 geode::Options 解析成 trial::Options。
#include "geode/src/checkpoint.hpp"
#include "geode/src/search.hpp"
#include "geode/src/terrain.hpp"
#include "search_gate.h"

#include <algorithm>
#include <atomic>
#include <chrono>
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

namespace {

using Clock = std::chrono::steady_clock;

constexpr int kMaxThreads = 64;
constexpr int kMaxLimit = 1000;
constexpr int kWorldMin = -30000000;
constexpr int kWorldMax = 30000000;
constexpr int kEngineWorldMax = 29999999;
constexpr int kRegionChunks = 8192; /* 131,072 blocks per checkpoint region */

std::mutex gMu;
std::thread gThread;
GeodeStatus gStatus;
GeodeRequest gRequest;
int gResumeSeed = 0;
std::vector<GeodeHit> gCollected;
std::shared_ptr<geode::Control> gControl;

std::atomic_bool gStop{false};
std::atomic_bool gPausing{false};
std::atomic_bool gResumed{false};
std::atomic_bool gTruncated{false};
std::atomic<int> gPhaseCode{1};
std::atomic<int> gPhaseIndex{1};
std::atomic<int> gPhaseCount{3};
std::atomic<uint64_t> gCurrent{0};
std::atomic<uint64_t> gTotal{0};
std::atomic<uint64_t> gVerifyDone{0};
std::atomic<uint64_t> gVerifyTotal{0};
std::atomic<int> gVerified{0};
std::atomic<int> gMismatch{0};
std::atomic<int> gBackend{0}; /* 0 = cpu, 1 = gpu */
std::string gGpuReason; /* why the GPU scan was not used, empty when it ran */
std::string gGpuDevice; /* CL_DEVICE_NAME of the GPU that ran the scan */
std::atomic<int64_t> gStartedMs{0};
std::atomic<int64_t> gPhaseStartedMs{0};
std::atomic<int64_t> gFinalElapsedMs{0};

int64_t nowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
}

std::string phaseName(int code)
{
    switch (code) {
        case 1: return "scan";
        case 2: return "simulate";
        case 3: return "rank";
        case 4: return "verify";
        default: return "done";
    }
}

#ifdef _WIN32
std::string utf8Path(const std::filesystem::path &path)
{
    const auto text = path.u8string();
    return std::string(reinterpret_cast<const char *>(text.data()), text.size());
}
#else
std::string utf8Path(const std::filesystem::path &path)
{
    return path.string();
}
#endif

std::filesystem::path checkpointDirectory()
{
    if (const char *explicitDir = std::getenv("AIO_GEODE_CHECKPOINTS"); explicitDir && *explicitDir)
        return std::filesystem::path(reinterpret_cast<const char8_t *>(explicitDir));
    if (const char *dataDir = std::getenv("AIO_DATA_DIR"); dataDir && *dataDir)
        return std::filesystem::path(reinterpret_cast<const char8_t *>(dataDir)) / "checkpoints" / "geode-native";
    std::error_code ec;
    const auto temp = std::filesystem::temp_directory_path(ec);
    if (ec) return {};
    return temp / "aio-geode-checkpoints";
}

void clearCheckpoints()
{
    const auto dir = checkpointDirectory();
    if (dir.empty()) return;
    std::error_code ec;
    if (!std::filesystem::exists(dir, ec)) return;
    for (const auto &entry : std::filesystem::directory_iterator(dir, ec)) {
        const std::string name = entry.path().filename().string();
        if (name.rfind("geode-v1-", 0) != 0) continue;
        std::error_code removeEc;
        std::filesystem::remove(entry.path(), removeEc);
    }
}

bool hasCheckpoint()
{
    const auto dir = checkpointDirectory();
    if (dir.empty()) return false;
    std::error_code ec;
    if (!std::filesystem::exists(dir, ec)) return false;
    for (const auto &entry : std::filesystem::directory_iterator(dir, ec)) {
        const std::string name = entry.path().filename().string();
        if (name.rfind("geode-v1-", 0) == 0) return true;
    }
    return false;
}

void removeCheckpointFile(const std::string &path)
{
    if (path.empty()) return;
    try {
        geode::remove_checkpoint(path);
    } catch (...) {
        /* A completed search is still valid when the checkpoint cannot be removed. */
    }
}

bool isFullWorld(const GeodeRequest &request)
{
    if (request.fullWorld) return true;
    return request.minX <= kWorldMin && request.maxX >= kEngineWorldMax && request.minZ <= kWorldMin &&
           request.maxZ >= kEngineWorldMax;
}

int autoBudgetFor(int width, int height)
{
    // 分档按“圆直径或正方形等效区域边长”比较；矩形使用 sqrt(width*height)。
    const double side = std::sqrt(double(width) * double(height));
    if (side <= 32768.0) return 0;
    if (side <= 131072.0) return 20000;
    if (side <= 1000001.0) return 100000;
    if (side <= 2000001.0) return 200000;
    if (side <= 10000001.0) return 500000;
    if (side <= 20000001.0) return 750000;
    return 1000000;
}

int budgetFor(const GeodeRequest &request)
{
    if (!request.autoBudget) return std::max(0, request.budget);
    return autoBudgetFor(request.maxX - request.minX + 1, request.maxZ - request.minZ + 1);
}

geode::Options optionsFor(const GeodeRequest &request, int64_t seed, int budget, bool fullMap,
                          const std::string &checkpointDir)
{
    geode::Options options;
    options.seed = static_cast<uint64_t>(seed);
    options.seed_text = std::to_string(seed);
    geode::set_version(options, request.version);
    options.terrain = request.model != "stone";
    options.search_rect = true;
    options.min_x = request.minX;
    // UI 世界边界显示到 30000000，但引擎真实可生成上界是 29999999。
    options.max_x = std::min(request.maxX, kEngineWorldMax);
    options.min_z = request.minZ;
    options.max_z = std::min(request.maxZ, kEngineWorldMax);
    // 矩形模式的排名中心取四至中点；同分距离与导出 dist 都使用该值。
    options.center_x = static_cast<int>((int64_t(request.minX) + std::min(request.maxX, kEngineWorldMax)) / 2);
    options.center_z = static_cast<int>((int64_t(request.minZ) + std::min(request.maxZ, kEngineWorldMax)) / 2);
    options.radius = std::max(options.max_x - options.min_x, options.max_z - options.min_z) / 2 + 1;
    options.shape = "rect";
    options.tick_radius = request.tickRadius;
    options.simulation_distance = request.simulationDistance;
    options.min_geodes = request.minGeodes;
    options.min_budding = request.minBudding;
    options.threads = std::max(1, std::min(kMaxThreads, request.threads));
    // 全图粗筛允许更多线程；模拟仍受 threads 限制。
    options.scan_threads = fullMap ? std::min(256, std::max(128, options.threads)) : 0;
    options.prefilter = budget;
    options.limit = kMaxLimit;
    options.scan_backend = fullMap ? (request.allowGpu ? "auto" : "cpu") : "cpu";
    options.checkpoint_region = fullMap ? kRegionChunks : 0;
    options.checkpoint_directory = fullMap ? checkpointDir : std::string();
    return options;
}

void updatePhase(int code, uint64_t done, uint64_t total)
{
    const int current = gPhaseCode.load();
    // Only a phase switch restarts the phase clock. Progress can legitimately
    // move backwards for a moment while parallel workers report out of order;
    // resetting the clock there made the "remaining this phase" estimate jump.
    if (current != code) gPhaseStartedMs.store(nowMs());
    gPhaseCode.store(code);
    gPhaseIndex.store(code);
    gCurrent.store(done);
    gTotal.store(total);
}

void job(GeodeRequest request, int startSeed)
{
    const auto control = std::make_shared<geode::Control>();
    {
        std::lock_guard<std::mutex> lock(gMu);
        gControl = control;
    }
    const bool fullMap = isFullWorld(request);
    const int budget = budgetFor(request);
    const std::string checkpointDir = fullMap ? utf8Path(checkpointDirectory()) : std::string();
    const int seedCount = static_cast<int>(request.seeds.size());
    std::string error;
    int runningSeed = startSeed;
    int index = startSeed;
    const int verifyTop = seedCount == 1 ? std::max(0, request.verifyTop) : 0;

    for (; index < seedCount; ++index) {
        runningSeed = index;
        if (gStop.load()) break;
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus.seedIndex = index;
        }
        gPhaseStartedMs.store(nowMs());
        updatePhase(1, 0, 0);
        gVerifyDone.store(0);
        gVerifyTotal.store(0);
        gVerified.store(0);
        gMismatch.store(0);

        geode::Options options;
        geode::Results output;
        bool cancelled = false;
        bool finishedSeed = false;
        try {
            options = optionsFor(request, request.seeds[index], budget, fullMap, checkpointDir);
            output = geode::search(options, *control, [&](const std::string &phase, uint64_t done, uint64_t total) {
                int code = phase == "scan" ? 1 : phase == "simulate" ? 2 : 3;
                updatePhase(code, done, total);
            }, [](const std::string &backend, const std::string &detail) {
                gBackend.store(backend == "gpu" ? 1 : 0);
                std::lock_guard<std::mutex> lock(gMu);
                if (backend == "gpu") {
                    gGpuDevice = detail;
                    gGpuReason.clear();
                } else {
                    gGpuDevice.clear();
                    gGpuReason = detail;
                }
            });
            if (output.cancelled || gStop.load()) {
                cancelled = true;
            } else {
                finishedSeed = true;
                gBackend.store(output.scan_backend == "gpu" ? 1 : 0);
                if (output.stats.resumed_scan > 0 || output.stats.resumed_simulation > 0) gResumed.store(true);
            }
        } catch (const std::bad_alloc &) {
            error = "out-of-memory";
        } catch (const std::invalid_argument &) {
            error = "bad-bounds";
        } catch (const geode::Cancelled &) {
            cancelled = true;
        } catch (const std::exception &exception) {
            std::fwprintf(stderr, L"[geode] search failed: %hs\n", exception.what());
            std::fflush(stderr);
            error = fullMap ? "geode-engine-failed" : "geode-start-failed";
        }

        if (!finishedSeed) {
            if (!cancelled && error.empty()) error = "geode-start-failed";
            break;
        }

        std::vector<GeodeHit> hits;
        hits.reserve(output.centers.size());
        for (const auto &center : output.centers) {
            GeodeHit hit;
            hit.seed = request.seeds[index];
            hit.x = center.x;
            hit.z = center.z;
            hit.budding = center.budding;
            hit.geodes = center.geodes;
            hits.push_back(hit);
        }

        bool verifyFailed = false;
        if (verifyTop > 0 && output.approximate && !hits.empty() && !gStop.load()) {
            const int count = std::min<int>(verifyTop, static_cast<int>(hits.size()));
            gPhaseCode.store(4);
            gPhaseIndex.store(4);
            gPhaseStartedMs.store(nowMs());
            gVerifyDone.store(0);
            gVerifyTotal.store(static_cast<uint64_t>(count));
            int mismatch = 0, verifiedCount = 0;
            try {
                for (int i = 0; i < count; ++i) {
                    control->checkpoint();
                    try {
                        const auto exact = geode::evaluate(options, hits[i].x, hits[i].z);
                        if (exact.budding != hits[i].budding || exact.geodes != hits[i].geodes) {
                            hits[i].listedBudding = hits[i].budding;
                            hits[i].listedGeodes = hits[i].geodes;
                            hits[i].budding = exact.budding;
                            hits[i].geodes = exact.geodes;
                            ++mismatch;
                        }
                        hits[i].verified = true;
                        ++verifiedCount;
                    } catch (const std::bad_alloc &) {
                        throw;
                    } catch (const geode::Cancelled &) {
                        throw;
                    } catch (const std::exception &) {
                        // 单点复核失败只让该条保持未复核，不中断整个搜索。
                        verifyFailed = true;
                    }
                    gVerifyDone.store(static_cast<uint64_t>(i + 1));
                }
            } catch (const geode::Cancelled &) {
                cancelled = true;
            } catch (const std::bad_alloc &) {
                error = "out-of-memory";
            } catch (const std::exception &) {
                error = "geode-verify-failed";
            }
            gVerified.store(verifiedCount);
            gMismatch.store(mismatch);
            if (cancelled || gStop.load()) {
                break;
            }
            // 前 N 条按精确值用 v3 规则重排；N 之后保持引擎顺序。
            std::stable_sort(hits.begin(), hits.begin() + count, [&](const GeodeHit &a, const GeodeHit &b) {
                return geode::final_better(options.center_x, options.center_z, {a.x, a.z, a.budding, a.geodes},
                                           {b.x, b.z, b.budding, b.geodes});
            });
            if (verifyFailed && error.empty()) error = "geode-verify-failed";
        }

        if (hits.size() >= static_cast<size_t>(kMaxLimit)) gTruncated.store(true);
        {
            std::lock_guard<std::mutex> lock(gMu);
            for (const auto &hit : hits) gCollected.push_back(hit);
            gStatus.hits = gCollected;
        }
        removeCheckpointFile(output.checkpoint_path);
        if (fullMap) clearCheckpoints();
    }

    const bool stopped = gStop.load();
    const bool allSeedsDone = index >= seedCount;
    const int finalElapsed =
        static_cast<int>(nowMs() - gStartedMs.load() - static_cast<int64_t>(control->paused_ms()));
    gFinalElapsedMs.store(std::max<int64_t>(0, finalElapsed));
    if (gPhaseCount.load() == 4 && gVerifyTotal.load() == 0) gPhaseCount.store(3);
    gPhaseCode.store(5);
    gPhaseIndex.store(5);
    gPhaseStartedMs.store(nowMs());
    if (error.empty() && verifyTop > 0 && gMismatch.load() > 0 && !stopped) {
        /* 复核不一致不是错误；页脚会显示计数。 */
    }
    if (!allSeedsDone && !stopped && error.empty()) error = "geode-start-failed";

    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus.running = false;
        gStatus.done = true;
        gStatus.paused = false;
        gStatus.pausing = false;
        gStatus.stopping = false;
        gStatus.stopped = stopped;
        gStatus.phase = "done";
        gStatus.error = error;
        if (stopped) {
            gCollected.clear();
            gStatus.hits.clear();
            gTruncated.store(false);
        }
        (void)runningSeed;
        gControl.reset();
    }
    if (stopped) {
        // 停止不保留断点；只有暂停会让断点留在磁盘上。
        clearCheckpoints();
    }
    searchGateRelease(SearchOwner::Geode);
}

bool validRequest(const GeodeRequest &request, std::string &error)
{
    try {
        geode::Options probe;
        geode::set_version(probe, request.version);
    } catch (const std::exception &) {
        error = "unsupported-version";
        return false;
    }
    if (request.seeds.empty()) {
        error = "no-seeds";
        return false;
    }
    if (isFullWorld(request) && request.seeds.size() != 1) {
        error = "full-map-single-seed";
        return false;
    }
    if (request.fullWorld && request.seeds.size() != 1) {
        error = "full-map-single-seed";
        return false;
    }
    if (request.minX > request.maxX || request.minZ > request.maxZ || request.minX < kWorldMin ||
        request.maxX > kWorldMax || request.minZ < kWorldMin || request.maxZ > kWorldMax) {
        error = "bad-bounds";
        return false;
    }
    if (request.model != "terrain" && request.model != "stone") {
        error = "bad-bounds";
        return false;
    }
    if (request.tickRadius < 1 || request.tickRadius > 256 || request.simulationDistance < 2 ||
        request.simulationDistance > 16 || request.minGeodes < 1 || request.minBudding < 0 || request.budget < 0) {
        error = "bad-bounds";
        return false;
    }
    const int budget = budgetFor(request);
    const int64_t chunks = (int64_t(request.maxX - request.minX + 1 + 15) / 16) *
                           (int64_t(request.maxZ - request.minZ + 1 + 15) / 16);
    if (budget == 0 && chunks > 16000000) {
        error = "bad-bounds";
        return false;
    }
    return true;
}

GeodeStatus snapshot()
{
    GeodeStatus status;
    {
        std::lock_guard<std::mutex> lock(gMu);
        status = gStatus;
    }
    status.phase = phaseName(gPhaseCode.load());
    status.phaseIndex = gPhaseIndex.load();
    status.phaseCount = gPhaseCount.load();
    if (gPhaseCode.load() == 4) {
        status.current = static_cast<int64_t>(gVerifyDone.load());
        status.total = static_cast<int64_t>(gVerifyTotal.load());
    } else if (gPhaseCode.load() == 5) {
        // 完成/停止时把阶段条收到 100%；复核阶段优先使用复核总数。
        const uint64_t finalTotal = gVerifyTotal.load() > 0 ? gVerifyTotal.load() : gTotal.load();
        status.current = static_cast<int64_t>(finalTotal);
        status.total = static_cast<int64_t>(finalTotal);
    } else {
        status.current = static_cast<int64_t>(gCurrent.load());
        status.total = static_cast<int64_t>(gTotal.load());
    }
    status.verifyDone = static_cast<int64_t>(gVerifyDone.load());
    status.verifyTotal = static_cast<int64_t>(gVerifyTotal.load());
    status.verified = gVerified.load();
    status.verifyMismatch = gMismatch.load();
    status.truncated = gTruncated.load();
    status.resumed = gResumed.load();
    status.scanBackend = gBackend.load() ? "gpu" : "cpu";
    status.backend = status.scanBackend;
    {
        std::lock_guard<std::mutex> lock(gMu);
        status.gpuReason = gGpuReason;
        status.gpuDevice = gGpuDevice;
    }

    const auto control = [&] {
        std::lock_guard<std::mutex> lock(gMu);
        return gControl;
    }();
    const double pausedMs = control ? control->paused_ms() : 0;
    if (!status.running) {
        status.elapsedMs = static_cast<double>(gFinalElapsedMs.load());
    } else {
        status.elapsedMs = std::max<int64_t>(0, nowMs() - gStartedMs.load() - static_cast<int64_t>(pausedMs));
    }

    const int64_t phaseMs = nowMs() - gPhaseStartedMs.load();
    const int64_t current = status.current;
    const int64_t total = status.total;
    if (status.running && !status.paused && current > 0 && total > current && phaseMs > 0) {
        status.etaSeconds = (static_cast<double>(phaseMs) / 1000.0) * double(total - current) / double(current);
    } else {
        status.etaSeconds = -1;
    }
    return status;
}

} // namespace

std::string geodeStart(const GeodeRequest &input)
{
    std::string error;
    GeodeRequest request = input;
    if (request.fullWorld) {
        request.minX = kWorldMin;
        request.maxX = kWorldMax;
        request.minZ = kWorldMin;
        request.maxZ = kWorldMax;
    }
    if (!validRequest(request, error)) return error;
    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Geode)) return "busy";

    request.threads = std::max(1, std::min(kMaxThreads, request.threads));
    request.minGeodes = std::max(1, request.minGeodes);
    request.minBudding = std::max(0, request.minBudding);
    request.budget = std::max(0, request.budget);
    request.verifyTop = std::max(0, std::min(100, request.verifyTop));
    if (request.verifyTop != 0 && request.verifyTop != 5 && request.verifyTop != 10 && request.verifyTop != 20)
        request.verifyTop = 20;

    const bool fullMap = isFullWorld(request);
    const int budget = budgetFor(request);
    const int phaseCount = (request.seeds.size() == 1 && budget > 0 && request.verifyTop > 0) ? 4 : 3;
    // A fresh start must not silently resume when the UI explicitly asked to restart.
    if (fullMap && !request.resume) clearCheckpoints();
    const bool resumed = fullMap && request.resume && hasCheckpoint();

    gStop.store(false);
    gPausing.store(false);
    gResumed.store(resumed);
    gTruncated.store(false);
    gPhaseCode.store(1);
    gPhaseIndex.store(1);
    gPhaseCount.store(phaseCount);
    gCurrent.store(0);
    gTotal.store(0);
    gVerifyDone.store(0);
    gVerifyTotal.store(0);
    gVerified.store(0);
    gMismatch.store(0);
    gBackend.store(0);
    {
        std::lock_guard<std::mutex> lock(gMu);
        gGpuReason.clear();
        gGpuDevice.clear();
    }
    gStartedMs.store(nowMs());
    gPhaseStartedMs.store(gStartedMs.load());
    gFinalElapsedMs.store(0);

    {
        std::lock_guard<std::mutex> lock(gMu);
        gRequest = request;
        gResumeSeed = 0;
        gCollected.clear();
        gStatus = {};
        gStatus.running = true;
        gStatus.seedCount = static_cast<int>(request.seeds.size());
        gStatus.autoBudget = request.autoBudget;
        gStatus.prefilter = budget;
        gStatus.approximate = budget > 0;
        gStatus.phaseCount = phaseCount;
        gStatus.resumed = resumed;
    }
    try {
        gThread = std::thread(job, request, 0);
    } catch (const std::exception &) {
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus = {};
            gStatus.done = true;
            gStatus.phase = "done";
            gStatus.error = "geode-start-failed";
        }
        gPhaseCode.store(5);
        searchGateRelease(SearchOwner::Geode);
        return "geode-start-failed";
    }
    return "";
}

void geodePause()
{
    std::lock_guard<std::mutex> lock(gMu);
    if (!gStatus.running || gStatus.paused) return;
    gPausing.store(true);
    gStatus.pausing = true;
    // 引擎在检查点阻塞；不用取消/重启。
    if (gControl) gControl->pause();
}

void geodeResume()
{
    std::lock_guard<std::mutex> lock(gMu);
    if (!gStatus.running) return;
    gPausing.store(false);
    gStatus.pausing = false;
    gStatus.paused = false;
    if (gControl) gControl->resume();
}

void geodeStop()
{
    std::shared_ptr<geode::Control> control;
    {
        std::lock_guard<std::mutex> lock(gMu);
        if (!gStatus.running) {
            if (!gStatus.paused) return;
            gStatus.paused = false;
            gStatus.pausing = false;
            gStatus.done = true;
            gStatus.phase = "done";
            gStatus.error = "";
            gCollected.clear();
            gStatus.hits.clear();
            gResumeSeed = 0;
            gPausing.store(false);
            gTruncated.store(false);
            gPhaseCode.store(5);
            gPhaseIndex.store(5);
            gControl.reset();
            clearCheckpoints();
            return;
        }
        gStop.store(true);
        gStatus.stopping = true;
        control = gControl;
    }
    if (control) control->cancel();
}

GeodeStatus geodePoll()
{
    {
        bool running = false;
        {
            std::lock_guard<std::mutex> lock(gMu);
            running = gStatus.running;
        }
        if (!running && gThread.joinable()) gThread.join();
    }

    {
        std::lock_guard<std::mutex> lock(gMu);
        // 暂停请求只有在工作线程真正停在检查点后才算生效。
        if (gStatus.running && gStatus.pausing && gControl && gControl->waiting() > 0) {
            gStatus.paused = true;
            gStatus.pausing = false;
            gPausing.store(false);
        }
        if (gStatus.running && gStatus.stopping && !gControl) {
            gStatus.stopping = false;
        }
    }
    return snapshot();
}

GeodeChunkSummary geodeChunkSummary(const std::string &version, int64_t seed, int x, int z)
{
    GeodeChunkSummary out;
    geode::Options options;
    geode::set_version(options, version);
    geode::Simulator simulator(static_cast<uint64_t>(seed), options.generation);
    auto terrain = options.terrain ? std::make_unique<geode::Terrain>(static_cast<uint64_t>(seed), options.generation)
                                   : nullptr;
    const auto result = simulator.generate(geode::floor_div(x, 16), geode::floor_div(z, 16), terrain.get());
    out.exists = result.exists;
    out.budding = static_cast<int>(result.budding.size());
    return out;
}
