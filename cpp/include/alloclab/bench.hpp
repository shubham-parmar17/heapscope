// bench.hpp — the three workloads shared by the native benchmark and the WASM comparison view, so
// the table in the README and the bars in the browser measure exactly the same thing. Generic over
// two callables (alloc(size, align) -> void*, free(ptr, size)) so new/delete, Arena and Pool plug in.
//
// Interview Q&A
// Q: Why a deterministic LCG instead of std::mt19937?  A: Same sequence on every run and every
//    platform (native vs wasm), and no <random> state to pay for inside the timed loop.
// Q: How does an arena handle "free" in the churn workload?  A: It can't free individually; free is
//    a no-op and when allocate() fails the harness reset()s and retries. The result reports `resets`
//    so the trade-off is visible, not hidden.
// Q: Why steady_clock?  A: Monotonic; wall-clock adjustments can't make a benchmark go negative.
#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace alloclab::bench {

enum class Workload { SmallAllocs, MixedSizes, Churn };

struct Result {
    double ms = 0;
    std::size_t ops = 0;
    std::size_t bytes = 0;
    std::size_t resets = 0;
};

inline constexpr std::size_t kSmallSize = 32;
inline constexpr std::size_t kMixedSizes[] = {16, 24, 32, 48, 64, 96, 128, 256};
inline constexpr std::size_t kMaxMixedSize = 256;
inline constexpr std::size_t kChurnWindow = 1024;

inline std::size_t max_size(Workload w) { return w == Workload::SmallAllocs ? kSmallSize : kMaxMixedSize; }
// How many blocks a pool needs so the workload never exhausts it.
inline std::size_t blocks_needed(Workload w, std::size_t n) { return w == Workload::Churn ? kChurnWindow : n; }

struct Lcg {
    std::uint32_t s = 0x9E3779B9u;
    std::uint32_t next() { s = s * 1664525u + 1013904223u; return s >> 8; }
};

template <class Alloc, class Free, class Reset>
Result run(Workload w, std::size_t n, Alloc alloc, Free free, Reset reset) {
    using clock = std::chrono::steady_clock;
    Result r;
    Lcg rng;
    std::vector<std::pair<void*, std::size_t>> live;
    live.reserve(w == Workload::Churn ? kChurnWindow : n);

    auto alloc_or_reset = [&](std::size_t size) {
        void* p = alloc(size, alignof(std::max_align_t));
        if (!p) { reset(); ++r.resets; p = alloc(size, alignof(std::max_align_t)); }
        return p;
    };

    const auto t0 = clock::now();
    if (w == Workload::Churn) {
        for (std::size_t i = 0; i < n; ++i) {
            const bool do_free = !live.empty() && (live.size() >= kChurnWindow || (rng.next() & 1));
            if (do_free) {
                const std::size_t k = rng.next() % live.size();
                free(live[k].first, live[k].second);
                live[k] = live.back();
                live.pop_back();
            } else {
                const std::size_t size = kMixedSizes[rng.next() % 8];
                live.emplace_back(alloc_or_reset(size), size);
                r.bytes += size;
            }
        }
        for (auto& [p, s] : live) free(p, s);
        r.ops = n + live.size();
    } else {
        for (std::size_t i = 0; i < n; ++i) {
            const std::size_t size = w == Workload::SmallAllocs ? kSmallSize : kMixedSizes[rng.next() % 8];
            live.emplace_back(alloc_or_reset(size), size);
            r.bytes += size;
        }
        for (auto& [p, s] : live) free(p, s);
        r.ops = 2 * n;
    }
    r.ms = std::chrono::duration<double, std::milli>(clock::now() - t0).count();
    return r;
}

}  // namespace alloclab::bench
