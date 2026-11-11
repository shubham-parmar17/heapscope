// stats.hpp — one plain struct every allocator reports through stats(). Counters are updated
// inline on each allocate/deallocate (a few adds, no heap), so the hot path stays O(1) and the
// visualizer can read a consistent snapshot after every operation.
//
// Interview Q&A
// Q: Why a struct instead of virtual getters?  A: No vtable, no indirection; the allocator copies
//    ~80 bytes out on request, which is trivially cheap and keeps the allocators non-polymorphic.
// Q: What is "fragmentation" here?  A: Arena: internal fragmentation = alignment padding bytes.
//    Pool: free_list_length (how many holes) and largest_free_block (what the biggest hole could serve).
// Q: Why does reset() keep total_* and peak_bytes?  A: They describe the allocator's whole lifetime;
//    the benchmark table reads them after many reset cycles.
#pragma once

#include <cstddef>

namespace alloclab {

struct AllocStats {
    std::size_t capacity_bytes = 0;
    std::size_t used_bytes = 0;
    std::size_t peak_bytes = 0;
    std::size_t live_allocations = 0;
    std::size_t total_allocations = 0;
    std::size_t total_deallocations = 0;
    std::size_t failed_allocations = 0;
    std::size_t padding_bytes = 0;       // arena: bytes lost to alignment (internal fragmentation)
    std::size_t free_list_length = 0;    // pool: number of free blocks on the list
    std::size_t largest_free_block = 0;  // arena: remaining; pool: block_size if any block is free

    void on_alloc(std::size_t bytes) noexcept {
        used_bytes += bytes;
        ++live_allocations;
        ++total_allocations;
        if (used_bytes > peak_bytes) peak_bytes = used_bytes;
    }
    void on_free(std::size_t bytes) noexcept {
        used_bytes -= bytes;
        --live_allocations;
        ++total_deallocations;
    }
    void on_reset() noexcept {
        used_bytes = 0;
        live_allocations = 0;
        padding_bytes = 0;
    }
};

}  // namespace alloclab
