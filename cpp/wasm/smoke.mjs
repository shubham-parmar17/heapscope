// smoke.mjs — loads the compiled module in Node and exercises Arena, Pool, FreeList and benchmarks.
// This is the Phase C acceptance test: if it prints real addresses and stats, the browser will too.
// Usage: node cpp/wasm/smoke.mjs
//
// Interview Q&A
// Q: Why test in Node, not just the browser?  A: Fast, scriptable, runs in CI without a headless browser.
// Q: Why .delete() the handles?  A: embind objects live in wasm memory; JS GC cannot free them.
// Q: Why are the addresses small (e.g. 0x0001xxxx)?  A: They're offsets into wasm linear memory,
//    which starts at 0 — not host process addresses.
import createAllocLab from "../../frontend/public/wasm/alloclab.mjs";

const hex = (n) => "0x" + n.toString(16).padStart(8, "0");
const m = await createAllocLab();

const arena = new m.Arena(256);
const a = arena.allocate(1, 1);
const b = arena.allocate(8, 16);
console.log("arena base", hex(arena.base()), "a", hex(a), "b", hex(b), "used", arena.used());
console.log("arena blocks", arena.blocks());
console.log("arena stats", arena.stats());
if (arena.used() !== 24) throw new Error("expected 24 bytes used (1 + 15 padding + 8)");

const pool = new m.Pool(32, 8, 16);
const p0 = pool.allocate(), p1 = pool.allocate(), p2 = pool.allocate();
pool.deallocate(p1);
console.log("pool base", hex(pool.base()), "blocks", [p0, p1, p2].map(hex), "freeList", pool.freeList());
console.log("pool stats", pool.stats(), "largestFreeRun", pool.largestFreeRun());
if (pool.freeList()[0] !== 1) throw new Error("freed block 1 should be free-list head");
if (pool.deallocate(p1 + 4)) throw new Error("misaligned pointer must be rejected");

const freelist = new m.FreeList(128);
const f0 = freelist.allocate(16), f1 = freelist.allocate(16);
let blocks = freelist.blocks();
if (blocks.length !== 3 || blocks[0].free || blocks[1].free || !blocks[2].free)
  throw new Error("first-fit allocations should split the initial block");
if (!freelist.deallocate(f0) || !freelist.deallocate(f1)) throw new Error("free-list deallocation failed");
blocks = freelist.blocks();
if (blocks.length !== 1 || !blocks[0].free || blocks[0].size !== freelist.capacity())
  throw new Error("adjacent free blocks should coalesce");
if (freelist.freeList().length !== 1 || freelist.freeList()[0] !== 0)
  throw new Error("free-list head should point to the coalesced first block");
console.log("freelist blocks", blocks, "stats", freelist.stats());

for (const w of ["small", "mixed", "churn"])
  for (const alloc of ["new", "arena", "pool", "freelist"])
    console.log(w.padEnd(6), alloc.padEnd(8), m.runBenchmark(alloc, w, 200000));

arena.delete();
pool.delete();
freelist.delete();
console.log("SMOKE OK");
