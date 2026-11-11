// poolRenderer.ts — canvas grid of fixed-size blocks. Used cells are solid, free cells are outlined,
// and the free list is drawn as a chain of arrows through the free cells in list order (head first).
// The cell touched by the last pop/push flashes in the accent colour and fades over 150ms.
//
// Interview Q&A
// Q: Why draw the chain in list order rather than address order?  A: The chain IS the data
//    structure; after a few frees it zig-zags, which is exactly the LIFO behaviour worth seeing.
// Q: How is the grid sized?  A: Columns = floor(width / minCell), clamped to the block count; cells
//    are square, so the canvas height follows from the row count.
// Q: Why a progress parameter for the flash instead of a CSS animation?  A: Canvas has no CSS; the
//    view drives a rAF loop for 150ms and passes 0..1, which also respects prefers-reduced-motion.
import type { PoolSnapshot } from "./poolModel";
import type { Palette } from "./arenaRenderer";
import { hex } from "../wasm/loadAllocLab";

export interface PoolLayout { cols: number; rows: number; cell: number; gap: number; height: number }

export function layoutPool(count: number, width: number): PoolLayout {
  const gap = 3;
  const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (44 + gap))));
  const cell = Math.min(56, Math.floor((width - gap * (cols - 1)) / cols));
  const rows = Math.ceil(count / cols);
  return { cols, rows, cell, gap, height: rows * (cell + gap) - gap + 18 };
}

export function cellAt(layout: PoolLayout, count: number, x: number, y: number): number | null {
  const stride = layout.cell + layout.gap;
  const c = Math.floor(x / stride), r = Math.floor(y / stride);
  if (c < 0 || c >= layout.cols || x - c * stride > layout.cell || y - r * stride > layout.cell) return null;
  const i = r * layout.cols + c;
  return i < count ? i : null;
}

export interface WalkState { visited: number[]; current: number | null }
export interface PoolDrawState { snap: PoolSnapshot; hovered: number | null; selected: number | null; flash: number; walk?: WalkState }

export function drawPool(canvas: HTMLCanvasElement, state: PoolDrawState, p: Palette, layout: PoolLayout) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(layout.height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(layout.height * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, layout.height);

  const { snap } = state;
  const stride = layout.cell + layout.gap;
  const pos = (i: number) => ({ x: (i % layout.cols) * stride, y: Math.floor(i / layout.cols) * stride });
  const center = (i: number) => { const q = pos(i); return { x: q.x + layout.cell / 2, y: q.y + layout.cell / 2 }; };

  ctx.font = `10px ${p.mono}`;
  ctx.textBaseline = "top";
  for (let i = 0; i < snap.blockCount; i++) {
    const { x, y } = pos(i);
    const used = snap.used[i];
    const sel = state.selected === i, hov = state.hovered === i;
    ctx.fillStyle = used ? (sel ? p.accent : hov ? p.fg : p.used) : p.raised;
    ctx.fillRect(x, y, layout.cell, layout.cell);
    ctx.strokeStyle = sel ? p.accent : hov ? p.fg : p.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, layout.cell - 1, layout.cell - 1);
    if (layout.cell >= 30) {
      ctx.fillStyle = used ? (sel ? p.bg : p.bg) : p.dim;
      ctx.fillText(String(i), x + 4, y + 3);
    }
  }

  // free-list chain, head first
  const fl = snap.freeList;
  if (fl.length) {
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    for (let k = 0; k + 1 < fl.length; k++) {
      const a = center(fl[k]), b = center(fl[k + 1]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const tip = { x: b.x - Math.cos(ang) * 8, y: b.y - Math.sin(ang) * 8 };
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - Math.cos(ang - 0.5) * 5, tip.y - Math.sin(ang - 0.5) * 5);
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - Math.cos(ang + 0.5) * 5, tip.y - Math.sin(ang + 0.5) * 5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const h = pos(fl[0]);
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(h.x + 1, h.y + 1, layout.cell - 2, layout.cell - 2);
    ctx.fillStyle = p.accent;
    ctx.fillText("head", h.x + 4, h.y + layout.cell - 13);
  }

  // free-list walker: hops already taken are drawn solid, the current node is filled
  if (state.walk) {
    const { visited, current } = state.walk;
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 2;
    for (let k = 0; k + 1 < visited.length; k++) {
      const a = center(visited[k]), b = center(visited[k + 1]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const v of visited) {
      const { x, y } = pos(v);
      ctx.strokeRect(x + 1, y + 1, layout.cell - 2, layout.cell - 2);
    }
    if (current !== null) {
      const { x, y } = pos(current);
      ctx.fillStyle = p.accent;
      ctx.fillRect(x, y, layout.cell, layout.cell);
      ctx.fillStyle = p.bg;
      ctx.fillText(String(current), x + 4, y + 3);
    }
    ctx.lineWidth = 1;
  }

  // flash the cell from the last pop/push
  if (snap.lastEvent && state.flash < 1) {
    const { x, y } = pos(snap.lastEvent.index);
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.7 * (1 - state.flash);
    ctx.fillRect(x, y, layout.cell, layout.cell);
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = p.dim;
  ctx.fillText(`${hex(snap.base)} … ${hex(snap.base + snap.blockSize * snap.blockCount)} · ${snap.blockCount} × ${snap.blockSize} B`, 0, layout.height - 12);
}
