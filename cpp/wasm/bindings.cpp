// bindings.cpp — embind surface for the browser. Thin "handle" classes wrap the real allocators,
// convert pointers to 32-bit wasm addresses, and record the per-block info (padding, alignment)
// the arena itself deliberately doesn't keep. JS never touches raw pointers.
//
// Interview Q&A
// Q: Why return addresses as numbers instead of pointers?  A: wasm32 pointers are offsets into one
//    linear memory; a uint32 is exactly that value, and JS can print it as hex with no marshalling.
// Q: Why does ArenaHandle store a blocks vector when the arena has no headers?
// A: Visualization needs per-block metadata; keeping it OUTSIDE the arena preserves the arena's
//    zero-overhead design. The JS log is a view, not part of the allocator.
// Q: Why emscripten::val arrays instead of register_vector?  A: register_vector returns a C++ object
//    JS must .delete(); plain JS arrays are garbage-collected and simpler to consume.
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cstdint>
#include <new>
#include <string>
#include <vector>

#include "alloclab/arena.hpp"
#include "alloclab/bench.hpp"
#include "alloclab/freelist.hpp"
#include "alloclab/pool.hpp"
#include "alloclab/shared_ptr.hpp"
#include "alloclab/stats.hpp"

using namespace emscripten;
using namespace alloclab;

static std::uint32_t addr_of(const void* p) { return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(p)); }

class ArenaHandle {
public:
    explicit ArenaHandle(std::uint32_t capacity) : arena_(capacity) {}

    std::uint32_t allocate(std::uint32_t size, std::uint32_t align) {
        const std::uint32_t cursor = addr_of(arena_.base()) + static_cast<std::uint32_t>(arena_.used());
        void* p = arena_.allocate(size, align);
        if (!p) return 0;
        const std::uint32_t addr = addr_of(p);
        blocks_.push_back({addr, size, align, addr - cursor});
        return addr;
    }

    void reset() { arena_.reset(); blocks_.clear(); }
    std::uint32_t base() const { return addr_of(arena_.base()); }
    std::uint32_t capacity() const { return arena_.capacity(); }
    std::uint32_t used() const { return arena_.used(); }
    AllocStats stats() const { return arena_.stats(); }

    val blocks() const {
        val out = val::array();
        for (const auto& b : blocks_) {
            val o = val::object();
            o.set("addr", b.addr); o.set("size", b.size); o.set("align", b.align); o.set("padding", b.padding);
            out.call<void>("push", o);
        }
        return out;
    }

private:
    struct Block { std::uint32_t addr, size, align, padding; };
    ArenaAllocator arena_;
    std::vector<Block> blocks_;
};

class PoolHandle {
public:
    PoolHandle(std::uint32_t block_size, std::uint32_t block_count, std::uint32_t alignment)
        : pool_(block_size, block_count, alignment) {}

    std::uint32_t allocate() { return addr_of(pool_.allocate()); }

    bool deallocate(std::uint32_t addr) {
        void* p = reinterpret_cast<void*>(static_cast<std::uintptr_t>(addr));
        if (!pool_.owns(p) || (addr - base()) % pool_.block_size() != 0) return false;
        pool_.deallocate(p);
        return true;
    }

    void reset() { pool_.reset(); }
    std::uint32_t base() const { return addr_of(pool_.base()); }
    std::uint32_t blockSize() const { return pool_.block_size(); }
    std::uint32_t blockCount() const { return pool_.block_count(); }
    std::uint32_t indexOf(std::uint32_t addr) const { return (addr - base()) / pool_.block_size(); }
    std::uint32_t largestFreeRun() const { return pool_.largest_free_run(); }
    AllocStats stats() const { return pool_.stats(); }

    val freeList() const {
        val out = val::array();
        for (std::size_t i : pool_.free_list_indices()) out.call<void>("push", static_cast<std::uint32_t>(i));
        return out;
    }

private:
    PoolAllocator pool_;
};

class FreeListHandle {
public:
    explicit FreeListHandle(std::uint32_t capacity) : allocator_(capacity) {}

    std::uint32_t allocate(std::uint32_t size) {
        void* p = allocator_.allocate(size);
        if (!p) return 0;
        const std::uint32_t addr = addr_of(p);
        allocations_.push_back({addr, size});
        return addr;
    }

    bool deallocate(std::uint32_t addr) {
        auto it = std::find_if(allocations_.begin(), allocations_.end(),
                               [addr](const Allocation& a) { return a.addr == addr; });
        if (it == allocations_.end()) return false;
        allocator_.deallocate(reinterpret_cast<void*>(static_cast<std::uintptr_t>(addr)));
        allocations_.erase(it);
        return true;
    }

    void reset() { allocator_.reset(); allocations_.clear(); }
    std::uint32_t base() const { return addr_of(allocator_.base()); }
    std::uint32_t capacity() const { return static_cast<std::uint32_t>(allocator_.capacity()); }
    std::uint32_t headerSize() const { return FreeListAllocator::kHeaderSize; }
    AllocStats stats() const { return allocator_.stats(); }

    val blocks() const {
        val out = val::array();
        for (const auto& block : allocator_.layout()) {
            val item = val::object();
            item.set("offset", static_cast<std::uint32_t>(block.offset));
            item.set("size", static_cast<std::uint32_t>(block.size));
            item.set("free", block.free);
            out.call<void>("push", item);
        }
        return out;
    }

    val freeList() const {
        val out = val::array();
        for (std::size_t offset : allocator_.free_list_offsets()) {
            out.call<void>("push", static_cast<std::uint32_t>(offset));
        }
        return out;
    }

    val allocations() const {
        val out = val::array();
        for (const auto& allocation : allocations_) {
            val item = val::object();
            item.set("addr", allocation.addr);
            item.set("size", allocation.size);
            out.call<void>("push", item);
        }
        return out;
    }

private:
    struct Allocation { std::uint32_t addr; std::uint32_t size; };
    FreeListAllocator allocator_;
    std::vector<Allocation> allocations_;
};

// allocator: "new" | "arena" | "pool"; workload: "small" | "mixed" | "churn"
static val runBenchmark(const std::string& allocator, const std::string& workload, std::uint32_t n) {
    using bench::Workload;
    const Workload w = workload == "small" ? Workload::SmallAllocs : workload == "mixed" ? Workload::MixedSizes : Workload::Churn;
    bench::Result r;
    if (allocator == "arena") {
        const std::size_t cap = (w == Workload::Churn ? bench::kChurnWindow * 64 : n) * (bench::max_size(w) + 16);
        ArenaAllocator arena(cap);
        r = bench::run(w, n, [&](std::size_t s, std::size_t a) { return arena.allocate(s, a); },
                       [](void*, std::size_t) {}, [&] { arena.reset(); });
    } else if (allocator == "pool") {
        PoolAllocator pool(bench::max_size(w), bench::blocks_needed(w, n));
        r = bench::run(w, n, [&](std::size_t, std::size_t) { return pool.allocate(); },
                       [&](void* p, std::size_t) { pool.deallocate(p); }, [&] { pool.reset(); });
    } else if (allocator == "freelist") {
        const std::size_t cap = (w == Workload::Churn ? bench::kChurnWindow * 4 : n) * (bench::max_size(w) + 32);
        FreeListAllocator fl(cap);
        r = bench::run(w, n, [&](std::size_t s, std::size_t) { return fl.allocate(s); },
                       [&](void* p, std::size_t) { fl.deallocate(p); }, [&] { fl.reset(); });
    } else {
        r = bench::run(w, n,
                       [](std::size_t s, std::size_t a) {
                           return ::operator new(s, static_cast<std::align_val_t>(a));
                       },
                       [](void* p, std::size_t) {
                           ::operator delete(p, static_cast<std::align_val_t>(alignof(std::max_align_t)));
                       },
                       [] {});
    }
    val o = val::object();
    o.set("ms", r.ms); o.set("ops", static_cast<std::uint32_t>(r.ops));
    o.set("bytes", static_cast<std::uint32_t>(r.bytes)); o.set("resets", static_cast<std::uint32_t>(r.resets));
    return o;
}

// Smart-pointer walkthrough for the "pointers" tab: every step records the real counts from the
// control block and how many objects are alive, so the UI shows what weak_ptr actually does.
namespace {
int g_alive = 0;
struct Probe { int payload[4] = {}; Probe() { ++g_alive; } ~Probe() { --g_alive; } };  // 16-byte object
struct DNode { SharedPtr<DNode> next; WeakPtr<DNode> prev; DNode() { ++g_alive; } ~DNode() { --g_alive; } };
struct CNode { SharedPtr<CNode> other; CNode() { ++g_alive; } ~CNode() { --g_alive; } };

val step(const char* code, long strong, long weak, bool expired) {
    val o = val::object();
    o.set("code", std::string(code)); o.set("strong", static_cast<int>(strong)); o.set("weak", static_cast<int>(weak));
    o.set("expired", expired); o.set("alive", g_alive);
    return o;
}
}  // namespace

static val weakPtrDemo() {
    val lifecycle = val::array();
    g_alive = 0;
    {
        SharedPtr<Probe> s = alloclab::make_shared<Probe>();
        lifecycle.call<void>("push", step("SharedPtr<T> s = make_shared<T>();", s.use_count(), s.weak_count(), false));
        WeakPtr<Probe> w = s;
        lifecycle.call<void>("push", step("WeakPtr<T> w = s;", s.use_count(), s.weak_count(), w.expired()));
        {
            SharedPtr<Probe> s2 = w.lock();
            lifecycle.call<void>("push", step("SharedPtr<T> s2 = w.lock();", s.use_count(), s.weak_count(), w.expired()));
        }
        lifecycle.call<void>("push", step("s2 goes out of scope", s.use_count(), s.weak_count(), w.expired()));
        s.reset();
        lifecycle.call<void>("push", step("s.reset();   // last owner", w.use_count(), 1, w.expired()));
        SharedPtr<Probe> dead = w.lock();
        lifecycle.call<void>("push", step("w.lock()     // -> empty", w.use_count(), 1, w.expired()));
        (void)dead;
    }
    lifecycle.call<void>("push", step("w goes out of scope  // control block freed", 0, 0, true));

    val cycle = val::array();
    g_alive = 0;
    {
        SharedPtr<CNode> a(new CNode), b(new CNode);
        a->other = b; b->other = a;
        cycle.call<void>("push", step("SharedPtr a, b; a->other = b; b->other = a;", a.use_count(), 0, false));
    }
    cycle.call<void>("push", step("scope ends — strong cycle, nothing freed", 1, 0, false));
    const int leaked = g_alive;
    g_alive = 0;
    {
        SharedPtr<DNode> a(new DNode), b(new DNode);
        a->next = b; b->prev = a;
        cycle.call<void>("push", step("SharedPtr a, b; a->next = b; b->prev = a; (prev is WeakPtr)", b.use_count(), 0, false));
    }
    cycle.call<void>("push", step("scope ends — back edge is weak, both freed", 0, 0, true));

    val o = val::object();
    o.set("lifecycle", lifecycle); o.set("cycle", cycle); o.set("leaked", leaked);
    val sizes = val::object();
    sizes.set("objectBytes", static_cast<int>(sizeof(Probe)));
    sizes.set("separateBlockBytes", static_cast<int>(SharedPtr<Probe>::separate_block_size));
    sizes.set("inplaceBlockBytes", static_cast<int>(SharedPtr<Probe>::inplace_block_size));
    sizes.set("pointerBytes", static_cast<int>(sizeof(void*)));
    o.set("sizes", sizes);
    return o;
}

EMSCRIPTEN_BINDINGS(alloclab) {
    value_object<AllocStats>("AllocStats")
        .field("capacityBytes", &AllocStats::capacity_bytes)
        .field("usedBytes", &AllocStats::used_bytes)
        .field("peakBytes", &AllocStats::peak_bytes)
        .field("liveAllocations", &AllocStats::live_allocations)
        .field("totalAllocations", &AllocStats::total_allocations)
        .field("totalDeallocations", &AllocStats::total_deallocations)
        .field("failedAllocations", &AllocStats::failed_allocations)
        .field("paddingBytes", &AllocStats::padding_bytes)
        .field("freeListLength", &AllocStats::free_list_length)
        .field("largestFreeBlock", &AllocStats::largest_free_block);

    class_<ArenaHandle>("Arena")
        .constructor<std::uint32_t>()
        .function("allocate", &ArenaHandle::allocate)
        .function("reset", &ArenaHandle::reset)
        .function("base", &ArenaHandle::base)
        .function("capacity", &ArenaHandle::capacity)
        .function("used", &ArenaHandle::used)
        .function("stats", &ArenaHandle::stats)
        .function("blocks", &ArenaHandle::blocks);

    class_<PoolHandle>("Pool")
        .constructor<std::uint32_t, std::uint32_t, std::uint32_t>()
        .function("allocate", &PoolHandle::allocate)
        .function("deallocate", &PoolHandle::deallocate)
        .function("reset", &PoolHandle::reset)
        .function("base", &PoolHandle::base)
        .function("blockSize", &PoolHandle::blockSize)
        .function("blockCount", &PoolHandle::blockCount)
        .function("indexOf", &PoolHandle::indexOf)
        .function("largestFreeRun", &PoolHandle::largestFreeRun)
        .function("stats", &PoolHandle::stats)
        .function("freeList", &PoolHandle::freeList);

    class_<FreeListHandle>("FreeList")
        .constructor<std::uint32_t>()
        .function("allocate", &FreeListHandle::allocate)
        .function("deallocate", &FreeListHandle::deallocate)
        .function("reset", &FreeListHandle::reset)
        .function("base", &FreeListHandle::base)
        .function("capacity", &FreeListHandle::capacity)
        .function("headerSize", &FreeListHandle::headerSize)
        .function("stats", &FreeListHandle::stats)
        .function("blocks", &FreeListHandle::blocks)
        .function("freeList", &FreeListHandle::freeList)
        .function("allocations", &FreeListHandle::allocations);

    function("runBenchmark", &runBenchmark);
    function("weakPtrDemo", &weakPtrDemo);
}
