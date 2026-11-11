// test_arena.cpp — smoke tests for the reference arena so the shared test binary covers both
// allocators from day one. Checks alignment padding, exhaustion, reset and create<T>.
// Replace/extend with your own arena's tests if its API differs.
//
// Interview Q&A
// Q: How do you test alignment padding?  A: Allocate 1 byte, then 16-aligned; used() must jump to 32, not 17.
// Q: Why check nullptr on exhaustion instead of throwing?  A: noexcept allocate keeps the hot path simple
//    and lets the caller (and the visualizer) decide how to report "out of memory".
// Q: Does reset() leak created objects?  A: Only if T has a non-trivial destructor — documented contract.
#include <gtest/gtest.h>

#include <cstdint>
#include <limits>

#include "alloclab/arena.hpp"

using alloclab::ArenaAllocator;

TEST(Arena, AlignsAndPads) {
    ArenaAllocator arena(256);
    void* a = arena.allocate(1, 1);
    void* b = arena.allocate(8, 16);
    EXPECT_EQ(a, arena.base());
    EXPECT_EQ(reinterpret_cast<std::uintptr_t>(b) % 16, 0u);
    EXPECT_EQ(arena.used(), 24u);
}

TEST(Arena, ReturnsNullWhenFull) {
    ArenaAllocator arena(64);
    EXPECT_NE(arena.allocate(64, 1), nullptr);
    EXPECT_EQ(arena.allocate(1, 1), nullptr);
}

TEST(Arena, ResetRewinds) {
    ArenaAllocator arena(64);
    arena.allocate(32, 1);
    arena.reset();
    EXPECT_EQ(arena.used(), 0u);
    EXPECT_EQ(arena.allocate(64, 1), arena.base());
}

TEST(Arena, CreateConstructsInPlace) {
    struct Vec3 { float x, y, z; };
    ArenaAllocator arena(64);
    Vec3* v = arena.create<Vec3>(Vec3{1.f, 2.f, 3.f});
    ASSERT_NE(v, nullptr);
    EXPECT_EQ(v->y, 2.f);
    EXPECT_EQ(arena.used(), sizeof(Vec3));
}

TEST(Arena, MoveOnly) {
    ArenaAllocator a(64);
    a.allocate(8);
    ArenaAllocator b(std::move(a));
    EXPECT_EQ(b.used(), 8u);
    EXPECT_EQ(a.base(), nullptr);  // NOLINT(bugprone-use-after-move)
}

TEST(Arena, RejectsInvalidAlignmentAndOversizedRequests) {
    ArenaAllocator arena(64);
    EXPECT_EQ(arena.allocate(1, 0), nullptr);
    EXPECT_EQ(arena.allocate(1, 3), nullptr);
    EXPECT_EQ(arena.allocate(std::numeric_limits<std::size_t>::max(), 1), nullptr);
    EXPECT_EQ(arena.stats().failed_allocations, 3u);
}
