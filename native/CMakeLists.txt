cmake_minimum_required(VERSION 3.20)
project(allinone C CXX)

if (MSVC)
  message(FATAL_ERROR "MSVC is not supported. Use the MSYS2 UCRT64 gcc toolchain.")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CUBI "${CMAKE_SOURCE_DIR}/../tools/cubiomes")
# geode/trial 的上游 26.3 支持依赖 qk-yiyihehe/cubiomes 的补丁（float Perlin、
# CLIMATE263 样条与 biome climate 接口）。这里只借用它的 26.3 专用接口与
# 头文件，基线 cubiomes 实现仍来自共享子模块，从而在整个 allinone DSO 中
# 只保留一份 cubiomes 符号，且 1.18–26.2 的结果保持不变。
set(CUBI263 "${CMAKE_SOURCE_DIR}/../tools/geode/third_party/cubiomes")
set(LOWY "${CMAKE_SOURCE_DIR}/../tools/dripstonecave")
set(SLIME "${CMAKE_SOURCE_DIR}/../tools/slime")
set(SLIMERADAR "${SLIME}/slimeradar/src")
set(SLIMEOPT "${SLIME}/slimeoptimizer")
set(RN "${CMAKE_SOURCE_DIR}/../tools/river")
set(LYSH "${CMAKE_SOURCE_DIR}/../tools/lowyswamphut")
set(FORTRESS "${CMAKE_SOURCE_DIR}/../tools/fortress")
set(MULTI "${CMAKE_SOURCE_DIR}/../tools/multimonument")
set(DOUBLE "${CMAKE_SOURCE_DIR}/../tools/doublemonument")
set(FLOWER "${CMAKE_SOURCE_DIR}/../tools/flower")
set(TRIAL "${CMAKE_SOURCE_DIR}/../tools/trial")
set(GEODE "${CMAKE_SOURCE_DIR}/../tools/geode")
if (EXISTS "${FLOWER}/cubiomes/biomes.h")
  message(WARNING
    "tools/flower/cubiomes is populated; FlowerFarmSearch.cpp may include that copy instead of the shared tools/cubiomes. "
    "Keep the nested cubiomes empty (or change the includes to angle brackets) so the single-node cubiomes stays unified.")
endif()
# LowYDripstoneCaveFinderBase also carries a nested cubiomes submodule. AIO keeps
# only the shared tools/cubiomes so every engine in the DLL uses the same headers
# and one cubiomes implementation; leave tools/dripstonecave/cubiomes empty.
if (EXISTS "${LOWY}/cubiomes/generator.h")
  message(WARNING
    "tools/dripstonecave/cubiomes is populated; the dripstone engine will include that copy instead of the shared tools/cubiomes. "
    "Keep the nested cubiomes empty so the single-node cubiomes stays unified.")
endif()
# doubleMonumentFinderBase also carries a nested cubiomes submodule, and
# monument_search_core.c includes "cubiomes/*.h" with quotes, so a populated
# tools/doublemonument/cubiomes would shadow the shared headers.  Keep it empty.
if (EXISTS "${DOUBLE}/cubiomes/finders.h")
  message(WARNING
    "tools/doublemonument/cubiomes is populated; the double monument kernel will include that copy instead of the shared tools/cubiomes. "
    "Keep the nested cubiomes empty so the single-node cubiomes stays unified.")
endif()

option(AIO_DOUBLE_MONUMENT_REFACTORED "doublemonument branch already renamed for AIO" ON)

set(CUBI_ROOT_SOURCES
  finders.c carver.c generator.c layers.c biomenoise.c biomes.c noise.c
  terrainnoise.c util.c quadbase.c xradv.c
)
set(CUBI_SOURCES "")
foreach(src ${CUBI_ROOT_SOURCES})
  list(APPEND CUBI_SOURCES "${CUBI}/${src}")
endforeach()
# 26.3 需要的 float Perlin / climate 接口只在补丁版里存在。这里不编译整份
# 补丁版 biomenoise.c（那会改变 1.18–26.2 的既有结果），而是把 26.3 分支
# 单独放进 cubiomes263_compat.c，旧版本继续使用共享子模块的基线实现。
list(APPEND CUBI_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/cubiomes263_compat.c")
file(GLOB CUBI_FEATURES "${CUBI}/features/*.c")
# AIO never calls the loot generation API; keep the headers but do not compile
# loot/** (it is ~1.5 MB of object code and none of it is reachable).
list(APPEND CUBI_SOURCES ${CUBI_FEATURES})

add_library(cubiomes_objs OBJECT ${CUBI_SOURCES})
set_target_properties(cubiomes_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(cubiomes_objs PUBLIC "${CUBI263}" "${CUBI}")
target_compile_options(cubiomes_objs PRIVATE
  -O3 -DNDEBUG -fwrapv -fno-semantic-interposition -mpopcnt
  -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
)

# ---------------------------------------------------------------------------
# 低 Y 女巫小屋内核（lysh_core）。
#
# 逐位一致的硬性要求：必须 -ffp-contract=off，绝不可加 -ffast-math。
# 这里刻意不给 lysh_core 开 -flto，避免链接期代码生成重新引入 FP contraction；
# 它不是 LTO 目标，所以链接参数里的 -flto 不会作用于这些对象。
# 主仓 cubiomes_objs 仍然只编一次，与 lysh_core 一起链进 allinone。
# ---------------------------------------------------------------------------
add_library(lysh_core STATIC
  "${LYSH}/src/rng.c"
  "${LYSH}/src/noise.c"
  "${LYSH}/src/structure.c"
  "${LYSH}/src/climate.c"
  "${LYSH}/src/caves.c"
  "${LYSH}/src/phase1.c"
  "${LYSH}/src/biome.c"
  "${LYSH}/src/spline.c"
  "${LYSH}/src/terrain.c"
  "${LYSH}/src/column_top.c"
  "${LYSH}/src/density.c"
  "${LYSH}/src/interp_noise.c"
  "${LYSH}/src/aquifer.c"
  "${LYSH}/src/carver.c"
  "${LYSH}/src/phase2.c"
  "${LYSH}/src/eval.c"
  "${LYSH}/src/search.c"
)
set_target_properties(lysh_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(lysh_core PRIVATE "${LYSH}/src")
target_compile_options(lysh_core PRIVATE
  -O3 -DNDEBUG -ffp-contract=off -mavx2
)

# 全花种：CTS 是 C11 + OpenMP，FlowerFarmSearch.cpp 是 C++20；单独编成 object
# library，避免把 -include pre_cubiomes.h 传播到其他引擎源，同时保留
# -ffp-contract=off / -fno-lto。
set(FLOWER_C
  "${FLOWER}/cts/climate.c"
  "${FLOWER}/cts/biome.c"
  "${FLOWER}/cts/engine.c"
)
add_library(flower_objs OBJECT
  "${FLOWER}/src/FlowerFarmSearch.cpp"
  ${FLOWER_C}
)
set_target_properties(flower_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(flower_objs PRIVATE
  "${FLOWER}/include"
  "${FLOWER}/cts"
  "${CMAKE_SOURCE_DIR}/../tools"
  "${CUBI}"
)
target_compile_definitions(flower_objs PRIVATE _WIN32)
target_compile_options(flower_objs PRIVATE
  -O3 -DNDEBUG -fwrapv -ffp-contract=off -fno-lto -fopenmp
  -include "${FLOWER}/cxx_compat/pre_cubiomes.h"
)

# 试炼刷怪笼：layout/search/climate263 是 C++20，biome_bridge 是 C。
# 引擎源单独编成 object library，不继承 allinone 目标的 -include pre_cubiomes.h；
# 只共用一份根 cubiomes（cubiomes_objs）。
add_library(trial_objs OBJECT
  "${TRIAL}/src/layout.cpp"
  "${TRIAL}/src/search.cpp"
  "${TRIAL}/src/climate263.cpp"
)
set_target_properties(trial_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(trial_objs PRIVATE
  "${TRIAL}/src"
  "${TRIAL}/data"
  "${CUBI263}"
  "${CUBI}"
)
target_compile_definitions(trial_objs PRIVATE
  _WIN32
  TRIAL_ENGINE_VERSION="3.1.2"
  # 与 geode/trial 上游锁定的 qk-yiyihehe/cubiomes 补丁版本一致，避免恢复
  # 旧版 26.3 断点时把不兼容的结果当成同一任务。
  CUBIOMES_REVISION="ea575d85536eba8e89a4e2a0528a60d2094221c8"
  CUBIOMES_FINGERPRINT=0xea575d85536eba8eULL
)
target_compile_options(trial_objs PRIVATE
  -O3 -DNDEBUG -fwrapv -fexceptions -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
)

add_library(trial_bridge OBJECT "${TRIAL}/src/biome_bridge.c")
set_target_properties(trial_bridge PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(trial_bridge PRIVATE "${CUBI263}" "${CUBI}")
target_compile_options(trial_bridge PRIVATE
  -O3 -DNDEBUG -fwrapv -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
)

# 紫水晶母岩：geode 引擎与试炼共用根 cubiomes；G-UP3 已把 layout 命名空间
# 和 biome 桥接函数改为 geode_layout / geode_biomes_*，因此两个引擎可同时链接。
add_library(geode_objs OBJECT
  "${GEODE}/src/geode.cpp"
  "${GEODE}/src/search.cpp"
  "${GEODE}/src/checkpoint.cpp"
  "${GEODE}/src/coarse_gpu.cpp"
  "${GEODE}/src/terrain.cpp"
  "${GEODE}/src/carver.cpp"
  "${GEODE}/src/structures.cpp"
  "${GEODE}/src/structure_layout/layout.cpp"
  "${GEODE}/src/structure_layout/climate263.cpp"
)
set_target_properties(geode_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(geode_objs PRIVATE
  "${GEODE}/src"
  "${GEODE}/data"
  "${GEODE}/src/structure_layout"
  "${CUBI263}"
  "${CUBI}"
)
target_compile_definitions(geode_objs PRIVATE
  _WIN32
  CUBIOMES_REVISION="ea575d85536eba8e89a4e2a0528a60d2094221c8"
  CUBIOMES_FINGERPRINT=0xea575d85536eba8eULL
)
target_compile_options(geode_objs PRIVATE
  -O3 -DNDEBUG -fwrapv -fexceptions -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
)

add_library(geode_bridge OBJECT "${GEODE}/src/structure_layout/biome_bridge.c")
set_target_properties(geode_bridge PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(geode_bridge PRIVATE "${CUBI263}" "${CUBI}")
target_compile_options(geode_bridge PRIVATE
  -O3 -DNDEBUG -fwrapv -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
)

# 河流：river-native 引擎。只编 search.cpp（引擎本体）+ coverage.cpp（计分几何）。
# 不编 storage.cpp / protocol.cpp：它们只为 CLI/JSON 导出服务，会额外拖入 953 KB 的
# third_party/json.hpp，且是 CUBIOMES_REVISION / RIVER_ENGINE_VERSION 的唯一使用者。
# cubiomes 一律用共享的 cubiomes_objs（tools/cubiomes），绝不编 river-native 自带的 .c，
# 否则 setupGenerator/applySeed/genBiomes 会与 allinone 里那份重复定义。
add_library(river_native_objs OBJECT
  "${RN}/src/search.cpp"
  "${RN}/src/coverage.cpp"
)
set_target_properties(river_native_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(river_native_objs PRIVATE
  "${RN}"
  "${RN}/src"
  "${RN}/third_party"
  "${CUBI}"
)
# 逐位一致：必须 -ffp-contract=off，且刻意的 -fno-lto（与 lysh_core 同一理由：
# 避免链接期代码生成重新引入 FP contraction；链接参数里的 -flto 不作用于这些对象）。
# 必须带 pre_cubiomes.h：cubiomes rng.h 的 lerp() 与 C++20 <math.h> 的 std::lerp 冲突，
# 该 prelude 把 lerp 改名后再引入 rng.h，正是 river-native 需要的。
target_compile_options(river_native_objs PRIVATE
  -O3 -DNDEBUG -fwrapv -fexceptions -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
  -include "${LOWY}/cxx_compat/pre_cubiomes.h"
)
target_compile_definitions(river_native_objs PRIVATE _WIN32)

# river-native 维护版 cubiomes 独有的两个函数（climateCaveBiome / mapVoronoiVolume），
# 共享 tools/cubiomes 里没有。单独编一个 C TU，只有这两个符号，不会重复定义别的。
add_library(river_cubiomes_shim OBJECT river_cubiomes_shim.c)
set_target_properties(river_cubiomes_shim PROPERTIES POSITION_INDEPENDENT_CODE ON)
# 注意：源码用 <cubiomes/xxx.h> 形式，需把 tools/ 作为 include 根。
target_include_directories(river_cubiomes_shim PRIVATE "${CMAKE_SOURCE_DIR}/../tools" "${CUBI}")
# 与 cubiomes_objs 同口径：-ffp-contract=off -fno-lto，保证数值与共享实现一致。
target_compile_options(river_cubiomes_shim PRIVATE
  -O3 -DNDEBUG -fwrapv -ffp-contract=off -fno-lto
  -ffunction-sections -fdata-sections
)

set(HOT_CXX
  addon.cpp
  map_service.cpp
  terrain_map.cpp
  lowy_host.cpp
  slime_host.cpp
  witch_host.cpp
  river_host.cpp
  fortress_host.cpp
  multi_monument_host.cpp
  double_monument_host.cpp
  flower_host.cpp
  trial_host.cpp
  trial_detail.cpp
  geode_host.cpp
  search_gate.cpp
  "${SLIME}/slime_search.cpp"
  "${SLIMEOPT}/src/geometry.cpp"
  "${SLIMEOPT}/src/slime_check.cpp"
  "${SLIMEOPT}/src/java_random.cpp"
  "${LOWY}/BiomeSampler.cpp"
  "${LOWY}/OctaveFieldCache.cpp"
  "${LOWY}/GpuCoarse.cpp"
)
if (AIO_DOUBLE_MONUMENT_REFACTORED)
  list(APPEND HOT_CXX "${DOUBLE}/monument_search.cpp")
endif()

set(MONUMENT_C
  "${MULTI}/monument_search_core.c"
  "${DOUBLE}/monument_search_core.c"
)
if (NOT AIO_DOUBLE_MONUMENT_REFACTORED)
  # 旧子模块：把 C 核心符号映射到计划中的 dm_* 名字。
  set(DOUBLE_CORE_DEFS
    "monument_generator_alloc=dm_monument_generator_alloc"
    "monument_generator_free=dm_monument_generator_free"
    "monument_init_generator=dm_monument_init_generator"
    "monument_try_region=dm_monument_try_region"
    "monument_try_region_g=dm_monument_try_region_g"
    "monument_exists_at_block=dm_monument_exists_at_block"
    "monument_exists_at_block_g=dm_monument_exists_at_block_g"
    "monument_classify_ocean_type=dm_monument_classify_ocean_type"
    "monument_classify_ocean_type_g=dm_monument_classify_ocean_type_g"
  )
  set_source_files_properties("${DOUBLE}/monument_search_core.c"
    PROPERTIES COMPILE_DEFINITIONS "${DOUBLE_CORE_DEFS}")
endif()
set(SLIME_C
  "${SLIMERADAR}/cpu_search.c"
  "${SLIMERADAR}/cpu_simd_avx2.c"
)
# WebView2 host engine: stable C ABI (aio_call/aio_free/aio_abi_version) on top of
# the Napi:: compatibility shim, so addon.cpp stays byte-for-byte unchanged.
set(ALLINONE_BINDING_SOURCES aio_capi.cpp napi_shim/napi_impl.cpp)
set(ALLINONE_BINDING_INCLUDES "${CMAKE_SOURCE_DIR}/napi_shim")

add_library(allinone SHARED
  ${HOT_CXX}
  ${SLIME_C}
  ${MONUMENT_C}
  $<TARGET_OBJECTS:flower_objs>
  $<TARGET_OBJECTS:trial_objs>
  $<TARGET_OBJECTS:trial_bridge>
  $<TARGET_OBJECTS:geode_objs>
  $<TARGET_OBJECTS:geode_bridge>
  $<TARGET_OBJECTS:river_native_objs>
  $<TARGET_OBJECTS:river_cubiomes_shim>
  ${ALLINONE_BINDING_SOURCES}
)
set_target_properties(allinone PROPERTIES
  PREFIX ""
  SUFFIX ".dll"
  OUTPUT_NAME "allinone"
)
target_include_directories(allinone PRIVATE
  ${ALLINONE_BINDING_INCLUDES}
  "${CMAKE_SOURCE_DIR}/../tools"
  "${FLOWER}/include"
  "${FLOWER}/cts"
  "${TRIAL}/src"
  "${GEODE}/src"
  "${CUBI263}"
  "${CUBI}"
  "${LOWY}"
  "${SLIMERADAR}"
  "${SLIMEOPT}/include"
  "${RN}"
  "${RN}/src"
  "${RN}/third_party"
)
target_compile_definitions(allinone PRIVATE
  _WIN32
)
if (AIO_DOUBLE_MONUMENT_REFACTORED)
  target_compile_definitions(allinone PRIVATE AIO_DOUBLE_MONUMENT_REFACTORED=1)
else()
  target_compile_definitions(allinone PRIVATE AIO_DOUBLE_MONUMENT_REFACTORED=0)
endif()
target_compile_options(allinone PRIVATE
  -O3 -DNDEBUG -fwrapv -fexceptions -flto -mpopcnt
  -ffunction-sections -fdata-sections
  -include "${LOWY}/cxx_compat/pre_cubiomes.h"
)
# SlimeRadar 的 AVX2 判定文件需要单独开 -mavx2；运行时仍由 CPUID 分派。
set_source_files_properties("${SLIMERADAR}/cpu_simd_avx2.c"
  PROPERTIES COMPILE_OPTIONS "-mavx2"
)
# 标量雷达热路径：-march=x86-64-v3 启用 AVX2/BMI2 等现代指令，
# -funroll-loops 与 SlimeRadar 官方基准一致。
set_source_files_properties("${SLIMERADAR}/cpu_search.c"
  PROPERTIES COMPILE_OPTIONS "-march=x86-64-v3;-funroll-loops"
)
# OpenCL 粗筛主机侧的噪声参数必须与 cubiomes / CPU 路径保持同一浮点口径。
set_source_files_properties("${LOWY}/GpuCoarse.cpp"
  PROPERTIES COMPILE_OPTIONS "-ffp-contract=off"
)
target_link_libraries(allinone PRIVATE
  cubiomes_objs lysh_core
  -lgomp -lwinpthread
)
target_link_options(allinone PRIVATE
  -flto
  -Wl,--gc-sections
  -s
  -static
  -static-libgcc
  -static-libstdc++
)
