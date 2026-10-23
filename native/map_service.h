#pragma once

#include <stdint.h>

#include <string>
#include <utility>
#include <vector>

struct McVersion {
    int id;
    std::string name;
};

struct BiomeEntry {
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
};

bool parseSeedText(const std::string &text, uint64_t *out, bool allowTextHash);

std::vector<McVersion> listMcVersions();
std::vector<BiomeEntry> listBiomes(int mc);
std::vector<FeatureEntry> listFeatures();

bool renderBiomeTile(int mc, uint64_t seed, int dim, uint32_t flags, int scale,
                      int x, int z, int sx, int sz, int blockY,
                      std::vector<uint8_t> &rgba, std::string &error);

void renderTiles(int mc, uint64_t seed, int dim, uint32_t flags, int blockY,
                 const std::vector<TileSpec> &tiles, std::vector<TileImage> &out);

void slimeMask(uint64_t seed, int chunkX, int chunkZ, int width, int height, std::vector<uint8_t> &out);

int biomeAt(int mc, uint64_t seed, int dim, uint32_t flags, int blockX, int blockY, int blockZ);

bool worldSpawn(int mc, uint64_t seed, uint32_t flags, int *x, int *z);

std::vector<PlacedFeature> featuresInView(int mc, uint64_t seed, int dim, uint32_t flags,
                                          int x0, int z0, int x1, int z1,
                                          const std::vector<int> &types);
