// ScriptView.tsx — workload editor: type an alloc/free script once, replay it step by step on the arena
// and the pool side by side. `alloc <size> [align]` allocates on both (pool ignores size/align — fixed
// blocks); `free <k>` frees the block returned by the k-th alloc (1-based) — a no-op on the arena,
// which is exactly the lesson; `reset` resets both. Space = step, r = reset.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArenaModel, describeOp } from "../lab/arenaModel";
import { PoolModel, describePoolOp } from "../lab/poolModel";
import { CANVAS_HEIGHT, drawArena, readPalette } from "../lab/arenaRenderer";
import { drawPool, layoutPool } from "../lab/poolRenderer";
import { loadAllocLab, type AllocLabModule } from "../wasm/loadAllocLab";
import { OpLog, type LogEntry } from "../components/OpLog";
import { reducedMotion, useLabKeys } from "../hooks/useLabKeys";
import { useThemeTick } from "../hooks/useTheme";

type Line = { kind: "alloc"; size: number; align: number } | { kind: "free"; ref: number } | { kind: "reset" };

export function parseScript(text: string): { lines: Line[]; errors: string[] } {
  const lines: Line[] = [], errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const t = raw.replace(/#.*$/, "").trim();
    if (!t) return;
    const [cmd, a, b] = t.split(/\s+/);
    if (cmd === "reset") lines.push({ kind: "reset" });
    else if (cmd === "alloc" && /^\d+$/.test(a ?? "")) {
      const align = b === undefined ? 16 : Number(b);
      if (!(align > 0 && (align & (align - 1)) === 0)) errors.push(`line ${i + 1}: align must be a power of two`);
      else lines.push({ kind: "alloc", size: Number(a), align });
    } else if (cmd === "free" && /^\d+$/.test(a ?? "")) lines.push({ kind: "free", ref: Number(a) });
    else errors.push(`line ${i + 1}: expected "alloc <size> [align]", "free <k>" or "reset"`);
  });
  return { lines, errors };
}

const DEFAULT = `# alloc <size> [align]
# free <k>  (k-th alloc)
# reset
alloc 48 16
alloc 7 1
alloc 100 64
free 2
alloc 24 8
free 1
free 3
alloc 64 32
reset
alloc 32 16`;

export function ScriptView() {
  const [m, setM] = useState<AllocLabModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState(DEFAULT);
  const [pc, setPc] = useState(0);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [tick, setTick] = useState(0);
  const themeTick = useThemeTick();
  const arenaRef = useRef<ArenaModel | null>(null);
  const poolRef = useRef<PoolModel | null>(null);
  const addrs = useRef<{ arena: number; pool: number }[]>([]);  // k-th alloc results
  const arenaCanvas = useRef<HTMLCanvasElement>(null);
  const poolCanvas = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const parsed = useMemo(() => parseScript(text), [text]);

  useEffect(() => { loadAllocLab().then(setM).catch((e) => setLoadError(String(e))); }, []);
  useEffect(() => {
    if (!m) return;
    arenaRef.current = new ArenaModel(m, 1024);
    poolRef.current = new PoolModel(m, 32, 16);
    setTick((t) => t + 1);
    return () => { arenaRef.current?.dispose(); poolRef.current?.dispose(); };
  }, [m]);

  const reset = useCallback(() => {
    setRunning(false); setPc(0); setLog([]); addrs.current = [];
    arenaRef.current?.apply({ kind: "reset" }); poolRef.current?.apply({ kind: "reset" });
    setTick((t) => t + 1);
  }, []);

  const step = useCallback(() => {
    const arena = arenaRef.current, pool = poolRef.current;
    if (!arena || !pool || pc >= parsed.lines.length) { setRunning(false); return; }
    const line = parsed.lines[pc];
    let text: string;
    if (line.kind === "alloc") {
      const a = arena.apply({ kind: "alloc", size: line.size, align: line.align, addr: 0 });
      const p = pool.apply({ kind: "alloc", addr: 0 });
      addrs.current.push({ arena: a.kind === "alloc" ? a.addr : 0, pool: p.kind === "alloc" ? p.addr : 0 });
      text = `#${addrs.current.length} arena ${describeOp(a)}\n   pool ${describePoolOp(p)}`;
    } else if (line.kind === "free") {
      const target = addrs.current[line.ref - 1];
      if (!target) text = `free ${line.ref}: no such allocation yet`;
      else {
        const p = target.pool ? pool.apply({ kind: "free", addr: target.pool, ok: false }) : null;
        text = `free #${line.ref} arena: no-op (cannot free)\n   pool ${p ? describePoolOp(p) : "nothing to free"}`;
      }
    } else {
      arena.apply({ kind: "reset" }); pool.apply({ kind: "reset" }); addrs.current = [];
      text = "reset()  both allocators";
    }
    setLog((l) => [...l, { text, blockIndex: null }]);
    setPc(pc + 1);
    setTick((t) => t + 1);
  }, [pc, parsed.lines]);

  useLabKeys(rootRef, step, reset);
  useEffect(() => {
    if (!running) return;
    if (pc >= parsed.lines.length) { setRunning(false); return; }
    const t = setTimeout(step, reducedMotion() ? 40 : 400);
    return () => clearTimeout(t);
  }, [running, pc, parsed.lines.length, step]);

  useEffect(() => {
    const arena = arenaRef.current, pool = poolRef.current, ac = arenaCanvas.current, pcv = poolCanvas.current;
    if (!arena || !pool || !ac || !pcv) return;
    const palette = readPalette(document.documentElement);
    const snapA = arena.snapshot(), snapP = pool.snapshot();
    const draw = () => {
      drawArena(ac, { snap: snapA, pointerOffset: snapA.used, hovered: null, selected: null }, palette);
      const layout = layoutPool(snapP.blockCount, pcv.clientWidth);
      pcv.style.height = `${layout.height}px`;
      drawPool(pcv, { snap: snapP, hovered: null, selected: null, flash: 1 }, palette, layout);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(ac); ro.observe(pcv);
    return () => ro.disconnect();
  }, [tick, themeTick]);

  if (loadError) return <div className="notice" data-testid="wasm-error">wasm load failed: {loadError}</div>;
  if (!m) return <div className="mono dim" data-testid="wasm-loading">loading alloclab.wasm…</div>;
  const a = arenaRef.current?.snapshot(), p = poolRef.current?.snapshot();

  return (
    <section className="view-grid" data-testid="script-view" ref={rootRef}>
      <div className="view">
        <div className="controls">
          <button className="btn" onClick={step} disabled={pc >= parsed.lines.length || parsed.errors.length > 0} data-testid="script-step-button" title="space">step</button>
          <button className="btn ghost" onClick={() => setRunning((r) => !r)} disabled={pc >= parsed.lines.length || parsed.errors.length > 0} data-testid="script-run-button">{running ? "pause" : "run"}</button>
          <button className="btn ghost" onClick={reset} data-testid="script-reset-button" title="r">reset</button>
          <span className="mono dim" data-testid="script-pc">line {pc} / {parsed.lines.length}</span>
          <span className="spacer" />
          <span className="mono dim">arena 1024 B · pool 16 × 32 B</span>
        </div>
        <div className="script-grid">
          <textarea className="script mono" value={text} onChange={(e) => { setText(e.target.value); reset(); }} spellCheck={false} rows={12} data-testid="script-textarea" aria-label="workload script" />
          <div className="view">
            {parsed.errors.length > 0 && <div className="notice" data-testid="script-errors">{parsed.errors.join(" · ")}</div>}
            <div className="canvas-wrap">
              <div className="mono dim">arena · used {a?.used ?? 0} / 1024 B · padding {a?.stats.paddingBytes ?? 0} B</div>
              <canvas ref={arenaCanvas} style={{ height: CANVAS_HEIGHT }} data-testid="script-arena-canvas" aria-label="arena" />
            </div>
            <div className="canvas-wrap">
              <div className="mono dim">pool · used {p?.stats.liveAllocations ?? 0} / 16 · free list {p?.stats.freeListLength ?? 16} · largest free run {p?.largestFreeRun ?? 16}</div>
              <canvas ref={poolCanvas} data-testid="script-pool-canvas" aria-label="pool" />
            </div>
          </div>
        </div>
      </div>
      <OpLog entries={log} cursor={log.length} selectedBlock={null} onSelect={() => undefined} />
    </section>
  );
}
