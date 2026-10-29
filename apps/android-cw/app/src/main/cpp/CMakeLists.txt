cmake_minimum_required(VERSION 3.22.1)

project(cwandroid LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Reuse the Harmony CW bridge and the locked multimon-ng projection in place.
# These are relative source paths, not copied files, and must not be edited here.
set(CW_HARMONY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../harmony-cw")
set(CW_BRIDGE_SOURCE "${CW_HARMONY_ROOT}/native/decoder_core.cpp")
set(CW_BRIDGE_HEADER "${CW_HARMONY_ROOT}/native/decoder_core.h")
set(CW_VENDOR_DIR "${CW_HARMONY_ROOT}/third_party/multimon-ng")
set(CW_TARGET_TONE_HZ 600)

foreach(required
    "${CW_BRIDGE_SOURCE}"
    "${CW_BRIDGE_HEADER}"
    "${CW_VENDOR_DIR}/demod_morse.c"
    "${CW_VENDOR_DIR}/multimon.h")
  if(NOT EXISTS "${required}")
    message(FATAL_ERROR "Required reused source is missing: ${required}")
  endif()
endforeach()

message(STATUS "Android CW bridge source: ${CW_BRIDGE_SOURCE}")
message(STATUS "Android CW vendor source: ${CW_VENDOR_DIR}")
message(STATUS "CW_TARGET_TONE_HZ=${CW_TARGET_TONE_HZ}")

add_library(cwdecoder_jni SHARED
  jni_bridge.cpp
  "${CW_BRIDGE_SOURCE}"
  "${CW_VENDOR_DIR}/demod_morse.c"
)

target_include_directories(cwdecoder_jni PRIVATE
  "${CW_HARMONY_ROOT}/native"
  "${CW_VENDOR_DIR}"
)

target_compile_definitions(cwdecoder_jni PRIVATE
  NO_X11
  MAX_VERBOSE_LEVEL=3
  CW_TARGET_TONE_HZ=${CW_TARGET_TONE_HZ}
)

target_link_libraries(cwdecoder_jni PRIVATE m log)
# Apply to both ARM ABIs; NDK flexible-page mode only changes 64-bit defaults.
target_link_options(cwdecoder_jni PRIVATE "-Wl,-z,max-page-size=16384")

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(cwdecoder_jni PRIVATE -Wall -Wextra)
endif()
