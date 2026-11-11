// arenaModel.ts — drives the real wasm Arena and keeps an operation history so the UI can step and
// scrub. Because a bump allocator is deterministic, "scrub to k" is just: reset, replay ops[0..k).
// Applying a new op while scrubbed back truncates the future (same mental model as undo/redo).
//
// Interview Q&A
// Q: Why replay instead of storing snapshots?  A: Replay costs O(k) trivial allocate() calls and zero
//    memory; snapshots would copy the block list per step. For hundreds of ops replay is instant.
// Q: Why fill allocated bytes with a tag?  A: So the hexdump shows which block owns which bytes, and
//    so reset() visibly does NOT clear memory — the old bytes stay until overwritten.
// Q: Why is padding computed here and not in the arena?  A: The arena has no per-block headers by
//    design; the handle derives padding from (returned addr − previous cursor).
import { hex, type AllocLabModule, type AllocStats, type ArenaHandle } from "../wasm/loadAllocLab";

export type ArenaOp =
  | { kind: "alloc"; size: number; align: number; addr: number }
  | { kind: "reset" };

export interface ArenaBlock {
  index: number;
  addr: number;
  size: number;
  align: number;
  padding: number;
  tag: number;
}

export interface ArenaSnapshot {
  base: number;
  capacity: number;
  used: number;
  blocks: ArenaBlock[];
  stats: AllocStats;
  cursor: number;
  historyLength: number;
}

export const tagFor = (index: number): number => (0x41 + index * 37) & 0xff;

export function describeOp(op: ArenaOp): string {
  if (op.kind === "reset") return "reset()";
  return `alloc(${op.size}, align ${op.align}) -> ${op.addr ? hex(op.addr) : "nullptr"}`;
}

export class ArenaModel {
  readonly history: ArenaOp[] = [];
  cursor = 0;
  private handle: ArenaHandle;

  constructor(private m: AllocLabModule, readonly capacity: number) {
    this.handle = new m.Arena(capacity);
  }

  private fill(addr: number, size: number, tag: number) {
    this.m.HEAPU8.fill(tag, addr, addr + size);
  }

  private run(op: ArenaOp): ArenaOp {
    if (op.kind === "reset") {
      this.handle.reset();
      return op;
    }
    const addr = this.handle.allocate(op.size, op.align);
    if (addr) this.fill(addr, op.size, tagFor(this.handle.blocks().length - 1));
    return { ...op, addr };
  }

  apply(op: ArenaOp): ArenaOp {
    this.history.length = this.cursor; // drop any "future" after a scrub
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

  snapshot(): ArenaSnapshot {
    const raw = this.handle.blocks();
    return {
      base: this.handle.base(),
      capacity: this.handle.capacity(),
      used: this.handle.used(),
      blocks: raw.map((b, index) => ({ index, ...b, tag: tagFor(index) })),
      stats: this.handle.stats(),
      cursor: this.cursor,
      historyLength: this.history.length,
    };
  }

  bytes(addr: number, length: number): Uint8Array {
    return this.m.HEAPU8.slice(addr, addr + length);
  }

  dispose() {
    this.handle.delete();
  }
}
