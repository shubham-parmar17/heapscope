// pmr_adapter.hpp — standard polymorphic memory resources for the arena and first-fit allocators.
// Resources borrow their allocator; the allocator must outlive every resource and container using it.
#pragma once

#include <cstddef>
#include <memory_resource>
#include <new>

#include "alloclab/arena.hpp"
#include "alloclab/freelist.hpp"

namespace alloclab {

class ArenaResource final : public std::pmr::memory_resource {
public:
    explicit ArenaResource(ArenaAllocator& arena) noexcept : arena_(arena) {}

private:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override {
        if (void* p = arena_.allocate(bytes, alignment)) return p;
        throw std::bad_alloc();
    }

    void do_deallocate(void*, std::size_t, std::size_t) override {
        // Arena allocations are reclaimed together by ArenaAllocator::reset().
    }

    bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override {
        const auto* resource = dynamic_cast<const ArenaResource*>(&other);
        return resource && &resource->arena_ == &arena_;
    }

    ArenaAllocator& arena_;
};

class FreeListResource final : public std::pmr::memory_resource {
public:
    explicit FreeListResource(FreeListAllocator& allocator) noexcept : allocator_(allocator) {}

private:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override {
        if (alignment <= FreeListAllocator::kAlign) {
            if (void* p = allocator_.allocate(bytes)) return p;
            throw std::bad_alloc();
        }
        return ::operator new(bytes, std::align_val_t{alignment});
    }

    void do_deallocate(void* p, std::size_t, std::size_t alignment) override {
        if (!p) return;
        if (allocator_.owns(p)) allocator_.deallocate(p);
        else ::operator delete(p, std::align_val_t{alignment});
    }

    bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override {
        const auto* resource = dynamic_cast<const FreeListResource*>(&other);
        return resource && &resource->allocator_ == &allocator_;
    }

    FreeListAllocator& allocator_;
};

}  // namespace alloclab
