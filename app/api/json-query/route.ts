import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, createReadStream, statSync } from "node:fs";
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
  return _JSONPath!({ path: normalizeFilterQuery(query), json: data, wrap: false });
}

/** jsonpath-plus with an array wrapper so a filter/match result is never
 *  ambiguous: returns `[]` when nothing matched and `[value]` when it did
 *  (with `wrap: false` a single match collapses to a bare value, which is
 *  indistinguishable from "no match" when the matched element is itself
 *  null/0/false). Used by the streaming selector scan. */
function jsonpathMatch(query: string, data: any): any[] {
  if (!_JSONPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("jsonpath-plus");
    _JSONPath = mod.JSONPath ?? mod.default?.JSONPath ?? mod;
  }
  const m = _JSONPath!({ path: normalizeFilterQuery(query), json: data, wrap: true });
  return Array.isArray(m) ? m : m != null ? [m] : [];
}

/** Marker tag on the value returned by parseJsonStream when it ran a
 *  streaming selector scan — lets callers distinguish the
 *  `{ results, total }` scan result from a plain parsed container. */
const SELECTOR_RESULT = Symbol("selectorResult");

function isSelectorResult(v: any): v is { results: any[]; total: number } {
  return !!v && typeof v === "object" && v[SELECTOR_RESULT] === true;
}

/** jsonpath-plus v10 has no `=~`/`!~` regex operator and no Jayway `contains`
 *  operator in filter expressions — both throw at parse time. Rewrite them to
 *  equivalent function calls the SafeScript evaluator accepts before the query
 *  is parsed, so RFC 9535-style `@.name =~ /NIFTY/` and Jayway-style
 *  `@.name contains 'NIFTY'` work like `@.name.includes('NIFTY')`. Also absorb
 *  the common dot-call typos `@.name.include('...')` and
 *  `@.name.contains('...')` into `.includes(...)`. */
function normalizeFilterQuery(query: string): string {
  // @.field =~ /regex/flags  ->  @.field.match(/regex/flags)
  // @.field !~ /regex/flags  ->  !@.field.match(/regex/flags)
  // @.field contains 's'     ->  @.field.includes('s')
  // @.field not contains 's' ->  !@.field.includes('s')
  // @.field.include('s')     ->  @.field.includes('s')
  // @.field.contains('s')    ->  @.field.includes('s')
  return query
    // Jayway filter typo `$[?{expr}]` silently evaluates to *nothing* in
    // jsonpath-plus (no error, just no matches) — rewrite to the supported
    // `$[?(expr)]` form.
    .replace(/\[\?\{(.*?)\}\]/g, "[?($1)]")
    // A dot directly before an index bracket (`$.[0:9]`, `$.items.[0:3]`) is
    // tolerated by jsonpath-plus itself but breaks our own `remaining`/root-key
    // parsing (selectors are expected to start with `[`). Strip structural dots
    // only when immediately followed by `[`, leaving `@.x[0]` inside filter
    // bodies and `..` recursive descent untouched.
    .replace(/(?<=[\w$\]])\.(?=\[)/g, "")
    .replace(
      /(@\.[\w$[\].]+)\s*(!~|=~)\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*)/g,
      (_m, target: string, op: string, regex: string) =>
        `${op === "!~" ? "!" : ""}${target}.match(${regex})`,
    )
    .replace(
      /(@\.[\w$[\].]+)\s*(not\s+contains|contains)\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g,
      (_m, target: string, op: string, literal: string) =>
        `${op === "not contains" ? "!" : ""}${target}.includes(${literal})`,
    )
    .replace(
      /(@\.[\w$[\].]+)\.(?:include|contains)\s*\(('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\)/g,
      (_m, target: string, literal: string) =>
        `${target}.includes(${literal})`,
    );
}

/** Value used to validate a query without executing its filter predicates
 *  against real-looking data. jsonpath-plus evaluates `[?(...)]` per item, so
 *  a plain-object placeholder runs the predicate against scalar values and
 *  throws on any property method call (e.g. `@.name.includes('NIFTY')` with
 *  `@.name` undefined) — falsely rejecting valid queries. This Proxy answers
 *  every property access with a callable that coerces to 0, so genuine syntax
 *  errors still throw while valid predicates pass. */
function validationSink(): any {
  return new Proxy(function () {}, {
    get: (_t: unknown, prop: string | symbol) => {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "valueOf") return () => 0;
      if (prop === "toString") return () => "";
      return validationSink();
    },
    apply: () => validationSink(),
  });
}

// ── Root-key extraction ────────────────────────────────────────────────────

function extractRootKey(query: string): { rootKey: string; remaining: string } {
  const stripped = query.replace(/^\$(\.(?!\.))?/, "");
  // No leading field name (root-level expression): "$[?(...)]", "$[n:m]", "$[*]",
  // "$..name", "$.name" where the root itself is an array. The whole expression
  // targets the root value, so rootKey stays "" and everything is "remaining".
  if (!stripped || /^[[.]/.test(stripped)) return { rootKey: "", remaining: stripped };
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

/** Largest container (in bytes) a local fallback query will fully materialize
 *  in memory so filter/projection expressions can scan past the 10-item
 *  preview. Larger containers keep the preview cap (avoids OOM on a
 *  manifest-less multi-GB file). */
const SAFE_QUERY_SCAN_BYTES = Number(process.env.SAFE_QUERY_SCAN_BYTES) || 256 * 1024 * 1024;

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
  /** True when this frame is the root array container being scanned with a
   *  per-element selector (`selector` parse param) — each completed element is
   *  evaluated individually instead of being built into a result array. */
  selScan: boolean;
  /** 0-based element index within the scanned array. */
  selIndex: number;
  /** Total number of selector matches seen so far (drives pagination). */
  selTotal: number;
  /** Collected selector matches, capped at selectorOffset + selectorLimit. */
  selResults: any[];
}

function parseJsonStream(
  readable: NodeJS.ReadableStream,
  jsonPath: string,
  depth: number,
  knownCount?: number,
  previewSize: number = MAX_PREVIEW_SIZE,
  selector?: string,
  selectorOffset = 0,
  selectorLimit = 100,
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
      // Only the root build frame of the scanned container runs the selector;
      // it materializes elements to unlimited depth so filter predicates see
      // the full item, not a depth-truncated stub.
      const selScan = selector != null && mode === "build" && isArray && stack.length === 0;
      stack.push({
        mode, isArray, depth: selScan ? Number.POSITIVE_INFINITY : frameDepth,
        result: mode === "build" ? (isArray ? [] : {}) : null,
        count: 0, key: null, target, navRest, navIndex: -1,
        selScan, selIndex: 0, selTotal: 0, selResults: [],
      });
    }

    function selectorResult(frame: Frame) {
      return { [SELECTOR_RESULT]: true, results: frame.selResults, total: frame.selTotal };
    }

    /** Apply the selector expression to one completed array element and record
     *  any matches. Positional accessors ([n], [n:m], [n:], [:m], [*]) select
     *  by element index; anything else (filters [?(...)], recursive descent) is
     *  evaluated against the element wrapped in a single-item array. */
    function emitSelectorValue(frame: Frame, value: any) {
      const acc = parseArrayAccessor(selector!);
      if (acc) {
        const idx = frame.selIndex++;
        if (idx >= acc.start && idx < acc.end) {
          const selected = acc.rest ? jsonpathMatch("$" + acc.rest, value) : [value];
          for (const s of selected) {
            if (frame.selTotal >= selectorOffset && frame.selResults.length < selectorLimit) {
              frame.selResults.push(s);
            }
            frame.selTotal++;
          }
        }
        // Finite end: total is known once the last selected element is done —
        // stop scanning (drops the rest of the stream) instead of walking the
        // whole container.
        if (acc.end !== Infinity && idx + 1 >= acc.end) {
          finish(selectorResult(frame));
        }
        return;
      }
      const matches = jsonpathMatch("$" + selector!, [value]);
      for (const s of matches) {
        if (frame.selTotal >= selectorOffset && frame.selResults.length < selectorLimit) {
          frame.selResults.push(s);
        }
        frame.selTotal++;
      }
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
          const popped = stack[stack.length - 1];
          const value = popFrame(event.name);
          if (stack.length === 0) {
            if (popped.selScan) {
              finish(selectorResult(popped));
            } else {
              finish(value);
            }
            return;
          }
          const parent = stack[stack.length - 1];
          if (parent.mode === "build") {
            if (parent.selScan) {
              emitSelectorValue(parent, value);
            } else if (parent.isArray) {
              parent.result.push(value);
              if (parent.result.length > previewSize) {
                parent.result.pop();
                if (knownCount != null) {
                  parent.result.push(truncatedMarker("array", knownCount - previewSize));
                  finish(parent.result);
                  return;
                }
                parent.mode = "skip";
                parent.count = previewSize + 1;
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
            if (frame.selScan) {
              emitSelectorValue(frame, val);
            } else if (frame.isArray) {
              frame.result.push(val);
              if (frame.result.length > previewSize) {
                frame.result.pop();
                if (knownCount != null) {
                  frame.result.push(truncatedMarker("array", knownCount - previewSize));
                  finish(frame.result);
                  return;
                }
                frame.mode = "skip";
                frame.count = previewSize + 1;
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
  if (!idx || typeof idx !== "object") return false;
  // Array-root file: buildIndex emits depth1 = null and no rootKeys, with "$"
  // as the root array container. The root container being structurally sound
  // is enough — accept it so we don't rebuild a huge index on every request.
  if (idx.depth1 == null) {
    const root = idx.containers?.["$"];
    if (!root || typeof root !== "object") return false;
    if (root.type !== "array") return false;
    return root.offset != null && root.endOffset != null && root.endOffset >= root.offset;
  }
  if (typeof idx.depth1 !== "object") return false;
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
  let { rootKey, remaining } = extractRootKey(query);
  if (!entry.chunks[rootKey] && entry.chunks["$"]) rootKey = "$";
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

/** Number of array items the local fallback should parse for a query. Filters
 *  and positional selectors (`remaining` starting with `[`) must scan array
 *  elements, so pull the whole container when its byte span is small enough;
 *  otherwise keep the 10-item preview to avoid materializing a huge file. */
function queryPreviewSize(remaining: string, byteSpan: number | undefined): number {
  if (remaining && /^\[/.test(remaining) && byteSpan != null && byteSpan <= SAFE_QUERY_SCAN_BYTES) {
    return Number.MAX_SAFE_INTEGER;
  }
  return MAX_PREVIEW_SIZE;
}

/** Whether a `[`-leading selector must be evaluated by streaming per-element
 *  scan instead of materializing the container: the container is an array, and
 *  it's too big to hold in memory (or its byte span is unknown). */
function needsSelector(
  remaining: string,
  byteSpan: number | undefined,
  type?: string,
): boolean {
  if (!remaining || !/^\[/.test(remaining)) return false;
  if (type != null && type !== "array") return false;
  if (byteSpan == null) return true;
  return byteSpan > SAFE_QUERY_SCAN_BYTES;
}

/** Parse a byte window of a local file and evaluate the query's `remaining`
 *  fragment against it — either by materializing the container (small byte
 *  span) or via the streaming per-element selector scan (large span). Returns
 *  null when the container can't be resolved. */
async function runQueryOnRange(
  filePath: string,
  jsonPath: string,
  remaining: string,
  depth: number,
  knownCount: number | undefined,
  start: number,
  end: number | undefined,
  containerType: string | undefined,
  offset: number,
  limit: number,
): Promise<{ results: any[]; total: number } | null> {
  const byteSpan = end != null ? end - start : undefined;
  const fileStream = createReadStream(filePath, { start, end });
  if (needsSelector(remaining, byteSpan, containerType)) {
    const scan = await parseJsonStream(
      fileStream, jsonPath, depth, knownCount, MAX_PREVIEW_SIZE,
      remaining, offset, limit,
    );
    if (scan === undefined) return null;
    if (isSelectorResult(scan)) return { results: scan.results, total: scan.total };
    return applyQueryResults(scan, remaining, offset, limit);
  }
  const rootData = await parseJsonStream(
    fileStream, jsonPath, depth, knownCount,
    queryPreviewSize(remaining, byteSpan),
  );
  if (rootData === undefined) return null;
  return applyQueryResults(rootData, remaining, offset, limit);
}

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
        const r = await runQueryOnRange(
          filePath, "$", remaining, depth, ci.count,
          ci.offset, ci.endOffset, ci.type, offset, limit,
        );
        if (r !== null) return r;
      }
    }

    // Ancestor walk-up
    if (rootKey && index.containers) {
      const segs = rootKey.split(".").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const ancestorPath = (i === 0 ? "$" : "$." + segs.slice(0, i).join("."));
        const anc = index.containers[ancestorPath];
        if (anc?.offset != null) {
          const r = await runQueryOnRange(
            filePath, segs.slice(i).join("."), remaining, depth, anc.count,
            anc.offset, anc.endOffset, anc.type, offset, limit,
          );
          if (r !== null) return r;
        }
      }
    }

    // rootKeys snapshot
    if (index.rootKeys?.[rootKey]) {
      const keyInfo = index.rootKeys[rootKey];
      if (keyInfo?.offset != null) {
        const r = await runQueryOnRange(
          filePath, "$", remaining, depth, keyInfo.count,
          keyInfo.offset, keyInfo.endOffset, undefined, offset, limit,
        );
        if (r !== null) return r;
      }
    }
  }

  // Fallback: stream-parse the entire file
  const jsonPath = rootKey ? `$.${rootKey}` : "$";
  const fileSize = statSync(filePath).size;
  const r = await runQueryOnRange(
    filePath, jsonPath, remaining, depth, undefined,
    0, fileSize, undefined, offset, limit,
  );
  if (r !== null) return r;

  return { results: [], total: 0 };
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
    if (Array.isArray(rootData) && /^\[/.test(remaining)) {
      // Root-level selector on an array: a filter (`[?(...)]`) or positional
      // accessor targets the array itself, not a single element — jsonpath-plus
      // never matches a filter applied to one object, so evaluate over the whole
      // array at once.
      try {
        const matches = jsonpath(expr, rootData);
        if (Array.isArray(matches)) results.push(...matches);
        else if (matches !== undefined && matches !== null) results.push(matches);
      } catch {
        // Expression didn't match
      }
    } else if (Array.isArray(rootData)) {
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
    const byteSpan = contentLength > 0 ? contentLength : undefined;

    const { remaining } = extractRootKey(query);

    // Stream-parse the response body
    if (res.body) {
      const webStream = res.body;
      const nodeStream = Readable.fromWeb(webStream as any);
      const jsonPath = rootKey ? `$.${rootKey}` : "$";
      if (needsSelector(remaining, byteSpan)) {
        const scan = await parseJsonStream(
          nodeStream, jsonPath, depth, undefined, MAX_PREVIEW_SIZE,
          remaining, offset, limit,
        );
        if (scan === undefined) return { results: [], total: 0 };
        if (isSelectorResult(scan)) return { results: scan.results, total: scan.total };
        return applyQueryResults(scan, remaining, offset, limit);
      }
      const rootData = await parseJsonStream(nodeStream, jsonPath, depth, undefined, queryPreviewSize(remaining, byteSpan));
      if (rootData === undefined) return { results: [], total: 0 };
      return applyQueryResults(rootData, remaining, offset, limit);
    }

    // Fallback to text parse if no stream available
    const text = await res.text();
    const data = JSON.parse(text);
    const rootData = rootKey ? data[rootKey] : data;
    if (rootData === undefined) return { results: [], total: 0 };
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
  const query = normalizeFilterQuery(body.query?.trim() ?? "");
  const depth = Math.max(0, Math.min(body.depth ?? 2, 12));
  const offset = Math.max(0, body.offset ?? 0);
  const limit = Math.max(1, Math.min(body.limit ?? 100, 1000));

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }
  if (!query) {
    return NextResponse.json({ error: "Missing 'query'" }, { status: 400 });
  }
  // The `?{...}` filter typo is rewritten to `?(...)` above; anything left is a
  // form jsonpath-plus silently ignores — reject it instead of returning an
  // empty result set.
  if (/\[\?\{/.test(query)) {
    return NextResponse.json(
      { error: `Unsupported filter syntax '?{...}' — use '?(...)': ${query}` },
      { status: 400 },
    );
  }

  // Validate the JSONPath expression by trying to parse it. Run it against a
  // truthy-sink array instead of a plain object so filter predicates that call
  // string methods (e.g. `@.name.includes('NIFTY')`) don't false-positive on
  // property access against undefined.
  try {
    jsonpath(query, [validationSink()]);
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

    // 1. Manifest-backed entry (Fastify). Only used when it actually has chunks
    //    — a registered manifest with zero split chunks (e.g. a root-level
    //    array the splitter can't split) can't satisfy any query, so fall
    //    through to the local index/stream path instead of returning nothing.
    const manifestEntry = getManifestEntry(id);
    if (manifestEntry && Object.keys(manifestEntry.chunks ?? {}).length > 0) {
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
