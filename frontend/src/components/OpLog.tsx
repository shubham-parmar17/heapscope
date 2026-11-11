// OpLog.tsx — scrolling operation log. Each entry is the exact call and result (e.g.
// `alloc(48, align 16) -> 0x00011860`); entries past the scrub cursor are dimmed ("future"),
// clicking an entry highlights its block in the view. Auto-scrolls to the newest entry.
import { useEffect, useRef } from "react";

export interface LogEntry { text: string; blockIndex: number | null }

interface Props {
  entries: LogEntry[];
  cursor: number;
  selectedBlock: number | null;
  onSelect: (blockIndex: number | null) => void;
}

export function OpLog({ entries, cursor, selectedBlock, onSelect }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [entries.length, cursor]);

  return (
    <aside className="oplog mono" data-testid="op-log" aria-label="operation log">
      <div className="oplog-title">operation log <span className="dim">· {entries.length}</span></div>
      <ol>
        {entries.map((e, i) => {
          const future = i >= cursor;
          const active = e.blockIndex !== null && e.blockIndex === selectedBlock && !future;
          return (
            <li key={i}>
              <button
                className={`oplog-row${future ? " future" : ""}${active ? " active" : ""}`}
                onClick={() => onSelect(e.blockIndex)}
                disabled={future || e.blockIndex === null}
                data-testid={`op-log-entry-${i}`}
              >
                <span className="dim">{String(i + 1).padStart(3, " ")}</span> {e.text}
              </button>
            </li>
          );
        })}
        {entries.length === 0 && <li className="dim oplog-empty">no operations yet — allocate or press space</li>}
      </ol>
      <div ref={endRef} />
    </aside>
  );
}
