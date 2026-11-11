// pool.hpp — fixed-size block allocator with an intrusive free list.
// Every block is the same size, so allocate/deallocate are O(1): pop/push the head of a
// singly linked list that lives INSIDE the free blocks themselves (zero header overhead).
//
// Interview Q&A
// Q: Why does block_size get rounded up to at least sizeof(void*)?
// A: A free block must hold the "next" pointer of the free list; smaller blocks could not store it.
// Q: Why is there no per-block header?
// A: Blocks are fixed size, so the allocator already knows how big each one is. The only
//    bookkeeping (the next pointer) is needed only while the block is free, so it lives in the block.
// Q: What happens on double free?
// A: Undefined behaviour here (the block would be in the list twice). Detecting it needs a header
//    bit or a bitmap; that's an explicit trade-off for zero overhead, and ASan tests exercise it.
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

class PoolAllocator {
public:
    PoolAllocator(std::size_t block_size, std::size_t block_count,
                  std::size_t alignment = alignof(std::max_align_t))
        : block_size_(rounded_block_size(block_size, alignment)),
          block_count_(block_count),
          alignment_(validated_alignment(alignment)) {
        if (block_count_ > std::numeric_limits<std::size_t>::max() / block_size_) {
            throw std::length_error("pool capacity is too large");
        }
        const std::size_t bytes = block_size_ * block_count_;
        if (bytes != 0) memory_ = static_cast<std::byte*>(::operator new(bytes, std::align_val_t{alignment_}));
        stats_.capacity_bytes = bytes;
        build_free_list();
    }

    ~PoolAllocator() {
        if (memory_) ::operator delete(memory_, std::align_val_t{alignment_});
    }

    PoolAllocator(const PoolAllocator&) = delete;
    PoolAllocator& operator=(const PoolAllocator&) = delete;

    PoolAllocator(PoolAllocator&& other) noexcept
        : block_size_(other.block_size_), block_count_(other.block_count_), alignment_(other.alignment_),
          memory_(std::exchange(other.memory_, nullptr)), head_(std::exchange(other.head_, nullptr)),
          free_count_(std::exchange(other.free_count_, 0)), stats_(std::exchange(other.stats_, AllocStats{})) {}

    PoolAllocator& operator=(PoolAllocator&& other) noexcept {
        if (this != &other) {
            if (memory_) ::operator delete(memory_, std::align_val_t{alignment_});
            block_size_ = other.block_size_;
            block_count_ = other.block_count_;
            alignment_ = other.alignment_;
            memory_ = std::exchange(other.memory_, nullptr);
            head_ = std::exchange(other.head_, nullptr);
            free_count_ = std::exchange(other.free_count_, 0);
            stats_ = std::exchange(other.stats_, AllocStats{});
        }
        return *this;
    }

    // Pop the head of the free list. Returns nullptr when the pool is exhausted.
    void* allocate() noexcept {
        if (head_ == nullptr) {
            ++stats_.failed_allocations;
            return nullptr;
        }
        FreeNode* node = head_;
        head_ = node->next;
        --free_count_;
        stats_.on_alloc(block_size_);
        return node;
    }

    // Push the block back as the new head of the free list.
    void deallocate(void* p) noexcept {
        if (p == nullptr) return;
        assert(owns(p) && "pointer does not belong to this pool");
        assert((static_cast<std::byte*>(p) - memory_) % block_size_ == 0 && "pointer is not a block start");
        FreeNode* node = static_cast<FreeNode*>(p);
        node->next = head_;
        head_ = node;
        ++free_count_;
        stats_.on_free(block_size_);
    }

    // Returns every block to the free list in address order.
    void reset() noexcept {
        build_free_list();
        stats_.on_reset();
    }

    AllocStats stats() const noexcept {
        AllocStats s = stats_;
        s.free_list_length = free_count_;
        s.largest_free_block = free_count_ ? block_size_ : 0;
        return s;
    }

    // Block index of a pointer handed out by allocate(); used by the visualizer and tests.
    std::size_t index_of(const void* p) const noexcept {
        assert(owns(p));
        return static_cast<std::size_t>((static_cast<const std::byte*>(p) - memory_) / block_size_);
    }

    // Free-list order, head first. O(free_count): walks the list, so call it per frame, not per op.
    std::vector<std::size_t> free_list_indices() const {
        std::vector<std::size_t> out;
        out.reserve(free_count_);
        for (const FreeNode* n = head_; n != nullptr; n = n->next) out.push_back(index_of(n));
        return out;
    }

    // Longest run of adjacent free blocks: how badly the pool is "checkerboarded".
    std::size_t largest_free_run() const {
        std::vector<bool> is_free(block_count_, false);
        for (std::size_t i : free_list_indices()) is_free[i] = true;
        std::size_t best = 0, run = 0;
        for (bool f : is_free) {
            run = f ? run + 1 : 0;
            if (run > best) best = run;
        }
        return best;
    }

    bool owns(const void* p) const noexcept {
        if (!p || !memory_) return false;
        const auto address = reinterpret_cast<std::uintptr_t>(p);
        const auto base = reinterpret_cast<std::uintptr_t>(memory_);
        return address >= base && address - base < block_size_ * block_count_;
    }

    std::size_t block_size() const noexcept { return block_size_; }
    std::size_t block_count() const noexcept { return block_count_; }
    std::size_t alignment() const noexcept { return alignment_; }
    std::size_t free_count() const noexcept { return free_count_; }
    std::size_t used_count() const noexcept { return block_count_ - free_count_; }
    const std::byte* base() const noexcept { return memory_; }

private:
    struct FreeNode { FreeNode* next; };

    static bool is_power_of_two(std::size_t x) noexcept { return x != 0 && (x & (x - 1)) == 0; }
    static std::size_t validated_alignment(std::size_t alignment) {
        if (!is_power_of_two(alignment)) throw std::invalid_argument("pool alignment must be a power of two");
        const std::size_t minimum = alignof(FreeNode) > alignof(std::max_align_t)
            ? alignof(FreeNode)
            : alignof(std::max_align_t);
        return alignment < minimum ? minimum : alignment;
    }
    static std::size_t rounded_block_size(std::size_t size, std::size_t alignment) {
        const std::size_t a = validated_alignment(alignment);
        const std::size_t minimum = size < sizeof(FreeNode) ? sizeof(FreeNode) : size;
        if (minimum > std::numeric_limits<std::size_t>::max() - (a - 1)) {
            throw std::length_error("pool block size is too large");
        }
        return (minimum + a - 1) & ~(a - 1);
    }

    // Thread the list through every block: block i points to block i+1, last points to null.
    void build_free_list() noexcept {
        head_ = nullptr;
        for (std::size_t i = block_count_; i-- > 0;) {
            auto* node = reinterpret_cast<FreeNode*>(memory_ + i * block_size_);
            node->next = head_;
            head_ = node;
        }
        free_count_ = block_count_;
    }

    std::size_t block_size_;
    std::size_t block_count_;
    std::size_t alignment_;
    std::byte* memory_ = nullptr;
    FreeNode* head_ = nullptr;
    std::size_t free_count_ = 0;
    AllocStats stats_;
};

}  // namespace alloclab
