#pragma once

/*
 * 26.3-only cubiomes entry points.
 *
 * tools/geode/third_party/cubiomes is a patched cubiomes fork that geode and
 * trial use for MC 26.3 (float Perlin noise and the serialized climate spline).
 * The shared tools/cubiomes submodule is kept as the single implementation for
 * 1.18-26.2, so only these 26.3-only functions are provided by the host.
 */

#include <stdint.h>

#include "generator.h"

/* The shared submodule's biomenoise.h predates these flags. */
#ifndef SAMPLE_NO_TEMPERATURE
#define SAMPLE_NO_TEMPERATURE 0x8
#endif
#ifndef SAMPLE_NO_HUMIDITY
#define SAMPLE_NO_HUMIDITY 0x10
#endif

#ifdef __cplusplus
extern "C" {
#endif

float samplePerlinFloatRaw(const uint8_t permutation[256], double ox, double oy, double oz, double x,
                           double y, double z, double smear);
float samplePerlinFloat(const PerlinNoise *noise, double x, double y, double z);
float sampleDoublePerlinFloat(const DoublePerlinNoise *noise, double x, double y, double z);

void sampleBiomeClimate(const BiomeNoise *bn, float values[NP_MAX], int x, int y, int z,
                        uint32_t sample_flags);
float sampleClimateNoise(const BiomeNoise *bn, int parameter, double x, double y, double z);
float sampleClimateDepth(const BiomeNoise *bn, float c, float e, float w, int blockY);

#ifdef __cplusplus
}
#endif
