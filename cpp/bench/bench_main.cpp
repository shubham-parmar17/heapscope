// bench_main.cpp — native benchmark: new/delete vs Arena vs Pool on three workloads, printed as a
// table (ms, ns/op, resets). Built WITHOUT sanitizers in Release so the numbers are real.
// Usage: ./alloclab_bench [n]   (default n = 2,000,000)
//
// Interview Q&A
// Q: Why is the pool's block size the workload's max size?  A: A pool has one block size; to serve
//    mixed sizes honestly it must be sized for the largest request (wasting space on small ones).
// Q: Why warm up?  A: First touch of fresh pages costs page faults; one untimed pass removes that noise.
// Q: Why ns/op rather than total ms?  A: Normalises across workloads with different op counts.
#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <vector>

#include "alloclab/arena.hpp"
#include "alloclab/bench.hpp"
#include "alloclab/freelist.hpp"
#include "alloclab/pool.hpp"

using namespace alloclab;
using bench::Workload;

static const char* kNames[] = {"small-allocs", "mixed-sizes", "churn"};
static constexpr std::size_t kSamples = 7;

static bool parse_n(int argc, char** argv, std::size_t& n) {
    if (argc > 2) return false;
    if (argc == 1) {
        n = 2'000'000;
        return true;
    }
    if (argv[1][0] == '-') return false;
    errno = 0;
    char* end = nullptr;
    const unsigned long long parsed = std::strtoull(argv[1], &end, 10);
    if (errno == ERANGE || end == argv[1] || *end != '\0' || parsed == 0 ||
        parsed > std::numeric_limits<std::size_t>::max() / (bench::kMaxMixedSize + 32)) {
        return false;
    }
    n = static_cast<std::size_t>(parsed);
    return true;
}

static bench::Result run_new_delete(Workload w, std::size_t n) {
    return bench::run(w, n,
        [](std::size_t s, std::size_t a) {
            return ::operator new(s, static_cast<std::align_val_t>(a));
        },
        [](void* p, std::size_t) {
            ::operator delete(p, static_cast<std::align_val_t>(alignof(std::max_align_t)));
        },
        [] {});
}

static bench::Result run_arena(Workload w, std::size_t n) {
    const std::size_t cap = (w == Workload::Churn ? bench::kChurnWindow * 64 : n) * (bench::max_size(w) + 16);
    ArenaAllocator arena(cap);
    return bench::run(w, n,
        [&](std::size_t s, std::size_t a) { return arena.allocate(s, a); },
        [](void*, std::size_t) {},
        [&] { arena.reset(); });
}

static bench::Result run_pool(Workload w, std::size_t n) {
    PoolAllocator pool(bench::max_size(w), bench::blocks_needed(w, n));
    return bench::run(w, n,
        [&](std::size_t, std::size_t) { return pool.allocate(); },
        [&](void* p, std::size_t) { pool.deallocate(p); },
        [&] { pool.reset(); });
}

static bench::Result run_freelist(Workload w, std::size_t n) {
    const std::size_t cap = (w == Workload::Churn ? bench::kChurnWindow * 4 : n) * (bench::max_size(w) + 32);
    FreeListAllocator fl(cap);
    return bench::run(w, n,
        [&](std::size_t s, std::size_t) { return fl.allocate(s); },
        [&](void* p, std::size_t) { fl.deallocate(p); },
        [&] { fl.reset(); });
}

int main(int argc, char** argv) {
    std::size_t n = 0;
    if (!parse_n(argc, argv, n)) {
        std::fprintf(stderr, "usage: alloclab_bench [positive-n] (n must be a valid allocator capacity)\n");
        return 2;
    }
#if defined(__clang__)
    std::printf("compiler: Clang %s\n", __clang_version__);
#elif defined(__GNUC__)
    std::printf("compiler: GCC %s\n", __VERSION__);
#else
    std::printf("compiler: unknown\n");
#endif
#if defined(__APPLE__)
    std::printf("platform: macOS\n");
#elif defined(__linux__)
    std::printf("platform: Linux\n");
#else
    std::printf("platform: unknown\n");
#endif
#if defined(__aarch64__) || defined(__arm64__)
    std::printf("architecture: arm64\n");
#elif defined(__x86_64__) || defined(_M_X64)
    std::printf("architecture: x86_64\n");
#else
    std::printf("architecture: unknown\n");
#endif
    std::printf("runtime: native C++\n");
    std::printf("n = %zu; samples = %zu; summary = median (range shown as max - min)\n", n, kSamples);
    std::printf("%-14s %-12s %12s %12s %10s %8s\n", "workload", "allocator", "median ms", "range ms", "ns/op", "resets");
    for (int wi = 0; wi < 3; ++wi) {
        const auto w = static_cast<Workload>(wi);
        struct { const char* name; bench::Result (*fn)(Workload, std::size_t); } rows[] = {
            {"new/delete", run_new_delete}, {"arena", run_arena}, {"pool", run_pool}, {"freelist", run_freelist}};
        for (auto& row : rows) {
            row.fn(w, std::max<std::size_t>(1, n / 10));  // warm-up
            std::vector<double> samples;
            samples.reserve(kSamples);
            bench::Result result;
            for (std::size_t i = 0; i < kSamples; ++i) {
                result = row.fn(w, n);
                samples.push_back(result.ms);
            }
            std::sort(samples.begin(), samples.end());
            const double median_ms = samples[kSamples / 2];
            std::printf("%-14s %-12s %12.3f %12.3f %10.2f %8zu\n", kNames[wi], row.name,
                        median_ms, samples.back() - samples.front(),
                        median_ms * 1e6 / result.ops, result.resets);
        }
    }
    return 0;
}
