# CMakeLists.txt — builds libpiper_phonemize_jni.so
#
# Pipeline:
#   1. FetchContent_Declare rhasspy/espeak-ng (the Piper fork with embedded
#      data + Android compile fixes) and build it as a static C library.
#   2. Compile our thin C++ JNI bridge (phonemize_jni.cpp) and link against
#      the espeak-ng static lib.
#   3. Output libpiper_phonemize_jni.so per ABI (arm64-v8a, armeabi-v7a).
#
# The resulting .so is loaded from Kotlin via System.loadLibrary("piper_phonemize_jni").
# espeak-ng-data is shipped as an Android asset and unpacked on first launch.

cmake_minimum_required(VERSION 3.18 FATAL_ERROR)
project(piper_phonemize_jni LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ----- Fetch espeak-ng (Piper fork) -----
include(FetchContent)

# espeak-ng's CMake produces a static `espeak-ng` target if BUILD_SHARED_LIBS
# is OFF. We disable all audio backends (we only need text→phonemes), all
# host tooling (we use the prebuilt data files shipped as Android assets),
# and all non-essential extras.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_ESPEAK_NG_EXE OFF CACHE BOOL "" FORCE)
set(BUILD_ESPEAK_NG_TESTS OFF CACHE BOOL "" FORCE)
set(USE_ASYNC OFF CACHE BOOL "" FORCE)
set(USE_MBROLA OFF CACHE BOOL "" FORCE)
set(USE_LIBSONIC OFF CACHE BOOL "" FORCE)
set(USE_LIBPCAUDIO OFF CACHE BOOL "" FORCE)
set(USE_KLATT OFF CACHE BOOL "" FORCE)
set(USE_SPEECHPLAYER OFF CACHE BOOL "" FORCE)
set(EXTRA_cmn OFF CACHE BOOL "" FORCE)
set(EXTRA_fr OFF CACHE BOOL "" FORCE)
# CRITICAL for cross-compile: do NOT build the data-compiler host tool
# (it would try to run on the target = ARM device, which obviously fails).
# We ship pre-compiled data files (phondata, phonindex, phontab, _dict)
# via Android assets — extracted at runtime to context.filesDir.
set(BUILD_DATA OFF CACHE BOOL "" FORCE)
# Avoid pkg-config probing that fails on bare Android toolchains.
set(CMAKE_DISABLE_FIND_PACKAGE_PkgConfig TRUE)

FetchContent_Declare(
  espeak_ng
  GIT_REPOSITORY https://github.com/rhasspy/espeak-ng.git
  # Piper-compatible fork. Pinned to the latest master commit
  # (2025-05-19, head of rhasspy/espeak-ng master at time of integration).
  # Contains Android compile fixes (UCD CMake + iOS portability) on top
  # of upstream espeak-ng 1.51.
  GIT_TAG 8593723f10cfd9befd50de447f14bf0a9d2a14a4
  GIT_SHALLOW FALSE
)
FetchContent_MakeAvailable(espeak_ng)

# espeak-ng may build a static library target called either `espeak-ng` or
# `ucd` depending on its CMake. The Piper fork emits target `espeak-ng`.
if (NOT TARGET espeak-ng)
  message(FATAL_ERROR "espeak-ng target was not produced by FetchContent. CMake config drift?")
endif()

# ----- Our JNI bridge -----
add_library(piper_phonemize_jni SHARED phonemize_jni.cpp)

# We need the public espeak-ng headers (speak_lib.h).
target_include_directories(piper_phonemize_jni PRIVATE
  ${espeak_ng_SOURCE_DIR}/src/include
  ${espeak_ng_SOURCE_DIR}/src/include/espeak-ng
  ${espeak_ng_BINARY_DIR}/src/include
)

find_library(log-lib log)

target_link_libraries(piper_phonemize_jni
  PRIVATE
    espeak-ng
    ${log-lib}
)

# Hide all C++ symbols by default (smaller .so).
set_target_properties(piper_phonemize_jni PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN ON
)
