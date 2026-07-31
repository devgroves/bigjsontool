import type { ManifestChunk, ManifestEntry } from "./manifestFileStore";

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

/** Which chunk + local (within-chunk) index holds global array index `idx`. */
function locateChunk(
  chunkList: ManifestChunk[],
  idx: number,
): { chunk: ManifestChunk; localIndex: number } | null {
  let cursor = 0;
  for (const c of chunkList) {
    if (idx < cursor + c.item_count) return { chunk: c, localIndex: idx - cursor };
    cursor += c.item_count;
  }
  return null;
}

/** GET {baseUrl}/{fileName}?...params, per the Fastify query API in README.md.
 *  ASSUMPTION (unverified — no sample Fastify response to check against):
 *  the endpoint returns the resolved value directly as the JSON body. If your
 *  server instead wraps it (e.g. { result: ... } or { value: ... }), adjust
 *  the unwrap line below — everything else is unaffected. */
async function fastifyGet(
  entry: ManifestEntry,
  fileName: string,
  params: Record<string, string | number>,
): Promise<any> {
  const url = new URL(`${entry.baseUrl.replace(/\/$/, "")}/${fileName}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const fastifyUrl = url.toString();
  const startMs = Date.now();
  console.log(`[manifestJsonValue] >>> fastifyGet: ${fastifyUrl}`);

  let res: Response;
  try {
    res = await fetch(fastifyUrl);
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[manifestJsonValue] <<< fastifyGet fetch error after ${elapsed}ms: ${fastifyUrl}`, err?.message);
    throw err;
  }

  const elapsed = Date.now() - startMs;

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "unable to read body");
    console.warn(`[manifestJsonValue] <<< fastifyGet FAILED ${res.status} in ${elapsed}ms: ${fastifyUrl}`);
    console.warn(`[manifestJsonValue] response body: ${errorBody}`);
    throw new Error(`Fastify request failed (${res.status}): ${fastifyUrl}`);
  }

  const body = await res.json();
  console.log(`[manifestJsonValue] <<< fastifyGet OK ${res.status} in ${elapsed}ms: ${fastifyUrl}`);
  console.log(`[manifestJsonValue] response keys: ${typeof body === "object" ? Object.keys(body).join(", ") : typeof body}`);

  // Unwrap common envelope shapes defensively; fall back to the raw body.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if ("result" in body) return body.result;
    if ("value" in body) return body.value;
  }
  return body;
}

/** Fetch up to `count` items of root array `key` starting at global offset
 *  `start`, crossing chunk boundaries as needed. Uses Fastify's own
 *  skip/limit so we never pull a full chunk just to preview 10 items. */
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
    const chunkEnd = cursor + c.item_count;
    if (start < chunkEnd) {
      const localSkip = Math.max(0, start - cursor);
      const need = count - out.length;
      const page = await fastifyGet(entry, c.file_name, { path: key, skip: localSkip, limit: need });
      if (Array.isArray(page)) out.push(...page);
    }
    cursor = chunkEnd;
  }
  return out;
}

/** Root-level entry point, mirroring resolvePath()/extractFromFile() in
 *  route.ts: given a $-path, a render depth, and an array pagination offset,
 *  return the tree-node value (with truncation markers), or undefined if the
 *  path doesn't resolve. */
export async function resolveManifestValue(
  entry: ManifestEntry,
  jsonPath: string,
  depth: number,
  offset: number,
): Promise<any> {
  // Root.
  if (jsonPath === "$" || jsonPath === "") {
    if (depth <= 1) return entry.depth1Snapshot;

    // depth>1 at root: expand every key's first page in one go, same as the
    // idxHasDepth1/root-expansion branch in route.ts.
    const base: Record<string, any> = {};
    for (const key of Object.keys(entry.chunks)) {
      const total = (entry.depth1Snapshot[key] as any).__count__ as number;
      const items = await sliceArray(entry, key, 0, MAX_PREVIEW_SIZE);
      const truncatedItems = items.map((it) => truncateByDepth(it, depth - 1));
      if (total > items.length) {
        truncatedItems.push(truncatedMarker("array", total - items.length));
      }
      base[key] = truncatedItems;
    }
    return base;
  }

  const segs = jsonPath.replace(/^\$\.?/, "").split(".").filter(Boolean);
  const topKey = segs[0];
  const chunkList = entry.chunks[topKey];
  if (!chunkList) return undefined;

  // Path targets the root array itself ("$.users") — return a batch page
  // starting at `offset`. This is what the "N items remaining" placeholder
  // click hits (isBatch branch in JsonTreeView.tsx).
  if (segs.length === 1) {
    const total = (entry.depth1Snapshot[topKey] as any).__count__ as number;
    const items = await sliceArray(entry, topKey, offset, MAX_PREVIEW_SIZE);
    const truncatedItems = items.map((it) => truncateByDepth(it, depth - 1));
    const consumed = offset + items.length;
    if (total > consumed) {
      truncatedItems.push(truncatedMarker("array", total - consumed));
    }
    return truncatedItems;
  }

  // Path targets one specific item, optionally a nested field within it
  // ("$.users.1523" or "$.users.1523.address.city").
  const idx = Number(segs[1]);
  if (Number.isInteger(idx) && idx >= 0) {
    // Numeric index — array item lookup via chunk pagination
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

  // Non-numeric second segment — nested object key (e.g. "$.numeric_tables.matrices").
  // Forward the full dot-path to Fastify and let it resolve the value.
  const subPath = segs.join(".");
  const chunk = chunkList[0];
  if (!chunk) return undefined;

  const value = await fastifyGet(entry, chunk.file_name, { path: subPath });
  if (value === undefined) return undefined;
  return truncateByDepth(value, depth);
}
