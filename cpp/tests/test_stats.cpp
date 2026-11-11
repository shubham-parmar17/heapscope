// test_stats.cpp — checks that AllocStats tracks used/peak/live/total/failed/padding for the arena
// and used/peak/free_list_length/largest_free_block for the pool, and that reset() keeps lifetime
// totals while clearing live state. Also covers free_list_indices() and largest_free_run().
//
// Interview Q&A
// Q: How do you know peak is right?  A: Allocate 3, free 2, allocate 1: used < peak and peak == 3 blocks.
// Q: Why test free_list_indices order?  A: The visualizer draws the chain in exactly that order (head first).
// Q: What does largest_free_run tell you that free_count doesn't?  A: Whether the free blocks are
//    scattered (run 1) or contiguous (run == free_count) — i.e. external fragmentation.
#include <gtest/gtest.h>

#include "alloclab/arena.hpp"
#include "alloclab/pool.hpp"

using alloclab::ArenaAllocator;
using alloclab::PoolAllocator;

TEST(Stats, ArenaTracksPaddingPeakAndFailures) {
    ArenaAllocator arena(64);
    arena.allocate(1, 1);     // used 1
    arena.allocate(8, 16);    // pad 15 -> used 24
    auto s = arena.stats();
    EXPECT_EQ(s.capacity_bytes, 64u);
    EXPECT_EQ(s.used_bytes, 24u);
    EXPECT_EQ(s.peak_bytes, 24u);
    EXPECT_EQ(s.padding_bytes, 15u);
    EXPECT_EQ(s.live_allocations, 2u);
    EXPECT_EQ(s.largest_free_block, 40u);

    EXPECT_EQ(arena.allocate(100, 1), nullptr);
    EXPECT_EQ(arena.stats().failed_allocations, 1u);

    arena.reset();
    s = arena.stats();
    EXPECT_EQ(s.used_bytes, 0u);
    EXPECT_EQ(s.live_allocations, 0u);
    EXPECT_EQ(s.padding_bytes, 0u);
    EXPECT_EQ(s.peak_bytes, 24u) << "peak survives reset";
    EXPECT_EQ(s.total_allocations, 2u) << "lifetime total survives reset";
}

TEST(Stats, PoolTracksUsedPeakAndFreeList) {
    PoolAllocator pool(32, 4);
    void* a = pool.allocate();
    void* b = pool.allocate();
    void* c = pool.allocate();
    auto s = pool.stats();
    EXPECT_EQ(s.used_bytes, 3 * pool.block_size());
    EXPECT_EQ(s.peak_bytes, 3 * pool.block_size());
    EXPECT_EQ(s.free_list_length, 1u);
    EXPECT_EQ(s.largest_free_block, pool.block_size());

    pool.deallocate(a);
    pool.deallocate(b);
    s = pool.stats();
    EXPECT_EQ(s.used_bytes, pool.block_size());
    EXPECT_EQ(s.peak_bytes, 3 * pool.block_size());
    EXPECT_EQ(s.live_allocations, 1u);
    EXPECT_EQ(s.total_deallocations, 2u);
    EXPECT_EQ(s.free_list_length, 3u);

    pool.allocate(); pool.allocate(); pool.allocate();
    EXPECT_EQ(pool.allocate(), nullptr);
    EXPECT_EQ(pool.stats().failed_allocations, 1u);
    EXPECT_EQ(pool.stats().largest_free_block, 0u);
    (void)c;
}

TEST(Stats, PoolFreeListOrderAndRuns) {
    PoolAllocator pool(16, 6);
    EXPECT_EQ(pool.free_list_indices(), (std::vector<std::size_t>{0, 1, 2, 3, 4, 5}));
    EXPECT_EQ(pool.largest_free_run(), 6u);

    void* p[6];
    for (auto& x : p) x = pool.allocate();
    pool.deallocate(p[1]);
    pool.deallocate(p[3]);
    pool.deallocate(p[5]);
    EXPECT_EQ(pool.free_list_indices(), (std::vector<std::size_t>{5, 3, 1})) << "LIFO: last freed is head";
    EXPECT_EQ(pool.largest_free_run(), 1u) << "checkerboard pattern";

    pool.deallocate(p[4]);
    EXPECT_EQ(pool.largest_free_run(), 3u) << "blocks 3,4,5 now adjacent";
    EXPECT_EQ(pool.index_of(p[4]), 4u);
}
