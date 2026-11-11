// SharedRunView.tsx — public, read-only page for a shared benchmark run (/share/:shareId). No sign-in
// needed: the backend exposes only label, n, device and results for runs that have a share_id.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API } from "../api";
import { deviceSummary, type SavedRun } from "../components/SavedRuns";
import { allocatorName, BENCH_WORKLOADS, nsPerOp } from "./CompareView";

export function SharedRunView() {
  const { shareId } = useParams();
  const [run, setRun] = useState<SavedRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/runs/shared/${shareId}`)
      .then(async (r) => { if (!r.ok) throw new Error(r.status === 404 ? "this shared run does not exist" : `error ${r.status}`); setRun((await r.json()) as SavedRun); })
      .catch((e) => setError(String(e.message ?? e)));
  }, [shareId]);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" data-testid="brand">ALLOCATOR LAB</Link>
        <span className="mono dim">shared benchmark run</span>
        <span className="spacer" />
        <Link to="/" className="btn ghost" data-testid="shared-open-lab">open the lab</Link>
      </header>
      <main className="lab" data-testid="shared-run-view">
        {error && <div className="notice" data-testid="shared-run-error">{error}</div>}
        {run && (
          <section className="view">
            <div className="controls mono">
              <span data-testid="shared-run-label">{run.label}</span>
              <span className="dim">· n = {run.n.toLocaleString()} · {deviceSummary(run.device)} · {new Date(run.created_at).toLocaleString()}</span>
            </div>
            <table className="bench mono" data-testid="shared-run-table">
              <thead><tr><th>workload</th><th>allocator</th><th className="num">ms</th><th className="num">ns/op</th><th className="num">vs new</th></tr></thead>
              <tbody>
                {BENCH_WORKLOADS.map((w) => {
                  const cells = run.results.filter((c) => c.workload === w.id);
                  const base = cells.find((c) => c.allocator === "new");
                  return cells.map((c, i) => (
                    <tr key={`${w.id}:${c.allocator}`}>
                      <td>{i === 0 ? w.label : ""}</td>
                      <td className={c.allocator === "new" ? "" : "accent"}>{allocatorName(c.allocator)}</td>
                      <td className="num">{c.ms.toFixed(2)}</td>
                      <td className="num">{nsPerOp(c).toFixed(1)}</td>
                      <td className="num">{base ? `${(nsPerOp(base) / nsPerOp(c)).toFixed(1)}×` : ""}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
            <p className="mono dim">measured in the browser with the real C++ allocators compiled to WebAssembly · "new/delete" inside wasm is Emscripten's malloc</p>
          </section>
        )}
      </main>
    </>
  );
}
