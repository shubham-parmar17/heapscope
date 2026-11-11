// FreeListView.tsx — shows first-fit allocation, block splitting, free-list order, and coalescing.
import { useEffect, useRef, useState } from "react";
import { readPalette } from "../lab/arenaRenderer";
import { allocationAt, drawFreeList, freeListBlockAt } from "../lab/freeListRenderer";
import { describeFreeListOp, FreeListModel, type FreeListOp, type FreeListSnapshot } from "../lab/freeListModel";
import { loadAllocLab, type AllocLabModule } from "../wasm/loadAllocLab";
import { OpLog, type LogEntry } from "../components/OpLog";
import { useThemeTick } from "../hooks/useTheme";

const CAPACITIES = [512, 1024, 4096, 16384];

export function FreeListView() {
  const [m, setM] = useState<AllocLabModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState(1024);
  const [size, setSize] = useState(64);
  const [snap, setSnap] = useState<FreeListSnapshot | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [selectedAddr, setSelectedAddr] = useState<number | null>(null);
  const themeTick = useThemeTick();
  const modelRef = useRef<FreeListModel | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => { loadAllocLab().then(setM).catch((e) => setLoadError(String(e))); }, []);

  useEffect(() => {
    if (!m) return;
    const model = new FreeListModel(m, capacity);
    modelRef.current = model;
    setSnap(model.snapshot());
    setLog([]);
    setSelectedAddr(null);
    setHovered(null);
    return () => { model.dispose(); modelRef.current = null; };
  }, [m, capacity]);

  const sync = () => {
    const model = modelRef.current;
    if (!model) return;
    setSnap(model.snapshot());
    setLog(model.history.map((op) => ({ text: describeFreeListOp(op), blockIndex: null })));
  };

  const apply = (op: FreeListOp) => {
    const model = modelRef.current;
    if (!model) return;
    const done = model.apply(op);
    if (done.kind === "alloc") setSelectedAddr(done.addr || null);
    if (done.kind === "free" || done.kind === "reset") setSelectedAddr(null);
    sync();
  };

  const runDemo = () => {
    const model = modelRef.current;
    if (!model) return;
    model.apply({ kind: "reset" });
    const first = model.apply({ kind: "alloc", size: 64, addr: 0 });
    model.apply({ kind: "alloc", size: 64, addr: 0 });
    const third = model.apply({ kind: "alloc", size: 64, addr: 0 });
    model.apply({ kind: "alloc", size: 64, addr: 0 });
    if (first.kind === "alloc" && first.addr) model.apply({ kind: "free", addr: first.addr, ok: false });
    if (third.kind === "alloc" && third.addr) model.apply({ kind: "free", addr: third.addr, ok: false });
    model.apply({ kind: "alloc", size: 32, addr: 0 });
    const active = model.snapshot().allocations;
    for (const allocation of active) model.apply({ kind: "free", addr: allocation.addr, ok: false });
    setSelectedAddr(null);
    sync();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snap) return;
    const palette = readPalette(document.documentElement);
    const draw = () => drawFreeList(canvas, snap, hovered, selectedAddr, palette);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [snap, hovered, selectedAddr, themeTick]);

  if (loadError) return <div className="notice" data-testid="wasm-error">wasm load failed: {loadError}</div>;
  if (!m || !snap) return <div className="mono dim" data-testid="wasm-loading">loading alloclab.wasm…</div>;

  const hoveredBlock = hovered === null ? null : snap.blocks[hovered] ?? null;
  const hoveredAllocation = hovered === null ? null : allocationAt(snap, hovered);
  const selectedAllocation = snap.allocations.find((a) => a.addr === selectedAddr);
  const freeChain = snap.freeList.map((offset, index) => {
    const block = snap.blocks.find((b) => b.offset === offset);
    return `${index ? "→ " : ""}${offset} (${block?.size ?? 0} B)`;
  });

  return (
    <section className="view-grid" data-testid="freelist-view">
      <div className="view">
        <div className="controls">
          <label className="field">capacity
            <select value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} data-testid="freelist-capacity-select">
              {CAPACITIES.map((c) => <option key={c} value={c}>{c} B</option>)}
            </select>
          </label>
          <label className="field">size
            <input type="number" min={0} max={1024} value={size} onChange={(e) => setSize(Math.max(0, Number(e.target.value) || 0))} data-testid="freelist-size-input" />
          </label>
          <button className="btn" onClick={() => apply({ kind: "alloc", size, addr: 0 })} data-testid="freelist-allocate-button">first-fit allocate</button>
          <button className="btn ghost" onClick={() => selectedAddr && apply({ kind: "free", addr: selectedAddr, ok: false })} disabled={!selectedAllocation} data-testid="freelist-free-button">free selected</button>
          <button className="btn ghost" onClick={runDemo} data-testid="freelist-demo-button">split / coalesce demo</button>
          <button className="btn ghost" onClick={() => apply({ kind: "reset" })} data-testid="freelist-reset-button">reset</button>
          <span className="spacer" />
          <span className="mono dim">first fit · address-ordered free list · 16 B header per block</span>
        </div>

        <div className="canvas-wrap">
          <canvas
            ref={canvasRef}
            style={{ width: "100%" }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHovered(freeListBlockAt(snap, e.clientX - rect.left, rect.width));
            }}
            onMouseLeave={() => setHovered(null)}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const index = freeListBlockAt(snap, e.clientX - rect.left, rect.width);
              setSelectedAddr(index === null ? null : allocationAt(snap, index));
            }}
            data-testid="freelist-canvas"
            aria-label="variable-size free-list memory layout"
          />
          <div className="hover-line mono" data-testid="freelist-hover">
            {hoveredBlock
              ? `${hoveredBlock.free ? "free" : "allocated"} block · offset ${hoveredBlock.offset} · ${hoveredBlock.size} B total${hoveredAllocation ? ` · payload ${snap.allocations.find((a) => a.addr === hoveredAllocation)?.size} B` : ""}`
              : "click an allocated block to free it · headers are orange"}
          </div>
        </div>

        <div className="free-list-chain mono" data-testid="freelist-chain">
          <span className="dim">free-list order: </span>
          {freeChain.length ? freeChain.map((item, i) => <span key={i}>{item} </span>) : <span className="accent">empty</span>}
        </div>

        <div className="scrub mono">
          <span className="dim">history</span>
          <input type="range" min={0} max={Math.max(snap.historyLength, 1)} value={snap.cursor} disabled={!snap.historyLength}
            onChange={(e) => { modelRef.current?.seek(Number(e.target.value)); setSelectedAddr(null); sync(); }}
            data-testid="freelist-scrubber" aria-label="replay free-list history" />
          <span data-testid="freelist-history-pos">{snap.cursor} / {snap.historyLength}</span>
        </div>

        <dl className="stats freelist-stats" data-testid="freelist-stats">
          <div><dt>used</dt><dd data-testid="freelist-stat-used">{snap.stats.usedBytes} / {snap.capacity} B</dd></div>
          <div><dt>free blocks</dt><dd data-testid="freelist-stat-count">{snap.stats.freeListLength}</dd></div>
          <div><dt>largest free payload</dt><dd data-testid="freelist-stat-largest">{snap.stats.largestFreeBlock} B</dd></div>
          <div><dt>failed</dt><dd>{snap.stats.failedAllocations}</dd></div>
        </dl>
      </div>
      <OpLog entries={log} cursor={snap.cursor} selectedBlock={null} onSelect={() => undefined} />
    </section>
  );
}
