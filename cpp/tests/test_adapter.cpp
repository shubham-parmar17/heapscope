// test_adapter.cpp — proves PoolAdapter satisfies the STL Allocator requirements in practice:
// std::vector, std::list and std::map all compile and behave; small nodes come from the pool,
// oversize vector buffers fall back to the heap and are returned to the right place.
//
// Interview Q&A
// Q: How do you prove std::list nodes really come from the pool?  A: pool.used_count() rises by one per
//    push_back and returns to zero after clear(); nodes fit in a block, so no fallback happens.
// Q: What goes wrong if deallocate() returned heap memory to the pool?  A: Pool would corrupt its free
//    list; owns() is the guard. ASan would also flag the mismatched free.
// Q: Why does vector<int> with a 64-byte block use the pool at first and fall back later?
// A: Capacity grows 1,2,4,8,16: 16 ints = 64 bytes fits; 32 ints = 128 bytes does not.
#include <gtest/gtest.h>

#include <cstddef>
#include <cstdint>
#include <list>
#include <map>
#include <memory_resource>
#include <vector>

#include "alloclab/pmr_adapter.hpp"
#include "alloclab/pool_adapter.hpp"

using alloclab::PoolAdapter;
using alloclab::PoolAllocator;
using alloclab::ArenaAllocator;
using alloclab::ArenaResource;
using alloclab::FreeListAllocator;
using alloclab::FreeListResource;

TEST(Adapter, VectorFitsInBlockThenFallsBack) {
    PoolAllocator pool(64, 8);
    PoolAdapter<int> alloc(pool);
    std::vector<int, PoolAdapter<int>> v(alloc);
    for (int i = 0; i < 16; ++i) v.push_back(i);
    EXPECT_EQ(pool.used_count(), 1u) << "one 64-byte block holds 16 ints";
    EXPECT_EQ(v.get_allocator().fallbacks(), 0u);

    v.push_back(16);  // needs 128 bytes -> heap fallback
    EXPECT_EQ(pool.used_count(), 0u) << "old block returned to the pool";
    EXPECT_EQ(v.size(), 17u);
    for (int i = 0; i < 17; ++i) EXPECT_EQ(v[i], i);
}

TEST(Adapter, ListNodesComeFromPool) {
    PoolAllocator pool(64, 16);
    std::list<int, PoolAdapter<int>> l{PoolAdapter<int>(pool)};
    for (int i = 0; i < 10; ++i) l.push_back(i);
    EXPECT_EQ(pool.used_count(), 10u);
    l.clear();
    EXPECT_EQ(pool.used_count(), 0u);
}

TEST(Adapter, MapWorksThroughRebind) {
    PoolAllocator pool(96, 32);
    using Alloc = PoolAdapter<std::pair<const int, int>>;
    std::map<int, int, std::less<int>, Alloc> m{Alloc(pool)};
    for (int i = 0; i < 20; ++i) m[i] = i * i;
    EXPECT_EQ(pool.used_count(), 20u);
    EXPECT_EQ(m[7], 49);
}

TEST(Adapter, EqualityMeansSamePool) {
    PoolAllocator p1(32, 2), p2(32, 2);
    EXPECT_TRUE(PoolAdapter<int>(p1) == PoolAdapter<double>(p1));
    EXPECT_TRUE(PoolAdapter<int>(p1) != PoolAdapter<int>(p2));
}

TEST(Adapter, ExhaustedPoolFallsBackInsteadOfThrowing) {
    PoolAllocator pool(32, 1);
    PoolAdapter<int> alloc(pool);
    int* a = alloc.allocate(1);
    int* b = alloc.allocate(1);
    EXPECT_TRUE(pool.owns(a));
    EXPECT_FALSE(pool.owns(b));
    EXPECT_EQ(alloc.fallbacks(), 1u);
    alloc.deallocate(a, 1);
    alloc.deallocate(b, 1);
    EXPECT_EQ(pool.free_count(), 1u);
}

TEST(PmrResource, ArenaSupportsStandardVector) {
    ArenaAllocator arena(1024);
    ArenaResource resource(arena);
    {
        std::pmr::vector<int> values(&resource);
        values.reserve(16);
        for (int i = 0; i < 16; ++i) values.push_back(i * i);
        EXPECT_EQ(values[7], 49);
        EXPECT_EQ(arena.used(), 16u * sizeof(int));
    }
    EXPECT_EQ(arena.used(), 16u * sizeof(int)) << "vector deallocation is deferred until arena reset";
}

TEST(PmrResource, FreeListReturnsStandardVectorStorage) {
    FreeListAllocator allocator(512);
    FreeListResource resource(allocator);
    {
        std::pmr::vector<int> values(&resource);
        values.reserve(16);
        for (int i = 0; i < 16; ++i) values.push_back(i);
        EXPECT_TRUE(allocator.owns(values.data()));
        EXPECT_EQ(allocator.stats().live_allocations, 1u);
    }
    EXPECT_EQ(allocator.stats().used_bytes, 0u);
    EXPECT_EQ(allocator.stats().free_list_length, 1u);
}

TEST(PmrResource, FreeListSupportsOverAlignedTypesWithHeapFallback) {
    struct alignas(64) OverAligned { std::uint64_t value = 42; };
    FreeListAllocator allocator(256);
    FreeListResource resource(allocator);
    {
        std::pmr::vector<OverAligned> values(&resource);
        values.emplace_back();
        EXPECT_EQ(reinterpret_cast<std::uintptr_t>(values.data()) % alignof(OverAligned), 0u);
        EXPECT_EQ(values[0].value, 42u);
        EXPECT_EQ(allocator.stats().used_bytes, 0u);
    }
    EXPECT_EQ(allocator.stats().used_bytes, 0u);
}

TEST(PmrResource, ResourcesCompareEqualWhenTheyWrapTheSameAllocator) {
    ArenaAllocator arena(256);
    ArenaResource a1(arena), a2(arena);
    EXPECT_TRUE(a1.is_equal(a2));

    FreeListAllocator allocator(256);
    FreeListResource f1(allocator), f2(allocator);
    EXPECT_TRUE(f1.is_equal(f2));
}
