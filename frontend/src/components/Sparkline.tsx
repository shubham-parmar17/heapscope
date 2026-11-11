// Sparkline.tsx — tiny inline SVG line chart (no library) for a per-operation series such as the
// pool's largest free run. The point at `cursor` is marked so scrubbing history moves the marker.
interface Props { values: number[]; cursor: number; max: number; testid?: string }

export function Sparkline({ values, cursor, max, testid }: Props) {
  const W = 120, H = 26, pad = 2;
  const n = Math.max(values.length, 2);
  const x = (i: number) => pad + (i / (n - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - (max > 0 ? (v / max) * (H - 2 * pad) : 0);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ci = Math.min(Math.max(cursor, 0), values.length - 1);
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} data-testid={testid} aria-hidden="true">
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="spark-axis" />
      {values.length > 1 && <polyline points={points} className="spark-line" />}
      {values.length > 0 && <circle cx={x(ci)} cy={y(values[ci])} r={2.5} className="spark-dot" />}
    </svg>
  );
}
