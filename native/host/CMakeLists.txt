cmake_minimum_required(VERSION 3.20)
project(aio_host CXX)

# Self-contained host build. The engine keeps its own CMake project in ../../CMakeLists.txt;
# the two are linked only through the C ABI (M1) and the --engine subprocess.
#
#   cmake -S native/host -B native/host/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
#         -DCMAKE_CXX_COMPILER=C:/msys64/ucrt64/bin/g++.exe
#   cmake --build native/host/build

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT WIN32)
  message(FATAL_ERROR "The All-In-One Finder host is Windows-only.")
endif()

set(WEBVIEW2_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/webview2")
if(NOT EXISTS "${WEBVIEW2_ROOT}/include/WebView2.h")
  message(FATAL_ERROR
    "WebView2 SDK missing. Follow native/host/third_party/webview2/VERSION.txt to vendor it.")
endif()

add_executable(aio-host main.cpp engine_server.cpp host.rc)
target_include_directories(aio-host PRIVATE "${WEBVIEW2_ROOT}/include" "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(aio-host PRIVATE
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_compile_options(aio-host PRIVATE
  -Wall -Wextra -Wno-unknown-pragmas -Wno-cast-function-type -Wno-non-virtual-dtor)
# Windows-only libraries; COM/WinRT support comes from ole32/oleaut32.
target_link_libraries(aio-host PRIVATE ole32 oleaut32 shell32 user32 gdi32 comdlg32 advapi32)
target_include_directories(aio-host PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../..")
target_link_options(aio-host PRIVATE -static-libgcc -static-libstdc++)
set_target_properties(aio-host PROPERTIES OUTPUT_NAME "aio-host")

add_custom_command(TARGET aio-host POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${WEBVIEW2_ROOT}/x64/WebView2Loader.dll"
    "$<TARGET_FILE_DIR:aio-host>/WebView2Loader.dll"
  COMMENT "Copying WebView2Loader.dll next to aio-host.exe")
