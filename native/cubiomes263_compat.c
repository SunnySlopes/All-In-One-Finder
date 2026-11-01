/*
 * MC 26.3 climate/noise compatibility layer.
 *
 * Derived from the GPL-3.0-only extensions in
 * tools/geode/third_party/cubiomes (qk-yiyihehe/cubiomes @ ea575d8), which in
 * turn is based on xpple/cubiomes @ aee7423. Only the 26.3-only code paths are
 * reproduced here so the shared cubiomes implementation can keep serving
 * 1.18-26.2 unchanged.
 */

#include "cubiomes263_compat.h"

#include <math.h>

#include "tables/spline263.h"

static inline float lerpClimate(float t, float a, float b)
{
    return a + t * (b - a);
}

/* Same helper as biomenoise.c's file-local peaksAndValleys(). */
static inline float peaksAndValleys(float weirdness)
{
    return -(fabsf(fabsf(weirdness) - 0.6666667F) - 0.33333334F) * 3.0F;
}

static float getSplineFloat(const Spline *sp, const float *values)
{
    if (sp->len == 1)
        return ((const FixSpline *)sp)->val;
    float x = values[sp->typ];
    int i = 0;
    while (i < sp->len && x >= sp->loc[i])
        i++;
    if (i == 0 || i == sp->len)
    {
        if (i) i--;
        return getSplineFloat(sp->val[i], values) + sp->der[i] * (x - sp->loc[i]);
    }
    float span = sp->loc[i] - sp->loc[i - 1];
    float t = (x - sp->loc[i - 1]) / span;
    float a = getSplineFloat(sp->val[i - 1], values);
    float b = getSplineFloat(sp->val[i], values);
    float delta = b - a;
    float da = sp->der[i - 1] * span - delta;
    float db = -sp->der[i] * span + delta;
    return lerpClimate(t, a, b) + t * (1.0F - t) * lerpClimate(t, da, db);
}

static inline float gradientFloat(uint8_t index, float a, float b, float c)
{
    /* Keep the vanilla three-term dot-product order; table lookup avoids a
       branch per corner and repeated double conversions. */
    static const float g[16][3] = {
        {1, 1, 0}, {-1, 1, 0}, {1, -1, 0}, {-1, -1, 0},
        {1, 0, 1}, {-1, 0, 1}, {1, 0, -1}, {-1, 0, -1},
        {0, 1, 1}, {0, -1, 1}, {0, 1, -1}, {0, -1, -1},
        {1, 1, 0}, {0, -1, 1}, {-1, 1, 0}, {0, -1, -1}
    };
    const float *v = g[index & 15];
    return (v[0] * a + v[1] * b) + v[2] * c;
}

static inline float lerpFloat(float t, float a, float b)
{
    return a + t * (b - a);
}

static inline double wrapFloatNoise(double x)
{
    return x - floor(x / 33554432.0 + 0.5) * 33554432.0;
}

float samplePerlinFloatRaw(const uint8_t permutation[256], double ox, double oy, double oz, double x,
                           double y, double z, double smear)
{
    /* 26.3 keeps coordinates and offsets in double but rounds lattice-local
       coordinates, gradients and interpolation to float. */
    double inputY = y;
    x = wrapFloatNoise(x) + ox;
    y = wrapFloatNoise(y) + oy;
    z = wrapFloatNoise(z) + oz;
    int ix = (int)floor(x), iy = (int)floor(y), iz = (int)floor(z);
    float dx = (float)(x - ix), dy = (float)(y - iy), dz = (float)(z - iz);
    float tx = dx * dx * dx * (dx * (dx * 6.0F - 15.0F) + 10.0F);
    float ty = dy * dy * dy * (dy * (dy * 6.0F - 15.0F) + 10.0F);
    float tz = dz * dz * dz * (dz * (dz * 6.0F - 15.0F) + 10.0F);
    if (smear != 0)
    {
        double relative = y - iy;
        double limit = inputY >= 0 && inputY < relative ? inputY : relative;
        dy = (float)(relative - floor(limit / smear + (double)1.0e-7F) * smear);
    }
    float corners[2][2][2];
    for (int a = 0; a < 2; a++)
        for (int b = 0; b < 2; b++)
            for (int c = 0; c < 2; c++)
            {
                int h = permutation[(permutation[(permutation[(ix + a) & 255] + iy + b) & 255] + iz + c) & 255];
                corners[a][b][c] = gradientFloat(h, dx - a, dy - b, dz - c);
            }
    return lerpFloat(tz,
        lerpFloat(ty, lerpFloat(tx, corners[0][0][0], corners[1][0][0]),
                      lerpFloat(tx, corners[0][1][0], corners[1][1][0])),
        lerpFloat(ty, lerpFloat(tx, corners[0][0][1], corners[1][0][1]),
                      lerpFloat(tx, corners[0][1][1], corners[1][1][1])));
}

float samplePerlinFloat(const PerlinNoise *noise, double x, double y, double z)
{
    return samplePerlinFloatRaw(noise->d, noise->a, noise->b, noise->c, x, y, z, 0);
}

float sampleDoublePerlinFloat(const DoublePerlinNoise *noise, double x, double y, double z)
{
    /* Vanilla's NoiseStack interleaves both octave groups; they cannot be
       summed separately and then scaled by the total amplitude. */
    float value = 0;
    int count = noise->octA.octcnt > noise->octB.octcnt ? noise->octA.octcnt : noise->octB.octcnt;
    for (int i = 0; i < count; i++)
    {
        if (i < noise->octA.octcnt)
        {
            const PerlinNoise *p = noise->octA.octaves + i;
            float weight = (float)(noise->amplitude * p->amplitude);
            value += weight * samplePerlinFloat(p, x * p->lacunarity, y * p->lacunarity, z * p->lacunarity);
        }
        if (i < noise->octB.octcnt)
        {
            const PerlinNoise *p = noise->octB.octaves + i;
            double f = p->lacunarity * (337.0 / 331.0);
            float weight = (float)(noise->amplitude * p->amplitude);
            value += weight * samplePerlinFloat(p, x * f, y * f, z * f);
        }
    }
    return value;
}

float sampleClimateNoise(const BiomeNoise *bn, int parameter, double x, double y, double z)
{
    const DoublePerlinNoise *noise = bn->climate + parameter;
    return bn->mc >= MC_26_3 ? sampleDoublePerlinFloat(noise, x, y, z)
                             : (float)sampleDoublePerlin(noise, x, y, z);
}

float sampleClimateDepth(const BiomeNoise *bn, float c, float e, float w, int blockY)
{
    float inputs[] = {c, e, peaksAndValleys(w), w};
    if (bn->mc >= MC_26_3)
    {
        int cy = blockY < -64 ? -64 : blockY > 320 ? 320 : blockY;
        float gradient = 1.5F + (float)(cy + 64) * (-3.0F / 384.0F);
        /* setupGenerator() still runs the baseline initBiomeNoise(), so use the
           serialized 26.3 spline directly instead of bn->sp. */
        return gradient + (-0.50375F + getSplineFloat(CLIMATE263_SPLINE_ROOT, inputs));
    }
    double off = getSpline(bn->sp, inputs) + 0.015F;
    return (float)(1.0 - blockY / 128.0 - 83.0 / 160.0 + off);
}

void sampleBiomeClimate(const BiomeNoise *bn, float values[NP_MAX], int x, int y, int z,
                        uint32_t flags)
{
    double px = x * 0.25, pz = z * 0.25;
    if (!(flags & SAMPLE_NO_SHIFT))
    {
        if (bn->mc >= MC_26_3)
        {
            px += sampleClimateNoise(bn, NP_SHIFT, x * 0.25, 0, z * 0.25) * 4.0F;
            pz += sampleClimateNoise(bn, NP_SHIFT, z * 0.25, x * 0.25, 0) * 4.0F;
        }
        else
        {
            px += sampleDoublePerlin(&bn->climate[NP_SHIFT], x * 0.25, 0, z * 0.25) * 4.0;
            pz += sampleDoublePerlin(&bn->climate[NP_SHIFT], z * 0.25, x * 0.25, 0) * 4.0;
        }
    }
    float c = sampleClimateNoise(bn, NP_CONTINENTALNESS, px, 0, pz);
    float e = sampleClimateNoise(bn, NP_EROSION, px, 0, pz);
    float w = sampleClimateNoise(bn, NP_WEIRDNESS, px, 0, pz);
    float d = flags & SAMPLE_NO_DEPTH ? 0 : sampleClimateDepth(bn, c, e, w, y);
    values[NP_TEMPERATURE] = flags & SAMPLE_NO_TEMPERATURE ? 0 :
        sampleClimateNoise(bn, NP_TEMPERATURE, px, 0, pz);
    values[NP_HUMIDITY] = flags & SAMPLE_NO_HUMIDITY ? 0 :
        sampleClimateNoise(bn, NP_HUMIDITY, px, 0, pz);
    values[NP_CONTINENTALNESS] = c;
    values[NP_EROSION] = e;
    values[NP_DEPTH] = d;
    values[NP_WEIRDNESS] = w;
}
