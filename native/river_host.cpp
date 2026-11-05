#include "river_host.h"

#include "search_gate.h"

#include "engine.hpp"
#include "coverage.hpp"
#include "spawn_rules.hpp"
#include "core/platform/player_y.hpp"

#include <cubiomes/biomes.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

/* 旧内核向外扩 128 格再搜；保持同样的召回行为。 */
constexpr int kRingOuter = 128;
constexpr int kOutputLimit = 1000;
/* 前端"线程数"输入框允许 1..256，宿主沿用同一上限。 */
constexpr int kRequestThreadsMax = 256;
/* 下发给引擎的线程上限：取"前端上限"和"上游 kMaxWorkerThreads"的较小值。
 * 上游在 93e5e6d 把 validate() 的 threads 上限从 32 放开到 1024（默认值也改成
 * 硬件并发度），因此这里不再写死 32 —— 否则用户在界面上填 64 会被悄悄压成 32。
 * 峰值内存与线程数近似线性增长（上游实测 32 线程约 0.4 GB），前端默认仍是
 * min(32, 核心数)，只有用户显式调高才会真的下发给更多线程。 */
constexpr int kThreadsCeiling =
    kRequestThreadsMax < riverfinder_native::kMaxWorkerThreads
        ? kRequestThreadsMax
        : riverfinder_native::kMaxWorkerThreads;
/* 面积门槛下限（上游 49640 的 50%）。 */
constexpr int kMinAreaFloor = 24820;
/* 纯河流单层满环上限，用于判定 >100%。 */
constexpr int kPureRiverCap = riverfinder_native::kPureRiverLayerCap;
/* 结果卡展示溶洞两项的条件：采样最低 Y < 该值。
 * 采样窗口整体都在 60 以上时溶洞没有刷怪价值，没必要展示两项恒为 0 的溶洞量。 */
constexpr int kCaveDisplayYMinMax = 60;
/* 统计溶洞的第二个条件：挂机Y < 该值。 */
constexpr int kCaveDisplayPlayerYMax = 85;
/* 1.18+ 世界高度范围，用于把挂机Y ±24 的平台窗口夹进合法区间。 */
constexpr int kMinecraftMinY = -64;
constexpr int kMinecraftMaxY = 320;

} // namespace

/* 全局状态：与旧实现一致，用一个后台线程 + 一把锁发布结果。 */
namespace {

std::mutex gMu;
std::thread gThread;
RiverStatus gStatus;
std::atomic<bool> gPause{false};
std::atomic<bool> gStop{false};
std::atomic<int> gPhase{0};
std::atomic<int64_t> gCur{0};
std::atomic<int64_t> gTot{0};
/* 当前搜索的 Control；job 内部重建，pause/resume/stop 需要它。 */
std::mutex gCtrlMu;
std::unique_ptr<riverfinder_native::Control> gControl;

int floorDiv(int value, int divisor)
{
    int q = value / divisor;
    int r = value % divisor;
    if (r != 0 && ((r < 0) != (divisor < 0))) --q;
    return q;
}

void publish(std::vector<RiverHit> hits, int fullArea, std::vector<RiverWarning> warnings,
             bool running, bool done, const std::string &error)
{
    std::lock_guard<std::mutex> lock(gMu);
    gStatus.hits = std::move(hits);
    gStatus.fullArea = fullArea;
    gStatus.warnings = std::move(warnings);
    gStatus.running = running;
    gStatus.done = done;
    gStatus.error = error;
    gStatus.paused = gPause.load();
}

/* 引擎 warning 文本 → 稳定 code。引擎文案是中文，只做子串匹配。 */
int warningCode(const std::string &text)
{
    if (text.find("超过24") != std::string::npos) return kRiverWarnSpanGt24;
    if (text.find("-58") != std::string::npos) return kRiverWarnYMinGtNeg58;
    if (text.find("49640") != std::string::npos) return kRiverWarnAreaOver100;
    return kRiverWarnNone;
}

/* 版本 label 反查：遍历上游 versions()，用 versionInfo() 拿到 cubiomes MC_*。 */
std::string labelForMc(int mc)
{
    for (const std::string &label : riverfinder_native::versions()) {
        try {
            if (riverfinder_native::versionInfo(label).cubiomesMc == mc) return label;
        } catch (const std::exception &) {
            /* 上游列表里个别 label 若解析失败，跳过即可。 */
        }
    }
    return std::string();
}

/* 挂机Y ±24 裁剪（与前端 F9 同口径，防止绕过前端）。 */
void clampWindow(int yMin, int yMax, int playerY, int &lo, int &hi)
{
    lo = std::max(yMin, playerY - 24);
    hi = std::min(yMax, playerY + 24);
}

void job(RiverRequest request)
{
    std::vector<RiverHit> all;
    std::vector<RiverWarning> warnings;
    std::string error;
    int fullArea = kPureRiverCap;

    /* 三字段门槛：两个面积都给时由引擎自算 minArea。 */
    const bool useThreeField = request.minRiverArea >= 0 || request.minCaveArea >= 0;
    const double conversion =
        request.caveConversion > 0.0 ? request.caveConversion : 4880.0 / 7011.0;

    /* 外扩 128 复刻旧行为，并夹在世界边界内。 */
    const long long rawWidth = static_cast<long long>(request.maxX) - request.minX + 1;
    const long long rawHeight = static_cast<long long>(request.maxZ) - request.minZ + 1;
    const int startX = std::clamp(request.minX - kRingOuter, riverfinder_native::kWorldMin,
                                            riverfinder_native::kWorldMax);
    const int startZ = std::clamp(request.minZ - kRingOuter, riverfinder_native::kWorldMin,
                                            riverfinder_native::kWorldMax);
    const int endX = std::clamp(request.maxX + kRingOuter, riverfinder_native::kWorldMin,
                                          riverfinder_native::kWorldMax);
    const int endZ = std::clamp(request.maxZ + kRingOuter, riverfinder_native::kWorldMin,
                                          riverfinder_native::kWorldMax);
    (void)rawWidth;
    (void)rawHeight;

    try {
        for (size_t index = 0; index < request.seeds.size(); index++) {
            if (gStop.load()) break;
            {
                std::lock_guard<std::mutex> lock(gMu);
                gStatus.seedIndex = static_cast<int>(index);
            }
            if (gStop.load()) break;

            while (gPause.load() && !gStop.load())
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (gStop.load()) break;

            riverfinder_native::Config cfg;
            cfg.version = labelForMc(request.mc);
            cfg.seed = std::to_string(request.seeds[index]);
            cfg.threads = std::clamp(request.threads, 1, kThreadsCeiling);
            cfg.top = kOutputLimit;
            cfg.coverage = "game";
            cfg.minDistance = 64;
            cfg.includeCaves = !request.pureRiver;
            cfg.caveConversion = conversion;

            /* 矩形外范围 */
            cfg.rectMode = true;
            cfg.minX = startX;
            cfg.maxX = endX;
            cfg.minZ = startZ;
            cfg.maxZ = endZ;

            /* Y 窗口：按挂机Y ±24 裁剪后下发（F9 的宿主侧兜底） */
            int lo = 0, hi = 0;
            clampWindow(request.yMin, request.yMax, request.y, lo, hi);
            if (hi < lo) {
                error = "bad-bounds";
                break;
            }
            cfg.yMin = lo;
            cfg.yMax = hi;
            cfg.playerY = request.y;
            /* 精算预算沿用上游默认（0 = 自动：max(768, 8*top, candidateBudget/16)）。 */
            cfg.exactBudget = 0;

            /* 门槛 */
            if (useThreeField) {
                cfg.minRiverArea = request.minRiverArea;
                cfg.minCaveArea = request.minCaveArea;
            } else {
                cfg.minRiverArea = -1;
                cfg.minCaveArea = -1;
                cfg.minArea = std::max(request.minScore, kMinAreaFloor);
            }

            /* validate() 会规整 yMin/yMax（含 S3 的纯河流多层） */
            riverfinder_native::validate(cfg);

            /* 显示分母：按裁剪后的层窗口算球壳层均格数 */
            fullArea = static_cast<int>(wcore::platform::fullShellArea(
                cfg.yMin, cfg.yMax, cfg.playerY));

            for (const std::string &text : cfg.warnings) {
                const int code = warningCode(text);
                if (code != kRiverWarnNone) warnings.push_back({code, text});
            }

            /* 每种子新建 Control（上游要求不可复用），并登记到全局供
             * riverPause/Resume/Stop 直接操作。
             *
             * 注意：这里必须把新 Control 交给 gControl 持有，否则
             * riverStop() 里的 `if (gControl) gControl->cancel()` 永远落空，
             * 取消信号到不了引擎 —— 表现为「点了停止但搜索一直在跑」。 */
            std::unique_ptr<riverfinder_native::Control> control =
                std::make_unique<riverfinder_native::Control>();
            {
                std::lock_guard<std::mutex> lock(gCtrlMu);
                gControl = std::move(control);
                control = nullptr;
            }
            riverfinder_native::Control *active = nullptr;
            {
                std::lock_guard<std::mutex> lock(gCtrlMu);
                active = gControl.get();
            }
            if (!active) break;
            /* 登记之前可能已经点过暂停/停止，这里补同步一次。 */
            if (gPause.load()) active->pause();
            if (gStop.load()) active->cancel();

            const riverfinder_native::SearchResult result =
                riverfinder_native::search(cfg, *active,
                    [](const riverfinder_native::Statistics &st) {
                        const bool coarse = (st.phase == "coarse");
                        gPhase.store(coarse ? 1 : 2);
                        if (coarse) {
                            gCur.store(static_cast<int64_t>(st.scannedChunks));
                            gTot.store(static_cast<int64_t>(st.totalChunks));
                        } else {
                            gCur.store(static_cast<int64_t>(st.refinedCandidates));
                            gTot.store(static_cast<int64_t>(st.refineTotal));
                        }
                    });

            if (gStop.load()) break;

            /* 河流模式的溶洞补充统计（仅用于结果卡展示）：
             *
             * 纯河流模式下上游把 yMin..yMax 归一成 Y=-63 单层，caveVolume 恒为 0，
             * 结果卡上的「溶洞面积 / 等效溶洞面积」就永远是 0。这里在采样最低 Y 低于 60
             * 时，用同一份种子，在挂机Y ±24 的平台层上只对**主结果的 Top-K 点**
             * 做单点打分（riverfinder_native::scorePoint），不重跑整轮搜索。
             *
             * 不改动主搜索的结果与排序：单纯回填 cave / rawCave，失败则保持 0。
             * 注意：这段只做展示，任何异常都必须吞掉，绝不能把整个搜索变成"0 结果"。 */
            const int requestedYMinRaw = std::min(request.yMin, request.yMax);
            /* 与上面 hasCave 同一套条件：采样最低 Y < 60 且挂机Y < 85 才补溶洞统计。 */
            const bool wantCaveDisplay = requestedYMinRaw < kCaveDisplayYMinMax
                && cfg.playerY < kCaveDisplayPlayerYMax;
            /* 溶洞统计窗口：**必须和主搜索完全一致**（主搜索按挂机Y ±24 裁剪后的 lo..hi）。
             *
             * 之前这里用挂机Y ±24（-64..-16，49 层）去统计溶洞，而主搜索只统计 -63..-51（13 层），
             * 两者口径不同：同一片纯河流区域会在补充窗口里数进完全不相干的高层溶洞，
             * 表现为"纯河流处却带出巨大的溶洞面积"。改用主搜索窗口后口径统一：
             *   溶洞体积 = 主搜索那 13 层的溶洞格数之和，与河流体积同口径。 */
            const int caveLo = (hi >= lo) ? lo : hi;
            const int caveHi = (hi >= lo) ? hi : lo;
            riverfinder_native::Config caveCfg;
            bool caveCfgReady = false;
            if (request.pureRiver && wantCaveDisplay) {
                try {
                    caveCfg.version = cfg.version;
                    caveCfg.seed = cfg.seed;
                    caveCfg.threads = 1;
                    caveCfg.top = cfg.top;
                    caveCfg.coverage = cfg.coverage;
                    caveCfg.simulationDistanceChunks = cfg.simulationDistanceChunks;
                    caveCfg.minDistance = cfg.minDistance;
                    caveCfg.includeCaves = true;
                    caveCfg.caveConversion = cfg.caveConversion;
                    caveCfg.rectMode = true;
                    caveCfg.minX = cfg.minX;
                    caveCfg.maxX = cfg.maxX;
                    caveCfg.minZ = cfg.minZ;
                    caveCfg.maxZ = cfg.maxZ;
                    caveCfg.yMin = caveLo;
                    caveCfg.yMax = caveHi;
                    caveCfg.playerY = cfg.playerY;
                    caveCfg.exactBudget = 0;
                    /* 单点打分只用单层/单点口径，门槛不影响 evaluate()。 */
                    caveCfg.minRiverArea = -1;
                    caveCfg.minCaveArea = -1;
                    caveCfg.minArea = kMinAreaFloor;
                    /* 先跑一遍 validate 把自动挂机Y、纯河流层窗口等规整掉，
                     * 之后所有点共用同一份 Config，单点打分不会因为越界抛异常。 */
                    riverfinder_native::validate(caveCfg);
                    caveCfgReady = true;
                } catch (const std::exception &) {
                    /* 仅用于展示的补充统计失败时安静跳过，绝不影响主搜索。 */
                    caveCfgReady = false;
                }
            }
            /* 河流模式的溶洞量：只对主结果 Top-K 点做单点打分（不整轮重搜）。 */
            for (const riverfinder_native::Hit &h : result.hits) {
                RiverHit item;
                item.seed = request.seeds[index];
                item.x = h.x;
                item.z = h.z;
                /* 地图跳转高度：用采样窗口的中点（上下限的中点），不是挂机Y。
                 * 挂机Y 只是计分球心，跳图时玩家站在窗口中间查看更直观；
                 * 这里取下发窗口与裁剪后窗口的中点，clamp 保证不越界。 */
                const int jumpLo = hi >= lo ? lo : hi;
                const int jumpHi = hi >= lo ? hi : lo;
                item.sampleY = jumpLo + (jumpHi - jumpLo) / 2;
                /* ===== 四项指标的语义（按用户确认的公式） =====
                 *  河流面积     = 区域内**河流群系**的格数（不折算）
                 *  溶洞面积     = 区域内**溶洞群系**的格数（不折算）
                 *  等效河流面积 = 河流面积 + 溶洞面积 / 折算系数
                 *  等效溶洞面积 = 溶洞面积 + 折算系数 * 河流面积
                 *
                 * 数据来源（已对照 tools/river 源码确认口径）：
                 *  - h.riverVolume = 统计各层、24..128 球壳内的河流群系格数之和
                 *  - h.caveVolume  = 统计各层、24..128 球壳内的溶洞群系格数之和
                 *  这两个是**多层累加的格数总和**，不是"面积"。展示前必须除以统计层数，
                 *  换算成单层平均面积（层均格数），四项口径一致。
                 *
                 * 折算系数 caveConversion 默认 4880/7011 ≈ 0.696（前端"河流/溶洞折算系数"）。
                 * 结果卡实时百分比仍用引擎 score/分母，不受这里影响。 */
                const int statLayers = std::max(1, riverfinder_native::layersOf(cfg));
                item.layers = statLayers;
                /* 先换算成单层平均面积，再做等效折算。 */
                const double rawRiverArea =
                    static_cast<double>(h.riverVolume) / static_cast<double>(statLayers);
                const double rawCaveArea =
                    static_cast<double>(h.caveVolume) / static_cast<double>(statLayers);
                item.rawRiver = static_cast<int>(std::lround(rawRiverArea));
                item.rawCave = static_cast<int>(std::lround(rawCaveArea));
                const double conv = cfg.caveConversion > 0.0 ? cfg.caveConversion
                                                              : riverfinder_native::kDefaultCaveConversion;
                /* 等效值用**未取整**的单层量再折算，避免"先四舍五入再换算"带来的 ±1 漂移。
                 * 前端结果卡也用同一套公式重算，两边口径一致。 */
                item.river = static_cast<int>(std::lround(rawRiverArea + rawCaveArea / conv));
                item.cave = static_cast<int>(std::lround(rawCaveArea + conv * rawRiverArea));
                item.score = static_cast<int>(
                    std::lround(riverfinder_native::score(h, cfg)));
                /* 河流模式：补一份溶洞面积（只用于展示，不参与总分与排序）。
                 * 用单点打分拿 caveVolume；补充统计窗口与主搜索一致，
                 * 所以同样除以层数换算成单层平均面积，再套同一套等效公式。 */
                if (caveCfgReady) {
                    try {
                        const riverfinder_native::PointScore ps =
                            riverfinder_native::scorePoint(caveCfg, h.x, h.z, *active);
                        const int caveLayers = std::max(1, riverfinder_native::layersOf(caveCfg));
                        const double caveConv = caveCfg.caveConversion > 0.0
                                                    ? caveCfg.caveConversion
                                                    : riverfinder_native::kDefaultCaveConversion;
                        /* rawRiver 已是单层平均面积；溶洞体积同样先除层数。 */
                        const double rr = static_cast<double>(item.rawRiver);
                        const double rc = static_cast<double>(ps.caveVolume) /
                                          static_cast<double>(caveLayers);
                        item.rawCave = static_cast<int>(std::lround(rc));
                        item.river = static_cast<int>(std::lround(rr + rc / caveConv));
                        item.cave = static_cast<int>(std::lround(rc + caveConv * rr));
                    } catch (const std::exception &) {
                        /* 单点失败时溶洞面积按 0 处理，等效值仍按公式给出。 */
                        item.rawCave = 0;
                        const double rr = static_cast<double>(item.rawRiver);
                        item.river = static_cast<int>(std::lround(rr));
                        item.cave = static_cast<int>(std::lround(conv * rr));
                    }
                    if (gStop.load()) break;
                }
                /* 是否统计溶洞——只看**搜索条件**，与这个点实际有没有溶洞无关：
                 *  - 采样最低 Y < 60；
                 *  - 挂机Y < 85。
                 * 满足就统计（面积可能是 0，前端照样输出四项）；不满足则不补统计，
                 * 溶洞面积保持 0，前端仍然显示这一项。
                 *
                 * 注：这里用前端下发的原始 yMin（request.yMin），不是裁剪后的 cfg.yMin——
                 * 挂机Y ±24 裁剪会把窗口抬到 -40 附近，按 cfg.yMin 判断会把默认空置域农场
                 * （-63..-51 + 挂机Y -40）误判成"不统计溶洞"。 */
                const int requestedYMin = std::min(request.yMin, request.yMax);
                item.hasCave = requestedYMin < kCaveDisplayYMinMax
                    && cfg.playerY < kCaveDisplayPlayerYMax;
                /* 诊断：临时打开可打印每点溶洞口径，便于核对"该点到底有没有溶洞"。 */
                if (const char *dbg = std::getenv("AIO_RIVER_DEBUG")) {
                    if (dbg[0] == '1') {
                        std::fprintf(stderr, "[river] %d,%d sampleY=%d river=%d rawRiver=%d cave=%d rawCave=%lld hasCave=%d\n",
                                     item.x, item.z, item.sampleY, item.river, item.rawRiver,
                                     item.cave, static_cast<long long>(item.rawCave),
                                     item.hasCave ? 1 : 0);
                    }
                }
                all.push_back(item);
            }

            if (gStop.load()) break;
        }
    } catch (const std::bad_alloc &) {
        error = "out-of-memory";
    } catch (const std::invalid_argument &ex) {
        error = ex.what();
    } catch (const std::exception &ex) {
        error = ex.what();
    }

    gPhase.store(-1);
    if (gStop.load()) {
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
    /* 先摘掉全局 Control 再发布结果：riverPoll() 看到 done 后会 join 线程，
     * 若此时 gControl 仍指向正在销毁的对象会与 join 竞态。 */
    {
        std::lock_guard<std::mutex> lock(gCtrlMu);
        gControl.reset();
    }
    publish(std::move(all), fullArea, std::move(warnings), false, true, error);
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
    if (request.threads < 1 || request.threads > kRequestThreadsMax) return "bad-bounds";
    /* 球壳半径 128：任一 Y 与挂机Y 差值超过 128 一定搜不到，直接拒绝。 */
    if (std::abs(request.yMin - request.y) > 128 ||
        std::abs(request.yMax - request.y) > 128) {
        return "y-out-of-shell";
    }
    {
        int lo = 0, hi = 0;
        clampWindow(request.yMin, request.yMax, request.y, lo, hi);
        if (hi < lo) return "bad-bounds";
    }

    {
        std::lock_guard<std::mutex> lock(gMu);
        if (gStatus.running) return "busy";
    }
    if (gThread.joinable()) gThread.join();
    if (!searchGateAcquire(SearchOwner::River)) return "busy";

    gPause.store(false);
    gStop.store(false);
    gPhase.store(0);
    gCur.store(0);
    gTot.store(0);
    {
        std::lock_guard<std::mutex> lock(gCtrlMu);
        gControl.reset();
    }

    {
        std::lock_guard<std::mutex> lock(gMu);
        gStatus = {};
        gStatus.running = true;
        gStatus.seedCount = static_cast<int>(request.seeds.size());
        /* 结果卡需要知道本次搜索的模式与折算系数，才能在溶洞模式下把第一行
         * 显示成"等效溶洞面积"、纯河流模式下显示成"等效河流面积"。 */
        gStatus.pureRiver = request.pureRiver;
        gStatus.caveConversion = request.caveConversion > 0.0
                                     ? request.caveConversion
                                     : riverfinder_native::kDefaultCaveConversion;
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
    gPause.store(true);
    std::lock_guard<std::mutex> lock(gCtrlMu);
    if (gControl) gControl->pause();
}

void riverResume()
{
    gPause.store(false);
    std::lock_guard<std::mutex> lock(gCtrlMu);
    if (gControl) gControl->resume();
}

void riverStop()
{
    gStop.store(true);
    std::lock_guard<std::mutex> lock(gCtrlMu);
    if (gControl) gControl->cancel();
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
    gStatus.stage = gPhase.load();
    gStatus.current = gCur.load();
    gStatus.total = gTot.load();
    gStatus.paused = gPause.load();
    return gStatus;
}

std::vector<RiverVersionEntry> riverVersions()
{
    std::vector<RiverVersionEntry> out;
    for (const std::string &label : riverfinder_native::versions()) {
        try {
            const int mc = riverfinder_native::versionInfo(label).cubiomesMc;
            /* label 生命周期为静态，直接借用指针。 */
            out.push_back({label.c_str(), mc});
        } catch (const std::exception &) {
        }
    }
    return out;
}

std::string riverVersionLabel(int mc)
{
    return labelForMc(mc);
}

int riverVersionMc(const std::string &label)
{
    try {
        return riverfinder_native::versionInfo(label).cubiomesMc;
    } catch (const std::exception &) {
        return -1;
    }
}

void riverClampYWindow(int yMin, int yMax, int playerY, int *outMin, int *outMax,
                       int *outLayers)
{
    int lo = 0, hi = 0;
    clampWindow(yMin, yMax, playerY, lo, hi);
    if (outMin) *outMin = lo;
    if (outMax) *outMax = hi;
    if (outLayers) *outLayers = hi >= lo ? (hi - lo + 1) : 0;
}
