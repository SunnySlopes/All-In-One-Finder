#include "slime_host.h"

#include "cubiomes/biomes.h"
#include "cubiomes/generator.h"
#include "search_gate.h"

#define SLIME_FARM_DECLARATIONS_ONLY
#include "../tools/slime/slime_search.cpp"
#undef SLIME_FARM_DECLARATIONS_ONLY

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>

namespace {

constexpr int kOutputLimit = 50;
/** 第二道去重的邻域半径：后一个结果与已保留结果的 |dx|、|dz| 都小于 64 时跳过。 */
constexpr int64_t kNearDedupRange = 64;

std::mutex gMu;
std::thread gThread;
SlimeStatus gStatus;
std::atomic<bool> gPause{false};
std::atomic<bool> gStop{false};

int32_t biomeAtCb(void *ctx, int32_t x, int32_t y, int32_t z)
{
    return getBiomeAt(static_cast<const Generator *>(ctx), 1, x, y, z);
}

void publish(const std::vector<SlimeHit> &hits, bool running, bool done, const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.hits = hits;
    gStatus.running = running;
    gStatus.done = done;
    gStatus.error = error;
    gStatus.paused = gPause.load();
}

void publishProgress(int stage, uint64_t current, uint64_t total,
                     uint64_t tiles_done, uint64_t tiles_total,
                     const std::vector<SlimeHit> &hits)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.stage = stage;
    gStatus.current = current;
    gStatus.total = total;
    gStatus.tilesDone = tiles_done;
    gStatus.tilesTotal = tiles_total;
    gStatus.paused = gPause.load();
    gStatus.hits = hits;
}

bool withinNearRange(const SlimeHit &kept, const SlimeHit &hit)
{
    if (kept.seed != hit.seed) return false;
    const int64_t dx = kept.x >= hit.x ? kept.x - hit.x : hit.x - kept.x;
    const int64_t dz = kept.z >= hit.z ? kept.z - hit.z : hit.z - kept.z;
    return dx < kNearDedupRange && dz < kNearDedupRange;
}

/*
 * 保留搜索器原有的 64x64 格子去重（dedupe_by_cell），在 host 输出前再加一道
 * 邻域去重：结果已按面积从高到低排序，若后一个结果落在任一已保留结果的
 * 64x64 范围内（|dx| < 64 且 |dz| < 64），则跳过。不同种子互不影响。
 */
void dedupeNear(std::vector<SlimeHit> &hits)
{
    if (hits.size() < 2) return;
    std::vector<SlimeHit> kept;
    kept.reserve(hits.size());
    for (const SlimeHit &hit : hits) {
        bool duplicate = false;
        for (const SlimeHit &prev : kept) {
            if (withinNearRange(prev, hit)) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) kept.push_back(hit);
    }
    hits.swap(kept);
}

void sortAndTrim(std::vector<SlimeHit> &hits)
{
    std::sort(hits.begin(), hits.end(), [](const SlimeHit &a, const SlimeHit &b) {
        if (a.areaEquiv != b.areaEquiv) return a.areaEquiv > b.areaEquiv;
        if (a.area != b.area) return a.area > b.area;
        if (a.chunks != b.chunks) return a.chunks > b.chunks;
        if (a.x != b.x) return a.x < b.x;
        return a.z < b.z;
    });
    dedupeNear(hits);
    if (hits.size() > static_cast<size_t>(kOutputLimit)) hits.resize(kOutputLimit);
}

void job(SlimeRequest request)
{
    std::vector<SlimeHit> all;
    std::string error;

    try {
        Generator generator;
        setupGenerator(&generator, request.mc, FORCE_OCEAN_VARIANTS);

        for (size_t i = 0; i < request.seeds.size(); i++) {
            if (gStop.load()) break;
            {
                std::lock_guard<std::mutex> lock(gMu);
                gStatus.seedIndex = static_cast<int>(i);
            }

            while (gPause.load() && !gStop.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            if (gStop.load()) break;

            applySeed(&generator, DIM_OVERWORLD,
                      static_cast<uint64_t>(request.seeds[i]));

            SlimeFarmParams p;
            slime_farm_params_init(&p);
            p.seed = request.seeds[i];
            p.afk_x0 = request.minX;
            p.afk_x1 = request.maxX;
            p.afk_z0 = request.minZ;
            p.afk_z1 = request.maxZ;
            p.min_slime_chunks = 0; /* 由 min_slime_area 自动决定 */
            p.min_slime_area = request.minSlimeArea;
            p.threads = request.threads;
            p.max_results = request.convert ? 100 : kOutputLimit;
            p.convert_biomes = request.convert ? 1 : 0;
            p.version_rule = request.versionRule;
            p.biome_at = &biomeAtCb;
            p.biome_ctx = &generator;
            p.output_limit = kOutputLimit;

            const int rc = slime_farm_start(&p);
            if (rc != SLIME_FARM_OK) {
                error = rc == SLIME_FARM_ERR_PARAM ? "area-too-large"
                    : rc == SLIME_FARM_ERR_ALLOC ? "out-of-memory"
                    : rc == SLIME_FARM_ERR_BUSY ? "busy"
                    : "slime-start-failed";
                break;
            }

            uint64_t tiles_done = 0;
            uint64_t tiles_total = 0;
            for (;;) {
                SlimeFarmProgress progress;
                slime_farm_poll(&progress);
                tiles_done = progress.tiles_done;
                tiles_total = progress.tiles_total;
                publishProgress(progress.stage, progress.stage_current,
                                progress.stage_total, progress.tiles_done,
                                progress.tiles_total, all);

                if (gStop.load()) slime_farm_cancel();
                if (gPause.load() && !progress.paused) slime_farm_pause();
                if (!gPause.load() && progress.paused) slime_farm_resume();
                if (progress.done) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }

            if (gStop.load()) break;

            /* 确保上一轮 worker 已 join，之后才能安全复用 generator。 */
            slime_farm_wait(0);

            const int32_t count = slime_farm_result_count();
            std::vector<SlimeFarmHit> raw(static_cast<size_t>(count));
            if (count > 0) slime_farm_get_results(raw.data(), count);
            for (const SlimeFarmHit &hit : raw) {
                SlimeHit item;
                item.seed = request.seeds[i];
                item.x = hit.x;
                item.z = hit.z;
                item.area = hit.area;
                item.areaEquiv = hit.area_equiv;
                item.chunks = hit.chunks;
                all.push_back(item);
            }
            sortAndTrim(all);
            publishProgress(SLIME_FARM_STAGE_FINALIZE, 1, 1,
                            tiles_done, tiles_total, all);

            if (gStop.load()) break;
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::exception &ex) {
        error = ex.what();
    }

    slime_farm_shutdown();
    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus.stage = !error.empty()
            ? SLIME_FARM_STAGE_ERROR
            : (gStop.load() ? SLIME_FARM_STAGE_CANCELLED : SLIME_FARM_STAGE_DONE);
        gStatus.current = 0;
        gStatus.total = 0;
    }
    publish(all, false, true, error);
    searchGateRelease(SearchOwner::Slime);
}

} // namespace

bool slimeSupports(int mc)
{
    return mc >= MC_1_18 && mc <= MC_NEWEST;
}

std::string slimeStart(const SlimeRequest &request)
{
    if (!slimeSupports(request.mc)) return "unsupported-version";
    if (request.seeds.empty()) return "no-seeds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";

    const long long width = static_cast<long long>(request.maxX) - request.minX + 1;
    const long long height = static_cast<long long>(request.maxZ) - request.minZ + 1;
    if (width <= 0 || height <= 0) return "bad-bounds";
    // 世界边界：与溶洞搜索器一致，正方形/矩形边长不得超过 60000001。
    if (width > 60000001LL || height > 60000001LL) return "area-too-large";
    if (request.minX < -30000000 || request.maxX > 30000000 ||
        request.minZ < -30000000 || request.maxZ > 30000000) {
        return "area-too-large";
    }
    if (request.minSlimeArea < 0) return "bad-bounds";

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Slime)) return "busy";

    gPause.store(false);
    gStop.store(false);
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
        searchGateRelease(SearchOwner::Slime);
        return "search-start-failed";
    }
    return "";
}

void slimePause()
{
    gPause.store(true);
    slime_farm_pause();
}

void slimeResume()
{
    gPause.store(false);
    slime_farm_resume();
}

void slimeStop()
{
    gStop.store(true);
    slime_farm_cancel();
}

SlimeStatus slimePoll()
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
    return gStatus;
}
