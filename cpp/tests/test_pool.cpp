// test_pool.cpp — behavioural tests for PoolAllocator: capacity, LIFO reuse, alignment,
// ownership checks, move semantics and a randomized churn test. Runs under ASan + UBSan, so
// any out-of-bounds write into a neighbouring block is caught even if the assertions pass.
//
// Interview Q&A
// Q: Why write every byte of each block in the churn test?
// A: It proves blocks never overlap; ASan would flag a write into a block it considers "live elsewhere".
// Q: Why assert LIFO order?  A: It pins down the free-list semantics the visualizer animates (push/pop head).
// Q: Why a fixed seed in the random test?  A: Reproducibility — a failure can be replayed exactly.
#include <gtest/gtest.h>

#include <cstdint>
#include <cstring>
#include <limits>
#include <random>
#include <set>
#include <stdexcept>
#include <vector>

#include "alloclab/pool.hpp"

using alloclab::PoolAllocator;

TEST(Pool, HandsOutExactlyBlockCountDistinctBlocks) {
    PoolAllocator pool(32, 8);
    std::set<void*> seen;
    for (int i = 0; i < 8; ++i) {
        void* p = pool.allocate();
        ASSERT_NE(p, nullptr);
        EXPECT_TRUE(seen.insert(p).second) << "duplicate block returned";
        EXPECT_TRUE(pool.owns(p));
    }
    EXPECT_EQ(pool.allocate(), nullptr) << "pool should be exhausted";
    EXPECT_EQ(pool.free_count(), 0u);
    EXPECT_EQ(pool.used_count(), 8u);
}

TEST(Pool, InitialFreeListIsInAddressOrder) {
    PoolAllocator pool(16, 4);
    auto* a = static_cast<std::byte*>(pool.allocate());
    auto* b = static_cast<std::byte*>(pool.allocate());
    EXPECT_EQ(a, pool.base());
    EXPECT_EQ(b - a, static_cast<std::ptrdiff_t>(pool.block_size()));
}

TEST(Pool, DeallocateIsLifo) {
    PoolAllocator pool(32, 4);
    void* a = pool.allocate();
    void* b = pool.allocate();
    pool.deallocate(a);
    pool.deallocate(b);
    EXPECT_EQ(pool.allocate(), b) << "most recently freed block should come back first";
    EXPECT_EQ(pool.allocate(), a);
}

TEST(Pool, BlockSizeIsRoundedUpToFitFreeNodeAndAlignment) {
    PoolAllocator tiny(1, 4);
    EXPECT_GE(tiny.block_size(), sizeof(void*));
    EXPECT_EQ(tiny.block_size() % tiny.alignment(), 0u);

    PoolAllocator odd(33, 4, 16);
    EXPECT_EQ(odd.block_size(), 48u);
}

TEST(Pool, EveryBlockRespectsAlignment) {
    PoolAllocator pool(24, 16, 64);
    for (int i = 0; i < 16; ++i) {
        void* p = pool.allocate();
        ASSERT_NE(p, nullptr);
        EXPECT_EQ(reinterpret_cast<std::uintptr_t>(p) % 64, 0u);
    }
}

TEST(Pool, OwnsRejectsForeignPointers) {
    PoolAllocator pool(32, 2);
    int on_stack = 0;
    EXPECT_FALSE(pool.owns(&on_stack));
    EXPECT_FALSE(pool.owns(pool.base() + pool.block_size() * pool.block_count()));
    EXPECT_TRUE(pool.owns(pool.base()));
}

TEST(Pool, ResetReturnsEverything) {
    PoolAllocator pool(32, 4);
    pool.allocate();
    pool.allocate();
    pool.reset();
    EXPECT_EQ(pool.free_count(), 4u);
    EXPECT_EQ(pool.allocate(), pool.base());
}

TEST(Pool, MoveTransfersOwnership) {
    PoolAllocator a(32, 4);
    void* p = a.allocate();
    PoolAllocator b(std::move(a));
    EXPECT_TRUE(b.owns(p));
    EXPECT_EQ(b.used_count(), 1u);
    EXPECT_EQ(a.base(), nullptr);  // NOLINT(bugprone-use-after-move) — moved-from state is specified
    b.deallocate(p);
    EXPECT_EQ(b.free_count(), 4u);
}

TEST(Pool, DeallocateNullIsNoop) {
    PoolAllocator pool(32, 2);
    pool.deallocate(nullptr);
    EXPECT_EQ(pool.free_count(), 2u);
}

TEST(Pool, RandomChurnNeverOverlapsOrLeaks) {
    constexpr std::size_t kBlock = 40, kCount = 128;
    PoolAllocator pool(kBlock, kCount);
    std::mt19937 rng(42);
    std::vector<std::pair<std::byte*, std::uint8_t>> live;

    for (int step = 0; step < 20000; ++step) {
        const bool do_alloc = live.empty() || (rng() % 2 == 0 && live.size() < kCount);
        if (do_alloc) {
            auto* p = static_cast<std::byte*>(pool.allocate());
            ASSERT_NE(p, nullptr);
            const auto tag = static_cast<std::uint8_t>(rng());
            std::memset(p, tag, pool.block_size());
            live.emplace_back(p, tag);
        } else {
            const std::size_t i = rng() % live.size();
            auto [p, tag] = live[i];
            for (std::size_t k = 0; k < pool.block_size(); ++k)
                ASSERT_EQ(static_cast<std::uint8_t>(p[k]), tag) << "block was clobbered";
            pool.deallocate(p);
            live[i] = live.back();
            live.pop_back();
        }
        ASSERT_EQ(pool.used_count(), live.size());
    }
    for (auto [p, tag] : live) pool.deallocate(p);
    EXPECT_EQ(pool.free_count(), kCount);
}

TEST(Pool, RejectsInvalidAlignmentAndOverflow) {
    EXPECT_THROW(PoolAllocator(32, 1, 0), std::invalid_argument);
    EXPECT_THROW(PoolAllocator(32, 1, 3), std::invalid_argument);
    EXPECT_THROW(PoolAllocator(std::numeric_limits<std::size_t>::max(), 1), std::length_error);
    EXPECT_THROW(PoolAllocator(16, std::numeric_limits<std::size_t>::max()), std::length_error);
}

TEST(Pool, SmallAlignmentStillAlignsFreeListNodes) {
    PoolAllocator pool(16, 2, 1);
    EXPECT_GE(pool.alignment(), alignof(std::max_align_t));
    auto* block = static_cast<std::byte*>(pool.allocate());
    ASSERT_NE(block, nullptr);
    EXPECT_EQ(reinterpret_cast<std::uintptr_t>(block) % alignof(std::max_align_t), 0u);
}
