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

set(HOT_CXX
  addon.cpp
  map_service.cpp
  lowy_host.cpp
  "${LOWY}/BiomeSampler.cpp"
  "${LOWY}/OctaveFieldCache.cpp"
)
add_library(allinone SHARED ${HOT_CXX} "${CMAKE_BINARY_DIR}/napi_bind.cpp")
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
target_link_libraries(allinone PRIVATE cubiomes_objs "${CMAKE_BINARY_DIR}/napi_proxy.o" -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic)
target_link_options(allinone PRIVATE
  -flto
  -static-libgcc
  -static-libstdc++
)
