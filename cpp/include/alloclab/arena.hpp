// arena.hpp — reference bump allocator (drop in your own version; the API below is what later
// phases call). allocate() aligns the cursor, hands out [cursor, cursor+size), and bumps forward.
// reset() rewinds the cursor to 0; nothing is freed individually, which is the whole point.
//
// Interview Q&A
// Q: Why is reset() O(1)?  A: It just sets used_ = 0; no per-block bookkeeping exists to tear down.
// Q: What does create<T> NOT do?  A: It never runs ~T on reset — only trivially destructible types are safe.
// Q: Why move-only?  A: Copying would duplicate the owning pointer and double-free in the destructor.
#pragma once

#include <cstddef>
#include <cstdint>
#include <new>
#include <utility>

#include "alloclab/stats.hpp"

namespace alloclab {

class ArenaAllocator {
public:
    explicit ArenaAllocator(std::size_t capacity)
        : capacity_(capacity),
          memory_(static_cast<std::byte*>(::operator new(capacity, std::align_val_t{alignof(std::max_align_t)}))) {
        stats_.capacity_bytes = capacity;
    }

    ~ArenaAllocator() {
        if (memory_) ::operator delete(memory_, std::align_val_t{alignof(std::max_align_t)});
    }

    ArenaAllocator(const ArenaAllocator&) = delete;
    ArenaAllocator& operator=(const ArenaAllocator&) = delete;

    ArenaAllocator(ArenaAllocator&& o) noexcept
        : capacity_(o.capacity_), used_(o.used_), memory_(std::exchange(o.memory_, nullptr)),
          stats_(std::exchange(o.stats_, AllocStats{})) {
        o.capacity_ = o.used_ = 0;
    }

    ArenaAllocator& operator=(ArenaAllocator&& o) noexcept {
        if (this != &o) {
            if (memory_) ::operator delete(memory_, std::align_val_t{alignof(std::max_align_t)});
            capacity_ = o.capacity_;
            used_ = o.used_;
            memory_ = std::exchange(o.memory_, nullptr);
            stats_ = std::exchange(o.stats_, AllocStats{});
            o.capacity_ = o.used_ = 0;
        }
        return *this;
    }

    // Returns nullptr when size (plus alignment padding) does not fit.
    void* allocate(std::size_t size, std::size_t alignment = alignof(std::max_align_t)) noexcept {
        if (alignment == 0 || (alignment & (alignment - 1)) != 0 || used_ > capacity_) {
            ++stats_.failed_allocations;
            return nullptr;
        }
        const std::uintptr_t cur = reinterpret_cast<std::uintptr_t>(memory_ + used_);
        const std::size_t padding = (alignment - (cur % alignment)) % alignment;
        const std::size_t available = capacity_ - used_;
        if (padding > available || size > available - padding) {
            ++stats_.failed_allocations;
            return nullptr;
        }
        void* out = memory_ + used_ + padding;
        used_ += padding + size;
        stats_.padding_bytes += padding;
        stats_.on_alloc(padding + size);
        return out;
    }

    template <class T, class... Args>
    T* create(Args&&... args) {
        void* p = allocate(sizeof(T), alignof(T));
        return p ? new (p) T(std::forward<Args>(args)...) : nullptr;
    }

    void reset() noexcept {
        used_ = 0;
        stats_.on_reset();
    }

    AllocStats stats() const noexcept {
        AllocStats s = stats_;
        s.largest_free_block = capacity_ - used_;
        return s;
    }

    std::size_t capacity() const noexcept { return capacity_; }
    std::size_t used() const noexcept { return used_; }
    std::size_t remaining() const noexcept { return capacity_ - used_; }
    const std::byte* base() const noexcept { return memory_; }

private:
    std::size_t capacity_;
    std::size_t used_ = 0;
    std::byte* memory_ = nullptr;
    AllocStats stats_;
};

}  // namespace alloclab
