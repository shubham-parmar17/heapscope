// SavedRuns.tsx — signed-in users can save the current benchmark run (with the browser's device
// info) and pick a saved run to compare against, cell by cell, as ns/op and a ratio.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { API } from "../api";
import type { BenchResult } from "../wasm/loadAllocLab";

export interface RunCell { workload: string; allocator: string; ms: number; ops: number; resets: number }
export interface SavedRun {
  run_id: string; label: string; n: number; created_at: string; share_id?: string | null;
  device: { userAgent: string; platform: string; hardwareConcurrency: number | null; deviceMemory: number | null };
  results: RunCell[];
}

export function deviceInfo() {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  return {
    userAgent: navigator.userAgent,
    platform: nav.userAgentData?.platform ?? navigator.platform ?? "",
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
  };
}

export function deviceSummary(d: SavedRun["device"]): string {
  const browser = /Chrome\/(\d+)/.exec(d.userAgent)?.[0] ?? /Firefox\/(\d+)/.exec(d.userAgent)?.[0] ?? /Safari\/(\d+)/.exec(d.userAgent)?.[0] ?? "browser";
  return `${d.platform || "?"} · ${browser}${d.hardwareConcurrency ? ` · ${d.hardwareConcurrency} cores` : ""}${d.deviceMemory ? ` · ${d.deviceMemory} GB` : ""}`;
}

interface Props {
  cells: Record<string, BenchResult | undefined>;
  n: number;
  done: boolean;
  compareTo: SavedRun | null;
  onCompare: (run: SavedRun | null) => void;
}

export function SavedRuns({ cells, n, done, compareTo, onCompare }: Props) {
  const { user } = useAuth();
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const statusTimer = useRef<number>(0);
  const flash = (msg: string, ms = 2500) => {
    setStatus(msg);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), ms);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/runs`, { credentials: "include" });
      if (!res.ok) {
        flash(`load failed (${res.status})`);
        return;
      }
      setRuns((await res.json()) as SavedRun[]);
    } catch {
      flash("load failed (network error)");
    }
  }, []);

  useEffect(() => { if (user) load(); else { setRuns([]); onCompare(null); } }, [user, load, onCompare]);

  const save = async () => {
    const results: RunCell[] = Object.entries(cells).flatMap(([k, r]) => {
      if (!r) return [];
      const [workload, allocator] = k.split(":");
      return [{ workload, allocator, ms: r.ms, ops: r.ops, resets: r.resets }];
    });
    try {
      const res = await fetch(`${API}/runs`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || `run ${new Date().toLocaleString()}`, n, device: deviceInfo(), results }),
      });
      flash(res.ok ? "saved" : `save failed (${res.status})`);
      if (res.ok) {
        setLabel("");
        load();
      }
    } catch {
      flash("save failed (network error)");
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`${API}/runs/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        flash(`delete failed (${res.status})`);
        return;
      }
      if (compareTo?.run_id === id) onCompare(null);
      load();
    } catch {
      flash("delete failed (network error)");
    }
  };

  const share = async (id: string) => {
    try {
      const res = await fetch(`${API}/runs/${id}/share`, { method: "POST", credentials: "include" });
      if (!res.ok) { flash(`share failed (${res.status})`); return; }
      const { share_id } = (await res.json()) as { share_id: string };
      const url = `${window.location.origin}/share/${share_id}`;
      setShareUrl(url);
      try { await navigator.clipboard.writeText(url); flash("link copied"); } catch { flash("link ready"); }
      load();
    } catch {
      flash("share failed (network error)");
    }
  };

  if (!user) return <div className="mono dim" data-testid="runs-signin-hint">sign in with Google to save this run and compare it with runs from other machines</div>;

  return (
    <section className="saved-runs" data-testid="saved-runs">
      <div className="controls">
        <label className="field">label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. work laptop" maxLength={80} data-testid="run-label-input" />
        </label>
        <button className="btn" onClick={save} disabled={!done} data-testid="run-save-button">save run</button>
        {status && <span className="mono accent" data-testid="run-save-status">{status}</span>}
        {shareUrl && <a className="mono accent" href={shareUrl} target="_blank" rel="noreferrer" data-testid="run-share-url">{shareUrl}</a>}
        <span className="spacer" />
        <span className="mono dim">{deviceSummary(deviceInfo())}</span>
      </div>
      <table className="bench mono" data-testid="runs-table">
        <thead><tr><th>saved run</th><th>device</th><th className="num">n</th><th>date</th><th></th></tr></thead>
        <tbody>
          {runs.length === 0 && <tr><td colSpan={5} className="dim">no saved runs yet</td></tr>}
          {runs.map((r) => (
            <tr key={r.run_id} data-testid={`run-row-${r.run_id}`} className={compareTo?.run_id === r.run_id ? "selected" : ""}>
              <td>{r.label}</td>
              <td className="dim">{deviceSummary(r.device)}</td>
              <td className="num">{r.n.toLocaleString()}</td>
              <td className="dim">{new Date(r.created_at).toLocaleString()}</td>
              <td className="num">
                <button className="btn ghost" onClick={() => onCompare(compareTo?.run_id === r.run_id ? null : r)} data-testid={`run-compare-${r.run_id}`}>
                  {compareTo?.run_id === r.run_id ? "comparing" : "compare"}
                </button>{" "}
                <button className="btn ghost" onClick={() => share(r.run_id)} data-testid={`run-share-${r.run_id}`}>{r.share_id ? "copy link" : "share"}</button>{" "}
                <button className="btn ghost" onClick={() => remove(r.run_id)} data-testid={`run-delete-${r.run_id}`}>delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
