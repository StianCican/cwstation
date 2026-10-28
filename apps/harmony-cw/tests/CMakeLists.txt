cmake_minimum_required(VERSION 3.16)

project(cw_capture_session_host_tests LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CW_APP_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
set(CW_NATIVE_DIR "${CW_APP_ROOT}/native")
set(CW_VENDOR_DIR "${CW_APP_ROOT}/third_party/multimon-ng")

find_package(Threads REQUIRED)

# The fake_audio.cpp translation unit is the only OH_Audio implementation in
# this executable; production capture_session.cpp is compiled unchanged.
add_executable(capture_session_host_test
  capture_session_host_test.cpp
  fake_audio.cpp
  "${CW_APP_ROOT}/entry/src/main/cpp/capture_session.cpp"
  "${CW_NATIVE_DIR}/decoder_core.cpp"
  "${CW_VENDOR_DIR}/demod_morse.c"
)

target_include_directories(capture_session_host_test PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${CW_APP_ROOT}/entry/src/main/cpp"
  "${CW_NATIVE_DIR}"
  "${CW_VENDOR_DIR}"
)

target_compile_definitions(capture_session_host_test PRIVATE
  MAX_VERBOSE_LEVEL=3
  NO_X11
)

target_link_libraries(capture_session_host_test PRIVATE Threads::Threads)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(capture_session_host_test PRIVATE -Wall -Wextra)
endif()

enable_testing()
add_test(
  NAME capture_session_host
  COMMAND capture_session_host_test "${CMAKE_CURRENT_BINARY_DIR}/testdata/cq-test.s16le"
)
