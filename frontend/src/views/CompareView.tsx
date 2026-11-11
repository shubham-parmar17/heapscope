// CompareView.tsx — the same workload on new/delete, Arena and Pool with LIVE timing bars: each
// run is split into 10 chunks so the bars grow while the allocator works, then the results table
// (ms, ns/op, speed-up) appears with "copy markdown" for the README.
//
// Interview Q&A
// Q: Why chunk the run instead of one call?  A: runBenchmark blocks the main thread; chunks give the
//    UI a chance to paint between them, which is what makes the bars "live".
// Q: Does chunking distort results?  A: Slightly — each chunk constructs its allocator; that cost is
//    the same for all rows and tiny next to the workload, and the native bench has no chunking.
// Q: Why bars relative to the slowest in each row group?  A: The question is "how much faster", so
//    the slowest allocator is the 100% reference per workload.
import { useCallback, useState } from "react";
import { loadAllocLab, type BenchAllocator, type BenchResult, type BenchWorkload } from "../wasm/loadAllocLab";
import { SavedRuns, type SavedRun } from "../components/SavedRuns";

const WORKLOADS: { id: BenchWorkload; label: string }[] = [
  { id: "small", label: "small-allocs (32 B)" },
  { id: "mixed", label: "mixed-sizes (16–256 B)" },
  { id: "churn", label: "churn (window 1024)" },
];
const ALLOCATORS: BenchAllocator[] = ["new", "arena", "pool", "freelist"];
const NS = [200_000, 1_000_000, 2_000_000];
const SAMPLE_COUNT = 3;

type Key = `${BenchWorkload}:${BenchAllocator}`;
type Cells = Partial<Record<Key, BenchResult>>;
export const nsPerOp = (r: { ms: number; ops: number }) => (r.ms * 1e6) / r.ops;
export const allocatorName = (a: string) => (a === "new" ? "new/delete" : a === "freelist" ? "first-fit list" : a);
const name = allocatorName;
export { WORKLOADS as BENCH_WORKLOADS, ALLOCATORS as BENCH_ALLOCATORS };

export function toMarkdown(cells: Cells, n: number): string {
  const lines = [`| workload (n=${n.toLocaleString()}) | allocator | median ms | range ms | ns/op | vs new/delete |`, "|---|---|---:|---:|---:|---:|"];
  for (const w of WORKLOADS) {
    const base = cells[`${w.id}:new`];
    for (const a of ALLOCATORS) {
      const r = cells[`${w.id}:${a}`];
      if (!r) continue;
      const range = r.minMs !== undefined && r.maxMs !== undefined ? (r.maxMs - r.minMs).toFixed(2) : "–";
      lines.push(`| ${w.label} | ${name(a)} | ${r.ms.toFixed(2)} | ${range} | ${nsPerOp(r).toFixed(1)} | ${base ? `${(nsPerOp(base) / nsPerOp(r)).toFixed(1)}×` : "–"} |`);
    }
  }
  return lines.join("\n");
}

export function CompareView() {
  const [n, setN] = useState(200_000);
  const [cells, setCells] = useState<Cells>({});
  const [running, setRunning] = useState<Key | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<SavedRun | null>(null);
  const onCompare = useCallback((r: SavedRun | null) => setCompareTo(r), []);
  const savedCell = (w: BenchWorkload, a: BenchAllocator) => compareTo?.results.find((c) => c.workload === w && c.allocator === a);

  const run = async () => {
    setCells({}); setError(null);
    try {
      const m = await loadAllocLab();
      const acc: Cells = {};
      for (const w of WORKLOADS) {
        for (const a of ALLOCATORS) {
          const key: Key = `${w.id}:${a}`;
          setRunning(key);
          // Warm up once, then time full-size samples so allocator setup isn't repeated per chunk.
          await new Promise((r) => setTimeout(r, 0));
          m.runBenchmark(a, w.id, Math.max(1, Math.floor(n / 10)));
          const samples: BenchResult[] = [];
          for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
            await new Promise((r) => setTimeout(r, 0));
            samples.push(m.runBenchmark(a, w.id, n));
            const ordered = [...samples].sort((x, y) => x.ms - y.ms);
            const median = ordered[Math.floor(ordered.length / 2)];
            acc[key] = { ...median, minMs: ordered[0].ms, maxMs: ordered[ordered.length - 1].ms };
            setCells({ ...acc });
          }
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(cells, n));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("clipboard unavailable — select the table and copy manually");
    }
  };

  const done = !running && Object.keys(cells).length === WORKLOADS.length * ALLOCATORS.length;

  return (
    <section className="view" data-testid="compare-view">
      <div className="controls">
        <label className="field">n
          <select value={n} onChange={(e) => { setN(Number(e.target.value)); setCells({}); }} disabled={!!running} data-testid="bench-n-select">
            {NS.map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
          </select>
        </label>
        <button className="btn" onClick={run} disabled={!!running} data-testid="bench-run-button">{running ? "running…" : "run workloads"}</button>
        <button className="btn ghost" onClick={copy} disabled={!done} data-testid="bench-copy-button">{copied ? "copied" : "copy markdown"}</button>
        <span className="spacer" />
        <span className="mono dim">wasm · 3 full-size samples, median shown · timer ≈0.1 ms resolution</span>
      </div>
      {error && <div className="notice" data-testid="bench-error">{error}</div>}

      <div className="bars mono" data-testid="bench-bars">
        {WORKLOADS.map((w) => {
          const group = ALLOCATORS.map((a) => cells[`${w.id}:${a}`]?.ms ?? 0);
          const max = Math.max(...group, 1e-9);
          return (
            <div className="bar-group" key={w.id}>
              <div className="bar-label dim">{w.label}</div>
              {ALLOCATORS.map((a, i) => {
                const r = cells[`${w.id}:${a}`];
                const active = running === `${w.id}:${a}`;
                return (
                  <div className="bar-row" key={a} data-testid={`bench-bar-${w.id}-${a}`}>
                    <span className={`bar-name${a === "new" ? "" : " accent"}`}>{name(a)}</span>
                    <div className="bar-track">
                      <div className={`bar-fill${a === "new" ? " base" : ""}${active ? " active" : ""}`} style={{ width: `${(group[i] / max) * 100}%` }} />
                    </div>
                    <span className="bar-value">{r ? `${r.ms.toFixed(1)} ms` : active ? "…" : ""}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <table className="bench mono" data-testid="bench-table">
        <thead><tr><th>workload</th><th>allocator</th><th className="num">ms</th><th className="num">ns/op</th><th className="num">resets</th><th className="num">vs new</th>
          {compareTo && <th className="num accent" data-testid="bench-saved-col">saved ns/op (saved ÷ now) · {compareTo.label}</th>}</tr></thead>
        <tbody>
          {WORKLOADS.map((w) => ALLOCATORS.map((a) => {
            const r = cells[`${w.id}:${a}`], base = cells[`${w.id}:new`];
            const sc = savedCell(w.id, a);
            const savedNs = sc ? (sc.ms * 1e6) / sc.ops : null;
            return (
              <tr key={`${w.id}:${a}`} data-testid={`bench-row-${w.id}-${a}`}>
                <td>{a === "new" ? w.label : ""}</td>
                <td className={a === "new" ? "" : "accent"}>{name(a)}</td>
                <td className="num" title={r && r.minMs !== undefined && r.maxMs !== undefined ? `sample range: ${r.minMs.toFixed(2)}–${r.maxMs.toFixed(2)} ms` : undefined}>{r ? r.ms.toFixed(2) : "–"}</td>
                <td className="num">{r ? nsPerOp(r).toFixed(1) : ""}</td>
                <td className="num">{r ? r.resets : ""}</td>
                <td className="num">{r && base ? `${(nsPerOp(base) / nsPerOp(r)).toFixed(1)}×` : ""}</td>
                {compareTo && (
                  <td className="num">{savedNs !== null ? `${savedNs.toFixed(1)}${r ? ` (${(savedNs / nsPerOp(r)).toFixed(2)}×)` : ""}` : "–"}</td>
                )}
              </tr>
            );
          }))}
        </tbody>
      </table>
      <SavedRuns cells={cells} n={n} done={done} compareTo={compareTo} onCompare={onCompare} />
    </section>
  );
}
