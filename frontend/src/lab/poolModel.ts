// poolModel.ts — drives the real wasm Pool and keeps an op history for step / scrub. A pool is
// deterministic for a given op sequence, so "scrub to k" = reset + replay ops[0..k). Freed blocks
// are NOT overwritten: their first 4 bytes become the free-list `next` pointer (visible in the hexdump).
//
// Interview Q&A
// Q: What is in a free block's memory?  A: The intrusive FreeNode: a 4-byte (wasm32) pointer to the
//    next free block, little-endian. The rest of the block keeps whatever the last owner wrote.
// Q: Why does deallocate() return a bool?  A: The binding rejects foreign or misaligned addresses
//    instead of corrupting the list; the log shows "free(0x…) -> rejected" so bugs are visible.
// Q: Why track lastEvent?  A: The renderer flashes the popped/pushed cell for 150ms — the animation
//    must be tied to the operation that caused it, nothing decorative.
import { hex, type AllocLabModule, type AllocStats, type PoolHandle } from "../wasm/loadAllocLab";

export type PoolOp =
  | { kind: "alloc"; addr: number }
  | { kind: "free"; addr: number; ok: boolean }
  | { kind: "reset" };

export interface PoolEvent { kind: "pop" | "push"; index: number; at: number }

export interface PoolSnapshot {
  base: number;
  blockSize: number;
  blockCount: number;
  freeList: number[];
  used: boolean[];
  stats: AllocStats;
  largestFreeRun: number;
  cursor: number;
  historyLength: number;
  lastEvent: PoolEvent | null;
}

export const tagFor = (index: number): number => (0x41 + index * 37) & 0xff;

export function describePoolOp(op: PoolOp): string {
  if (op.kind === "reset") return "reset()";
  if (op.kind === "alloc") return `alloc() -> ${op.addr ? hex(op.addr) : "nullptr (exhausted)"}`;
  return `free(${hex(op.addr)})${op.ok ? "" : " -> rejected"}`;
}

export class PoolModel {
  readonly history: PoolOp[] = [];
  cursor = 0;
  private handle: PoolHandle;
  private lastEvent: PoolEvent | null = null;

  constructor(private m: AllocLabModule, readonly blockSize: number, readonly blockCount: number) {
    this.handle = new m.Pool(blockSize, blockCount, 16);
  }

  addrOf(index: number): number { return this.handle.base() + index * this.handle.blockSize(); }
  indexOf(addr: number): number { return this.handle.indexOf(addr); }

  private run(op: PoolOp, animate: boolean): PoolOp {
    if (op.kind === "reset") {
      this.handle.reset();
      if (animate) this.lastEvent = null;
      return op;
    }
    if (op.kind === "alloc") {
      const addr = this.handle.allocate();
      if (addr) {
        const idx = this.indexOf(addr);
        this.m.HEAPU8.fill(tagFor(idx), addr, addr + this.handle.blockSize());
        if (animate) this.lastEvent = { kind: "pop", index: idx, at: performance.now() };
      }
      return { kind: "alloc", addr };
    }
    const ok = this.handle.deallocate(op.addr);
    if (ok && animate) this.lastEvent = { kind: "push", index: this.indexOf(op.addr), at: performance.now() };
    return { ...op, ok };
  }

  apply(op: PoolOp): PoolOp {
    this.history.length = this.cursor;
    const done = this.run(op, true);
    this.history.push(done);
    this.cursor = this.history.length;
    return done;
  }

  seek(k: number) {
    const target = Math.max(0, Math.min(k, this.history.length));
    this.handle.reset();
    for (let i = 0; i < target; i++) this.run(this.history[i], false);
    this.lastEvent = null;
    this.cursor = target;
  }

  usedIndices(): number[] {
    const free = new Set(this.handle.freeList());
    const out: number[] = [];
    for (let i = 0; i < this.handle.blockCount(); i++) if (!free.has(i)) out.push(i);
    return out;
  }

  snapshot(): PoolSnapshot {
    const freeList = this.handle.freeList();
    const free = new Set(freeList);
    const count = this.handle.blockCount();
    return {
      base: this.handle.base(),
      blockSize: this.handle.blockSize(),
      blockCount: count,
      freeList,
      used: Array.from({ length: count }, (_, i) => !free.has(i)),
      stats: this.handle.stats(),
      largestFreeRun: this.handle.largestFreeRun(),
      cursor: this.cursor,
      historyLength: this.history.length,
      lastEvent: this.lastEvent,
    };
  }

  bytes(addr: number, length: number): Uint8Array { return this.m.HEAPU8.slice(addr, addr + length); }
  dispose() { this.handle.delete(); }
}
