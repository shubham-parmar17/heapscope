// freeListModel.ts — drives the real wasm first-fit allocator and replays its operation history.
// The allocator reports physical block spans, so split and coalesce results are inspected directly.
import {
  hex,
  type AllocLabModule,
  type AllocStats,
  type FreeListHandle,
  type RawFreeListAllocation,
  type RawFreeListBlock,
} from "../wasm/loadAllocLab";

export type FreeListOp =
  | { kind: "alloc"; size: number; addr: number }
  | { kind: "free"; addr: number; ok: boolean }
  | { kind: "reset" };

export interface FreeListSnapshot {
  base: number;
  capacity: number;
  headerSize: number;
  blocks: RawFreeListBlock[];
  freeList: number[];
  allocations: RawFreeListAllocation[];
  stats: AllocStats;
  cursor: number;
  historyLength: number;
}

export function describeFreeListOp(op: FreeListOp): string {
  if (op.kind === "reset") return "reset()";
  if (op.kind === "alloc") return `alloc(${op.size}) -> ${op.addr ? hex(op.addr) : "nullptr (fragmented or full)"}`;
  return `free(${hex(op.addr)})${op.ok ? "" : " -> rejected"}`;
}

export class FreeListModel {
  readonly history: FreeListOp[] = [];
  cursor = 0;
  private handle: FreeListHandle;

  constructor(private m: AllocLabModule, readonly capacity: number) {
    this.handle = new m.FreeList(capacity);
  }

  private run(op: FreeListOp): FreeListOp {
    if (op.kind === "reset") {
      this.handle.reset();
      return op;
    }
    if (op.kind === "alloc") {
      const addr = this.handle.allocate(op.size);
      if (addr) this.m.HEAPU8.fill(0x41 + (this.cursor % 26), addr, addr + op.size);
      return { ...op, addr };
    }
    return { ...op, ok: this.handle.deallocate(op.addr) };
  }

  apply(op: FreeListOp): FreeListOp {
    this.history.length = this.cursor;
    const done = this.run(op);
    this.history.push(done);
    this.cursor = this.history.length;
    return done;
  }

  seek(k: number) {
    const target = Math.max(0, Math.min(k, this.history.length));
    this.handle.reset();
    for (let i = 0; i < target; i++) this.run(this.history[i]);
    this.cursor = target;
  }

  snapshot(): FreeListSnapshot {
    return {
      base: this.handle.base(),
      capacity: this.handle.capacity(),
      headerSize: this.handle.headerSize(),
      blocks: this.handle.blocks(),
      freeList: this.handle.freeList(),
      allocations: this.handle.allocations(),
      stats: this.handle.stats(),
      cursor: this.cursor,
      historyLength: this.history.length,
    };
  }

  bytes(addr: number, length: number): Uint8Array { return this.m.HEAPU8.slice(addr, addr + length); }
  dispose() { this.handle.delete(); }
}
