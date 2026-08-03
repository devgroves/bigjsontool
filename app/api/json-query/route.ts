import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { parserStream } from "stream-json";
import { dataPath, isValidId, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";
import { getManifestEntry } from "../../lib/manifestFileStore";
import type { ManifestEntry } from "../../lib/manifestFileStore";
import {
  getManifestKeyKind,
  getManifestArrayItems,
  getManifestMergedObject,
  getManifestScalar,
} from "../../lib/manifestJsonValue";
import { getRemoteEntry } from "../../lib/remoteFileStore";
import type { RemoteFileEntry } from "../../lib/remoteFileStore";

export const dynamic = "force-dynamic";

// Lazy-require jsonpath-plus (CJS) to avoid bundling it client-side.
let _JSONPath: ((opts: { path: string; json: any; wrap?: boolean }) => any[]) | null = null;
function jsonpath(query: string, data: any): any[] {
  if (!_JSONPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("jsonpath-plus");
    _JSONPath = mod.JSONPath ?? mod.default?.JSONPath ?? mod;
  }
  return _JSONPath!({ path: query, json: data, wrap: false });
}

// ── Root-key extraction ────────────────────────────────────────────────────

function extractRootKey(query: string): { rootKey: string; remaining: string } {
  const stripped = query.replace(/^\$\.?/, "");
  const match = stripped.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(.*)/);
  if (!match) return { rootKey: stripped, remaining: "" };
  return { rootKey: match[1], remaining: match[2] };
}

/** Detect a leading positional array accessor on the remainder of an array
 *  root-key query: [n], [n:m], [n:], [:m], [*] — anything that indexes the
 *  array itself, as opposed to a per-item expression like a filter ([?(...)]),
 *  field projection (.name), or recursive descent (..name). Returns the global
 *  range the accessor selects plus whatever expression follows it, or null
 *  when the remainder isn't positional. An open-ended [n:] / [*] yields
 *  end = Infinity. */
function parseArrayAccessor(
  remaining: string,
): { start: number; end: number; rest: string } | null {
  const m = remaining.match(/^\[([^?[\]]*)\](.*)$/);
  if (!m) return null;
  const inner = m[1].trim();
  if (inner === "*") return { start: 0, end: Infinity, rest: m[2] };
  if (inner === "") return null;
  const im = inner.match(/^(\d*):(\d*)$/);
  if (im) {
    return {
      start: im[1] === "" ? 0 : Number(im[1]),
      end: im[2] === "" ? Infinity : Number(im[2]),
      rest: m[2],
    };
  }
  if (/^\d+$/.test(inner)) {
    const idx = Number(inner);
    return { start: idx, end: idx + 1, rest: m[2] };
  }
  return null;
}

// ── Streaming JSON parser (reuses stream-json) ────────────────────────────

const TOKEN_KINDS = new Set([
  "startObject", "endObject", "startArray", "endArray",
  "keyValue", "stringValue", "numberValue", "nullValue", "trueValue", "falseValue",
]);

type Token = { name: string; value?: any };

function scalarFromEvent(e: Token): any {
  if (e.name === "nullValue") return null;
  if (e.name === "trueValue") return true;
  if (e.name === "falseValue") return false;
  if (e.name === "numberValue") return Number(e.value);
  return e.value;
}

function truncatedMarker(kind: "object" | "array", count: number) {
  return { __truncated__: true, __kind__: kind, __count__: count };
}

const MAX_PREVIEW_SIZE = 10;

type FrameMode = "build" | "skip" | "nav";

interface Frame {
  mode: FrameMode;
  isArray: boolean;
  depth: number;
  result: any;
  count: number;
  key: string | null;
  target: string | null;
  navRest: string[];
  navIndex: number;
}

function parseJsonStream(
  readable: NodeJS.ReadableStream,
  jsonPath: string,
  depth: number,
  knownCount?: number,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const segments =
      jsonPath === "$" || jsonPath === "" ? [] : jsonPath.replace(/^\$\.?/, "").split(".").filter(Boolean);

    let resolved = false;
    const stack: Frame[] = [];

    function finish(value: any) {
      if (resolved) return;
      resolved = true;
      resolve(value);
      tokenStream.destroy();
      (readable as any).destroy?.();
    }

    function pushFrame(mode: FrameMode, isArray: boolean, frameDepth: number,
                       target: string | null, navRest: string[]) {
      stack.push({
        mode, isArray, depth: frameDepth,
        result: mode === "build" ? (isArray ? [] : {}) : null,
        count: 0, key: null, target, navRest, navIndex: -1,
      });
    }

    function popFrame(eventName: string): any {
      const frame = stack.pop()!;
      if (frame.mode === "skip") {
        if (frame.result && frame.count > 0) {
          const remaining = frame.count - (Array.isArray(frame.result) ? frame.result.length : 0);
          if (remaining > 0) {
            (frame.result as any[]).push(
              truncatedMarker(eventName === "endArray" ? "array" : "object", remaining),
            );
          }
          return frame.result;
        }
        return truncatedMarker(eventName === "endArray" ? "array" : "object", frame.count);
      }
      if (frame.mode === "nav") return undefined;
      return frame.result;
    }

    function processToken(event: Token) {
      if (resolved || !TOKEN_KINDS.has(event.name)) return;

      if (stack.length === 0) {
        if (segments.length > 0) {
          if (event.name === "startObject" || event.name === "startArray") {
            pushFrame("nav", event.name === "startArray", -1, segments[0], segments.slice(1));
          } else {
            finish(undefined);
          }
        } else {
          if (event.name === "startObject" || event.name === "startArray") {
            pushFrame("build", event.name === "startArray", depth, null, []);
          } else {
            finish(scalarFromEvent(event));
          }
        }
        return;
      }

      const top = stack[stack.length - 1];
      if (top.mode === "nav") {
        processNav(event, top);
      } else {
        processBuildOrSkip(event, top);
      }
    }

    function processNav(event: Token, frame: Frame) {
      if (frame.isArray) {
        switch (event.name) {
          case "endArray":
            finish(undefined);
            return;
          case "startObject":
          case "startArray": {
            frame.navIndex++;
            if (String(frame.navIndex) === frame.target) {
              stack.pop();
              if (frame.navRest.length === 0) {
                pushFrame("build", event.name === "startArray", depth, null, []);
              } else {
                pushFrame("nav", event.name === "startArray", -1, frame.navRest[0], frame.navRest.slice(1));
              }
            } else {
              skipContainer(event);
            }
            return;
          }
          default: {
            frame.navIndex++;
            if (String(frame.navIndex) === frame.target) {
              if (frame.navRest.length === 0) {
                finish(scalarFromEvent(event));
              } else {
                finish(undefined);
              }
            }
            return;
          }
        }
      } else {
        switch (event.name) {
          case "endObject":
            finish(undefined);
            return;
          case "keyValue": {
            frame.key = event.value;
            return;
          }
          case "startObject":
          case "startArray": {
            if (frame.key === frame.target) {
              stack.pop();
              if (frame.navRest.length === 0) {
                pushFrame("build", event.name === "startArray", depth, null, []);
              } else {
                pushFrame("nav", event.name === "startArray", -1, frame.navRest[0], frame.navRest.slice(1));
              }
            } else {
              skipContainer(event);
            }
            return;
          }
          default: {
            if (frame.key === frame.target) {
              if (frame.navRest.length === 0) {
                finish(scalarFromEvent(event));
              } else {
                finish(undefined);
              }
            }
            return;
          }
        }
      }
    }

    function processBuildOrSkip(event: Token, frame: Frame) {
      switch (event.name) {
        case "keyValue": {
          frame.key = event.value;
          return;
        }
        case "startObject":
        case "startArray": {
          const isArr = event.name === "startArray";
          if (frame.mode === "skip" || frame.depth - 1 <= 0) {
            pushFrame("skip", isArr, -1, null, []);
          } else {
            pushFrame("build", isArr, frame.depth - 1, null, []);
          }
          return;
        }
        case "endObject":
        case "endArray": {
          const value = popFrame(event.name);
          if (stack.length === 0) {
            finish(value);
            return;
          }
          const parent = stack[stack.length - 1];
          if (parent.mode === "build") {
            if (parent.isArray) {
              parent.result.push(value);
              if (parent.result.length > MAX_PREVIEW_SIZE) {
                parent.result.pop();
                if (knownCount != null) {
                  parent.result.push(truncatedMarker("array", knownCount - MAX_PREVIEW_SIZE));
                  finish(parent.result);
                  return;
                }
                parent.mode = "skip";
                parent.count = MAX_PREVIEW_SIZE + 1;
              }
            } else if (parent.key !== null) {
              parent.result[parent.key] = value;
            }
          } else if (parent.mode === "skip") {
            parent.count++;
          }
          return;
        }
        default: {
          const val = scalarFromEvent(event);
          if (frame.mode === "build") {
            if (frame.isArray) {
              frame.result.push(val);
              if (frame.result.length > MAX_PREVIEW_SIZE) {
                frame.result.pop();
                if (knownCount != null) {
                  frame.result.push(truncatedMarker("array", knownCount - MAX_PREVIEW_SIZE));
                  finish(frame.result);
                  return;
                }
                frame.mode = "skip";
                frame.count = MAX_PREVIEW_SIZE + 1;
              }
            } else if (frame.key !== null) {
              frame.result[frame.key] = val;
            }
          } else {
            frame.count++;
          }
          return;
        }
      }
    }

    function skipContainer(first: Token) {
      pushFrame("skip", first.name === "startArray", -1, null, []);
    }

    const tokenStream = parserStream({ packValues: true, streamValues: false });
    (readable as any).pipe(tokenStream);

    tokenStream.on("data", processToken);
    tokenStream.on("end", () => finish(undefined));
    tokenStream.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    (readable as any).on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

// ── Index helpers (same pattern as json-level) ────────────────────────────

function isValidIndex(idx: Record<string, any>): boolean {
  if (!idx?.depth1 || typeof idx.depth1 !== "object") return false;
  const hasMarker = Object.values(idx.depth1).some(
    (v: any) => v && typeof v === "object" && v.__truncated__ != null,
  );
  if (hasMarker) return true;
  const depth1Keys = Object.keys(idx.depth1);
  if (depth1Keys.length === 0) return false;
  const containerCount = idx.containers ? Object.keys(idx.containers).length : 0;
  if (containerCount === 1 && !idx.rootKeys) return false;
  if (containerCount > 1) return false;
  return true;
}

function loadOrBuildIndex(id: string, filePath: string): Record<string, any> | null {
  const ip = indexFilePath(id);
  if (existsSync(ip)) {
    try {
      const parsed = JSON.parse(readFileSync(ip, "utf8"));
      if (isValidIndex(parsed)) return parsed;
    } catch { /* fall through to rebuild */ }
  }
  try {
    const buf = readFileSync(filePath);
    const index = buildIndex(buf);
    writeFileSync(ip, JSON.stringify(index));
    return index;
  } catch {
    return null;
  }
}

// ── Fastify chunk fetching (manifest entries) ──────────────────────────────
// Shared helpers (sliceArray/mergedObject/fastifyGet + kind detection) live in
// manifestJsonValue.ts — dispatch by the manifest's value_type so object and
// scalar root keys resolve too, not just arrays.

async function queryManifest(
  entry: ManifestEntry,
  query: string,
  offset: number,
  limit: number,
): Promise<{ results: any[]; total: number }> {
  const { rootKey, remaining } = extractRootKey(query);
  const chunkList = entry.chunks[rootKey];
  if (!chunkList) return { results: [], total: 0 };

  const kind = await getManifestKeyKind(entry, rootKey);

  // Object / scalar root keys — apply the remaining expression to the whole
  // value (no per-item fan-out needed).
  if (kind === "scalar") {
    const value = await getManifestScalar(entry, rootKey);
    if (value === undefined) return { results: [], total: 0 };
    const results = remaining ? applyToValue(remaining, value) : [value];
    return { results: results.slice(offset, offset + limit), total: results.length };
  }

  if (kind === "object") {
    const value = await getManifestMergedObject(entry, rootKey);
    if (value === undefined) return { results: [], total: 0 };
    const results = remaining ? applyToValue(remaining, value) : [value];
    return { results: results.slice(offset, offset + limit), total: results.length };
  }

  // Array root key — paginate chunk items, apply the expression per item.
  const totalCount = (entry.depth1Snapshot[rootKey] as any)?.__count__ ?? 0;

  // Positional accessors ([n], [n:m], [n:], [:m], [*]) select from the array
  // itself, so evaluating them per item would always miss. Fetch exactly the
  // selected window across chunk boundaries instead, then apply any trailing
  // expression (e.g. .name) to the fetched items.
  const accessor = remaining ? parseArrayAccessor(remaining) : null;
  if (accessor) {
    const fetchStart = accessor.start + offset;
    const fetchCount = Number.isFinite(accessor.end)
      ? Math.max(0, Math.min(accessor.end - fetchStart, limit))
      : limit;
    if (fetchCount <= 0) return { results: [], total: 0 };

    const windowItems = await getManifestArrayItems(entry, rootKey, fetchStart, fetchCount);
    let results: any[] = windowItems;
    if (accessor.rest) {
      const expr = `$${accessor.rest}`;
      results = [];
      for (const item of windowItems) {
        try {
          const matches = jsonpath(expr, item);
          if (Array.isArray(matches)) results.push(...matches);
          else if (matches !== undefined && matches !== null) results.push(matches);
        } catch {
          // Skip items where the expression doesn't match
        }
      }
    }
    const total = Number.isFinite(accessor.end)
      ? accessor.end - accessor.start
      : Math.max(0, totalCount - accessor.start);
    return { results, total };
  }

  // Filter accessor ([?(...)]) — jsonpath-plus evaluates [?(...)] over an
  // array's elements, not a single object (per-item filters never match), so
  // apply the whole expression to the fetched window of items instead.
  if (remaining.startsWith("[?(")) {
    const fetchUpTo = offset + limit;
    const items = await getManifestArrayItems(entry, rootKey, 0, fetchUpTo);
    const expr = `$${remaining}`;
    const matches = jsonpath(expr, items);
    const results: any[] =
      Array.isArray(matches) ? matches
      : matches !== undefined && matches !== null ? [matches] : [];
    const paginated = results.slice(offset, offset + limit);
    return { results: paginated, total: Math.max(results.length, totalCount) };
  }

  const fetchUpTo = offset + limit;
  const items = await getManifestArrayItems(entry, rootKey, 0, fetchUpTo);

  const results: any[] = [];
  if (remaining) {
    const expr = `$${remaining}`;
    for (const item of items) {
      try {
        const matches = jsonpath(expr, item);
        if (Array.isArray(matches)) results.push(...matches);
        else if (matches !== undefined && matches !== null) results.push(matches);
      } catch {
        // Skip items where the expression doesn't match
      }
    }
  } else {
    results.push(...items);
  }

  const paginated = results.slice(offset, offset + limit);
  return { results: paginated, total: Math.max(results.length, totalCount) };
}

/** Apply a remaining JSONPath fragment (e.g. ".configuration") to a whole
 *  object/scalar value. Returns an array of matches. */
function applyToValue(remaining: string, value: any): any[] {
  const expr = `$${remaining}`;
  try {
    const matches = jsonpath(expr, value);
    if (Array.isArray(matches)) return matches;
    if (matches !== undefined && matches !== null) return [matches];
  } catch {
    // Expression didn't match
  }
  return [];
}

// ── Local disk query (streaming) ──────────────────────────────────────────

async function queryLocal(
  id: string,
  query: string,
  offset: number,
  limit: number,
  depth: number,
): Promise<{ results: any[]; total: number }> {
  const filePath = dataPath(id);
  if (!existsSync(filePath)) return { results: [], total: 0 };

  const { rootKey, remaining } = extractRootKey(query);

  // Try the index first for O(1) byte-range seek
  const index = loadOrBuildIndex(id, filePath);
  if (index) {
    const containerPath = rootKey ? `$.${rootKey}` : "$";

    // Direct container hit via index
    if (index.containers?.[containerPath]) {
      const ci = index.containers[containerPath];
      if (ci.offset != null) {
        const fileStream = createReadStream(filePath, { start: ci.offset, end: ci.endOffset });
        const rootData = await parseJsonStream(fileStream, "$", depth, ci.count);
        if (rootData !== undefined) {
          return applyQueryResults(rootData, remaining, offset, limit);
        }
      }
    }

    // Ancestor walk-up
    if (rootKey && index.containers) {
      const segs = rootKey.split(".").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const ancestorPath = (i === 0 ? "$" : "$." + segs.slice(0, i).join("."));
        const anc = index.containers[ancestorPath];
        if (anc?.offset != null) {
          const subPath = segs.slice(i).join(".");
          const fileStream = createReadStream(filePath, { start: anc.offset, end: anc.endOffset });
          const rootData = await parseJsonStream(fileStream, subPath, depth, anc.count);
          if (rootData !== undefined) {
            return applyQueryResults(rootData, remaining, offset, limit);
          }
        }
      }
    }

    // rootKeys snapshot
    if (index.rootKeys?.[rootKey]) {
      const keyInfo = index.rootKeys[rootKey];
      if (keyInfo?.offset != null) {
        const fileStream = createReadStream(filePath, { start: keyInfo.offset, end: keyInfo.endOffset });
        const rootData = await parseJsonStream(fileStream, "$", depth, keyInfo.count);
        if (rootData !== undefined) {
          return applyQueryResults(rootData, remaining, offset, limit);
        }
      }
    }
  }

  // Fallback: stream-parse the entire file
  const jsonPath = rootKey ? `$.${rootKey}` : "$";
  const fileStream = createReadStream(filePath);
  const rootData = await parseJsonStream(fileStream, jsonPath, depth);

  if (rootData === undefined) return { results: [], total: 0 };

  return applyQueryResults(rootData, remaining, offset, limit);
}

function applyQueryResults(
  rootData: any,
  remaining: string,
  offset: number,
  limit: number,
): { results: any[]; total: number } {
  const results: any[] = [];
  if (remaining) {
    const expr = `$${remaining}`;
    if (Array.isArray(rootData)) {
      for (const item of rootData) {
        try {
          const matches = jsonpath(expr, item);
          if (Array.isArray(matches)) results.push(...matches);
          else if (matches !== undefined && matches !== null) results.push(matches);
        } catch {
          // Skip items where expression doesn't match
        }
      }
    } else {
      try {
        const matches = jsonpath(expr, rootData);
        if (Array.isArray(matches)) results.push(...matches);
        else if (matches !== undefined && matches !== null) results.push(matches);
      } catch {
        // Expression didn't match
      }
    }
  } else {
    if (Array.isArray(rootData)) results.push(...rootData);
    else results.push(rootData);
  }

  const paginated = results.slice(offset, offset + limit);
  return { results: paginated, total: results.length };
}

// ── Remote entry query ─────────────────────────────────────────────────────

async function queryRemote(
  re: RemoteFileEntry,
  query: string,
  offset: number,
  limit: number,
  depth: number,
): Promise<{ results: any[]; total: number }> {
  const { rootKey } = extractRootKey(query);

  try {
    const res = await fetch(re.url, { headers: { Range: "bytes=0-" } });
    if (!res.ok) return { results: [], total: 0 };

    const contentType = res.headers.get("content-type") || "";
    const contentLength = Number(res.headers.get("content-length") || 0);

    // Stream-parse the response body
    if (res.body) {
      const webStream = res.body;
      const nodeStream = Readable.fromWeb(webStream as any);
      const jsonPath = rootKey ? `$.${rootKey}` : "$";
      const rootData = await parseJsonStream(nodeStream, jsonPath, depth);
      if (rootData === undefined) return { results: [], total: 0 };

      const { remaining } = extractRootKey(query);
      return applyQueryResults(rootData, remaining, offset, limit);
    }

    // Fallback to text parse if no stream available
    const text = await res.text();
    const data = JSON.parse(text);
    const rootData = rootKey ? data[rootKey] : data;
    if (rootData === undefined) return { results: [], total: 0 };

    const { remaining } = extractRootKey(query);
    return applyQueryResults(rootData, remaining, offset, limit);
  } catch {
    return { results: [], total: 0 };
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { id?: string; query?: string; depth?: number; offset?: number; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }

  const id = body.id?.trim();
  const query = body.query?.trim();
  const depth = Math.max(0, Math.min(body.depth ?? 2, 12));
  const offset = Math.max(0, body.offset ?? 0);
  const limit = Math.max(1, Math.min(body.limit ?? 100, 1000));

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }
  if (!query) {
    return NextResponse.json({ error: "Missing 'query'" }, { status: 400 });
  }

  // Validate the JSONPath expression by trying to parse it
  try {
    jsonpath(query.replace(/^\$/, "$"), { _placeholder: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Invalid JSONPath expression: ${e.message ?? query}` },
      { status: 400 },
    );
  }

  const startMs = Date.now();
  console.log(`[json-query] id=${id}, query=${query}, depth=${depth}, offset=${offset}, limit=${limit}`);

  try {
    let results: any[];
    let total: number;

    // 1. Manifest-backed entry (Fastify)
    const manifestEntry = getManifestEntry(id);
    if (manifestEntry) {
      console.log(`[json-query] manifest hit for ${id}`);
      const r = await queryManifest(manifestEntry, query, offset, limit);
      results = r.results;
      total = r.total;
    } else {
      // 2. Remote entry
      const remoteEntry = getRemoteEntry(id);
      if (remoteEntry) {
        console.log(`[json-query] remote hit for ${id}`);
        const r = await queryRemote(remoteEntry, query, offset, limit, depth);
        results = r.results;
        total = r.total;
      } else {
        // 3. Local disk
        console.log(`[json-query] local hit for ${id}`);
        const r = await queryLocal(id, query, offset, limit, depth);
        results = r.results;
        total = r.total;
      }
    }

    const elapsed = Date.now() - startMs;
    console.log(`[json-query] resolved ${results.length} results in ${elapsed}ms`);

    return NextResponse.json({
      query,
      depth,
      value: results,
      total,
      hasMore: offset + results.length < total,
    });
  } catch (e: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[json-query] failed after ${elapsed}ms:`, e?.message);
    return NextResponse.json(
      { error: e.message ?? "Query failed" },
      { status: 500 },
    );
  }
}
