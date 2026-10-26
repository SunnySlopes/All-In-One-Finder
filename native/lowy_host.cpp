#include "lowy_host.h"

#include "OctaveFieldCache.h"
#include "cubiomes/generator.h"
#include "search_gate.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <set>
#include <stdexcept>
#include <thread>

#ifndef DRIPSTONECAVE_FINDER_JNI_LIB
#define DRIPSTONECAVE_FINDER_JNI_LIB
#endif
#include "dripstonecave_finder.cpp"
#include "LargePitSearch.cpp"

namespace {

constexpr double kRiverArea = 49640.0; /* 24 < r <= 128 刷怪环的格点总面积 */
constexpr int kRing = 128;
constexpr float kPreserve = 0.9f;

std::mutex gMu;
std::thread gThread;
Progress gProgress;
ThreadSafeResults<Res> gResults;
LowyStatus gStatus;
bool gJoined = true;

uint64_t rol64(uint64_t a, int bits)
{
    return (a << bits) | (a >> (64 - bits));
}

uint64_t mix64(uint64_t a)
{
    a = (a ^ (a >> 30)) * 0xbf58476d1ce4e5b9ULL;
    a = (a ^ (a >> 27)) * 0x94d049bb133111ebULL;
    return a ^ (a >> 31);
}

struct Rng {
    uint64_t lo;
    uint64_t hi;
    explicit Rng(uint64_t seed)
    {
        seed ^= 0x6a09e667f3bcc909ULL;
        lo = mix64(seed);
        hi = mix64(seed + 0x9e3779b97f4a7c15ULL);
        if ((lo | hi) == 0) {
            lo = static_cast<uint64_t>(-7046029254386353131LL);
            hi = 7640891576956012809ULL;
        }
    }
    Rng(uint64_t loIn, uint64_t hiIn) : lo(loIn), hi(hiIn)
    {
        if ((lo | hi) == 0) {
            lo = static_cast<uint64_t>(-7046029254386353131LL);
            hi = 7640891576956012809ULL;
        }
    }
    uint64_t next()
    {
        uint64_t l = lo;
        uint64_t h = hi;
        uint64_t r = rol64(l + h, 17) + l;
        h ^= l;
        lo = rol64(l, 49) ^ h ^ (h << 21);
        hi = rol64(h, 28);
        return r;
    }
};

float octaveYo(Rng &base, uint64_t h0, uint64_t h1)
{
    Rng rng(base.lo ^ h0, base.hi ^ h1);
    int top = static_cast<int>((rng.next() >> 32) & 0xFFFFFFu);
    return top * 5.9604645E-8f;
}

void resetCounters()
{
    gProgress.chunkInRunning.store(0);
    gProgress.current.store(0);
    gProgress.total.store(0);
    gProgress.phase1.store(0);
}

void applyPreserveRange(std::vector<Res> &res, float opV)
{
    if (opV <= 0.f || res.empty()) return;
    const double thr = (double)res[0].area * (double)opV;
    size_t keep = 0;
    while (keep < res.size() && (double)res[keep].area >= thr) keep++;
    res.resize(keep);
}

std::vector<Res> dedup(const std::vector<Res> &items)
{
    std::set<Point> seen;
    std::vector<Res> out;
    for (const auto &item : items) {
        if (seen.insert(item.point).second) out.push_back(item);
    }
    return out;
}

std::vector<LowyHit> filterHits(const std::vector<Res> &raw, int64_t seed)
{
    std::set<long long> used;
    std::vector<Res> sorted = raw;
    std::sort(sorted.begin(), sorted.end(), [](const Res &a, const Res &b) { return a.area > b.area; });
    std::vector<LowyHit> unique;
    std::set<long long> seen;
    for (const auto &item : sorted) {
        long long key = (static_cast<long long>(item.point.x) << 32) ^ (uint32_t)item.point.y;
        if (!seen.insert(key).second) continue;
        unique.push_back({seed, item.point.x, item.point.y, item.area, item.caveArea, item.riverArea});
    }
    std::vector<LowyHit> out;
    for (const auto &hit : unique) {
        int bx = hit.x >= 0 ? hit.x / 64 : (hit.x - 63) / 64;
        int bz = hit.z >= 0 ? hit.z / 64 : (hit.z - 63) / 64;
        long long key = (static_cast<long long>(bx) << 32) ^ (uint32_t)bz;
        if (!used.insert(key).second) continue;
        out.push_back(hit);
    }
    return out;
}

std::vector<Res> runOnce(const LowyRequest &request, int64_t seed)
{
    if (gProgress.try_stop.load()) return {};
    float riverWeight = request.riverWeight;
    if (riverWeight < 0.f) riverWeight = 0.f;
    if (riverWeight > 1.f) riverWeight = 1.f;
    const int minArea = std::max(1, (int)std::lround(request.ratioPercent / 100.0 * kRiverArea));
    const int startX = request.minX - kRing;
    const int startZ = request.minZ - kRing;
    const int width = (request.maxX - request.minX + 1) + 2 * kRing;
    const int height = (request.maxZ - request.minZ + 1) + 2 * kRing;
    int threads = request.threads > 0 ? request.threads : (int)std::thread::hardware_concurrency();
    if (threads < 1) threads = 1;

    Generator generator;
    setupGenerator(&generator, request.mc, FORCE_OCEAN_VARIANTS);
    applySeed(&generator, DIM_OVERWORLD, static_cast<uint64_t>(seed));
    gResults.clear();
    resetCounters();

    if (request.mode == 2) {
        const int boxMinX = startX + kRing;
        const int boxMaxX = startX + width - 1 - kRing;
        const int boxMinZ = startZ + kRing;
        const int boxMaxZ = startZ + height - 1 - kRing;
        std::vector<Res> found = runLargePitSearch(&generator, minArea, 0.f, threads, &gProgress,
                                                    boxMinX, boxMaxX, boxMinZ, boxMaxZ);
        if (gProgress.try_stop.load()) return {};
        std::sort(found.begin(), found.end(), [](const Res &a, const Res &b) { return a.area > b.area; });
        gProgress.phase1.store(-1);
        return dedup(found);
    }

    const long long userW = (long long)width - 2LL * kRing;
    const long long userH = (long long)height - 2LL * kRing;
    const bool wantPhase0 =
        (userW >= SearchConfig::PHASE0_MIN_SIDE_BLOCKS && userH >= SearchConfig::PHASE0_MIN_SIDE_BLOCKS) ||
        (userW > 0 && userH > 0 && userW * userH >= SearchConfig::PHASE0_MIN_SIDE_BLOCKS * SearchConfig::PHASE0_MIN_SIDE_BLOCKS);

    OctaveACache octaveCache;
    setActiveOctaveACache(nullptr);
    int contScale = request.fastMode ? 0 : SearchConfig::PHASE1_CONT_PREFILTER_SCALE / 4;
    int weirdScale = request.fastMode ? 0 : SearchConfig::PHASE1_WEIRDNESS_GRID_SCALE / 2;
    if (!request.fastMode) {
        contScale = 32;
        weirdScale = 16;
    }

    if (wantPhase0) {
        gProgress.phase1.store(0);
        const int contSc = contScale > 0 ? contScale : SearchConfig::PHASE1_CONT_PREFILTER_SCALE;
        const int weirdSc = weirdScale > 0 ? weirdScale : SearchConfig::PHASE1_WEIRDNESS_GRID_SCALE;
        if (!buildOctaveACache(&octaveCache, &generator.bn, contSc, weirdSc, threads,
                               &gProgress.current, &gProgress.total,
                               &gProgress.try_pause, &gProgress.try_stop)) {
            setActiveOctaveACache(nullptr);
            if (gProgress.try_stop.load()) return {};
        } else {
            setActiveOctaveACache(&octaveCache);
        }
        if (gProgress.try_stop.load()) {
            setActiveOctaveACache(nullptr);
            return {};
        }
    }

    gProgress.phase1.store(1);
    gProgress.current.store(0);
    gProgress.total.store(0);
    gProgress.chunkInRunning.store(0);
    if (contScale <= 0 && weirdScale <= 0) {
        findBiggestRiverParallelPool(gResults, &generator, startX, startZ, width, height, minArea, &gProgress, threads);
    } else {
        int cont = contScale > 0 ? contScale : SearchConfig::PHASE1_CONT_PREFILTER_SCALE;
        int weird = weirdScale > 0 ? weirdScale : SearchConfig::PHASE1_WEIRDNESS_GRID_SCALE;
        if (cont % weird != 0) cont = weird;
        findBiggestRiverParallelPool(gResults, &generator, startX, startZ, width, height, minArea,
                                     &gProgress, threads, cont, 1, weird);
    }
    setActiveOctaveACache(nullptr);
    auto coarse = gResults.getAllResults();
    if (gProgress.try_stop.load()) return {};
    std::sort(coarse.begin(), coarse.end(), [](const Res &a, const Res &b) { return a.area > b.area; });
    applyPreserveRange(coarse, kPreserve);

    gProgress.phase1.store(2);
    gProgress.total.store((int)coarse.size());
    gProgress.current.store(0);
    gProgress.chunkInRunning.store(0);
    gResults.clear();

    if (!coarse.empty()) {
        ThreadPool pool((size_t)threads);
        for (const auto &candidate : coarse) {
            if (gProgress.try_stop.load()) break;
            pool.enqueue([&, cand = candidate, seedVal = static_cast<uint64_t>(seed), minArea, riverWeight, mc = request.mc]() {
                if (gProgress.try_stop.load()) return;
                while (gProgress.try_pause.load()) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(200));
                    if (gProgress.try_stop.load()) return;
                }
                gProgress.chunkInRunning.fetch_add(1);
                thread_local Generator tls;
                thread_local bool ready = false;
                thread_local int tlsMc = -1;
                thread_local uint64_t tlsSeed = ~0ull;
                if (!ready || tlsMc != mc) {
                    setupGenerator(&tls, mc, FORCE_OCEAN_VARIANTS);
                    ready = true;
                    tlsMc = mc;
                    tlsSeed = ~0ull;
                }
                if (tlsSeed != seedVal) {
                    applySeed(&tls, DIM_OVERWORLD, seedVal);
                    tlsSeed = seedVal;
                }
                auto refined = findBiggestRiver<1>(
                    &tls,
                    cand.point.x - SearchConfig::REFINE_HALF_WINDOW,
                    cand.point.y - SearchConfig::REFINE_HALF_WINDOW,
                    SearchConfig::REFINE_WINDOW_BLOCKS,
                    SearchConfig::REFINE_WINDOW_BLOCKS,
                    minArea, 1.0, FilterMode::PreciseBiome, riverWeight);
                if (!refined.empty() && refined[0].area >= minArea) gResults.addResult(refined[0]);
                gProgress.chunkInRunning.fetch_sub(1);
                gProgress.current.fetch_add(1);
            });
        }
    }
    if (gProgress.try_stop.load()) return {};
    auto finalList = dedup(gResults.getAllResults());
    gProgress.phase1.store(-1);
    return finalList;
}

void publish(const std::vector<LowyHit> &hits, bool running, bool done, const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.hits = hits;
    gStatus.running = running;
    gStatus.done = done;
    gStatus.error = error;
    gStatus.phase = gProgress.phase1.load();
    gStatus.current = gProgress.current.load();
    gStatus.total = gProgress.total.load();
    gStatus.paused = gProgress.try_pause.load();
}

void job(LowyRequest request)
{
    std::vector<LowyHit> all;
    std::string error;
    try {
        for (size_t i = 0; i < request.seeds.size(); i++) {
            if (gProgress.try_stop.load()) break;
            {
                std::lock_guard<std::mutex> lock(gMu);
                gStatus.seedIndex = (int)i;
            }
            auto found = runOnce(request, request.seeds[i]);
            auto filtered = filterHits(found, request.seeds[i]);
            all.insert(all.end(), filtered.begin(), filtered.end());
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::exception &ex) {
        error = ex.what();
    }
    setActiveOctaveACache(nullptr);

    if (gProgress.try_stop.load()) {
        all.clear();
    } else {
        std::sort(all.begin(), all.end(), [](const LowyHit &a, const LowyHit &b) {
            if (a.total != b.total) return a.total > b.total;
            const int64_t da = static_cast<int64_t>(a.x) * a.x + static_cast<int64_t>(a.z) * a.z;
            const int64_t db = static_cast<int64_t>(b.x) * b.x + static_cast<int64_t>(b.z) * b.z;
            if (da != db) return da < db;
            if (a.x != b.x) return a.x < b.x;
            return a.z < b.z;
        });
        if (all.size() > 1000) all.resize(1000);
    }
    publish(all, false, true, error);
    searchGateRelease(SearchOwner::Cave);
}

} // namespace

bool lowySupports(int mc)
{
    return mc >= MC_1_18 && mc <= MC_NEWEST;
}

float lowyWeirdness(int64_t seed)
{
    Rng world(static_cast<uint64_t>(seed));
    uint64_t n0 = world.next();
    uint64_t n1 = world.next();
    n0 ^= 0xefc8ef4d36102b34ULL;
    n1 ^= 0x1beeeb324a0f24eaULL;
    Rng noise(n0, n1);
    uint64_t a0 = noise.next();
    uint64_t a1 = noise.next();
    uint64_t b0 = noise.next();
    uint64_t b1 = noise.next();
    Rng aFork(a0, a1);
    aFork.next();
    Rng bFork(b0, b1);
    bFork.next();
    Rng h0(0xf11268128982754fULL, 0x257a1d670430b0aaULL);
    h0.next();
    Rng h1(0xe51c98ce7d1de664ULL, 0x5f9478a733040c45ULL);
    h1.next();
    float w0a = octaveYo(aFork, h0.lo, h0.hi);
    float w1a = octaveYo(aFork, h1.lo, h1.hi);
    float w0b = octaveYo(bFork, h0.lo, h0.hi);
    float w1b = octaveYo(bFork, h1.lo, h1.hi);
    return std::fabs(w0a - 0.5f) + std::fabs(w1a - 0.5f) + std::fabs(w0b - 0.5f) + std::fabs(w1b - 0.5f);
}

std::string lowyStart(const LowyRequest &request)
{
    if (!lowySupports(request.mc)) return "unsupported-version";
    if (request.seeds.empty()) return "no-seeds";
    if (request.maxX < request.minX || request.maxZ < request.minZ) return "bad-bounds";
    const long long width = (long long)request.maxX - request.minX + 1;
    const long long height = (long long)request.maxZ - request.minZ + 1;
    if (width <= 0 || height <= 0) return "bad-bounds";
    if (width > 60000001LL || height > 60000001LL) return "area-too-large";
    /* 超大范围（> 20000001²）时，溶洞面积占比至少 90%；大坑模式不受此限制。 */
    if (request.mode != 2 && width * height > 20000001LL * 20000001LL && request.ratioPercent < 90.0f) {
        return "bad-ratio";
    }
    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::Cave)) return "busy";
    gProgress.try_pause.store(false);
    gProgress.try_stop.store(false);
    resetCounters();
    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus = {};
        gStatus.running = true;
        gStatus.seedCount = (int)request.seeds.size();
    }
    gJoined = false;
    try {
        gThread = std::thread(job, request);
    } catch (const std::exception &) {
        gJoined = true;
        {
            std::lock_guard<std::mutex> lock(gMu);
            gStatus = {};
        }
        searchGateRelease(SearchOwner::Cave);
        return "search-start-failed";
    }
    return "";
}

void lowyPause() { gProgress.try_pause.store(true); }
void lowyResume() { gProgress.try_pause.store(false); }
void lowyStop() { gProgress.try_stop.store(true); }

LowyStatus lowyPoll()
{
    if (!gStatus.running && gThread.joinable()) {
        gThread.join();
        gJoined = true;
    }
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.phase = gProgress.phase1.load();
    gStatus.current = gProgress.current.load();
    gStatus.total = gProgress.total.load();
    gStatus.paused = gProgress.try_pause.load();
    return gStatus;
}
