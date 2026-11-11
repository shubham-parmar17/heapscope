// test_smart_ptr.cpp — UniquePtr: single delete, move semantics, custom deleter, size == one word.
// SharedPtr: use_count arithmetic, copy/move, self-assignment, and a multi-threaded copy/destroy
// storm that must end with exactly one destruction (atomic ref count under ASan + UBSan).
//
// Interview Q&A
// Q: How do you test "deleted exactly once"?  A: A Tracked type increments a static counter in its
//    destructor; every test asserts the counter equals the number of objects created.
// Q: Why 8 threads x 10k copies?  A: Enough contention that a non-atomic count would visibly miscount
//    (double delete or leak), which ASan then reports as heap-use-after-free or a leak.
// Q: Why is sizeof(UniquePtr<T>) == sizeof(T*) important?  A: Proves zero-overhead abstraction — the
//    smart pointer costs nothing over the raw pointer it replaces.
#include <gtest/gtest.h>

#include <atomic>
#include <thread>
#include <utility>
#include <vector>

#include "alloclab/shared_ptr.hpp"
#include "alloclab/unique_ptr.hpp"

using alloclab::SharedPtr;
using alloclab::UniquePtr;
using alloclab::WeakPtr;

namespace {
struct Tracked {
    static inline std::atomic<int> alive{0};
    int value;
    explicit Tracked(int v = 0) : value(v) { ++alive; }
    ~Tracked() { --alive; }
};
}  // namespace

TEST(UniquePtr, OwnsAndDeletesOnce) {
    Tracked::alive = 0;
    {
        auto p = alloclab::make_unique<Tracked>(7);
        EXPECT_EQ(p->value, 7);
        EXPECT_EQ(Tracked::alive, 1);
        UniquePtr<Tracked> q(std::move(p));
        EXPECT_FALSE(p);  // NOLINT(bugprone-use-after-move)
        EXPECT_TRUE(q);
        EXPECT_EQ(Tracked::alive, 1);
    }
    EXPECT_EQ(Tracked::alive, 0);
}

TEST(UniquePtr, ResetAndRelease) {
    Tracked::alive = 0;
    UniquePtr<Tracked> p(new Tracked(1));
    p.reset(new Tracked(2));
    EXPECT_EQ(Tracked::alive, 1);
    EXPECT_EQ(p->value, 2);
    Tracked* raw = p.release();
    EXPECT_FALSE(p);
    EXPECT_EQ(Tracked::alive, 1);
    delete raw;
    EXPECT_EQ(Tracked::alive, 0);
}

TEST(UniquePtr, CustomDeleterAndZeroOverhead) {
    int calls = 0;
    struct CountingDelete {
        int* calls;
        void operator()(int* p) const { ++*calls; delete p; }
    };
    {
        UniquePtr<int, CountingDelete> p(new int(5), CountingDelete{&calls});
        EXPECT_EQ(*p, 5);
    }
    EXPECT_EQ(calls, 1);
    static_assert(sizeof(UniquePtr<int>) == sizeof(int*), "empty deleter must add no storage");
}

TEST(SharedPtr, CountsCopiesAndDeletesAtZero) {
    Tracked::alive = 0;
    {
        SharedPtr<Tracked> a = alloclab::make_shared<Tracked>(3);
        EXPECT_EQ(a.use_count(), 1);
        {
            SharedPtr<Tracked> b = a;
            SharedPtr<Tracked> c(b);
            EXPECT_EQ(a.use_count(), 3);
            EXPECT_EQ(c->value, 3);
        }
        EXPECT_EQ(a.use_count(), 1);
        EXPECT_EQ(Tracked::alive, 1);
    }
    EXPECT_EQ(Tracked::alive, 0);
}

TEST(SharedPtr, MoveAndSelfAssignment) {
    Tracked::alive = 0;
    SharedPtr<Tracked> a = alloclab::make_shared<Tracked>(1);
    SharedPtr<Tracked> b = std::move(a);
    EXPECT_FALSE(a);  // NOLINT(bugprone-use-after-move)
    EXPECT_EQ(b.use_count(), 1);
    b = b;  // NOLINT(clang-diagnostic-self-assign-overloaded)
    EXPECT_EQ(b.use_count(), 1);
    EXPECT_EQ(Tracked::alive, 1);
    b.reset();
    EXPECT_EQ(Tracked::alive, 0);
    EXPECT_EQ(b.use_count(), 0);
}

TEST(SharedPtr, ThreadSafeRefCount) {
    Tracked::alive = 0;
    {
        SharedPtr<Tracked> root = alloclab::make_shared<Tracked>(42);
        std::vector<std::thread> threads;
        for (int t = 0; t < 8; ++t) {
            threads.emplace_back([root] {
                for (int i = 0; i < 10000; ++i) {
                    SharedPtr<Tracked> copy = root;
                    SharedPtr<Tracked> moved = std::move(copy);
                    EXPECT_EQ(moved->value, 42);
                }
            });
        }
        for (auto& th : threads) th.join();
        EXPECT_EQ(root.use_count(), 1);
        EXPECT_EQ(Tracked::alive, 1);
    }
    EXPECT_EQ(Tracked::alive, 0);
}

TEST(WeakPtr, ObservesWithoutOwningAndExpires) {
    Tracked::alive = 0;
    WeakPtr<Tracked> w;
    {
        SharedPtr<Tracked> s = alloclab::make_shared<Tracked>(9);
        w = s;
        EXPECT_EQ(s.use_count(), 1) << "weak must not add to strong";
        EXPECT_EQ(s.weak_count(), 1);
        EXPECT_FALSE(w.expired());
        SharedPtr<Tracked> locked = w.lock();
        EXPECT_EQ(locked->value, 9);
        EXPECT_EQ(s.use_count(), 2);
    }
    EXPECT_TRUE(w.expired());
    EXPECT_FALSE(w.lock());
    EXPECT_EQ(Tracked::alive, 0) << "object died even though a weak observer remains";
}

namespace {
int g_nodes = 0;
struct DNode {  // doubly linked: forward edge owns, back edge observes
    SharedPtr<DNode> next;
    WeakPtr<DNode> prev;
    DNode() { ++g_nodes; }
    ~DNode() { --g_nodes; }
};
struct CNode {  // strong cycle: both edges own
    SharedPtr<CNode> other;
    CNode() { ++g_nodes; }
    ~CNode() { --g_nodes; }
};
}  // namespace

TEST(WeakPtr, BreaksOwnershipCycle) {
    g_nodes = 0;
    {
        SharedPtr<DNode> a(new DNode), b(new DNode);
        a->next = b;
        b->prev = a;  // back edge is weak -> no cycle of owners
        EXPECT_EQ(a.use_count(), 1);
        EXPECT_EQ(b.use_count(), 2);
        EXPECT_EQ(b->prev.lock().get(), a.get());
    }
    EXPECT_EQ(g_nodes, 0) << "both nodes freed";
}

TEST(WeakPtr, SharedCycleLeaksForComparison) {
    g_nodes = 0;
    CNode* raw_a;
    {
        SharedPtr<CNode> a(new CNode), b(new CNode);
        raw_a = a.get();
        a->other = b;
        b->other = a;  // strong cycle
    }
    EXPECT_EQ(g_nodes, 2) << "demonstrates the leak weak_ptr prevents";
    {
        SharedPtr<CNode> b = raw_a->other;  // hold b so breaking the cycle is well-defined
        b->other.reset();                   // a's last owner gone -> ~a releases a->other
    }                                       // b's last owner gone
    EXPECT_EQ(g_nodes, 0);
}

TEST(SharedPtr, MakeSharedIsOneAllocationAndStillSafeWithWeak) {
    Tracked::alive = 0;
    static_assert(SharedPtr<Tracked>::inplace_block_size >= sizeof(Tracked) + 2 * sizeof(long),
                  "in-place block embeds the object next to the counts");
    static_assert(SharedPtr<Tracked>::separate_block_size <= SharedPtr<Tracked>::inplace_block_size,
                  "separate block only stores a pointer (Tracked is pointer-sized, so equal here)");
    WeakPtr<Tracked> w;
    {
        SharedPtr<Tracked> s = alloclab::make_shared<Tracked>(5);
        w = s;
        EXPECT_EQ(s->value, 5);
        EXPECT_EQ(Tracked::alive, 1);
    }
    EXPECT_TRUE(w.expired());
    EXPECT_EQ(Tracked::alive, 0) << "~T ran in place while the block stays alive for the observer";
}
