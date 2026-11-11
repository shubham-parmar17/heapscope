// ArenaView.tsx — controls + canvas + stats for the bump allocator. Owns an ArenaModel, a queue of
// pending workload ops (for step / run), the history scrubber, and a 150ms pointer animation
// (disabled under prefers-reduced-motion). Keyboard: space = step, r = reset.
//
// Interview Q&A
// Q: Where does the animation state live?  A: In a ref (pointerRef), not React state — a rAF loop
//    mutates it 60x/s and re-renders would be wasteful; React state only changes per operation.
// Q: What does "step" do when nothing is queued?  A: It applies one op from the current form
//    (size/align), so space-bar always does something predictable.
// Q: Why rebuild the model when capacity changes?  A: The wasm Arena's buffer is fixed at
//    construction; a new capacity is a new allocator (and we .delete() the old one).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArenaModel, describeOp, type ArenaBlock, type ArenaOp, type ArenaSnapshot } from "../lab/arenaModel";
import { blockAt, CANVAS_HEIGHT, drawArena, readPalette } from "../lab/arenaRenderer";
import { hex, loadAllocLab, type AllocLabModule } from "../wasm/loadAllocLab";
import { HexDump } from "../components/HexDump";
import { OpLog, type LogEntry } from "../components/OpLog";
import { reducedMotion, useLabKeys } from "../hooks/useLabKeys";
import { useThemeTick } from "../hooks/useTheme";

const ALIGNS = [1, 2, 4, 8, 16, 32, 64];
const CAPACITIES = [512, 1024, 4096, 16384];
const WORKLOAD_SIZES = [24, 7, 64, 13, 128, 48, 3, 96, 32, 200, 16, 56];

export function ArenaView() {
  const [m, setM] = useState<AllocLabModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState(1024);
  const [size, setSize] = useState(48);
  const [align, setAlign] = useState(16);
  const [snap, setSnap] = useState<ArenaSnapshot | null>(null);
  const [queue, setQueue] = useState<ArenaOp[]>([]);
  const [running, setRunning] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [lastOp, setLastOp] = useState<string>("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const themeTick = useThemeTick();

  const modelRef = useRef<ArenaModel | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const pointerRef = useRef({ from: 0, to: 0, start: 0 });
  const rafRef = useRef(0);

  useEffect(() => { loadAllocLab().then(setM).catch((e) => setLoadError(String(e))); }, []);

  useEffect(() => {
    if (!m) return;
    const model = new ArenaModel(m, capacity);
    modelRef.current = model;
    setSnap(model.snapshot());
    setSelected(null); setQueue([]); setLastOp(""); setLog([]);
    pointerRef.current = { from: 0, to: 0, start: 0 };
    return () => { model.dispose(); modelRef.current = null; };
  }, [m, capacity]);

  const refresh = useCallback(() => {
    const model = modelRef.current;
    if (!model) return;
    const s = model.snapshot();
    const cur = pointerRef.current;
    const now = performance.now();
    const elapsed = Math.min(1, (now - cur.start) / 150);
    const currentPos = cur.from + (cur.to - cur.from) * elapsed;
    pointerRef.current = { from: reducedMotion() ? s.used : currentPos, to: s.used, start: now };
    setSnap(s);
  }, []);

  const apply = useCallback((op: ArenaOp) => {
    const model = modelRef.current;
    if (!model) return;
    const done = model.apply(op);
    setLastOp(describeOp(done));
    const blockIndex = done.kind === "alloc" && done.addr ? model.snapshot().blocks.length - 1 : null;
    setLog((l) => [...l.slice(0, model.cursor - 1), { text: describeOp(done), blockIndex }]);
    setSelected(blockIndex);
    refresh();
  }, [refresh]);

  const step = useCallback(() => {
    if (queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest);
      apply(next);
    } else {
      apply({ kind: "alloc", size, align, addr: 0 });
    }
  }, [queue, apply, size, align]);

  const reset = useCallback(() => { setRunning(false); setQueue([]); apply({ kind: "reset" }); }, [apply]);

  const queueWorkload = () => {
    setQueue(WORKLOAD_SIZES.map((s, i) => ({ kind: "alloc", size: s, align: ALIGNS[(i * 3) % ALIGNS.length], addr: 0 })));
  };

  useEffect(() => {
    if (!running) return;
    if (!queue.length) { setRunning(false); return; }
    const t = setTimeout(step, reducedMotion() ? 40 : 180);
    return () => clearTimeout(t);
  }, [running, queue, step]);

  useLabKeys(rootRef, step, reset);

  // draw loop: redraw while the pointer is still sliding, then settle
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snap) return;
    const palette = readPalette(document.documentElement);
    const draw = () => {
      const cur = pointerRef.current;
      const t = Math.min(1, (performance.now() - cur.start) / 150);
      const eased = 1 - (1 - t) * (1 - t);
      drawArena(canvas, { snap, pointerOffset: cur.from + (cur.to - cur.from) * eased, hovered, selected }, palette);
      if (t < 1) rafRef.current = requestAnimationFrame(draw);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [snap, hovered, selected, themeTick]);

  const hit = (e: React.MouseEvent<HTMLCanvasElement>): ArenaBlock | null => {
    if (!snap) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    return blockAt(snap, e.clientX - rect.left, rect.width);
  };

  const selectedBlock = useMemo(() => snap?.blocks.find((b) => b.index === selected) ?? null, [snap, selected]);
  const hoveredBlock = snap?.blocks.find((b) => b.index === hovered) ?? null;

  if (loadError) return <div className="notice" data-testid="wasm-error">wasm load failed: {loadError}</div>;
  if (!m || !snap) return <div className="mono dim" data-testid="wasm-loading">loading alloclab.wasm…</div>;

  const st = snap.stats;
  const canScrub = snap.historyLength > 0;

  return (
    <section className="view-grid" data-testid="arena-view" ref={rootRef}>
      <div className="view">
      <div className="controls">
        <label className="field">capacity
          <select value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} data-testid="arena-capacity-select">
            {CAPACITIES.map((c) => <option key={c} value={c}>{c} B</option>)}
          </select>
        </label>
        <label className="field">size
          <input type="number" min={1} max={capacity} value={size} onChange={(e) => setSize(Math.max(1, Number(e.target.value) || 1))} data-testid="arena-size-input" />
        </label>
        <label className="field">align
          <select value={align} onChange={(e) => setAlign(Number(e.target.value))} data-testid="arena-align-select">
            {ALIGNS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => apply({ kind: "alloc", size, align, addr: 0 })} data-testid="arena-allocate-button">allocate</button>
        <span className="sep" />
        <button className="btn ghost" onClick={queueWorkload} disabled={queue.length > 0} data-testid="arena-workload-button">
          queue workload{queue.length ? ` (${queue.length})` : ""}
        </button>
        <button className="btn ghost" onClick={step} data-testid="arena-step-button" title="space">step</button>
        <button className="btn ghost" onClick={() => setRunning((r) => !r)} disabled={!queue.length} data-testid="arena-run-button">
          {running ? "pause" : "run"}
        </button>
        <button className="btn ghost" onClick={reset} data-testid="arena-reset-button" title="r">reset</button>
        <span className="spacer" />
        <span className="mono dim" data-testid="arena-last-op">{lastOp || "no operations yet"}</span>
      </div>

      <div className="canvas-wrap">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: CANVAS_HEIGHT }}
          onMouseMove={(e) => setHovered(hit(e)?.index ?? null)}
          onMouseLeave={() => setHovered(null)}
          onClick={(e) => setSelected(hit(e)?.index ?? null)}
          data-testid="arena-canvas"
          aria-label="arena memory bar"
        />
        <div className="hover-line mono" data-testid="arena-hover">
          {hoveredBlock
            ? `#${hoveredBlock.index} ${hex(hoveredBlock.addr)} · ${hoveredBlock.size} B · align ${hoveredBlock.align}${hoveredBlock.padding ? ` · ${hoveredBlock.padding} B padding before` : ""}`
            : "hover a block · click to inspect"}
        </div>
      </div>

      <div className="scrub mono">
        <span className="dim">history</span>
        <input
          type="range" min={0} max={Math.max(snap.historyLength, 1)} value={snap.cursor} disabled={!canScrub}
          onChange={(e) => { modelRef.current?.seek(Number(e.target.value)); setSelected(null); refresh(); }}
          data-testid="arena-scrubber" aria-label="replay history"
        />
        <span data-testid="arena-history-pos">{snap.cursor} / {snap.historyLength}</span>
      </div>

      <dl className="stats" data-testid="arena-stats">
        <div><dt>used</dt><dd data-testid="stat-used">{st.usedBytes} / {st.capacityBytes} B</dd></div>
        <div><dt>padding</dt><dd data-testid="stat-padding">{st.paddingBytes} B</dd></div>
        <div><dt>live</dt><dd>{st.liveAllocations}</dd></div>
        <div><dt>total</dt><dd>{st.totalAllocations}</dd></div>
        <div><dt>failed</dt><dd className={st.failedAllocations ? "accent" : ""}>{st.failedAllocations}</dd></div>
        <div><dt>peak</dt><dd>{st.peakBytes} B</dd></div>
        <div><dt>largest free</dt><dd>{st.largestFreeBlock} B</dd></div>
        <div><dt>bump ptr</dt><dd className="accent">{hex(snap.base + snap.used)}</dd></div>
      </dl>

      {selectedBlock && (
        <HexDump
          title={`block #${selectedBlock.index} · ${hex(selectedBlock.addr)} · ${selectedBlock.size} B · align ${selectedBlock.align}`}
          addr={selectedBlock.addr}
          size={selectedBlock.size}
          padding={selectedBlock.padding}
          read={(a, n) => modelRef.current!.bytes(a, n)}
        />
      )}
      </div>
      <OpLog entries={log} cursor={snap.cursor} selectedBlock={selected} onSelect={setSelected} />
    </section>
  );
}
