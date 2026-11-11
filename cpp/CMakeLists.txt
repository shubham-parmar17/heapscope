# CMakeLists.txt — header-only library target + GoogleTest runner. ALLOCLAB_SANITIZE (ON by
# default) adds AddressSanitizer + UndefinedBehaviorSanitizer to the tests so overflows,
# use-after-free and misaligned access fail loudly instead of silently.
#
# Interview Q&A
# Q: Why INTERFACE library?  A: Header-only: nothing to compile, we only propagate include dirs/flags.
# Q: Why sanitizers on tests only?  A: They cost 2-3x runtime; benchmarks must measure the real thing.
# Q: Why -fno-omit-frame-pointer?  A: ASan stack traces need frame pointers to be readable.
cmake_minimum_required(VERSION 3.16)
project(alloclab LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ALLOCLAB_SANITIZE "Build tests with ASan + UBSan" ON)

add_library(alloclab INTERFACE)
target_include_directories(alloclab INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(alloclab INTERFACE -Wall -Wextra -Wpedantic)

find_package(GTest REQUIRED)
enable_testing()

add_executable(alloclab_tests
    tests/test_pool.cpp
    tests/test_arena.cpp
    tests/test_stats.cpp
    tests/test_adapter.cpp
    tests/test_smart_ptr.cpp
    tests/test_freelist.cpp
)
target_link_libraries(alloclab_tests PRIVATE alloclab GTest::gtest GTest::gtest_main pthread)

if(ALLOCLAB_SANITIZE)
    set(SAN_FLAGS -fsanitize=address,undefined -fno-omit-frame-pointer -g)
    target_compile_options(alloclab_tests PRIVATE ${SAN_FLAGS})
    target_link_options(alloclab_tests PRIVATE ${SAN_FLAGS})
endif()

include(GoogleTest)
# ASan start-up can take several seconds in containers; the default discovery timeout is 5s.
gtest_discover_tests(alloclab_tests DISCOVERY_TIMEOUT 60)

# Benchmark: never sanitized, always optimised, so numbers reflect the allocators and not the tooling.
add_executable(alloclab_bench bench/bench_main.cpp)
target_link_libraries(alloclab_bench PRIVATE alloclab)
target_compile_options(alloclab_bench PRIVATE -O2 -DNDEBUG)
