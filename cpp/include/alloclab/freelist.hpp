// freelist.hpp — general-purpose first-fit allocator with coalescing: variable-size blocks, each with a
// 16-byte header {size, next}. Free blocks live on an address-ordered singly linked list, so freeing a
// block can merge it with its lower and upper neighbours in O(list length). The "classic" allocator
// the arena and pool are specialisations of — and the baseline that shows why they are faster.
//
// Interview Q&A
// Q: Why keep the free list in address order?  A: Coalescing needs to know whether the previous and
//    next FREE blocks are physically adjacent; address order makes that a pointer comparison.
// Q: Where is the header's `next` valid?  A: Only while the block is free; once allocated those 8 bytes
//    belong to the user — same intrusive trick as the pool, but with a size field kept for free().
// Q: What is the fragmentation failure mode?  A: External: enough total free bytes but no single run
//    large enough. stats().largest_free_block vs capacity − used shows exactly that gap.
#pragma once

#include <cassert>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <new>
#include <stdexcept>
#include <utility>
#include <vector>

#include "alloclab/stats.hpp"

namespace alloclab {

class FreeListAllocator {
public:
    static constexpr std::size_t kAlign = 16;
    static constexpr std::size_t kHeaderSize = kAlign;
    struct BlockLayout { std::size_t offset; std::size_t size; bool free; };

    explicit FreeListAllocator(std::size_t capacity)
        : capacity_(round_up_capacity(capacity)),
          memory_(static_cast<std::byte*>(::operator new(capacity_, std::align_val_t{kAlign}))) {
        stats_.capacity_bytes = capacity_;
        build_initial_block();
    }

    ~FreeListAllocator() {
        if (memory_) ::operator delete(memory_, std::align_val_t{kAlign});
    }

    FreeListAllocator(const FreeListAllocator&) = delete;
    FreeListAllocator& operator=(const FreeListAllocator&) = delete;
    FreeListAllocator(FreeListAllocator&& o) noexcept
        : capacity_(o.capacity_), memory_(std::exchange(o.memory_, nullptr)), head_(std::exchange(o.head_, nullptr)),
          stats_(std::exchange(o.stats_, AllocStats{})) { o.capacity_ = 0; }
    FreeListAllocator& operator=(FreeListAllocator&& o) noexcept {
        if (this != &o) {
            if (memory_) ::operator delete(memory_, std::align_val_t{kAlign});
            capacity_ = o.capacity_; memory_ = std::exchange(o.memory_, nullptr);
            head_ = std::exchange(o.head_, nullptr); stats_ = std::exchange(o.stats_, AllocStats{});
            o.capacity_ = 0;
        }
        return *this;
    }

    // First fit: walk the address-ordered free list, take the first block that fits, split the rest.
    void* allocate(std::size_t size) noexcept {
        std::size_t rounded_size = 0;
        if (!round_up_checked(size == 0 ? 1 : size, rounded_size) ||
            rounded_size > std::numeric_limits<std::size_t>::max() - sizeof(Header)) {
            ++stats_.failed_allocations;
            return nullptr;
        }
        const std::size_t need = rounded_size + sizeof(Header);
        Header* prev = nullptr;
        for (Header* cur = head_; cur; prev = cur, cur = cur->next) {
            if (cur->size < need) continue;
            if (cur->size - need >= sizeof(Header) + kAlign) {  // split: remainder becomes a new free block
                auto* rest = reinterpret_cast<Header*>(reinterpret_cast<std::byte*>(cur) + need);
                rest->size = cur->size - need;
                rest->next = cur->next;
                cur->size = need;
                (prev ? prev->next : head_) = rest;
            } else {
                (prev ? prev->next : head_) = cur->next;
            }
            stats_.on_alloc(cur->size);
            return reinterpret_cast<std::byte*>(cur) + sizeof(Header);
        }
        ++stats_.failed_allocations;
        return nullptr;
    }

    // Insert back in address order, then merge with the next and previous block if adjacent.
    void deallocate(void* p) noexcept {
        if (!p) return;
        assert(owns(p));
        auto* blk = reinterpret_cast<Header*>(static_cast<std::byte*>(p) - sizeof(Header));
        stats_.on_free(blk->size);
        Header* prev = nullptr;
        Header* cur = head_;
        while (cur && cur < blk) { prev = cur; cur = cur->next; }
        blk->next = cur;
        (prev ? prev->next : head_) = blk;
        if (cur && end_of(blk) == reinterpret_cast<std::byte*>(cur)) { blk->size += cur->size; blk->next = cur->next; }
        if (prev && end_of(prev) == reinterpret_cast<std::byte*>(blk)) { prev->size += blk->size; prev->next = blk->next; }
    }

    void reset() noexcept { build_initial_block(); stats_.on_reset(); }

    bool owns(const void* p) const noexcept {
        if (!p || !memory_) return false;
        const auto address = reinterpret_cast<std::uintptr_t>(p);
        const auto base = reinterpret_cast<std::uintptr_t>(memory_);
        return address >= base && address - base < capacity_;
    }

    AllocStats stats() const noexcept {
        AllocStats s = stats_;
        for (Header* cur = head_; cur; cur = cur->next) {
            ++s.free_list_length;
            if (cur->size > s.largest_free_block) s.largest_free_block = cur->size;
        }
        if (s.largest_free_block) s.largest_free_block -= sizeof(Header);  // report usable payload
        return s;
    }

    std::size_t capacity() const noexcept { return capacity_; }
    const std::byte* base() const noexcept { return memory_; }

    // Physical blocks in address order, including headers. Intended for inspection, not timed paths.
    std::vector<BlockLayout> layout() const {
        std::vector<BlockLayout> out;
        std::size_t offset = 0;
        Header* free_block = head_;  // the free list is maintained in address order
        while (offset < capacity_) {
            auto* block = reinterpret_cast<const Header*>(memory_ + offset);
            assert(block->size >= sizeof(Header) && block->size <= capacity_ - offset);
            const bool is_free = free_block == block;
            if (is_free) free_block = free_block->next;
            out.push_back({offset, block->size, is_free});
            offset += block->size;
        }
        return out;
    }

    // Offsets in linked-list order, which differs from physical order after arbitrary frees.
    std::vector<std::size_t> free_list_offsets() const {
        std::vector<std::size_t> out;
        for (Header* cur = head_; cur; cur = cur->next) {
            out.push_back(static_cast<std::size_t>(reinterpret_cast<const std::byte*>(cur) - memory_));
        }
        return out;
    }

private:
    struct alignas(kAlign) Header {  // padded to 16 on wasm32 too, so payloads stay 16-byte aligned
        std::size_t size;  // whole block including this header
        Header* next;      // valid only while free
    };
    static_assert(sizeof(Header) == kAlign, "header must keep payloads 16-byte aligned");

    static bool round_up_checked(std::size_t n, std::size_t& out) noexcept {
        if (n > std::numeric_limits<std::size_t>::max() - (kAlign - 1)) return false;
        out = (n + kAlign - 1) & ~(kAlign - 1);
        return true;
    }
    static std::size_t round_up_capacity(std::size_t n) {
        if (n < sizeof(Header)) throw std::invalid_argument("free-list capacity must fit a block header");
        std::size_t out = 0;
        if (!round_up_checked(n, out)) throw std::length_error("free-list capacity is too large");
        return out;
    }
    static std::byte* end_of(Header* h) noexcept { return reinterpret_cast<std::byte*>(h) + h->size; }

    void build_initial_block() noexcept {
        head_ = reinterpret_cast<Header*>(memory_);
        head_->size = capacity_;
        head_->next = nullptr;
    }

    std::size_t capacity_;
    std::byte* memory_ = nullptr;
    Header* head_ = nullptr;
    AllocStats stats_;
};

}  // namespace alloclab
