cmake_minimum_required(VERSION 3.15)
project(cwdecoder LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CW_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../")
add_library(cwdecoder SHARED capture_session.cpp napi_init.cpp
  "${CW_ROOT}/native/decoder_core.cpp"
  "${CW_ROOT}/third_party/multimon-ng/demod_morse.c")
target_include_directories(cwdecoder PRIVATE "${CW_ROOT}/native" "${CW_ROOT}/third_party/multimon-ng")
target_compile_definitions(cwdecoder PRIVATE NO_X11 MAX_VERBOSE_LEVEL=3 CW_TARGET_TONE_HZ=600)
target_link_libraries(cwdecoder PUBLIC libace_napi.z.so libohaudio.so m)
