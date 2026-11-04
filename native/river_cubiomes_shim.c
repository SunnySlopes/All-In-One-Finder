/*
 * river-native 专用 cubiomes 扩展（shim）。
 *
 * 背景：river-native 使用的 cubiomes 维护分支（qk-yiyihehe/cubiomes,
 * minecraft-finders）在 biomenoise.c / layers.c 里新增了两个函数：
 *
 *   int  climateCaveBiome(int mc, const uint64_t np[6]);
 *   void mapVoronoiVolume(uint64_t sha, int *out, const int *src, ...);
 *
 * AIO 全仓只链接一份共享 cubiomes（tools/cubiomes，xpple/cubiomes master）
 * 与 tools/geode/third_party/cubiomes（26.3 补丁），这两份都**没有**上述函数。
 * 为保持“单一 cubiomes 实现、不重复符号”的硬约束，这里只把这**两个函数**的
 * 源码原样搬过来编进 river_native_objs，其余 cubiomes 符号仍由 cubiomes_objs 提供。
 *
 * 源码逐字取自：
 *   tools/river/third_party/cubiomes/biomenoise.c:1518-1559 (climateCaveBiome)
 *   tools/river/third_party/cubiomes/layers.c:1762-1835      (mapVoronoiVolume)
 * 两者都是独立函数，仅依赖 getVoronoiCell（由共享 cubiomes 的 layers.c 提供）。
 *
 * 许可：GPL-3.0-only（随 river-native 子模块分发）。
 */

#include <cubiomes/biomes.h>
#include <cubiomes/biomenoise.h>
#include <cubiomes/layers.h>
#include <cubiomes/rng.h>

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* layers.c 里是 static inline，这里复制同一份实现（逐字取自共享 cubiomes）。 */
static inline void rn_getVoronoiCell(uint64_t sha, int a, int b, int c,
        int *x, int *y, int *z)
{
    uint64_t s = sha;
    s = mcStepSeed(s, a);
    s = mcStepSeed(s, b);
    s = mcStepSeed(s, c);
    s = mcStepSeed(s, a);
    s = mcStepSeed(s, b);
    s = mcStepSeed(s, c);

    *x = (((s >> 24) & 1023) - 512) * 36;
    s = mcStepSeed(s, sha);
    *y = (((s >> 24) & 1023) - 512) * 36;
    s = mcStepSeed(s, sha);
    *z = (((s >> 24) & 1023) - 512) * 36;
}

/* ---- 取自 river-native cubiomes/biomenoise.c ---- */
/* 八组版本表已核对：非洞穴叶的深度仅为 0 或 10000，四类洞穴使用下列参数框。 */
int climateCaveBiome(int mc, const uint64_t np[6])
{
    if (mc < MC_1_18 || mc > MC_26_3)
        return none;
    static const int32_t boxes[4][6][2] = {
        {{-10000,10000},{-10000,10000},{8000,10000},{-10000,10000},{2000,9000},{-10000,10000}},
        {{-10000,10000},{7000,10000},{-10000,10000},{-10000,10000},{2000,9000},{-10000,10000}},
        {{-10000,10000},{-10000,10000},{-10000,10000},{-10000,-3750},{11000,11000},{-10000,10000}},
        {{-10000,10000},{-10000,10000},{-1900,5500},{4500,10000},{2000,9000},{-11000,-8500}}
    };
    static const int ids[4] = {dripstone_caves,lush_caves,deep_dark,sulfur_caves};
    int64_t depth = (int64_t)np[NP_DEPTH];
    uint64_t a = depth*(uint64_t)depth;
    uint64_t b = (depth-10000)*(uint64_t)(depth-10000);
    uint64_t best = a < b ? a : b;
    int selected = none;
    int count = mc >= MC_26_2 ? 4 : mc >= MC_1_19_2 ? 3 : 2;
    for (int cave = 0; cave < count; cave++)
    {
        uint64_t distance = 0;
        for (int axis = 0; axis < 6; axis++)
        {
            int64_t value = (int64_t)np[axis];
            int64_t delta = value < boxes[cave][axis][0] ? boxes[cave][axis][0]-value :
                value > boxes[cave][axis][1] ? value-boxes[cave][axis][1] : 0;
            distance += delta*(uint64_t)delta;
        }
        // 严格小于全部竞争者才返回；洞穴间同距也必须回原树，不能改写原版优先级。
        if (distance < best)
        {
            best = distance;
            selected = ids[cave];
        }
        else if (distance == best)
        {
            selected = none;
        }
    }
    return selected;
}

/* ---- 取自 river-native cubiomes/layers.c ---- */
void mapVoronoiVolume(uint64_t sha, int *out, const int *src,
    int x, int y, int z, int sx, int sy, int sz,
    int px, int py, int pz, int psx, int psy, int psz)
{
    const int64_t plane = (int64_t)sx*sz, source_plane = (int64_t)psx*psz;
    for (int cy = 0; cy < psy-1; cy++)
    {
        int oy = (py+cy)*4+2-y;
        int ly = oy < 0 ? -oy : 0, hy = sy-oy < 4 ? sy-oy : 4;
        if (ly >= hy) continue;
        for (int cz = 0; cz < psz-1; cz++)
        {
            int oz = (pz+cz)*4+2-z;
            int lz = oz < 0 ? -oz : 0, hz = sz-oz < 4 ? sz-oz : 4;
            if (lz >= hz) continue;
            for (int cx = 0; cx < psx-1; cx++)
            {
                int ox = (px+cx)*4+2-x;
                int lx = ox < 0 ? -ox : 0, hx = sx-ox < 4 ? sx-ox : 4;
                if (lx >= hx) continue;
                int ids[8], uniform = 1;
                for (int corner = 0; corner < 8; corner++)
                {
                    int bx = (corner & 4) != 0, by = (corner & 2) != 0, bz = corner & 1;
                    ids[corner] = src[(int64_t)(cy+by)*source_plane + (int64_t)(cz+bz)*psx+cx+bx];
                    if (corner && ids[corner] != ids[0]) uniform = 0;
                }
                if (uniform)
                {
                    // 八个候选角点同群系时，内部全部格位必然相同，无需计算随机偏移。
                    for (int iy = ly; iy < hy; iy++)
                        for (int iz = lz; iz < hz; iz++)
                            for (int ix = lx; ix < hx; ix++)
                                out[(oy+iy)*plane+(int64_t)(oz+iz)*sx+ox+ix] = ids[0];
                    continue;
                }
                int64_t xd[4][8], yd[4][8], zd[4][8];
                for (int corner = 0; corner < 8; corner++)
                {
                    int bx = (corner & 4) != 0, by = (corner & 2) != 0, bz = corner & 1;
                    int rx, ry, rz;
                    rn_getVoronoiCell(sha, px+cx+bx, py+cy+by, pz+cz+bz, &rx, &ry, &rz);
                    // 一个4³小块只生成八次偏移；沿各轴复用距离平方，严格保留角点同距顺序。
                    for (int k = 0; k < 4; k++)
                    {
                        int64_t a = rx + k*10240 - bx*40960;
                        int64_t b = ry + k*10240 - by*40960;
                        int64_t c = rz + k*10240 - bz*40960;
                        xd[k][corner] = a*a;
                        yd[k][corner] = b*b;
                        zd[k][corner] = c*c;
                    }
                }
                for (int iy = ly; iy < hy; iy++)
                    for (int iz = lz; iz < hz; iz++)
                        for (int ix = lx; ix < hx; ix++)
                        {
                            uint64_t best = (uint64_t)-1;
                            int selected = 0;
                            for (int corner = 0; corner < 8; corner++)
                            {
                                uint64_t distance = xd[ix][corner]+yd[iy][corner]+zd[iz][corner];
                                if (distance < best)
                                {
                                    best = distance;
                                    selected = corner;
                                }
                            }
                            out[(oy+iy)*plane+(int64_t)(oz+iz)*sx+ox+ix] = ids[selected];
                        }
            }
        }
    }
}

#ifdef __cplusplus
}
#endif
