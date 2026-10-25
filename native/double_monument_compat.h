#pragma once

/*
 * 过渡适配层。
 *
 * 正式方案：tools/doublemonument 的 aio-lib 分支已经把符号改成
 * DoubleProgress / DoublePairHit / DoubleMonumentConfig / DoubleResults /
 * runDoubleMonumentSearch / dm_*，此时打开 AIO_DOUBLE_MONUMENT_REFACTORED=1，
 * 本文件只包含上游头文件。
 *
 * 分支就绪前：用宏把当前子模块的旧符号映射到同一套名字，host 代码不需要改。
 * 分支就绪后删除该适配层即可。
 */

#if defined(AIO_DOUBLE_MONUMENT_REFACTORED) && AIO_DOUBLE_MONUMENT_REFACTORED

#include "../tools/doublemonument/monument_search.h"

#else

#define Progress DoubleProgress
#define PairHit DoublePairHit
#define MonumentSearchConfig DoubleMonumentConfig
#define ThreadSafeResults DoubleResults
#define ThreadPool DoublePool
#define runMonumentSearch runDoubleMonumentSearch
#define MonumentGenerator DmMonumentGenerator
#define monument_generator_alloc dm_monument_generator_alloc
#define monument_generator_free dm_monument_generator_free
#define monument_init_generator dm_monument_init_generator
#define monument_try_region dm_monument_try_region
#define monument_try_region_g dm_monument_try_region_g
#define monument_exists_at_block dm_monument_exists_at_block
#define monument_exists_at_block_g dm_monument_exists_at_block_g
#define monument_classify_ocean_type dm_monument_classify_ocean_type
#define monument_classify_ocean_type_g dm_monument_classify_ocean_type_g

#include "../tools/doublemonument/monument_search.cpp"

#undef Progress
#undef PairHit
#undef MonumentSearchConfig
#undef ThreadSafeResults
#undef ThreadPool
#undef runMonumentSearch
#undef MonumentGenerator
#undef monument_generator_alloc
#undef monument_generator_free
#undef monument_init_generator
#undef monument_try_region
#undef monument_try_region_g
#undef monument_exists_at_block
#undef monument_exists_at_block_g
#undef monument_classify_ocean_type
#undef monument_classify_ocean_type_g

#endif
