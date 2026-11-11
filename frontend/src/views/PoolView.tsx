// PoolView.tsx — controls + grid + stats + log for the fixed-block pool. Click a used block to select
// it, "free selected" pushes it back on the free list; the hexdump of a FREE block shows the
// little-endian `next` pointer in its first 4 bytes. Space = step, r = reset.
//
// Interview Q&A
// Q: What does "queue workload" do here?  A: Queues intents (alloc / free-random); a free intent is
//    resolved at step time against the blocks that are actually used then, so replay stays valid.
// Q: Why can the pool run out?  A: Fixed capacity by design; alloc() returns nullptr and the log
//    says "exhausted" — the stats row counts it under failed.
// Q: What is largest free run?  A: The longest stretch of adjacent free blocks; low values with many
//    free blocks = external fragmentation (checkerboard).
import { useCallback, useEffect, useRef, useState } from "react";
import { describePoolOp, PoolModel, type PoolOp, type PoolSnapshot } from "../lab/poolModel";
import { readPalette } from "../lab/arenaRenderer";
import { cellAt, drawPool, layoutPool, type WalkState } from "../lab/poolRenderer";
import { hex, loadAllocLab, type AllocLabModule } from "../wasm/loadAllocLab";
import { HexDump } from "../components/HexDump";
import { OpLog, type LogEntry } from "../components/OpLog";
import { Sparkline } from "../components/Sparkline";
import { reducedMotion, useLabKeys } from "../hooks/useLabKeys";
import { useThemeTick } from "../hooks/useTheme";

type Intent = "alloc" | "free";
const BLOCK_SIZES = [16, 32, 64, 128];
const BLOCK_COUNTS = [16, 32, 64, 128];
const WORKLOAD: Intent[] = ["alloc", "alloc", "alloc", "alloc", "alloc", "alloc", "free", "alloc", "free", "free", "alloc", "alloc", "free", "alloc", "free", "alloc"];

export function PoolView() {
  const [m, setM] = useState<AllocLabModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blockSize, setBlockSize] = useState(32);
  const [blockCount, setBlockCount] = useState(32);
  const [snap, setSnap] = useState<PoolSnapshot | null>(null);
  const [queue, setQueue] = useState<Intent[]>([]);
  const [running, setRunning] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [runSeries, setRunSeries] = useState<number[]>([]);   // largest free run after op i (index 0 = initial)
  const [walk, setWalk] = useState<WalkState | null>(null);
  const themeTick = useThemeTick();

  const modelRef = useRef<PoolModel | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const rafRef = useRef(0);
  const seedRef = useRef(7);

  useEffect(() => { loadAllocLab().then(setM).catch((e) => setLoadError(String(e))); }, []);

  useEffect(() => {
    if (!m) return;
    const model = new PoolModel(m, blockSize, blockCount);
    modelRef.current = model;
    setSnap(model.snapshot()); setSelected(null); setQueue([]); setLog([]); setWalk(null);
    setRunSeries([model.snapshot().largestFreeRun]);
    return () => { model.dispose(); modelRef.current = null; };
  }, [m, blockSize, blockCount]);

  const refresh = useCallback(() => {
    const model = modelRef.current;
    if (model) setSnap(model.snapshot());
  }, []);

  const apply = useCallback((op: PoolOp) => {
    const model = modelRef.current;
    if (!model) return;
    const done = model.apply(op);
    const blockIndex = done.kind === "reset" || !done.addr ? null : model.indexOf(done.addr);
    setLog((l) => [...l.slice(0, model.cursor - 1), { text: describePoolOp(done), blockIndex }]);
    setRunSeries((s) => [...s.slice(0, model.cursor), model.snapshot().largestFreeRun]);
    setWalk(null);
    setSelected(done.kind === "alloc" && done.addr ? blockIndex : null);
    refresh();
  }, [refresh]);

  const resolve = useCallback((intent: Intent): PoolOp => {
    const model = modelRef.current!;
    if (intent === "free") {
      const used = model.usedIndices();
      if (used.length) {
        seedRef.current = (seedRef.current * 1103515245 + 12345) & 0x7fffffff;
        return { kind: "free", addr: model.addrOf(used[seedRef.current % used.length]), ok: false };
      }
    }
    return { kind: "alloc", addr: 0 };
  }, []);

  const step = useCallback(() => {
    if (queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest);
      apply(resolve(next));
    } else {
      apply({ kind: "alloc", addr: 0 });
    }
  }, [queue, apply, resolve]);

  const reset = useCallback(() => { setRunning(false); setQueue([]); apply({ kind: "reset" }); }, [apply]);
  const freeSelected = () => {
    if (selected === null || !modelRef.current) return;
    apply({ kind: "free", addr: modelRef.current.addrOf(selected), ok: false });
  };

  useLabKeys(rootRef, step, reset);

  // free-list walker: one hop every 350ms, following the actual `next` pointer bytes in memory
  const startWalk = () => {
    if (!snap) return;
    setSelected(null);
    setWalk({ visited: [], current: snap.freeList.length ? snap.freeList[0] : null });
  };
  useEffect(() => {
    if (!walk || walk.current === null || !modelRef.current) return;
    const model = modelRef.current;
    const t = setTimeout(() => {
      const cur = walk.current!;
      const b = model.bytes(model.addrOf(cur), 4);
      const next = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
      const visited = [...walk.visited, cur];
      setWalk({ visited, current: next ? model.indexOf(next) : null });
    }, reducedMotion() ? 120 : 350);
    return () => clearTimeout(t);
  }, [walk]);

  const walkText = (() => {
    if (!walk || !modelRef.current) return null;
    const model = modelRef.current;
    const cur = walk.current;
    if (cur === null) return `hop ${walk.visited.length}: next = 0x00000000 (nullptr) — end of free list, ${walk.visited.length} nodes`;
    const b = model.bytes(model.addrOf(cur), 4);
    const next = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    return `hop ${walk.visited.length}: node @${hex(model.addrOf(cur))} (block #${cur}) · bytes ${Array.from(b, (v) => v.toString(16).padStart(2, "0")).join(" ")} → next = ${hex(next)}${next ? ` (block #${model.indexOf(next)})` : " (nullptr)"}`;
  })();

  useEffect(() => {
    if (!running) return;
    if (!queue.length) { setRunning(false); return; }
    const t = setTimeout(step, reducedMotion() ? 40 : 220);
    return () => clearTimeout(t);
  }, [running, queue, step]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snap) return;
    const palette = readPalette(document.documentElement);
    const draw = () => {
      const layout = layoutPool(snap.blockCount, canvas.clientWidth);
      canvas.style.height = `${layout.height}px`;
      const flash = snap.lastEvent && !reducedMotion() ? Math.min(1, (performance.now() - snap.lastEvent.at) / 150) : 1;
      drawPool(canvas, { snap, hovered, selected, flash, walk: walk ?? undefined }, palette, layout);
      if (flash < 1) rafRef.current = requestAnimationFrame(draw);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [snap, hovered, selected, themeTick, walk]);

  const hit = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    if (!snap) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    return cellAt(layoutPool(snap.blockCount, rect.width), snap.blockCount, e.clientX - rect.left, e.clientY - rect.top);
  };

  if (loadError) return <div className="notice" data-testid="wasm-error">wasm load failed: {loadError}</div>;
  if (!m || !snap) return <div className="mono dim" data-testid="wasm-loading">loading alloclab.wasm…</div>;

  const st = snap.stats;
  const model = modelRef.current!;
  const headAddr = snap.freeList.length ? hex(model.addrOf(snap.freeList[0])) : "nullptr";
  const hovText = hovered !== null
    ? `#${hovered} ${hex(model.addrOf(hovered))} · ${snap.used[hovered] ? "used" : `free · list position ${snap.freeList.indexOf(hovered)}`}`
    : "hover a block · click to inspect";

  return (
    <section className="view-grid" data-testid="pool-view" ref={rootRef}>
      <div className="view">
        <div className="controls">
          <label className="field">block size
            <select value={blockSize} onChange={(e) => setBlockSize(Number(e.target.value))} data-testid="pool-blocksize-select">
              {BLOCK_SIZES.map((b) => <option key={b} value={b}>{b} B</option>)}
            </select>
          </label>
          <label className="field">blocks
            <select value={blockCount} onChange={(e) => setBlockCount(Number(e.target.value))} data-testid="pool-blockcount-select">
              {BLOCK_COUNTS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <button className="btn" onClick={() => apply({ kind: "alloc", addr: 0 })} data-testid="pool-allocate-button">allocate</button>
          <button className="btn ghost" onClick={freeSelected} disabled={selected === null || !snap.used[selected]} data-testid="pool-free-button">
            free {selected !== null && snap.used[selected] ? `#${selected}` : "selected"}
          </button>
          <span className="sep" />
          <button className="btn ghost" onClick={() => setQueue(WORKLOAD)} disabled={queue.length > 0} data-testid="pool-workload-button">
            queue workload{queue.length ? ` (${queue.length})` : ""}
          </button>
          <button className="btn ghost" onClick={step} data-testid="pool-step-button" title="space">step</button>
          <button className="btn ghost" onClick={() => setRunning((r) => !r)} disabled={!queue.length} data-testid="pool-run-button">{running ? "pause" : "run"}</button>
          <button className="btn ghost" onClick={reset} data-testid="pool-reset-button" title="r">reset</button>
          <span className="sep" />
          <button className="btn ghost" onClick={startWalk} disabled={!snap.freeList.length || (walk !== null && walk.current !== null)} data-testid="pool-walk-button">
            {walk && walk.current !== null ? "walking…" : "walk free list"}
          </button>
        </div>

        <div className="canvas-wrap">
          <canvas
            ref={canvasRef}
            style={{ width: "100%" }}
            onMouseMove={(e) => setHovered(hit(e))}
            onMouseLeave={() => setHovered(null)}
            onClick={(e) => setSelected(hit(e))}
            data-testid="pool-canvas"
            aria-label="pool block grid"
          />
          <div className="hover-line mono" data-testid="pool-hover">{walk && (walk.current !== null || hovered === null) ? walkText : hovText}</div>
        </div>

        <div className="scrub mono">
          <span className="dim">history</span>
          <input type="range" min={0} max={Math.max(snap.historyLength, 1)} value={snap.cursor} disabled={!snap.historyLength}
            onChange={(e) => { model.seek(Number(e.target.value)); setSelected(null); setWalk(null); refresh(); }}
            data-testid="pool-scrubber" aria-label="replay history" />
          <span data-testid="pool-history-pos">{snap.cursor} / {snap.historyLength}</span>
        </div>

        <dl className="stats" data-testid="pool-stats">
          <div><dt>used</dt><dd data-testid="pool-stat-used">{st.liveAllocations} / {snap.blockCount}</dd></div>
          <div><dt>free list</dt><dd data-testid="pool-stat-freelist">{st.freeListLength}</dd></div>
          <div><dt>largest free run</dt><dd data-testid="pool-stat-run">{snap.largestFreeRun} <Sparkline values={runSeries} cursor={snap.cursor} max={snap.blockCount} testid="pool-run-sparkline" /></dd></div>
          <div><dt>bytes</dt><dd>{st.usedBytes} / {st.capacityBytes}</dd></div>
          <div><dt>peak</dt><dd>{st.peakBytes} B</dd></div>
          <div><dt>total / freed</dt><dd>{st.totalAllocations} / {st.totalDeallocations}</dd></div>
          <div><dt>failed</dt><dd className={st.failedAllocations ? "accent" : ""}>{st.failedAllocations}</dd></div>
          <div><dt>head</dt><dd className="accent" data-testid="pool-stat-head">{headAddr}</dd></div>
        </dl>

        {selected !== null && (
          <HexDump
            title={`block #${selected} · ${hex(model.addrOf(selected))} · ${snap.blockSize} B · ${snap.used[selected] ? "used" : "free — first 4 bytes = next pointer (little-endian)"}`}
            addr={model.addrOf(selected)} size={snap.blockSize} padding={0}
            read={(a, n) => model.bytes(a, n)}
          />
        )}
      </div>
      <OpLog entries={log} cursor={snap.cursor} selectedBlock={selected} onSelect={setSelected} />
    </section>
  );
}
