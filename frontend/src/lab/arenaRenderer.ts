// arenaRenderer.ts — pure canvas drawing for the arena bar. Input: a snapshot + pointer offset +
// hover/selection; output: pixels. No React, no state, so it is trivially testable and the view can
// call it from a requestAnimationFrame loop while the bump pointer slides.
//
// Interview Q&A
// Q: Why canvas and not one <div> per block?  A: Hundreds of blocks at sub-pixel widths; canvas draws
//    them in one pass with exact proportional geometry and no layout thrash.
// Q: How is the hatch pattern made?  A: An 8x8 offscreen canvas with one diagonal line, used as a
//    repeating fillStyle — the standard way to get "blueprint" hatching without an image asset.
// Q: Why scale by devicePixelRatio?  A: Otherwise 1px hairlines blur on HiDPI screens; we draw in CSS
//    pixels after ctx.scale(dpr, dpr).
import type { ArenaBlock, ArenaSnapshot } from "./arenaModel";
import { hex } from "../wasm/loadAllocLab";

export interface Palette {
  bg: string; raised: string; line: string; fg: string; dim: string; accent: string; used: string; mono: string;
}

export function readPalette(el: HTMLElement): Palette {
  const s = getComputedStyle(el);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return { bg: v("--bg"), raised: v("--bg-raised"), line: v("--line"), fg: v("--fg"), dim: v("--fg-dim"),
    accent: v("--accent"), used: v("--used"), mono: v("--mono") };
}

export const BAR_TOP = 18;
export const BAR_HEIGHT = 56;
export const LABEL_ROW = 20;
export const CANVAS_HEIGHT = BAR_TOP + BAR_HEIGHT + LABEL_ROW * 2;

let hatchCache: { key: string; pattern: CanvasPattern } | null = null;
function hatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern {
  if (hatchCache?.key === color) return hatchCache.pattern;
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const h = c.getContext("2d")!;
  h.strokeStyle = color;
  h.lineWidth = 1;
  h.beginPath(); h.moveTo(0, 8); h.lineTo(8, 0); h.stroke();
  const pattern = ctx.createPattern(c, "repeat")!;
  hatchCache = { key: color, pattern };
  return pattern;
}

export interface DrawState {
  snap: ArenaSnapshot;
  pointerOffset: number;   // animated "used" value in bytes
  hovered: number | null;
  selected: number | null;
}

export function blockAt(snap: ArenaSnapshot, x: number, width: number): ArenaBlock | null {
  const offset = (x / width) * snap.capacity;
  for (const b of snap.blocks) {
    const start = b.addr - snap.base;
    if (offset >= start - b.padding && offset < start + b.size) return b;
  }
  return null;
}

export function drawArena(canvas: HTMLCanvasElement, state: DrawState, p: Palette) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(CANVAS_HEIGHT * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(CANVAS_HEIGHT * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, CANVAS_HEIGHT);

  const { snap } = state;
  const px = (bytes: number) => (bytes / snap.capacity) * (width - 1);
  const y = BAR_TOP, h = BAR_HEIGHT;

  ctx.fillStyle = p.raised;
  ctx.fillRect(0, y, width, h);

  for (const b of state.snap.blocks) {
    const start = b.addr - snap.base;
    if (b.padding > 0) {
      ctx.fillStyle = hatch(ctx, p.dim);
      ctx.fillRect(px(start - b.padding), y, Math.max(px(b.padding), 1), h);
    }
    const x0 = px(start), w = Math.max(px(b.size), 1);
    const isSel = state.selected === b.index, isHover = state.hovered === b.index;
    ctx.fillStyle = isSel ? p.accent : isHover ? p.fg : p.used;
    ctx.fillRect(x0, y, w, h);
    ctx.fillStyle = p.bg;
    ctx.fillRect(x0 + w - 1, y, 1, h);
    if (w > 44) {
      ctx.fillStyle = isSel ? p.bg : p.dim;
      ctx.font = `11px ${p.mono}`;
      ctx.textBaseline = "middle";
      ctx.fillText(`${b.size}`, x0 + 5, y + h / 2);
    }
  }

  ctx.strokeStyle = p.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, y + 0.5, width - 1, h - 1);

  // address ticks: base, every block start that has room, and end
  ctx.font = `10px ${p.mono}`;
  ctx.textBaseline = "top";
  let lastLabelEnd = -Infinity;
  const label = (bytes: number, text: string, color: string, row: number) => {
    const x = px(bytes);
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), y + h, 1, 5);
    const tw = ctx.measureText(text).width;
    const tx = Math.min(x + 2, width - tw);
    if (row === 0 && tx < lastLabelEnd + 6) return;
    ctx.fillText(text, tx, y + h + 7 + row * LABEL_ROW);
    if (row === 0) lastLabelEnd = tx + tw;
  };
  label(0, hex(snap.base), p.dim, 0);
  for (const b of snap.blocks) {
    const color = state.selected === b.index ? p.accent : p.dim;
    label(b.addr - snap.base, hex(b.addr), color, 0);
  }

  // bump pointer
  const bx = Math.round(px(state.pointerOffset)) + 0.5;
  ctx.strokeStyle = p.accent;
  ctx.beginPath(); ctx.moveTo(bx, y - 10); ctx.lineTo(bx, y + h + 4); ctx.stroke();
  ctx.fillStyle = p.accent;
  ctx.beginPath(); ctx.moveTo(bx - 4, y - 12); ctx.lineTo(bx + 4, y - 12); ctx.lineTo(bx, y - 6); ctx.closePath(); ctx.fill();
  const ptrText = `bump ${hex(snap.base + snap.used)}`;
  ctx.font = `10px ${p.mono}`;
  ctx.textBaseline = "top";
  const ptw = ctx.measureText(ptrText).width;
  ctx.fillText(ptrText, Math.min(Math.max(bx + 6, 0), width - ptw), 0);

  const freeText = `${snap.capacity - snap.used} B free`;
  const fx = px(snap.used);
  if (width - fx > ctx.measureText(freeText).width + 12) {
    ctx.fillStyle = p.dim;
    ctx.textBaseline = "middle";
    ctx.fillText(freeText, fx + 8, y + h / 2);
  }
}
