import type { ManifestChunk, ManifestEntry } from "./manifestFileStore";
import { fastifyGet, getKeyKind } from "./manifestFileStore";

// Must match MAX_PREVIEW_SIZE in app/api/json-level/route.ts and
// INDIVIDUAL_ITEM_THRESHOLD in JsonTreeView.tsx.
const MAX_PREVIEW_SIZE = 10;

function truncatedMarker(kind: "object" | "array", count: number) {
  return { __truncated__: true, __kind__: kind, __count__: count };
}

/** Same truncation contract as the streaming parser in route.ts, just applied
 *  to an already-parsed value instead of a token stream — safe here because
 *  chunk files are capped at ~3MB, so a fetched item is never big enough to
 *  need streaming. depth<=0 turns a container into a marker; arrays cap at
 *  MAX_PREVIEW_SIZE with a trailing marker for the remainder. */
function truncateByDepth(value: any, depth: number): any {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    if (depth <= 0) return truncatedMarker("array", value.length);
    const items = value.slice(0, MAX_PREVIEW_SIZE).map((v) => truncateByDepth(v, depth - 1));
    if (value.length > MAX_PREVIEW_SIZE) {
      items.push(truncatedMarker("array", value.length - MAX_PREVIEW_SIZE));
    }
    return items;
  }

  if (depth <= 0) return truncatedMarker("object", Object.keys(value).length);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = truncateByDepth(v, depth - 1);
  return out;
}

/** Which chunk + local (within-chunk) index holds global array index `idx`.
 *  Prefers the json_path-derived ranges stamped at registration, falling back
 *  to item_count accumulation for legacy manifests. */
function locateChunk(
  chunkList: ManifestChunk[],
  idx: number,
): { chunk: ManifestChunk; localIndex: number } | null {
  let cursor = 0;
  for (const c of chunkList) {
    const start = c.start ?? cursor;
    const end = c.end ?? cursor + (c.item_count ?? 0);
    if (idx >= start && idx < end) return { chunk: c, localIndex: idx - start };
    cursor = end;
  }
  return null;
}

/** Total item/key count for a root key across all its chunks. */
function totalCount(entry: ManifestEntry, key: string): number {
  const snap = entry.depth1Snapshot?.[key] as any;
  if (snap && typeof snap === "object" && snap.__count__ != null) return snap.__count__;
  return (entry.chunks?.[key] ?? []).reduce((s, c) => s + (c.item_count ?? 0), 0);
}

/** Fetch up to `count` items of root array `key` starting at global offset
 *  `start`, crossing chunk boundaries as needed. Uses Fastify's own
 *  skip/limit so we never pull a full chunk just to preview 10 items.
 *  Array root keys only — callers dispatch on kind first. */
async function sliceArray(
  entry: ManifestEntry,
  key: string,
  start: number,
  count: number,
): Promise<any[]> {
  const chunkList = entry.chunks[key];
  if (!chunkList) return [];

  const out: any[] = [];
  let cursor = 0;
  for (const c of chunkList) {
    if (out.length >= count) break;
    const chunkStart = c.start ?? cursor;
    const chunkEnd = c.end ?? cursor + (c.item_count ?? 0);
    if (start < chunkEnd) {
      const localSkip = Math.max(0, start - chunkStart);
      const need = count - out.length;
      const page = await fastifyGet(entry, c.file_name, { path: key, skip: localSkip, limit: need });
      if (Array.isArray(page)) out.push(...page);
    }
    cursor = chunkEnd;
  }
  return out;
}

/** Merge every chunk of an object root key into a single object. Chunks may
 *  hold disjoint key subsets (split objects: {"key": {…parts…}}), so we
 *  Object.assign them together. Falls back to returning a scalar/array if a
 *  chunk turns out not to be an object (kind mismatches). */
async function mergedObject(entry: ManifestEntry, key: string): Promise<any> {
  const chunkList = entry.chunks?.[key] ?? [];
  const merged: Record<string, any> = {};
  for (const c of chunkList) {
    const part = await fastifyGet(entry, c.file_name, { path: key });
    if (part && typeof part === "object" && !Array.isArray(part)) {
      Object.assign(merged, part);
    } else if (Array.isArray(part)) {
      return part;
    } else if (Object.keys(merged).length === 0) {
      return part;
    }
  }
  return merged;
}

/** Fetch a scalar root key's value from its single chunk. */
async function scalarValue(entry: ManifestEntry, key: string): Promise<any> {
  const chunk = entry.chunks?.[key]?.[0];
  if (!chunk) return undefined;
  return fastifyGet(entry, chunk.file_name, { path: key });
}

/** Build the depth-truncated subtree shown for root key `key` when expanding
 *  the root view (path="$", depth>1). */
async function buildRootChild(
  entry: ManifestEntry,
  key: string,
  kind: "array" | "object" | "scalar",
  depth: number,
): Promise<any> {
  if (kind === "scalar") return scalarValue(entry, key);
  if (kind === "array") {
    const items = await sliceArray(entry, key, 0, MAX_PREVIEW_SIZE);
    const truncatedItems = items.map((it) => truncateByDepth(it, depth - 1));
    const total = totalCount(entry, key);
    if (total > truncatedItems.length) {
      truncatedItems.push(truncatedMarker("array", total - truncatedItems.length));
    }
    return truncatedItems;
  }
  return truncateByDepth(await mergedObject(entry, key), depth - 1);
}

/** Root-level entry point, mirroring resolvePath()/extractFromFile() in
 *  route.ts: given a $-path, a render depth, and an array pagination offset,
 *  return the tree-node value (with truncation markers), or undefined if the
 *  path doesn't resolve. Dispatch is kind-aware (array/object/scalar) based
 *  on the manifest's value_type, so object root keys like `metadata` render
 *  as objects instead of being mistaken for arrays. */
export async function resolveManifestValue(
  entry: ManifestEntry,
  jsonPath: string,
  depth: number,
  offset: number,
): Promise<any> {
  // Root.
  if (jsonPath === "$" || jsonPath === "") {
    if (depth <= 1) return entry.depth1Snapshot;

    // depth>1 at root: expand every key's first page in one go, dispatching
    // each key by its container kind.
    const base: Record<string, any> = {};
    for (const key of Object.keys(entry.chunks)) {
      const kind = await getKeyKind(entry, key);
      base[key] = await buildRootChild(entry, key, kind, depth);
    }
    return base;
  }

  const segs = jsonPath.replace(/^\$\.?/, "").split(".").filter(Boolean);
  const topKey = segs[0];
  const chunkList = entry.chunks[topKey];
  if (!chunkList) return undefined;
  const kind = await getKeyKind(entry, topKey);

  // Path targets the root value itself ("$.metadata", "$.users"). Arrays
  // return a batch page starting at `offset` (what the "N items remaining"
  // placeholder click hits); objects/scalars return their whole value.
  if (segs.length === 1) {
    if (kind === "scalar") return scalarValue(entry, topKey);
    if (kind === "object") return truncateByDepth(await mergedObject(entry, topKey), depth);

    const items = await sliceArray(entry, topKey, offset, MAX_PREVIEW_SIZE);
    const truncatedItems = items.map((it) => truncateByDepth(it, depth - 1));
    const total = totalCount(entry, topKey);
    const consumed = offset + items.length;
    if (total > consumed) {
      truncatedItems.push(truncatedMarker("array", total - consumed));
    }
    return truncatedItems;
  }

  // Path goes one (or more) levels under the root key.
  if (kind === "array") {
    // "users.1523" or "users.1523.address.city" — array item lookup via chunk pagination
    const idx = Number(segs[1]);
    if (!Number.isInteger(idx) || idx < 0) return undefined;

    const rest = segs.slice(2);
    const loc = locateChunk(chunkList, idx);
    if (!loc) return undefined;

    const subPath = rest.length
      ? `${topKey}.${loc.localIndex}.${rest.join(".")}`
      : `${topKey}.${loc.localIndex}`;

    const value = await fastifyGet(entry, loc.chunk.file_name, { path: subPath });
    if (value === undefined) return undefined;
    return truncateByDepth(value, depth);
  }

  // Object root key (e.g. "metadata.configuration.export_settings") — resolve
  // the nested path against the merged object locally.
  const merged = await mergedObject(entry, topKey);
  let value = merged;
  for (const s of segs.slice(1)) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[s];
  }
  if (value === undefined) return undefined;
  return truncateByDepth(value, depth);
}

// ── Shared helpers reused by app/api/json-query/route.ts ────────────────────

export async function getManifestKeyKind(
  entry: ManifestEntry,
  key: string,
): Promise<"array" | "object" | "scalar"> {
  return getKeyKind(entry, key);
}

export function getManifestArrayItems(
  entry: ManifestEntry,
  key: string,
  start: number,
  count: number,
): Promise<any[]> {
  return sliceArray(entry, key, start, count);
}

export function getManifestMergedObject(entry: ManifestEntry, key: string): Promise<any> {
  return mergedObject(entry, key);
}

export function getManifestScalar(entry: ManifestEntry, key: string): Promise<any> {
  return scalarValue(entry, key);
}
