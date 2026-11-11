// unique_ptr.hpp — a minimal std::unique_ptr: exclusive ownership, move-only, deleter as a
// template parameter (empty by default so the pointer stays exactly one word in size).
// Destroying or reset()-ing calls the deleter once; release() hands the raw pointer back.
//
// Interview Q&A
// Q: Why is the copy constructor deleted?  A: Two owners would both delete; "unique" is the contract.
// Q: Why does move leave the source null?  A: So the source's destructor does nothing — ownership moved.
// Q: Why is the deleter a type, not a function pointer?  A: An empty deleter type has no storage, so
//    sizeof(UniquePtr<T>) == sizeof(T*); std::function or a fn pointer would add a word.
#pragma once

#include <cstddef>
#include <utility>

namespace alloclab {

template <class T>
struct DefaultDelete {
    void operator()(T* p) const noexcept { delete p; }
};

template <class T, class Deleter = DefaultDelete<T>>
class UniquePtr {
public:
    UniquePtr() noexcept = default;
    explicit UniquePtr(T* p) noexcept : ptr_(p) {}
    UniquePtr(T* p, Deleter d) noexcept : ptr_(p), del_(std::move(d)) {}

    ~UniquePtr() { reset(); }

    UniquePtr(const UniquePtr&) = delete;
    UniquePtr& operator=(const UniquePtr&) = delete;

    UniquePtr(UniquePtr&& o) noexcept : ptr_(o.release()), del_(std::move(o.del_)) {}
    UniquePtr& operator=(UniquePtr&& o) noexcept {
        if (this != &o) {
            reset(o.release());
            del_ = std::move(o.del_);
        }
        return *this;
    }

    T* release() noexcept { return std::exchange(ptr_, nullptr); }

    void reset(T* p = nullptr) noexcept {
        T* old = std::exchange(ptr_, p);
        if (old) del_(old);
    }

    T* get() const noexcept { return ptr_; }
    T& operator*() const noexcept { return *ptr_; }
    T* operator->() const noexcept { return ptr_; }
    explicit operator bool() const noexcept { return ptr_ != nullptr; }
    Deleter& get_deleter() noexcept { return del_; }

private:
    T* ptr_ = nullptr;
    [[no_unique_address]] Deleter del_{};
};

template <class T, class... Args>
UniquePtr<T> make_unique(Args&&... args) {
    return UniquePtr<T>(new T(std::forward<Args>(args)...));
}

}  // namespace alloclab
