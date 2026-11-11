// HexDump.tsx — classic 16-bytes-per-row dump of a block read straight from wasm linear memory
// (HEAPU8). Rows are aligned to 16, so bytes before/after the block appear dimmed; padding bytes
// that precede the block get their own style so alignment waste is visible byte by byte.
//
// Interview Q&A
// Q: Where do the bytes come from?  A: Module.HEAPU8 — a Uint8Array view over the wasm Memory; the
//    address is an index into it. No copying across a boundary; it IS the allocator's memory.
// Q: Why cap at 256 bytes?  A: Readability; the header still tells you the full size.
// Q: Why re-read on every render instead of caching?  A: Memory growth replaces the HEAPU8 buffer,
//    and the arena may be scrubbed; always reading fresh is both simpler and correct.
import { hex } from "../wasm/loadAllocLab";

interface Props {
  title: string;
  addr: number;
  size: number;
  padding: number;
  read: (addr: number, length: number) => Uint8Array;
}

const MAX_BYTES = 256;

export function HexDump({ title, addr, size, padding, read }: Props) {
  const shown = Math.min(size, MAX_BYTES);
  const rowStart = Math.floor((addr - padding) / 16) * 16;
  const rowEnd = Math.ceil((addr + shown) / 16) * 16;
  const bytes = read(rowStart, rowEnd - rowStart);
  const rows: number[] = [];
  for (let r = rowStart; r < rowEnd; r += 16) rows.push(r);

  const cls = (a: number) => (a >= addr && a < addr + size ? "in" : a >= addr - padding && a < addr ? "pad" : "out");

  return (
    <section className="hexdump mono" data-testid="hexdump">
      <div className="hexdump-title">{title}{size > MAX_BYTES && <span className="dim"> · showing first {MAX_BYTES} B</span>}</div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <td className="dim">{hex(r)}</td>
              <td>
                {Array.from({ length: 16 }, (_, i) => (
                  <span key={i} className={`byte ${cls(r + i)}`}>{bytes[r + i - rowStart].toString(16).padStart(2, "0")}</span>
                ))}
              </td>
              <td className="ascii">
                {Array.from({ length: 16 }, (_, i) => {
                  const v = bytes[r + i - rowStart];
                  return <span key={i} className={cls(r + i)}>{v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "."}</span>;
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
