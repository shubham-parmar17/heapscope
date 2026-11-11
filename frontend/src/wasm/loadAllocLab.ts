// loadAllocLab.ts — typed loader for the Emscripten module served from /public/wasm. Imported at
// runtime (not bundled) so the .mjs/.wasm pair stays a plain static asset. Memoised: one wasm
// instance per page, shared by every view. The interfaces mirror EMSCRIPTEN_BINDINGS in bindings.cpp.
export interface AllocStats {
  capacityBytes: number;
  usedBytes: number;
  peakBytes: number;
  liveAllocations: number;
  totalAllocations: number;
  totalDeallocations: number;
  failedAllocations: number;
  paddingBytes: number;
  freeListLength: number;
  largestFreeBlock: number;
}

export interface RawArenaBlock { addr: number; size: number; align: number; padding: number }

export interface ArenaHandle {
  allocate(size: number, align: number): number;
  reset(): void;
  base(): number;
  capacity(): number;
  used(): number;
  stats(): AllocStats;
  blocks(): RawArenaBlock[];
  delete(): void;
}

export interface PoolHandle {
  allocate(): number;
  deallocate(addr: number): boolean;
  reset(): void;
  base(): number;
  blockSize(): number;
  blockCount(): number;
  indexOf(addr: number): number;
  largestFreeRun(): number;
  stats(): AllocStats;
  freeList(): number[];
  delete(): void;
}

export interface RawFreeListBlock { offset: number; size: number; free: boolean }
export interface RawFreeListAllocation { addr: number; size: number }

export interface FreeListHandle {
  allocate(size: number): number;
  deallocate(addr: number): boolean;
  reset(): void;
  base(): number;
  capacity(): number;
  headerSize(): number;
  stats(): AllocStats;
  blocks(): RawFreeListBlock[];
  freeList(): number[];
  allocations(): RawFreeListAllocation[];
  delete(): void;
}

export interface BenchResult { ms: number; ops: number; bytes: number; resets: number; minMs?: number; maxMs?: number }
export type BenchAllocator = "new" | "arena" | "pool" | "freelist";
export type BenchWorkload = "small" | "mixed" | "churn";

export interface DemoStep { code: string; strong: number; weak: number; expired: boolean; alive: number }
export interface BlockSizes { objectBytes: number; separateBlockBytes: number; inplaceBlockBytes: number; pointerBytes: number }
export interface WeakPtrDemo { lifecycle: DemoStep[]; cycle: DemoStep[]; leaked: number; sizes: BlockSizes }

export interface AllocLabModule {
  Arena: new (capacity: number) => ArenaHandle;
  Pool: new (blockSize: number, blockCount: number, alignment: number) => PoolHandle;
  FreeList: new (capacity: number) => FreeListHandle;
  runBenchmark(allocator: BenchAllocator, workload: BenchWorkload, n: number): BenchResult;
  weakPtrDemo(): WeakPtrDemo;
  HEAPU8: Uint8Array;
}

let modulePromise: Promise<AllocLabModule> | null = null;

export function loadAllocLab(): Promise<AllocLabModule> {
  if (!modulePromise) {
    modulePromise = import(/* @vite-ignore */ `${window.location.origin}/wasm/alloclab.mjs`)
      .then((mod: { default: () => Promise<AllocLabModule> }) => mod.default())
      .catch((e: unknown) => { modulePromise = null; throw e; }); // allow a retry after a failed load
  }
  return modulePromise;
}

export const hex = (n: number): string => "0x" + (n >>> 0).toString(16).padStart(8, "0");
