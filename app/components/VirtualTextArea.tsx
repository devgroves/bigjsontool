"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type UIEvent,
} from "react";

const LINE_HEIGHT = 20;
// Remote mode renders fixed-width "rows" of this many characters — a
// synthetic wrap point, not a real line break. This is what makes windowing
// work for minified JSON: a real newline-delimited "line" can BE the whole
// multi-GB file, so counting/fetching by line is meaningless there. A fixed
// character count has no such degenerate case, and it's also a byte-offset
// seek server-side (O(1)) rather than a scan (O(n)).
const ROW_CHARS = 200;

interface VirtualTextAreaProps {
  value: string;
  onChange: (next: string) => void;
  /** When set, rows are fetched from /api/file-chars on demand instead of
   *  being derived from `value` locally. Only the current viewport's worth
   *  of characters is ever held in memory. Remote mode is read-only —
   *  there's no write-back path to persist edits to the server-side file. */
  fileId?: string | null;
}

/**
 * Renders text the same way JsonTreeView renders JSON trees: split into
 * fixed-size chunks, then only mount the handful currently in the viewport
 * (+ overscan), absolutely positioned inside a spacer div sized to the
 * total row count. In local mode rows come from splitting `value` on
 * newlines (fine for small/pasted content); in remote mode rows are fixed-
 * width character windows fetched from the server as the user scrolls,
 * with old windows dropped rather than accumulated — this is what keeps a
 * multi-GB file, minified or not, from ever being held as one string.
 */
export default function VirtualTextArea({ value, onChange, fileId = null }: VirtualTextAreaProps) {
  // ---- Local mode: unchanged, newline-delimited — fine for small content
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (fileId) return;
    const id = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(id);
  }, [value, fileId]);
  const localLines = useMemo(() => (fileId ? [] : debounced.split("\n")), [debounced, fileId]);
  const isStale = !fileId && debounced !== value;

  // ---- Remote mode: fixed-width character rows, fetched by byte offset --
  const [remoteRows, setRemoteRows] = useState<Map<number, string>>(new Map());
  const [totalBytes, setTotalBytes] = useState(0);
  const fetchedRangeRef = useRef<{ start: number; end: number } | null>(null);

  const fetchWindow = useCallback(
    (startRow: number, endRow: number) => {
      if (!fileId) return;
      const charStart = startRow * ROW_CHARS;
      const charLength = Math.max(1, (endRow - startRow) * ROW_CHARS);
      fetch(`/api/file-chars?id=${encodeURIComponent(fileId)}&start=${charStart}&length=${charLength}`)
        .then((res) => res.json())
        .then((body) => {
          if (body.error) return;
          const text: string = body.text ?? "";
          const next = new Map<number, string>();
          for (let r = startRow; r < endRow; r++) {
            const offset = (r - startRow) * ROW_CHARS;
            if (offset >= text.length) break;
            next.set(r, text.slice(offset, offset + ROW_CHARS));
          }
          setRemoteRows(next);
          fetchedRangeRef.current = { start: startRow, end: endRow };
          if (typeof body.totalBytes === "number") setTotalBytes(body.totalBytes);
        })
        .catch(() => {
          // Best-effort viewer — leave the previous window in place on failure.
        });
    },
    [fileId]
  );

  // Bootstrap: as soon as we have a fileId, fetch a first window
  // unconditionally. This is required, not just a nice-to-have — rowCount
  // is derived from `totalBytes`, which starts at 0 and is only ever set
  // by this very fetch's response. Without an unconditional first call,
  // the scroll-driven effect below computes rowCount=0 → endIndex=0 →
  // bails out before ever fetching → totalBytes never arrives → permanent
  // deadlock, and the pane never loads anything.
  useEffect(() => {
    if (!fileId) return;
    fetchedRangeRef.current = null;
    setRemoteRows(new Map());
    setTotalBytes(0);
    fetchWindow(0, 20); // a reasonable default first screen
  }, [fileId, fetchWindow]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setViewportHeight(entries[0].contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const overscan = 20;
  // totalBytes is used as a stand-in for total characters — exact for
  // ASCII-heavy JSON (the common case), approximate otherwise.
  const rowCount = fileId ? Math.ceil(totalBytes / ROW_CHARS) : localLines.length;
  const totalHeight = rowCount * LINE_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - overscan);
  // Before the first fetch resolves in remote mode, rowCount is 0 (totalBytes
  // isn't known yet). Clamping endIndex to rowCount in that state would make
  // endIndex always 0 — which makes the "already covered" check below look
  // satisfied forever, and the bootstrap fetch that would *tell us*
  // totalBytes never fires. So: don't clamp until we actually know the total.
  const rawEndIndex = Math.ceil((scrollTop + viewportHeight) / LINE_HEIGHT) + overscan;
  const endIndex = fileId
    ? (totalBytes > 0 ? Math.min(rowCount, rawEndIndex) : rawEndIndex)
    : Math.min(localLines.length, rawEndIndex);

  // Debounced: whenever the visible window moves outside what we already
  // fetched, ask the server for exactly the new character range. Old rows
  // are replaced, not merged — bounded memory over perfect cache reuse.
  useEffect(() => {
    if (!fileId || endIndex <= startIndex) return;
    const covered = fetchedRangeRef.current;
    if (covered && startIndex >= covered.start && endIndex <= covered.end) return;

    const id = setTimeout(() => fetchWindow(startIndex, endIndex), 100);
    return () => clearTimeout(id);
  }, [fileId, startIndex, endIndex, fetchWindow]);

  const getRowText = useCallback(
    (rowIndex: number) => (fileId ? remoteRows.get(rowIndex) : localLines[rowIndex]),
    [fileId, remoteRows, localLines]
  );

  const commitLocalLines = useCallback(
    (nextLines: string[]) => onChange(nextLines.join("\n")),
    [onChange]
  );

  const handleLineChange = useCallback(
    (lineIndex: number, e: ChangeEvent<HTMLInputElement>) => {
      if (fileId) return; // remote mode is read-only
      const next = localLines.slice();
      next[lineIndex] = e.target.value;
      commitLocalLines(next);
    },
    [fileId, localLines, commitLocalLines]
  );

  const handleLineKeyDown = useCallback(
    (lineIndex: number, e: KeyboardEvent<HTMLInputElement>) => {
      if (fileId) return; // remote mode is read-only
      const el = e.currentTarget;

      if (e.key === "Enter") {
        e.preventDefault();
        const pos = el.selectionStart ?? el.value.length;
        const before = el.value.slice(0, pos);
        const after = el.value.slice(pos);
        const next = localLines.slice();
        next.splice(lineIndex, 1, before, after);
        commitLocalLines(next);
        return;
      }

      if (e.key === "Backspace" && (el.selectionStart ?? 0) === 0 && lineIndex > 0) {
        e.preventDefault();
        const next = localLines.slice();
        const merged = next[lineIndex - 1] + next[lineIndex];
        next.splice(lineIndex - 1, 2, merged);
        commitLocalLines(next);
      }
    },
    [fileId, localLines, commitLocalLines]
  );

  const gutterWidth = fileId ? 90 : Math.max(40, String(rowCount).length * 9 + 20);

  const visibleIndices: number[] = [];
  for (let i = startIndex; i < endIndex; i++) visibleIndices.push(i);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="vta-scroll"
      style={{ height: "100%", width: "100%", overflow: "auto", position: "relative" }}
    >
      {fileId && (
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            fontSize: 11,
            color: "var(--jt-linenum, #6b7078)",
            padding: "4px 10px",
            background: "var(--jt-editor-bg, #1e1e1e)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          Read-only preview — {ROW_CHARS} chars/row, fetched from server as you scroll
        </div>
      )}
      <div style={{ height: totalHeight, position: "relative", opacity: isStale ? 0.6 : 1 }}>
        {visibleIndices.map((rowIndex) => {
          const rowText = getRowText(rowIndex);
          const loaded = rowText !== undefined;
          return (
            <div
              key={rowIndex}
              style={{
                position: "absolute",
                top: rowIndex * LINE_HEIGHT,
                left: 0,
                right: 0,
                height: LINE_HEIGHT,
                display: "flex",
                alignItems: "center",
              }}
            >
              <span
                className="vta-gutter"
                style={{
                  width: gutterWidth,
                  flexShrink: 0,
                  textAlign: "right",
                  paddingRight: 10,
                  color: "var(--jt-linenum, #6b7078)",
                  userSelect: "none",
                  fontFamily:
                    "var(--jt-mono-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
                  fontSize: 12,
                }}
              >
                {fileId ? rowIndex * ROW_CHARS : rowIndex + 1}
              </span>
              <input
                className="vta-line"
                value={loaded ? rowText! : "…"}
                readOnly={!!fileId}
                spellCheck={false}
                onChange={(e) => handleLineChange(rowIndex, e)}
                onKeyDown={(e) => handleLineKeyDown(rowIndex, e)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: "100%",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: loaded
                    ? "var(--jt-editor-fg, #d4d4d4)"
                    : "var(--jt-linenum, #6b7078)",
                  fontFamily:
                    "var(--jt-mono-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
                  fontSize: 13,
                  padding: 0,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
