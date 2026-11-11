// freeListRenderer.ts — draws physical first-fit blocks, including each block's in-band header.
import type { FreeListSnapshot } from "./freeListModel";
import type { Palette } from "./arenaRenderer";

export function freeListBlockAt(snap: FreeListSnapshot, x: number, width: number): number | null {
  if (width <= 0) return null;
  const offset = (x / width) * snap.capacity;
  return snap.blocks.findIndex((block) => offset >= block.offset && offset < block.offset + block.size);
}

export function allocationAt(snap: FreeListSnapshot, index: number): number | null {
  const block = snap.blocks[index];
  if (!block || block.free) return null;
  const payloadAddr = snap.base + block.offset + snap.headerSize;
  return snap.allocations.find((a) => a.addr === payloadAddr)?.addr ?? null;
}

export function drawFreeList(
  canvas: HTMLCanvasElement,
  snap: FreeListSnapshot,
  hovered: number | null,
  selectedAddr: number | null,
  p: Palette,
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = 84;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const y = 20, h = 42;
  const px = (offset: number) => (offset / snap.capacity) * (width - 1);

  ctx.fillStyle = p.raised;
  ctx.fillRect(0, y, width, h);
  snap.blocks.forEach((block, index) => {
    const x0 = px(block.offset);
    const x1 = px(block.offset + block.size);
    const w = Math.max(1, x1 - x0);
    const addr = allocationAt(snap, index);
    const selected = addr !== null && addr === selectedAddr;
    const active = hovered === index;
    ctx.fillStyle = block.free ? p.raised : selected ? p.accent : active ? p.fg : p.used;
    ctx.fillRect(x0, y, w, h);

    const headerWidth = Math.min(w, Math.max(1, (snap.headerSize / snap.capacity) * (width - 1)));
    ctx.fillStyle = block.free ? p.accent : p.dim;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x0, y, headerWidth, h);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = active || selected ? p.fg : p.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(0, w - 1), h - 1);
    if (w > 58) {
      ctx.fillStyle = block.free ? p.fg : selected ? p.bg : p.bg;
      ctx.font = `10px ${p.mono}`;
      ctx.textBaseline = "middle";
      ctx.fillText(`${block.free ? "free" : "used"} ${block.size}B`, x0 + 4, y + h / 2);
    }
  });

  ctx.font = `10px ${p.mono}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = p.dim;
  ctx.fillText(`base ${snap.base.toString(16).padStart(8, "0")}`, 0, 2);
  const end = `end ${snap.capacity} B`;
  ctx.fillText(end, Math.max(0, width - ctx.measureText(end).width), 66);
}
