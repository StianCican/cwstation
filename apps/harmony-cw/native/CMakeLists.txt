cmake_minimum_required(VERSION 3.16)

project(cw_harmony_decode_bridge LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CW_VENDOR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/multimon-ng")

find_package(Threads REQUIRED)

# 必须指向已应用 patches/multimon-ng/multimon-threshold-hysteresis.patch 的
# multimon-ng CLI；host 对照测试用它作为字节级参考。
set(CW_MULTIMON_CLI "" CACHE FILEPATH "patched multimon-ng CLI used for byte comparison")
if(NOT CW_MULTIMON_CLI AND DEFINED ENV{MULTIMON_CLI})
  set(CW_MULTIMON_CLI "$ENV{MULTIMON_CLI}")
endif()

add_library(cw_decoder STATIC
  decoder_core.cpp
  "${CW_VENDOR_DIR}/demod_morse.c"
)
target_include_directories(cw_decoder
  PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}"
  PRIVATE "${CW_VENDOR_DIR}"
)
target_compile_definitions(cw_decoder PRIVATE MAX_VERBOSE_LEVEL=3 NO_X11)
target_link_libraries(cw_decoder PUBLIC Threads::Threads)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(cw_decoder PRIVATE -Wall -Wextra)
endif()

add_executable(cw_decode_harness tests/harness_main.cpp)
target_link_libraries(cw_decode_harness PRIVATE cw_decoder)

add_executable(cw_bridge_selftest tests/bridge_selftest.cpp)
target_link_libraries(cw_bridge_selftest PRIVATE cw_decoder)

enable_testing()
add_test(
  NAME bridge_host_contract
  COMMAND bash "${CMAKE_CURRENT_SOURCE_DIR}/tests/run_host_tests.sh"
    "$<TARGET_FILE:cw_decode_harness>"
    "$<TARGET_FILE:cw_bridge_selftest>"
    "${CMAKE_CURRENT_BINARY_DIR}/testdata"
    "${CW_MULTIMON_CLI}"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
