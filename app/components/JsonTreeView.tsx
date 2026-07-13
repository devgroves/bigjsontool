"use client";

import type React from "react";
import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  memo,
} from "react";
import Spinner from "./Spinner";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Server-sent stand-in for a container whose contents weren't sent yet.
 *  Field names are deliberately unusual so they can't collide with real
 *  JSON data. See app/api/json-level/route.ts for the producing side. */
interface TruncatedMarker {
  __truncated__: true;
  __kind__: "object" | "array";
  __count__: number;
}

function isTruncatedMarker(v: JsonValue): v is TruncatedMarker & JsonValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>).__truncated__ === true
  );
}

/** Mirrors the common `collapsed` prop shape: depth number, true/false, or
 *  a custom per-node predicate ("function" mode). */
type CollapsedSetting = number | boolean | "function";

interface JsonTreeViewProps {
  /** Raw JSON text. Used when `fileId` is not set — parsed locally, same
   *  as before. */
  source: string;
  /** When set, the tree is populated from the server (/api/json-level)
   *  instead of parsing `source` locally: only the requested depth is
   *  fetched, and expanding a node past that depth fetches deeper on
   *  demand. This is what makes huge imported/streamed files cheap to
   *  browse — the browser never holds or walks the full parsed object. */
  fileId?: string | null;
  /** Collapse object/array nodes deeper than this on first render. Default 2. */
  defaultExpandDepth?: number;
  /** Row height in px, used by the virtualized list. Default 22. */
  rowHeight?: number;
  /** Arrays longer than this are grouped into expandable chunks, unless
   *  `ignoreLargeArray` is enabled. Default 100. */
  groupSize?: number;
}

function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeColor(v: JsonValue): string {
  if (v === null) return "var(--jt-null, #9aa3ad)";
  switch (typeof v) {
    case "string":
      return "var(--jt-string, #ce9178)";
    case "number":
      return "var(--jt-number, #b5cea8)";
    case "boolean":
      return "var(--jt-boolean, #569cd6)";
    default:
      return "var(--jt-value, #d4d4d4)";
  }
}

function formatPrimitive(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Sample heuristic used for the "function" collapsed preset: collapse
 *  containers past a size threshold instead of a flat depth cutoff. Only
 *  applies in local-parse mode — see presetToServerDepth for the
 *  server-mode approximation. */
function defaultCollapseFn(_key: string | null, value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 5;
  if (isObject(value)) return Object.keys(value).length > 8;
  return false;
}

/** Server-mode depth requests are a flat number, so the true/false/"function"
 *  presets have to be approximated: true = expand deep (capped so a huge
 *  file doesn't get fully materialized), false = just the root's immediate
 *  children, "function" ≈ a flat depth since its per-node size heuristic
 *  isn't replicated server-side. */
function presetToServerDepth(preset: CollapsedSetting): number {
  if (typeof preset === "number") return preset;
  if (preset === true) return 8;
  if (preset === false) return 1;
  return 3;
}

// ---------------------------------------------------------------------------
// Flattening: the tree is walked once per render into a flat array of rows.
// Only rows that are actually visible (i.e. every ancestor is expanded) get
// produced, and that flat array is what react-window virtualizes — so a
// 50,000-element array only ever mounts the handful of rows in the viewport.
//
// Two path schemes are tracked side by side: `path` is a UI identifier used
// for expand/collapse state (it includes synthetic "#chunk" segments for
// grouped arrays), while `jsonPath` is the real dot-path into the JSON data
// (records.3.meta, etc.) with no synthetic segments — it's what the server
// needs to navigate to a node for a level fetch.
// ---------------------------------------------------------------------------

type Row =
  | {
      kind: "node";
      path: string;
      jsonPath: string;
      key: string | null;
      value: JsonValue;
      depth: number;
      isLast: boolean;
      isContainer: boolean;
      expanded: boolean;
    }
  | {
      kind: "close";
      path: string;
      depth: number;
      bracket: string;
      isLast: boolean;
    }
  | {
      kind: "chunk";
      path: string;
      depth: number;
      start: number;
      end: number;
      items: [string, JsonValue][];
      expanded: boolean;
      isLast: boolean;
    }
  | {
      kind: "placeholder";
      path: string;
      jsonPath: string;
      parentJsonPath: string;
      offset: number;
      key: string | null;
      depth: number;
      isLast: boolean;
      jtype: "object" | "array";
      size: number;
      loading: boolean;
    };

interface FlattenCtx {
  expandedOverrides: Map<string, boolean>;
  chunkExpanded: Set<string>;
  collapsed: CollapsedSetting;
  groupSize: number;
  ignoreLargeArray: boolean;
  loadingPaths: Set<string>;
}

function isDefaultExpanded(
  depth: number,
  key: string | null,
  value: JsonValue,
  ctx: FlattenCtx
): boolean {
  const { collapsed } = ctx;
  if (collapsed === true) return false;
  if (collapsed === false) return true;
  if (collapsed === "function") return !defaultCollapseFn(key, value);
  return depth < collapsed;
}

function flatten(
  key: string | null,
  value: JsonValue,
  depth: number,
  path: string,
  jsonPath: string,
  isLast: boolean,
  ctx: FlattenCtx,
  out: Row[]
) {
  if (isTruncatedMarker(value)) {
    const marker = value as unknown as TruncatedMarker;
    // For array placeholders, derive the parent array path and item offset
    // so we can paginate (load next batch from server on click).
    const lastSeg = jsonPath.split('.').pop()!;
    const isArrayItem = /^\d+$/.test(lastSeg) && jsonPath.includes('.');
    const parentJsonPath = isArrayItem ? jsonPath.substring(0, jsonPath.lastIndexOf('.')) : jsonPath;
    const itemOffset = isArrayItem ? Number(lastSeg) : 0;
    out.push({
      kind: "placeholder",
      path,
      jsonPath,
      parentJsonPath,
      offset: itemOffset,
      key,
      depth,
      isLast,
      jtype: marker.__kind__,
      size: marker.__count__,
      loading: ctx.loadingPaths.has(jsonPath),
    });
    return;
  }

  const isContainer = isObject(value) || Array.isArray(value);

  if (!isContainer) {
    out.push({
      kind: "node",
      path,
      jsonPath,
      key,
      value,
      depth,
      isLast,
      isContainer: false,
      expanded: false,
    });
    return;
  }

  const override = ctx.expandedOverrides.get(path);
  const expanded =
    override !== undefined ? override : isDefaultExpanded(depth, key, value, ctx);

  out.push({ kind: "node", path, jsonPath, key, value, depth, isLast, isContainer: true, expanded });

  if (!expanded) return;

  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, JsonValue])
    : (Object.entries(value) as [string, JsonValue][]);

  const bracketClose = Array.isArray(value) ? "]" : "}";

  const shouldGroup =
    Array.isArray(value) && !ctx.ignoreLargeArray && entries.length > ctx.groupSize;

  if (shouldGroup) {
    const groupSize = ctx.groupSize;
    const numChunks = Math.ceil(entries.length / groupSize);
    for (let c = 0; c < numChunks; c++) {
      const start = c * groupSize;
      const end = Math.min(start + groupSize, entries.length) - 1;
      const chunkPath = `${path}.#chunk${c}`;
      const chunkIsLast = c === numChunks - 1;
      const chunkItems = entries.slice(start, end + 1);
      const chunkExpanded = ctx.chunkExpanded.has(chunkPath);

      out.push({
        kind: "chunk",
        path: chunkPath,
        depth: depth + 1,
        start,
        end,
        items: chunkItems,
        expanded: chunkExpanded,
        isLast: chunkIsLast,
      });

      if (chunkExpanded) {
        for (let i = 0; i < chunkItems.length; i++) {
          const [k, v] = chunkItems[i];
          flatten(
            null,
            v,
            depth + 2,
            `${chunkPath}.${k}`,
            `${jsonPath}.${k}`,
            i === chunkItems.length - 1,
            ctx,
            out
          );
        }
      }
    }
  } else {
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      flatten(
        Array.isArray(value) ? null : k,
        v,
        depth + 1,
        `${path}.${k}`,
        `${jsonPath}.${k}`,
        i === entries.length - 1,
        ctx,
        out
      );
    }
  }

  out.push({
    kind: "close",
    path: path + ".#close",
    depth,
    bracket: bracketClose,
    isLast,
  });
}

/** Immutably replaces the value at `jsonPath` inside `root` — used to splice
 *  a freshly-fetched subtree back into the tree after expanding a
 *  server-truncated node. */
function setAtJsonPath(root: JsonValue, jsonPath: string, value: JsonValue): JsonValue {
  if (jsonPath === "$" || jsonPath === "") return value;
  const segments = jsonPath.replace(/^\$\.?/, "").split(".").filter(Boolean);

  function recur(node: JsonValue, idx: number): JsonValue {
    if (idx === segments.length) return value;
    const seg = segments[idx];
    if (Array.isArray(node)) {
      const i = Number(seg);
      const copy = node.slice();
      copy[i] = recur(copy[i], idx + 1);
      return copy;
    }
    if (isObject(node)) {
      const copy = { ...node };
      copy[seg] = recur(copy[seg], idx + 1);
      return copy;
    }
    return node;
  }

  return recur(root, 0);
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10">
      <path
        d="M4 2 L12 8 L4 14 Z"
        fill="currentColor"
        style={{
          transform: expanded ? "rotate(90deg)" : "none",
          transformOrigin: "7px 8px",
          transition: "transform 120ms ease",
        }}
      />
    </svg>
  );
}

const RowRenderer = memo(function RowRenderer({
  row,
  top,
  height,
  toggleNode,
  toggleChunk,
  loadPlaceholder,
}: {
  row: Row;
  top: number;
  height: number;
  toggleNode: (path: string, current: boolean) => void;
  toggleChunk: (path: string) => void;
  loadPlaceholder: (jsonPath: string, parentJsonPath: string, offset: number) => void;
}) {
  const indent = 10 + row.depth * 14;
  const style: React.CSSProperties = {
    position: "absolute",
    top,
    left: 0,
    right: 0,
    height,
    paddingLeft: indent,
  };

  if (row.kind === "close") {
    return (
      <div className="jt-row jt-close-row" style={style}>
        <span className="jt-bracket">{row.bracket}</span>
        {!row.isLast && <span className="jt-comma">,</span>}
      </div>
    );
  }

  if (row.kind === "chunk") {
    return (
      <div className="jt-row jt-chunk-row" style={style}>
        <button
          type="button"
          className="jt-toggle"
          onClick={() => toggleChunk(row.path)}
          aria-label={row.expanded ? "Collapse chunk" : "Expand chunk"}
          data-expanded={row.expanded}
        >
          <ChevronIcon expanded={row.expanded} />
        </button>
        <span className="jt-chunk-label">
          [{row.start} … {row.end}]
        </span>
        {!row.expanded && !row.isLast && <span className="jt-comma">,</span>}
      </div>
    );
  }

  if (row.kind === "placeholder") {
    const bracketOpen = row.jtype === "array" ? "[" : "{";
    const bracketClose = row.jtype === "array" ? "]" : "}";
    return (
      <div className="jt-row" style={style}>
        <span className="jt-toggle-spacer" />
        {row.key !== null && <span className="jt-key">{row.key}</span>}
        {row.key !== null && <span className="jt-colon">:</span>}
        <span className="jt-bracket">{bracketOpen}</span>
        <span
          className="jt-collapsed-summary"
          onClick={() => !row.loading && loadPlaceholder(row.jsonPath, row.parentJsonPath, row.offset)}
          style={{ cursor: row.loading ? "default" : "pointer" }}
        >
          {row.loading
            ? "loading…"
            : `${row.size} item${row.size === 1 ? "" : "s"} — click to load from server`}
        </span>
        <span className="jt-bracket">{bracketClose}</span>
        {!row.isLast && <span className="jt-comma">,</span>}
      </div>
    );
  }

  const { value } = row;
  const isContainer = row.isContainer;
  const bracketOpen = Array.isArray(value) ? "[" : "{";
  const bracketClose = Array.isArray(value) ? "]" : "}";
  const containerLabel = Array.isArray(value)
    ? `Array(${(value as JsonValue[]).length})`
    : `Object(${value ? Object.keys(value as object).length : 0})`;

  return (
    <div className="jt-row" style={style}>
      {isContainer ? (
        <button
          type="button"
          className="jt-toggle"
          onClick={() => toggleNode(row.path, row.expanded)}
          aria-label={row.expanded ? "Collapse" : "Expand"}
          data-expanded={row.expanded}
        >
          <ChevronIcon expanded={row.expanded} />
        </button>
      ) : (
        <span className="jt-toggle-spacer" />
      )}

      {row.key !== null && <span className="jt-key">{row.key}</span>}
      {row.key !== null && <span className="jt-colon">:</span>}

      {isContainer ? (
        <>
          <span className="jt-bracket">{bracketOpen}</span>
          {!row.expanded && (
            <>
              <span
                className="jt-collapsed-summary"
                onClick={() => toggleNode(row.path, row.expanded)}
              >
                {containerLabel}
              </span>
              <span className="jt-bracket">{bracketClose}</span>
              {!row.isLast && <span className="jt-comma">,</span>}
            </>
          )}
        </>
      ) : (
        <span className="jt-value" style={{ color: typeColor(value) }}>
          {formatPrimitive(value)}
          {!row.isLast && <span className="jt-comma">,</span>}
        </span>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Size measurement (no extra dependency — same ResizeObserver pattern
// already used in JsonEditor.tsx)
// ---------------------------------------------------------------------------

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const PRESETS: { label: string; value: CollapsedSetting }[] = [
  { label: "0", value: 0 },
  { label: "1", value: 1 },
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "true", value: true },
  { label: "false", value: false },
  { label: "function", value: "function" },
];

function parseJson(source: string): { ok: true; value: JsonValue | null } | { ok: false; error: string } {
  try {
    if (source.trim() === "") return { ok: true, value: null };
    return { ok: true, value: JSON.parse(source) as JsonValue };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

export default function JsonTreeView({
  source,
  fileId = null,
  defaultExpandDepth = 2,
  rowHeight = 22,
  groupSize = 100,
}: JsonTreeViewProps) {
  // --- Local-parse mode (fileId not set): unchanged from before -----------
  const [debouncedSource, setDebouncedSource] = useState(source);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSource(source), 200);
    return () => clearTimeout(id);
  }, [source]);
  const localParsed = useMemo(() => parseJson(debouncedSource), [debouncedSource]);

  const [collapsed, setCollapsed] = useState<CollapsedSetting>(defaultExpandDepth);
  const [ignoreLargeArray, setIgnoreLargeArray] = useState(false);
  const [expandedOverrides, setExpandedOverrides] = useState<Map<string, boolean>>(
    new Map()
  );
  const [chunkExpanded, setChunkExpanded] = useState<Set<string>>(new Set());

  // --- Server mode (fileId set): fetch a depth-limited subtree instead of
  // parsing `source` at all. Containers beyond the fetched depth arrive as
  // TruncatedMarker placeholders that get fetched individually on expand. --
  const [serverRoot, setServerRoot] = useState<JsonValue | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!fileId) {
      setServerRoot(null);
      setServerError(null);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    setServerError(null);

    // Fetch at the depth matching the current collapse preset.  The server
    // fast-path (byte-offset seeking / rootKeys expansion) can serve
    // depths 2-3 without a full file scan.  Capped at 3 so even the
    // "true"/"function" presets don't trigger an overly deep response.
    const fetchDepth = Math.min(presetToServerDepth(collapsed), 3);
    fetch(`/api/json-level?id=${encodeURIComponent(fileId)}&path=%24&depth=${fetchDepth}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
        if (!cancelled) setServerRoot(body.value);
      })
      .catch((e) => {
        if (!cancelled) setServerError(e.message || "Failed to load JSON from server");
      })
      .finally(() => {
        if (!cancelled) setServerLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // Re-fetch the root view whenever the file or the requested depth preset
    // changes. Per-node expansion beyond that is handled by loadPlaceholder.
  }, [fileId, collapsed]);

  const loadPlaceholder = useCallback(
    (jsonPath: string, _parentJsonPath: string, _offset: number) => {
      if (!fileId) return;
      setLoadingPaths((prev) => new Set(prev).add(jsonPath));
      const phDepth = Math.min(presetToServerDepth(collapsed), 3);
      const url = `/api/json-level?id=${encodeURIComponent(fileId)}&path=${encodeURIComponent(jsonPath)}&depth=${phDepth}`;
      fetch(url)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
          if (body.value == null) throw new Error("Server returned null value");
          setServerRoot((prev) => {
            if (prev == null) return prev;
            return setAtJsonPath(prev, jsonPath, body.value);
          });
        })
        .catch(() => {
          // Best-effort: leave the placeholder in place so the user can retry.
        })
        .finally(() => {
          setLoadingPaths((prev) => {
            const next = new Set(prev);
            next.delete(jsonPath);
            return next;
          });
        });
    },
    [fileId, collapsed]
  );

  const parsed = useMemo<{ ok: true; value: JsonValue | null } | { ok: false; error: string }>(() => {
    if (!fileId) return localParsed;
    if (serverError) return { ok: false, error: serverError };
    return { ok: true, value: serverRoot };
  }, [fileId, serverError, serverRoot, localParsed]);

  // Changing a preset (or the ignoreLargeArray toggle) resets any manual
  // per-node overrides so the new setting applies cleanly.
  useEffect(() => {
    setExpandedOverrides(new Map());
    setChunkExpanded(new Set());
  }, [collapsed, ignoreLargeArray]);

  const toggleNode = useCallback((path: string, current: boolean) => {
    setExpandedOverrides((prev) => {
      const next = new Map(prev);
      next.set(path, !current);
      return next;
    });
  }, []);

  const toggleChunk = useCallback((path: string) => {
    setChunkExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Rows are computed off the synchronous render path: we flip `isComputing`
  // on immediately (cheap state update, paints right away), then let the
  // browser actually paint that loader before running the potentially heavy
  // flatten() pass. This is what makes the loader show up even for a single
  // expand/collapse click on a huge array, not just on initial load.
  const [rows, setRows] = useState<Row[]>([]);
  const [isComputing, setIsComputing] = useState(true);

  useEffect(() => {
    setIsComputing(true);
    let cancelled = false;

    const raf = requestAnimationFrame(() => {
      setTimeout(() => {
        if (cancelled) return;

        if (!parsed.ok || parsed.value === null) {
          setRows([]);
          setIsComputing(false);
          return;
        }

        const ctx: FlattenCtx = {
          expandedOverrides,
          chunkExpanded,
          collapsed,
          groupSize,
          ignoreLargeArray,
          loadingPaths,
        };
        const out: Row[] = [];
        flatten(null, parsed.value, 0, "$", "$", true, ctx, out);

        if (!cancelled) {
          setRows(out);
          setIsComputing(false);
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [parsed, expandedOverrides, chunkExpanded, collapsed, groupSize, ignoreLargeArray, loadingPaths]);

  // Waiting on the debounce (source still arriving) counts as loading too —
  // only relevant in local-parse mode, since server mode has its own
  // serverLoading flag.
  const isStreamingIn = !fileId && debouncedSource !== source;
  const isLoading = isStreamingIn || isComputing || (fileId ? serverLoading : false);

  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Reset scroll position when the underlying row set changes shape
  // drastically (e.g. a fresh preset), so we don't end up "stuck" past
  // the new, possibly shorter, content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [collapsed, ignoreLargeArray, parsed.ok]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const overscan = 8;
  const viewportHeight = bodySize.height || 0;
  const totalHeight = rows.length * rowHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan
  );

  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <div className="jt-pane" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="jt-toolbar">
        <span className="jt-toolbar-title">
          Tree view{fileId ? " (server-fetched by level)" : ""}
        </span>
        <div className="jt-toolbar-actions">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="jt-btn"
              data-active={collapsed === p.value}
              onClick={() => setCollapsed(p.value)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className="jt-btn jt-btn-ignore"
            data-active={ignoreLargeArray}
            onClick={() => setIgnoreLargeArray((v) => !v)}
          >
            ignoreLargeArray
          </button>
        </div>
      </div>

      <div
        className="jt-body"
        ref={bodyRef}
        style={{ flex: 1, minHeight: 0, position: "relative" }}
      >
        {!parsed.ok ? (
          <div className="jt-error">
            <div className="jt-error-title">Invalid JSON</div>
            <div className="jt-error-detail">{parsed.error}</div>
          </div>
        ) : rows.length === 0 && !isLoading ? (
          <div className="jt-empty">Empty</div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{ height: "100%", width: "100%", overflow: "auto", position: "relative" }}
          >
            {/* Spacer that gives the scrollbar the full (virtual) content height */}
            <div style={{ height: totalHeight, position: "relative" }}>
              {visibleRows.map((row, i) => (
                <RowRenderer
                  key={row.path}
                  row={row}
                  top={(startIndex + i) * rowHeight}
                  height={rowHeight}
                  toggleNode={toggleNode}
                  toggleChunk={toggleChunk}
                  loadPlaceholder={loadPlaceholder}
                />
              ))}
            </div>
          </div>
        )}

        {isLoading && parsed.ok && (
          <div
            className="jt-loading-overlay"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              background: "rgba(20, 22, 26, 0.55)",
              color: "#e8eaed",
              fontSize: 13,
              zIndex: 5,
              pointerEvents: rows.length === 0 ? "auto" : "none",
            }}
          >
            <Spinner
              size={16}
              label={
                isStreamingIn
                  ? "Waiting for more data…"
                  : fileId && serverLoading
                  ? "Fetching level from server…"
                  : "Preparing tree…"
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
