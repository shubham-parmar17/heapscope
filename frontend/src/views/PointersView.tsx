// PointersView.tsx — runs weakPtrDemo() in wasm and shows the control-block counts after every
// statement: SharedPtr lifecycle with a WeakPtr observer, then the strong-cycle leak vs the weak
// back-edge fix. Numbers come from the real SharedPtr/WeakPtr implementation, not a mock-up.
import { useEffect, useState } from "react";
import { loadAllocLab, type DemoStep, type WeakPtrDemo } from "../wasm/loadAllocLab";

function Steps({ title, steps, testid }: { title: string; steps: DemoStep[]; testid: string }) {
  return (
    <table className="bench mono" data-testid={testid}>
      <thead>
        <tr><th>{title}</th><th className="num">strong</th><th className="num">weak</th><th className="num">expired()</th><th className="num">objects alive</th></tr>
      </thead>
      <tbody>
        {steps.map((s, i) => (
          <tr key={i} data-testid={`${testid}-row-${i}`}>
            <td>{s.code}</td>
            <td className="num">{s.strong}</td>
            <td className="num">{s.weak}</td>
            <td className={`num${s.expired ? " accent" : ""}`}>{String(s.expired)}</td>
            <td className={`num${s.alive && s.strong === 0 ? " accent" : ""}`}>{s.alive}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PointersView() {
  const [demo, setDemo] = useState<WeakPtrDemo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAllocLab().then((m) => setDemo(m.weakPtrDemo())).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="notice" data-testid="wasm-error">wasm load failed: {error}</div>;
  if (!demo) return <div className="mono dim" data-testid="wasm-loading">loading alloclab.wasm…</div>;

  return (
    <section className="view" data-testid="pointers-view">
      <div className="controls mono dim">
        SharedPtr&lt;T&gt; / WeakPtr&lt;T&gt; · control block = {"{ atomic strong, atomic weak }"} · weak column shows observers only (the internal +1 is hidden)
      </div>
      <Steps title="lifecycle: observer outlives owner" steps={demo.lifecycle} testid="ptr-lifecycle" />
      <Steps title={`cycles: strong ↔ strong leaks ${demo.leaked} objects · weak back-edge frees both`} steps={demo.cycle} testid="ptr-cycle" />
      <table className="bench mono" data-testid="ptr-sizes">
        <thead><tr><th>make_shared layout (sizeof(T) = {demo.sizes.objectBytes} B, pointer = {demo.sizes.pointerBytes} B)</th><th className="num">allocations</th><th className="num">bytes</th></tr></thead>
        <tbody>
          <tr data-testid="ptr-sizes-separate"><td>SharedPtr&lt;T&gt;(new T) — SeparateBlock {"{vptr, strong, weak, T*}"} + T on its own</td><td className="num">2</td><td className="num">{demo.sizes.separateBlockBytes} + {demo.sizes.objectBytes} = {demo.sizes.separateBlockBytes + demo.sizes.objectBytes}</td></tr>
          <tr data-testid="ptr-sizes-inplace"><td className="accent">make_shared&lt;T&gt;() — InplaceBlock {"{vptr, strong, weak, T storage}"}</td><td className="num accent">1</td><td className="num accent">{demo.sizes.inplaceBlockBytes}</td></tr>
        </tbody>
      </table>
      <p className="mono dim ptr-note">
        lock() is a compare-exchange loop on strong: it only increments when the count is non-zero, so a WeakPtr can never resurrect an object whose last owner is mid-destruction.
      </p>
    </section>
  );
}
