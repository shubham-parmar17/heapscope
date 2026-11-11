// pool_adapter.hpp — makes PoolAllocator usable as std::vector<T, PoolAdapter<T>>. The adapter is a
// cheap handle (one pointer) to a shared PoolAllocator. Requests that fit one block come from the
// pool; bigger requests (vector growth) fall back to ::operator new, so containers never break.
//
// Interview Q&A
// Q: Why can't a pool serve std::vector growth directly?
// A: vector asks for n*sizeof(T) contiguous bytes; a pool only has fixed blocks. Without the fallback,
//    push_back past one block's worth would have to throw bad_alloc.
// Q: Why is_always_equal = false and the operator== comparing pool pointers?
// A: Two adapters are interchangeable only if they share the same pool; memory from one pool must not
//    be returned to another. The container uses this to decide whether it may steal memory on move.
// Q: What's the rebind constructor for?  A: std::list / std::map allocate nodes, not T, so they
//    convert PoolAdapter<T> to PoolAdapter<Node>; it must share the same pool.
#pragma once

#include <cstddef>
#include <new>

#include "alloclab/pool.hpp"

namespace alloclab {

template <class T>
class PoolAdapter {
public:
    using value_type = T;
    using propagate_on_container_move_assignment = std::true_type;
    using propagate_on_container_swap = std::true_type;
    using is_always_equal = std::false_type;

    explicit PoolAdapter(PoolAllocator& pool) noexcept : pool_(&pool) {}

    template <class U>
    PoolAdapter(const PoolAdapter<U>& other) noexcept : pool_(other.pool()) {}

    T* allocate(std::size_t n) {
        const std::size_t bytes = n * sizeof(T);
        if (bytes <= pool_->block_size() && alignof(T) <= pool_->alignment()) {
            if (void* p = pool_->allocate()) return static_cast<T*>(p);
        }
        ++fallbacks_;
        return static_cast<T*>(::operator new(bytes, std::align_val_t{alignof(T)}));
    }

    void deallocate(T* p, std::size_t) noexcept {
        if (pool_->owns(p)) pool_->deallocate(p);
        else ::operator delete(p, std::align_val_t{alignof(T)});
    }

    PoolAllocator* pool() const noexcept { return pool_; }
    std::size_t fallbacks() const noexcept { return fallbacks_; }

private:
    PoolAllocator* pool_;
    std::size_t fallbacks_ = 0;
};

template <class T, class U>
bool operator==(const PoolAdapter<T>& a, const PoolAdapter<U>& b) noexcept { return a.pool() == b.pool(); }
template <class T, class U>
bool operator!=(const PoolAdapter<T>& a, const PoolAdapter<U>& b) noexcept { return !(a == b); }

}  // namespace alloclab
