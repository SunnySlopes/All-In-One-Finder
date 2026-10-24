cmake_minimum_required(VERSION 3.20)
project(allinone C CXX)

if (MSVC)
  message(FATAL_ERROR "MSVC is not supported. Use the MSYS2 UCRT64 gcc toolchain.")
endif()

if (NOT NODE_ADDON_API_DIR OR NOT NODE_API_HEADERS_DIR)
  message(FATAL_ERROR "Pass NODE_ADDON_API_DIR and NODE_API_HEADERS_DIR")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CUBI "${CMAKE_SOURCE_DIR}/../tools/cubiomes")
set(LOWY "${CMAKE_SOURCE_DIR}/../tools/dripstonecave/jni")
set(SLIME "${CMAKE_SOURCE_DIR}/../tools/slime")
set(SLIMERADAR "${SLIME}/slimeradar/src")
set(SLIMEOPT "${SLIME}/slimeoptimizer")
set(RIVER "${CMAKE_SOURCE_DIR}/../tools/river")
set(LYSH "${CMAKE_SOURCE_DIR}/../tools/lowyswamphut/lysh-c")

set(CUBI_ROOT_SOURCES
  finders.c carver.c generator.c layers.c biomenoise.c biomes.c noise.c
  terrainnoise.c util.c quadbase.c xradv.c
)
set(CUBI_SOURCES "")
foreach(src ${CUBI_ROOT_SOURCES})
  list(APPEND CUBI_SOURCES "${CUBI}/${src}")
endforeach()
file(GLOB CUBI_FEATURES "${CUBI}/features/*.c")
file(GLOB CUBI_LOOT
  "${CUBI}/loot/*.c"
  "${CUBI}/loot/cjson/*.c"
  "${CUBI}/loot/loot_tables/barrels/*.c"
  "${CUBI}/loot/loot_tables/chests/*.c"
  "${CUBI}/loot/loot_tables/chests/trial_chambers/*.c"
)
list(APPEND CUBI_SOURCES ${CUBI_FEATURES} ${CUBI_LOOT})

add_library(cubiomes_objs OBJECT ${CUBI_SOURCES})
set_target_properties(cubiomes_objs PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(cubiomes_objs PUBLIC "${CUBI}")
target_compile_options(cubiomes_objs PRIVATE
  -O3 -DNDEBUG -fwrapv -fno-semantic-interposition -mpopcnt -flto -D_WIN32
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

set(HOT_CXX
  addon.cpp
  map_service.cpp
  lowy_host.cpp
  slime_host.cpp
  witch_host.cpp
  river_host.cpp
  search_gate.cpp
  "${SLIME}/slime_search.cpp"
  "${SLIMEOPT}/src/geometry.cpp"
  "${SLIMEOPT}/src/slime_check.cpp"
  "${SLIMEOPT}/src/java_random.cpp"
  "${LOWY}/BiomeSampler.cpp"
  "${LOWY}/OctaveFieldCache.cpp"
)
# tools/river 的 river_finder.cpp 由 river_host.cpp include（唯一 TU），不在这里
# 再列一次：上游 riverFinderLib.cpp / JNI 桥也是直接 include 它，同时编译会重复符号。
set(SLIME_C
  "${SLIMERADAR}/cpu_search.c"
  "${SLIMERADAR}/cpu_simd_avx2.c"
)
add_library(allinone SHARED ${HOT_CXX} ${SLIME_C} "${CMAKE_BINARY_DIR}/napi_bind.cpp")
set_target_properties(allinone PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "allinone"
)
target_include_directories(allinone PRIVATE
  "${NODE_ADDON_API_DIR}"
  "${NODE_API_HEADERS_DIR}"
  "${CMAKE_SOURCE_DIR}/../tools"
  "${LOWY}"
  "${SLIMERADAR}"
  "${SLIMEOPT}/include"
  "${RIVER}"
)
target_compile_definitions(allinone PRIVATE
  NAPI_VERSION=8
  NAPI_CPP_EXCEPTIONS
  DRIPSTONECAVE_FINDER_JNI_LIB
  _WIN32
)
target_compile_options(allinone PRIVATE
  -O3 -DNDEBUG -fwrapv -fexceptions -flto -mpopcnt
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
target_link_libraries(allinone PRIVATE cubiomes_objs lysh_core "${CMAKE_BINARY_DIR}/napi_proxy.o" -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic)
target_link_options(allinone PRIVATE
  -flto
  -static-libgcc
  -static-libstdc++
)
