// test_freelist.cpp — first-fit + coalescing behaviour: split on allocate, merge with both neighbours
// on free, first-fit reuse of an earlier hole, honest failure on fragmentation, and a random churn
// run under ASan that writes every payload byte to prove blocks never overlap their headers.
//
// Interview Q&A
// Q: How do you prove coalescing works?  A: Allocate A,B,C; free A and C (2 holes) then B → list length
//    collapses to 1 and largest_free_block equals the whole payload again.
// Q: Why is largest_free_block < capacity even when empty?  A: One header (16 B) always precedes the payload.
// Q: What does the fragmentation test show?  A: Freeing every other block leaves plenty of free bytes
//    in total, yet a request for a single large block fails — external fragmentation made visible.
#include <gtest/gtest.h>

#include <cstring>
#include <limits>
#include <random>
#include <stdexcept>
#include <vector>

#include "alloclab/freelist.hpp"

using alloclab::FreeListAllocator;

TEST(FreeList, SplitsThenCoalescesBothSides) {
    FreeListAllocator fl(1024);
    EXPECT_EQ(fl.stats().largest_free_block, 1024u - 16);
    void* a = fl.allocate(32);
    void* b = fl.allocate(32);
    void* c = fl.allocate(32);
    EXPECT_EQ(fl.stats().free_list_length, 1u);
    fl.deallocate(a);
    fl.deallocate(c);
    EXPECT_EQ(fl.stats().free_list_length, 2u) << "hole a, plus c already merged with the tail";
    fl.deallocate(b);
    EXPECT_EQ(fl.stats().free_list_length, 1u) << "b merged with a and c (and c with the tail)";
    EXPECT_EQ(fl.stats().largest_free_block, 1024u - 16);
    EXPECT_EQ(fl.stats().used_bytes, 0u);
}

TEST(FreeList, FirstFitReusesEarliestHole) {
    FreeListAllocator fl(1024);
    void* a = fl.allocate(64);
    fl.allocate(64);
    void* c = fl.allocate(64);
    fl.allocate(64);
    fl.deallocate(a);
    fl.deallocate(c);
    EXPECT_EQ(fl.allocate(16), a) << "first fit takes the lowest-address hole that fits";
}

TEST(FreeList, ExternalFragmentationFailsHonestly) {
    FreeListAllocator fl(16 * 48);  // 16 blocks of 32 B payload + 16 B header
    void* p[16];
    for (auto& x : p) { x = fl.allocate(32); ASSERT_NE(x, nullptr); }
    for (int i = 0; i < 16; i += 2) fl.deallocate(p[i]);
    const auto s = fl.stats();
    EXPECT_EQ(s.free_list_length, 8u);
    EXPECT_EQ(s.largest_free_block, 32u);
    EXPECT_EQ(fl.allocate(64), nullptr) << "384 B free in total, but no 64 B run";
    EXPECT_EQ(fl.stats().failed_allocations, 1u);
}

TEST(FreeList, RandomChurnNeverCorruptsHeaders) {
    FreeListAllocator fl(64 * 1024);
    std::mt19937 rng(7);
    std::vector<std::pair<std::byte*, std::size_t>> live;
    for (int i = 0; i < 20000; ++i) {
        if (live.empty() || (rng() % 3 != 0)) {
            const std::size_t n = 1 + rng() % 200;
            auto* p = static_cast<std::byte*>(fl.allocate(n));
            if (!p) continue;
            std::memset(p, static_cast<int>(n & 0xff), n);
            live.emplace_back(p, n);
        } else {
            const std::size_t k = rng() % live.size();
            auto [p, n] = live[k];
            for (std::size_t j = 0; j < n; ++j) ASSERT_EQ(p[j], static_cast<std::byte>(n & 0xff));
            fl.deallocate(p);
            live[k] = live.back();
            live.pop_back();
        }
    }
    for (auto& [p, n] : live) fl.deallocate(p);
    EXPECT_EQ(fl.stats().free_list_length, 1u) << "everything coalesced back into one block";
    EXPECT_EQ(fl.stats().used_bytes, 0u);
}

TEST(FreeList, HandlesZeroSizeAndRejectsOverflow) {
    FreeListAllocator fl(128);
    void* zero = fl.allocate(0);
    ASSERT_NE(zero, nullptr);
    fl.deallocate(zero);

    EXPECT_EQ(fl.allocate(std::numeric_limits<std::size_t>::max()), nullptr);
    EXPECT_EQ(fl.stats().failed_allocations, 1u);
    EXPECT_EQ(fl.stats().used_bytes, 0u);
}

TEST(FreeList, RejectsCapacityTooSmallOrTooLarge) {
    EXPECT_THROW(FreeListAllocator(0), std::invalid_argument);
    EXPECT_THROW(FreeListAllocator(15), std::invalid_argument);
    EXPECT_THROW((void)FreeListAllocator(std::numeric_limits<std::size_t>::max()), std::length_error);
}

TEST(FreeList, ReportsPhysicalBlocksAndFreeListOrder) {
    FreeListAllocator fl(128);
    void* a = fl.allocate(16);
    void* b = fl.allocate(16);
    auto blocks = fl.layout();
    ASSERT_EQ(blocks.size(), 3u);
    EXPECT_FALSE(blocks[0].free);
    EXPECT_FALSE(blocks[1].free);
    EXPECT_TRUE(blocks[2].free);

    fl.deallocate(a);
    fl.deallocate(b);
    blocks = fl.layout();
    ASSERT_EQ(blocks.size(), 1u);
    EXPECT_TRUE(blocks[0].free);
    EXPECT_EQ(fl.free_list_offsets(), (std::vector<std::size_t>{0}));
}
