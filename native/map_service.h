#pragma once

#include <stdint.h>

#include <string>
#include <utility>
#include <vector>

// ---------------------------------------------------------------------------
// 结构内容求值全部搬到 tools/loots 子模块（独立仓库，见 tools/loots/README.md）。
// 这里只做 using 导入，保持 addon.cpp / map_service.cpp 的调用点不变。
// ---------------------------------------------------------------------------
#include "loots/loots.h"
#include "loots/structure_pieces.h"
#include "loots/fixed_structures.h"
#include "loots/shipwreck.h"
#include "loots/outpost.h"
#include "loots/bastion.h"

using loots::Box3i;
using loots::OverlayFeature;
using loots::Overlay_City_Silence;
using loots::Overlay_City_SwiftSneak;
using loots::Overlay_City_GoldenApple;
using loots::AncientCityTier;
using loots::CityTier_None;
using loots::CityTier_119;
using loots::CityTier_120_1;
using loots::CityTier_120_2;
using loots::CityTier_121_6;
using loots::CityTier_26_1;
using loots::OverlayCapability;
using loots::CityChest;
using loots::CityChestInfo;
using loots::MonumentSponge;
using loots::ancientCityTier;
using loots::overlayCapability;
using loots::overlaySupported;
using loots::ancientCityChests;
using loots::monumentSponge;
using loots::StructureLoot;
using loots::StructureChest;
using loots::netherFortressLoot;
using loots::endCityLoot;
using loots::desertPyramidLoot;
using loots::jungleTempleLoot;
using loots::shipwreckLoot;
using loots::pillagerOutpostLoot;
using loots::bastionLoot;
using loots::mineshaftLoot;
using loots::OutpostLoot;
struct McVersion {
    int id;
    std::string name;
};

struct FeatureEntry {
    int id;
    std::string key;
    int dim;
};

struct PlacedFeature {
    int type;
    int x;
    int z;
    int variant; // 0 default; 1 end-city ship / abandoned-camp copper chest
    bool hasFrame = false;
    Box3i large;
    std::vector<Box3i> pieces;
};

/** Nether fortress bounds used by the map's structure frames and inspector. */
struct FortressBounds {
    Box3i large;
    Box3i start;
    std::vector<Box3i> pieces;
};

struct TileSpec {
    int scale;
    int x;
    int z;
    int sx;
    int sz;
};

struct TileImage {
    std::vector<uint8_t> rgba;
    /** Surface Y per pixel (topmost solid block), only for layer > 0 at 1:1. */
    std::vector<int16_t> height;
    /** Cave opening mask per 4x4 cell (0 none, 1 dry, 2 water, 3 lava), layer 2 at 1:1. */
    std::vector<uint8_t> cave;
    /** Highest fluid surface per 4x4 cell for layer 2 openings; no-fluid sentinel otherwise. */
    std::vector<int16_t> floodY;
};

/** 一个结构实例里所有箱子的战利品判定。 */
struct LootChest {
    int x = 0;
    int y = 0;                     // 0 = 该版本/结构没有精确 Y
    int z = 0;
    bool trim = false;             // 该箱子开出了纹饰模板
    bool silence = false;          // 纹饰是 Silence（地图最高亮）
    bool ward = false;             // 纹饰是 Ward（古城）
    bool netheriteUpgrade = false;
    int goldenApples = 0;
    bool snifferEgg = false;
    /** Snout banner pattern found in this chest. */
    bool piglinBanner = false;
    /** 命中的纹饰种类，按 loots::TrimKind 的位掩码（0 = 无）。 */
    unsigned trimKinds = 0;
    /** Music discs / fragments, see loots::LootDiscBits. */
    unsigned discKinds = 0;
    /** Banner / sniffer egg / golden apple, see loots::LootMiscBits. */
    unsigned miscKinds = 0;
    /** Pottery sherds, see loots::LootSherdBits (bits 17-22 reserved). */
    unsigned sherdKinds = 0;
    /** Total disc_fragment_5 items in this container. */
    int discFragments = 0;
    /** 0 = chest, 1 = barrel, 2 = decorated pot, 3 = suspicious block. */
    int container = 0;
    /** True when the position/existence is approximate (abandoned mineshaft). */
    bool approximate = false;
    /** 迅捷潜行附魔书的等级（每本一项，升序）。 */
    std::vector<int> swiftSneakLevels;
};

struct LootChestInfo {
    int type = 0;                  // cubiomes StructureType
    int x = 0;
    int z = 0;
    bool exists = false;
    int pieces = 0;
    /**
     * 该结构里是否存在目标战利品（任意箱子开出纹饰/下界合金/金苹果/嗅探蛋）。
     * 沙漠神殿与丛林神殿只用这个字段：它们不给箱子坐标，也就不需要地形高度。
     */
    bool hasLoot = false;
    /** Pillager outpost: a feature_cage_with_allays piece was placed (1.19+). */
    bool hasAllay = false;
    /** Number of allay cage feature pieces, when allay detection was evaluated. */
    int allayCages = 0;
    /** 命中的战利品种类（0 无, 1 纹饰, 2 下界合金, 3 嗅探蛋, 4 附魔金苹果, 5 旗帜图案, 6 唱片, 7 陶片）。 */
    int lootKind = 0;
    /** 仅提示型的命中明细（可与 lootKind 同时为真，例如沙丘 + 附魔金）。 */
    bool hasTrim = false;
    bool hasNetherite = false;
    bool hasSnifferEgg = false;
    bool hasGoldenApple = false;
    /** Piglin banner pattern found in any evaluated chest of this structure. */
    bool hasPiglinBanner = false;
    /** 本结构所有目标箱的 trimKinds 并集（用于图标右下角的模板角标）。 */
    unsigned trimKinds = 0;
    /** 本结构所有目标箱的唱片/碎片并集（loots::LootDiscBits）。 */
    unsigned discKinds = 0;
    /** 本结构所有目标箱的杂项并集（loots::LootMiscBits）。 */
    unsigned miscKinds = 0;
    /** 本结构所有目标箱/方块的陶片并集（loots::LootSherdBits）。 */
    unsigned sherdKinds = 0;
    /** 本结构所有目标箱的 disc_fragment_5 总数。 */
    int discFragments = 0;
    /** UI 类别位：1 杂项 / 2 模板 / 4 唱片 / 8 陶片（loots::LootCategoryBits）。 */
    unsigned categoryMask = 0;
    /** True when the structure's chest positions/seeds are approximate. */
    bool approximate = false;
    /**
     * 结果可信度：false 表示该结构的战利品坐标/判定仍是近似值
     * （1.20 之前的海底遗迹嗅探蛋、废弃矿井箱子）。
     */
    bool reliable = true;
    std::vector<LootChest> chests;
};

/** Install the host-provided loots inputs (ancient-city layout / surface height). */
/**
 * 按结构类型批量求箱子战利品。
 */
std::vector<LootChestInfo> lootChests(int mc, uint64_t seed,
                                      const std::vector<std::pair<int, int>> &structures,
                                      const std::vector<int> &types);

bool parseSeedText(const std::string &text, uint64_t *out, bool allowTextHash);

std::vector<McVersion> listMcVersions();
std::vector<FeatureEntry> listFeatures();

bool renderBiomeTile(int mc, uint64_t seed, int dim, uint32_t flags, int scale,
                      int x, int z, int sx, int sz, int blockY,
                      std::vector<uint8_t> &rgba, std::string &error);

void renderTiles(int mc, uint64_t seed, int dim, uint32_t flags, int blockY,
                 const std::vector<TileSpec> &tiles, std::vector<TileImage> &out);

void slimeMask(uint64_t seed, int chunkX, int chunkZ, int width, int height, std::vector<uint8_t> &out);

int biomeAt(int mc, uint64_t seed, int dim, uint32_t flags, int blockX, int blockY, int blockZ);

std::vector<PlacedFeature> featuresInView(int mc, uint64_t seed, int dim, uint32_t flags,
                                          int x0, int z0, int x1, int z1,
                                          const std::vector<int> &types);

bool fortressBounds(int mc, uint64_t seed, int blockX, int blockZ, FortressBounds &out);
