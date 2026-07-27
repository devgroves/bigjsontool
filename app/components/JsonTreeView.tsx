"use client";

import type React from "react";
import {
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

type CollapsedSetting = number | boolean | "function";

interface JsonTreeViewProps {
  fileId: string;
  defaultExpandDepth?: number;
  rowHeight?: number;
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

function defaultCollapseFn(_key: string | null, value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 5;
  if (isObject(value)) return Object.keys(value).length > 8;
  return false;
}

function presetToServerDepth(preset: CollapsedSetting): number {
  if (typeof preset === "number") return preset;
  if (preset === true) return 8;
  if (preset === false) return 1;
  return 3;
}

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

function extendArrayAtPath(root: JsonValue, jsonPath: string, newItems: JsonValue[], offset: number): JsonValue {
  const segments = jsonPath.replace(/^\$\.?/, "").split(".").filter(Boolean);
  function recur(node: JsonValue, idx: number): JsonValue {
    if (idx === segments.length) {
      const arr = Array.isArray(node) ? node : [];
      return [...arr.slice(0, offset), ...newItems, ...arr.slice(offset + newItems.length)] as JsonValue;
    }
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

function collectTruncatedPaths(value: JsonValue | null, jsonPath: string, out: string[]) {
  if (value == null) return;
  if (isTruncatedMarker(value)) {
    out.push(jsonPath);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectTruncatedPaths(v, `${jsonPath}.${i}`, out));
  } else if (isObject(value)) {
    Object.entries(value).forEach(([k, v]) => collectTruncatedPaths(v, `${jsonPath}.${k}`, out));
  }
}

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

const PRESETS: { label: string; value: CollapsedSetting }[] = [
  { label: "0", value: 0 },
  { label: "1", value: 1 },
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "true", value: true },
  { label: "false", value: false },
  { label: "function", value: "function" },
];

export default function JsonTreeView({
  fileId,
  defaultExpandDepth = 2,
  rowHeight = 22,
  groupSize = 100,
}: JsonTreeViewProps) {
  const [collapsed, setCollapsed] = useState<CollapsedSetting>(defaultExpandDepth);
  const [ignoreLargeArray, setIgnoreLargeArray] = useState(false);
  const [expandedOverrides, setExpandedOverrides] = useState<Map<string, boolean>>(
    new Map()
  );
  const [chunkExpanded, setChunkExpanded] = useState<Set<string>>(new Set());

  const [serverRoot, setServerRoot] = useState<JsonValue | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  const serverRootRef = useRef<JsonValue | null>(null);
  useEffect(() => {
    serverRootRef.current = serverRoot;
  }, [serverRoot]);

  const fetchedDepthRef = useRef(0);
  const lastFileIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastFileIdRef.current !== fileId) {
      lastFileIdRef.current = fileId;
      fetchedDepthRef.current = 0;
      serverRootRef.current = null;
      setServerRoot(null);
    }

    const targetDepth = Math.min(presetToServerDepth(collapsed), 3);

    if (targetDepth <= fetchedDepthRef.current && serverRootRef.current != null) {
      return;
    }

    let cancelled = false;

    (async () => {
      setServerLoading(true);
      setServerError(null);
      try {
        if (serverRootRef.current == null) {
          const res = await fetch(
            `/api/json-level?id=${encodeURIComponent(fileId)}&path=%24&depth=${targetDepth}`
          );
          const body = await res.json();
          if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
          if (!cancelled) {
            setServerRoot(body.value);
            fetchedDepthRef.current = targetDepth;
          }
          return;
        }

        const frontier: string[] = [];
        collectTruncatedPaths(serverRootRef.current, "$", frontier);
        const delta = targetDepth - fetchedDepthRef.current;

        if (frontier.length === 0) {
          fetchedDepthRef.current = targetDepth;
          return;
        }

        const res = await fetch(`/api/json-level/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: fileId, paths: frontier, depth: delta }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
        const values: Record<string, JsonValue> = body.values;

        if (!cancelled) {
          setServerRoot((prev) => {
            let next = prev;
            for (const jsonPath of frontier) {
              if (next == null) break;
              if (jsonPath in values) next = setAtJsonPath(next, jsonPath, values[jsonPath]);
            }
            return next;
          });
          fetchedDepthRef.current = targetDepth;
        }
      } catch (e: any) {
        if (!cancelled) setServerError(e.message || "Failed to load JSON from server");
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileId, collapsed]);

  const INDIVIDUAL_ITEM_THRESHOLD = 10;

  const loadPlaceholder = useCallback(
    (jsonPath: string, parentJsonPath: string, offset: number) => {
      setLoadingPaths((prev) => new Set(prev).add(jsonPath));
      const phDepth = Math.min(presetToServerDepth(collapsed), 3);

      const isBatch = offset >= INDIVIDUAL_ITEM_THRESHOLD && offset > 0;
      const url = isBatch
        ? `/api/json-level?id=${encodeURIComponent(fileId)}&path=${encodeURIComponent(parentJsonPath)}&depth=${phDepth}&offset=${offset}`
        : `/api/json-level?id=${encodeURIComponent(fileId)}&path=${encodeURIComponent(jsonPath)}&depth=${phDepth}`;

      fetch(url)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
          if (body.value == null) throw new Error("Server returned null value");
          setServerRoot((prev) => {
            if (prev == null) return prev;
            if (isBatch && Array.isArray(body.value)) {
              return extendArrayAtPath(prev, parentJsonPath, body.value as JsonValue[], offset);
            }
            return setAtJsonPath(prev, jsonPath, body.value);
          });
        })
        .catch(() => {
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

  const [rows, setRows] = useState<Row[]>([]);
  const [isComputing, setIsComputing] = useState(true);

  const parsedError = serverError;

  useEffect(() => {
    setIsComputing(true);
    let cancelled = false;

    const raf = requestAnimationFrame(() => {
      setTimeout(() => {
        if (cancelled) return;

        if (parsedError || serverRoot === null) {
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
        flatten(null, serverRoot, 0, "$", "$", true, ctx, out);

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
  }, [serverRoot, expandedOverrides, chunkExpanded, collapsed, groupSize, ignoreLargeArray, loadingPaths, parsedError]);

  const isLoading = isComputing || serverLoading;

  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [collapsed, ignoreLargeArray, serverRoot]);

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
          Tree view (server-fetched by level)
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
        {parsedError ? (
          <div className="jt-error">
            <div className="jt-error-title">Error</div>
            <div className="jt-error-detail">{parsedError}</div>
          </div>
        ) : rows.length === 0 && !isLoading ? (
          <div className="jt-empty">Empty</div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{ height: "100%", width: "100%", overflow: "auto", position: "relative" }}
          >
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

        {isLoading && !parsedError && (
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
                serverLoading
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
