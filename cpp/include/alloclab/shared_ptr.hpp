// shared_ptr.hpp — minimal std::shared_ptr + weak_ptr: shared ownership through a heap control block
// with two atomic counts. strong = owners; weak = observers + 1 while any owner exists. Object dies
// when strong hits 0; the control block dies when weak hits 0. WeakPtr::lock() revives safely via CAS.
//
// Interview Q&A
// Q: Why does weak start at 1?  A: The "+1 while strong > 0" trick: the owners collectively hold one
//    weak reference, so the control block can only be freed after both the last owner and the last
//    observer are gone — one decrement path, no double-check race.
// Q: How does lock() avoid reviving a dead object?  A: compare_exchange loop: read strong; if 0 give up;
//    else try to bump it. A concurrent last release can't slip in between the read and the increment.
// Q: How does weak_ptr break cycles?  A: A→B→A with two shared_ptrs never reaches 0. Make the back
//    edge weak: it observes without owning, so the forward chain can unwind. (Tested in test_smart_ptr.)
#pragma once

#include <atomic>
#include <cstddef>
#include <utility>

namespace alloclab {

template <class T> class WeakPtr;

template <class T>
class SharedPtr {
public:
    SharedPtr() noexcept = default;
    explicit SharedPtr(T* p) : ptr_(p), ctrl_(p ? new SeparateBlock(p) : nullptr) {}

    ~SharedPtr() { release(); }

    SharedPtr(const SharedPtr& o) noexcept : ptr_(o.ptr_), ctrl_(o.ctrl_) {
        if (ctrl_) ctrl_->strong.fetch_add(1, std::memory_order_relaxed);
    }

    SharedPtr& operator=(const SharedPtr& o) noexcept {
        SharedPtr tmp(o);  // copy-and-swap: handles self-assignment and exception safety in one line
        swap(tmp);
        return *this;
    }

    SharedPtr(SharedPtr&& o) noexcept : ptr_(std::exchange(o.ptr_, nullptr)), ctrl_(std::exchange(o.ctrl_, nullptr)) {}

    SharedPtr& operator=(SharedPtr&& o) noexcept {
        SharedPtr tmp(std::move(o));
        swap(tmp);
        return *this;
    }

    void swap(SharedPtr& o) noexcept {
        std::swap(ptr_, o.ptr_);
        std::swap(ctrl_, o.ctrl_);
    }

    void reset() noexcept {
        release();
        ptr_ = nullptr;
        ctrl_ = nullptr;
    }

    T* get() const noexcept { return ptr_; }
    T& operator*() const noexcept { return *ptr_; }
    T* operator->() const noexcept { return ptr_; }
    explicit operator bool() const noexcept { return ptr_ != nullptr; }
    long use_count() const noexcept { return ctrl_ ? ctrl_->strong.load(std::memory_order_relaxed) : 0; }
    long weak_count() const noexcept { return ctrl_ ? ctrl_->weak.load(std::memory_order_relaxed) - (use_count() ? 1 : 0) : 0; }

private:
    friend class WeakPtr<T>;

    // Polymorphic control block: one allocation (InplaceBlock, via make_shared) or two (SeparateBlock).
    struct ControlBlock {
        std::atomic<long> strong{1};
        std::atomic<long> weak{1};  // observers + 1 while strong > 0
        virtual ~ControlBlock() = default;
        virtual void destroy_object() noexcept = 0;  // called when strong hits 0
    };
    struct SeparateBlock final : ControlBlock {
        T* obj;
        explicit SeparateBlock(T* p) : obj(p) {}
        void destroy_object() noexcept override { delete obj; }
    };
    struct InplaceBlock final : ControlBlock {
        alignas(T) unsigned char storage[sizeof(T)];
        template <class... Args> explicit InplaceBlock(Args&&... args) { new (storage) T(std::forward<Args>(args)...); }
        T* object() noexcept { return reinterpret_cast<T*>(storage); }
        void destroy_object() noexcept override { object()->~T(); }
    };

    SharedPtr(T* p, ControlBlock* c) noexcept : ptr_(p), ctrl_(c) {}  // used by WeakPtr::lock / make_shared

    static void release_weak(ControlBlock* c) noexcept {
        if (c->weak.fetch_sub(1, std::memory_order_acq_rel) == 1) delete c;
    }

    void release() noexcept {
        if (ctrl_ && ctrl_->strong.fetch_sub(1, std::memory_order_acq_rel) == 1) {
            ctrl_->destroy_object();
            release_weak(ctrl_);
        }
    }

    template <class U, class... Args> friend SharedPtr<U> make_shared(Args&&... args);

public:
    static constexpr std::size_t separate_block_size = sizeof(SeparateBlock);
    static constexpr std::size_t inplace_block_size = sizeof(InplaceBlock);

private:
    T* ptr_ = nullptr;
    ControlBlock* ctrl_ = nullptr;
};

template <class T>
class WeakPtr {
public:
    WeakPtr() noexcept = default;
    WeakPtr(const SharedPtr<T>& s) noexcept : ptr_(s.ptr_), ctrl_(s.ctrl_) {
        if (ctrl_) ctrl_->weak.fetch_add(1, std::memory_order_relaxed);
    }
    WeakPtr(const WeakPtr& o) noexcept : ptr_(o.ptr_), ctrl_(o.ctrl_) {
        if (ctrl_) ctrl_->weak.fetch_add(1, std::memory_order_relaxed);
    }
    WeakPtr(WeakPtr&& o) noexcept : ptr_(std::exchange(o.ptr_, nullptr)), ctrl_(std::exchange(o.ctrl_, nullptr)) {}
    WeakPtr& operator=(WeakPtr o) noexcept { swap(o); return *this; }
    WeakPtr& operator=(const SharedPtr<T>& s) noexcept { WeakPtr tmp(s); swap(tmp); return *this; }
    ~WeakPtr() { if (ctrl_) SharedPtr<T>::release_weak(ctrl_); }

    void swap(WeakPtr& o) noexcept { std::swap(ptr_, o.ptr_); std::swap(ctrl_, o.ctrl_); }
    void reset() noexcept { WeakPtr tmp; swap(tmp); }

    long use_count() const noexcept { return ctrl_ ? ctrl_->strong.load(std::memory_order_relaxed) : 0; }
    bool expired() const noexcept { return use_count() == 0; }

    // Promote to an owner if the object is still alive; otherwise an empty SharedPtr.
    SharedPtr<T> lock() const noexcept {
        if (!ctrl_) return {};
        long cur = ctrl_->strong.load(std::memory_order_relaxed);
        while (cur != 0) {
            if (ctrl_->strong.compare_exchange_weak(cur, cur + 1, std::memory_order_acq_rel, std::memory_order_relaxed))
                return SharedPtr<T>(ptr_, ctrl_);
        }
        return {};
    }

private:
    T* ptr_ = nullptr;
    typename SharedPtr<T>::ControlBlock* ctrl_ = nullptr;
};

// One allocation: T lives inside the control block (like std::make_shared). The block's memory is
// only released when the last WeakPtr goes too — the classic make_shared trade-off.
template <class T, class... Args>
SharedPtr<T> make_shared(Args&&... args) {
    auto* block = new typename SharedPtr<T>::InplaceBlock(std::forward<Args>(args)...);
    return SharedPtr<T>(block->object(), block);
}

}  // namespace alloclab
