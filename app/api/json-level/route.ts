import { NextRequest, NextResponse } from "next/server";
import { createReadStream, readFileSync, existsSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { parserStream } from "stream-json";
import { dataPath, isValidId, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";
import { getRemoteEntry } from "../../lib/remoteFileStore";
import { getManifestEntry } from "../../lib/manifestFileStore";
import { resolveManifestValue } from "../../lib/manifestJsonValue";

export const dynamic = "force-dynamic";

/** Synthetic object key used to hold a "more entries remain" marker when a
 *  container (or the root object) is paginated. The client detects it by the
 *  marker's VALUE shape, so the key itself never needs to match real data. */
const RESERVED_MARKER_KEY = "\u2026"; // "…"

function truncatedMarker(kind: "object" | "array", count: number, offset?: number) {
  const marker: Record<string, unknown> = { __truncated__: true, __kind__: kind, __count__: count };
  if (offset != null) marker.__offset__ = offset;
  return marker;
}

const MAX_PREVIEW_SIZE = 10;

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
  /** Number of leading items/keys to skip when paging through a container. */
  offset: number;
  /** The offset this frame began at — used to compute the `__offset__` on a
   *  remainder marker so the client knows where the next page starts. */
  startOffset: number;
  /** Max entries kept in a build frame before it truncates to a marker. */
  previewSize: number;
}

function parseJsonStream(
  readable: NodeJS.ReadableStream,
  jsonPath: string,
  depth: number,
  knownCount?: number,
  arrayOffset?: number,
  previewSize: number = MAX_PREVIEW_SIZE,
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
                       target: string | null, navRest: string[],
                       offset = 0, startOffset = 0) {
      stack.push({
        mode, isArray, depth: frameDepth,
        result: mode === "build" ? (isArray ? [] : {}) : null,
        count: 0, key: null, target, navRest, navIndex: -1,
        offset, startOffset, previewSize,
      });
    }

    function popFrame(eventName: string): any {
      const frame = stack.pop()!;
      const isRoot = stack.length === 0;
      const rootOffset = isRoot ? frame.startOffset + frame.previewSize : undefined;
      if (frame.mode === "skip") {
        if (frame.result && frame.count > 0) {
          const held = frame.isArray
            ? (frame.result as any[]).length
            : Object.keys(frame.result).length;
          const remaining = frame.count - held;
          if (remaining > 0) {
            const marker = truncatedMarker(
              eventName === "endArray" ? "array" : "object",
              remaining,
              rootOffset,
            );
            if (frame.isArray) (frame.result as any[]).push(marker);
            else frame.result[frame.key ?? RESERVED_MARKER_KEY] = marker;
          }
          return frame.result;
        }
        return truncatedMarker(
          eventName === "endArray" ? "array" : "object",
          frame.count,
          rootOffset,
        );
      }
      if (frame.mode === "nav") return undefined;
      return frame.result;
    }

    /** Push a value (scalar or completed child container) into a build frame,
     *  honoring paging offsets and preview-size truncation for BOTH arrays and
     *  objects. The `knownCount` fast-path (which stops early with a remainder
     *  marker) only applies to the ROOT frame — i.e. the container that was
     *  actually fetched — since `knownCount` describes that container's
     *  remaining entries. Nested frames just flip to skip-mode counting. */
    function emitBuildValue(frame: Frame, value: any) {
      const isRoot = stack.length === 1;
      if (frame.isArray) {
        if (frame.offset > 0) { frame.offset--; return; }
        frame.result.push(value);
        if (frame.result.length > frame.previewSize) {
          frame.result.pop();
          if (knownCount != null && isRoot) {
            frame.result.push(truncatedMarker("array", knownCount - frame.previewSize));
            finish(frame.result);
            return;
          }
          frame.mode = "skip";
          frame.count = frame.previewSize + 1;
        }
      } else if (frame.key !== null) {
        if (frame.offset > 0) { frame.offset--; return; }
        frame.result[frame.key] = value;
        if (Object.keys(frame.result).length > frame.previewSize) {
          delete frame.result[frame.key];
          if (knownCount != null && isRoot) {
            frame.result[frame.key] = truncatedMarker(
              "object",
              knownCount - frame.previewSize,
              frame.startOffset + frame.previewSize,
            );
            finish(frame.result);
            return;
          }
          frame.mode = "skip";
          frame.count = frame.previewSize + 1;
        }
      }
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
            const ao = arrayOffset ?? 0;
            pushFrame("build", event.name === "startArray", depth, null, [], ao, ao);
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
              const aoArr = arrayOffset ?? 0;
              if (frame.navRest.length === 0) {
                pushFrame("build", event.name === "startArray", depth, null, [], aoArr, aoArr);
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
              const aoObj = arrayOffset ?? 0;
              if (frame.navRest.length === 0) {
                pushFrame("build", event.name === "startArray", depth, null, [], aoObj, aoObj);
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
          if (frame.mode === "skip" || frame.depth - 1 <= 0 || frame.offset > 0) {
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
            emitBuildValue(parent, value);
          } else if (parent.mode === "skip") {
            parent.count++;
          }
          return;
        }
        default: {
          const val = scalarFromEvent(event);
          if (frame.mode === "build") {
            emitBuildValue(frame, val);
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

function extractFromFile(
  filePath: string,
  jsonPath: string,
  depth: number,
  startOffset?: number,
  endOffset?: number,
  knownCount?: number,
  arrayOffset?: number,
  previewSize?: number,
): Promise<any> {
  const fileStream = startOffset != null
    ? createReadStream(filePath, { start: startOffset, end: endOffset })
    : createReadStream(filePath);
  return parseJsonStream(fileStream, jsonPath, depth, knownCount, arrayOffset, previewSize);
}

function extractFromText(
  text: string,
  jsonPath: string,
  depth: number,
  knownCount?: number,
  arrayOffset?: number,
  previewSize?: number,
): Promise<any> {
  const textStream = Readable.from([text]);
  return parseJsonStream(textStream, jsonPath, depth, knownCount, arrayOffset, previewSize);
}

/** Minimal validity check.  A corrupted index from the earlier inString bug
 *  produces depth1 string/number values where truncated markers should be,
 *  causing the root-expansion loop to silently do nothing and fall through
 *  to the slow path.  We detect that pattern here and force a rebuild. */
function isValidIndex(idx: Record<string, any>): boolean {
  if (!idx || typeof idx !== "object") return false;
  // Array-root file: buildIndex emits depth1 = null and no rootKeys, with "$"
  // as the root array container. A structurally sound root container is enough
  // — accept it so we don't rebuild a huge index on every expand (which made
  // tree expansion appear to "do nothing" for multi-GB array-root uploads).
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

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const jsonPath = searchParams.get("path") || "$";
  const depth = Math.max(0, Math.min(Number(searchParams.get("depth")) || 1, 12));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const limit = Math.max(1, Math.min(Number(searchParams.get("limit")) || MAX_PREVIEW_SIZE, 1000));

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }

  // ── Manifest-backed entry (Fastify) — checked first ────────────────────
  // A registered manifest with zero split chunks (root-level array the splitter
  // can't split) can't resolve anything — skipping it lets the local disk path
  // below serve the real tree instead of an empty object.
  const manifestEntry = getManifestEntry(id);
  console.info(`[json-level] manifest entry ${manifestEntry}`);
  if (manifestEntry && Object.keys(manifestEntry.chunks ?? {}).length > 0) {
    const startMs = Date.now();
    console.info(`[json-level] manifest hit for ${id}, path=${jsonPath}, depth=${depth}, offset=${offset}`);
    try {
      const value = await resolveManifestValue(manifestEntry, jsonPath, depth, offset, limit);
      const elapsed = Date.now() - startMs;
      console.info(`[json-level] manifest resolved in ${elapsed}ms, path=${jsonPath}`);
      if (value === undefined) {
        return NextResponse.json({ error: `Path '${jsonPath}' not found` }, { status: 404 });
      }
      return NextResponse.json({ path: jsonPath, depth, value });
    } catch (e: any) {
      const elapsed = Date.now() - startMs;
      console.warn(`[json-level] manifest query failed after ${elapsed}ms:`, e?.message);
      return NextResponse.json({ error: e.message ?? "Manifest query failed" }, { status: 500 });
    }
  }

  // ── Remote entry (in-memory, no disk file) ───────────────────────────
  const remoteEntry = getRemoteEntry(id);
  if (remoteEntry) {
    const re = remoteEntry;
    if (jsonPath === "$" && depth === 1) {
      if (re.depth1Snapshot) {
        const entries = Object.entries(re.depth1Snapshot);
        const total = entries.length;
        if (offset >= total) return NextResponse.json({ path: "$", depth: 1, value: {} });
        const page = entries.slice(offset, offset + limit);
        const value: Record<string, any> = {};
        for (const [k, v] of page) value[k] = v;
        if (offset + page.length < total) {
          value[RESERVED_MARKER_KEY] = truncatedMarker("object", total - offset - page.length, offset + page.length);
        }
        return NextResponse.json({ path: "$", depth: 1, value });
      }
      return NextResponse.json({ status: "loading" });
    }

    const index = re.index;
    if (!index) {
      return NextResponse.json({ status: "loading" });
    }

    // Resolve path using the in-memory index, then Range-fetch
    async function resolveRemotePath(path: string): Promise<any | undefined> {
      const segs = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
      const idx = index as any;

      // (a) Exact match in containers — Range-fetch that byte span
      if (idx.containers?.[path]) {
        const ci = idx.containers[path];
        if (ci.offset != null) {
          try {
            const text = await rangeFetch(re.url, ci.offset, ci.endOffset);
            return await extractFromText(text, "$", depth, (ci.count ?? 0) - offset, offset || undefined, limit);
          } catch { /* fall through */ }
        }
      }

      // (b) Ancestor walk-up
      if (idx.containers && segs.length > 0) {
        for (let i = segs.length - 1; i >= 0; i--) {
          const ancestorPath = (i === 0 ? "$" : "$." + segs.slice(0, i).join("."));
          const anc = idx.containers[ancestorPath];
          if (anc?.offset != null) {
            const subPath = segs.slice(i).join(".");
            try {
              const text = await rangeFetch(re.url, anc.offset, anc.endOffset);
              return await extractFromText(text, subPath, depth, (anc.count ?? 0) - offset, offset || undefined, limit);
            } catch { return undefined; }
          }
        }
      }

      // (c) rootKeys navigation
      if (idx.rootKeys && segs.length > 0) {
        const topKey = segs[0];
        const keyInfo = idx.rootKeys[topKey];
        if (keyInfo?.offset != null) {
          const subPath = segs.length > 1 ? segs.slice(1).join(".") : "$";
          try {
            const text = await rangeFetch(re.url, keyInfo.offset, keyInfo.endOffset);
            return await extractFromText(text, subPath, depth, (keyInfo.count ?? 0) - offset, offset || undefined, limit);
          } catch { return undefined; }
        }
      }

      return undefined;
    }

    // Try path resolution for non-root paths
    if (jsonPath !== "$") {
      const val = await resolveRemotePath(jsonPath);
      if (val !== undefined) {
        return NextResponse.json({ path: jsonPath, depth, value: val });
      }
    }

    // depth>1 at root — expand root containers via per-child Range-fetches,
    // paginated over top-level keys [offset, offset+limit).
    if (idxHasDepth1(index) && idxHasContainers(index) && jsonPath === "$" && depth > 1) {
      const cm = index.containers as Record<string, { offset: number; endOffset?: number; count?: number; type: string }>;
      const entries = Object.entries(index.depth1);
      const total = entries.length;
      if (offset >= total) return NextResponse.json({ path: "$", depth, value: {} });
      const base: Record<string, any> = {};
      let consumed = 0;

      for (const [key, marker] of entries) {
        if (consumed < offset) { consumed++; continue; }
        if (consumed >= offset + limit) break;
        consumed++;
        base[key] = marker;
        const m = marker as any;
        if (!m || typeof m !== "object" || !m.__truncated__) continue;
        const containerPath = `$.${key}`;
        const ci = cm[containerPath];
        if (!ci?.offset) continue;

        if (m.__kind__ === "array") {
          const items: any[] = [];
          const maxItems = Math.min(10, ci.count ?? 10);
          for (let i = 0; i < maxItems; i++) {
            const childPath = `${containerPath}.${i}`;
            const childInfo = cm[childPath];
            if (childInfo?.offset != null) {
              try {
                const text = await rangeFetch(re.url, childInfo.offset, childInfo.endOffset);
                const child = await extractFromText(text, "$", depth - 1, childInfo.count, 0, limit);
                if (child !== undefined) items.push(child);
                else items.push(truncatedMarker(childInfo.type as "object" | "array", childInfo.count ?? 0));
              } catch {
                items.push(truncatedMarker(childInfo.type as "object" | "array", childInfo.count ?? 0));
              }
            } else {
              items.push({ __truncated__: true, __kind__: "object", __count__: 0 });
            }
          }
          const remaining = (ci.count ?? 0) - maxItems;
          if (remaining > 0) {
            items.push(truncatedMarker("array", remaining));
          }
          base[key] = items;
        } else {
          try {
            const text = await rangeFetch(re.url, ci.offset, ci.endOffset);
            const expanded = await extractFromText(text, "$", depth - 1, ci.count, 0, limit);
            if (expanded !== undefined) base[key] = expanded;
          } catch { /* keep marker */ }
        }
      }

      if (offset + limit < total) {
        base[RESERVED_MARKER_KEY] = truncatedMarker("object", total - offset - limit, offset + limit);
      }
      return NextResponse.json({ path: "$", depth, value: base });
    }

    // No path resolved or index incomplete
    return NextResponse.json({ status: "loading" });
  }

  // ── Local file (disk-based) ──────────────────────────────────────────
  const basePath = dataPath(id);
  if (!existsSync(basePath)) {
    return NextResponse.json(
      { error: `No saved file for id '${id}'.` },
      { status: 404 }
    );
  }

  const index = loadOrBuildIndex(id, basePath);
  console.info(`[json-level] index build index${id}, path=${jsonPath}, depth=${depth}, offset=${offset}, limit=${limit}`);
  if (index?.depth1 && jsonPath === "$" && depth === 1) {
    const entries = Object.entries(index.depth1 as Record<string, any>);
    const total = entries.length;
    if (offset >= total) return NextResponse.json({ path: "$", depth: 1, value: {} });
    const page = entries.slice(offset, offset + limit);
    const value: Record<string, any> = {};
    for (const [k, v] of page) value[k] = v;
    if (offset + page.length < total) {
      value[RESERVED_MARKER_KEY] = truncatedMarker("object", total - offset - page.length, offset + page.length);
    }
    return NextResponse.json({ path: "$", depth: 1, value });
  }
  console.info
  async function resolvePath(path: string): Promise<any | undefined> {
    if (!index) return undefined;
    const segs = path.replace(/^\$\.?/, "").split(".").filter(Boolean);

      if (index.containers?.[path]) {
      const ci = index.containers[path];
      if (ci.offset != null) {
        try {
          return await extractFromFile(
            basePath, "$", depth,
            ci.offset, ci.endOffset, (ci.count ?? 0) - offset,
            offset || undefined, limit,
          );
        } catch { /* fall through */ }
      }
    }

    if (index.containers && segs.length > 0) {
      for (let i = segs.length - 1; i >= 0; i--) {
        const ancestorPath = (i === 0 ? "$" : "$." + segs.slice(0, i).join("."));
        const anc = index.containers[ancestorPath];
        if (anc?.offset != null) {
          const subPath = segs.slice(i).join(".");
          try {
            return await extractFromFile(
              basePath, subPath, depth,
              anc.offset, anc.endOffset, (anc.count ?? 0) - offset,
              offset || undefined, limit,
            );
          } catch { return undefined; }
        }
      }
    }

    if (index.rootKeys && segs.length > 0) {
      const topKey = segs[0];
      const keyInfo = index.rootKeys[topKey];
      if (keyInfo?.offset != null) {
        const subPath = segs.length > 1 ? segs.slice(1).join(".") : "$";
        try {
          return await extractFromFile(
            basePath, subPath, depth,
            keyInfo.offset, keyInfo.endOffset, (keyInfo.count ?? 0) - offset,
            offset || undefined, limit,
          );
        } catch { return undefined; }
      }
    }

    return undefined;
  }

  if (jsonPath !== "$") {
    const val = await resolvePath(jsonPath);
    if (val !== undefined) {
      return NextResponse.json({ path: jsonPath, depth, value: val });
    }
  }
  console.info(`[json-level] crossed $ file fetch for ${id}, path=${jsonPath}, depth=${depth}, offset=${offset}, limit=${limit}`);
  if (index?.depth1 && index?.containers && jsonPath === "$" && depth > 1) {
    const cm = index.containers as Record<string, { offset: number; endOffset?: number; count?: number; type: string }>;
    const entries = Object.entries(index.depth1 as Record<string, any>);
    const total = entries.length;
    if (offset >= total) return NextResponse.json({ path: "$", depth, value: {} });
    const base: Record<string, any> = {};
    let consumed = 0;

    for (const [key, marker] of entries) {
      if (consumed < offset) { consumed++; continue; }
      if (consumed >= offset + limit) break;
      consumed++;
      base[key] = marker;
      const m = marker as any;
      if (!m || typeof m !== "object" || !m.__truncated__) continue;
      const containerPath = `$.${key}`;
      const ci = cm[containerPath];
      if (!ci?.offset) continue;

      if (m.__kind__ === "array") {
        const items: any[] = [];
        const maxItems = Math.min(10, ci.count ?? 10);
        for (let i = 0; i < maxItems; i++) {
          const childPath = `${containerPath}.${i}`;
          const childInfo = cm[childPath];
          if (childInfo?.offset != null) {
            try {
              const child = await extractFromFile(
                basePath, "$", depth - 1,
                childInfo.offset, childInfo.endOffset, childInfo.count,
                undefined, limit,
              );
              if (child !== undefined) items.push(child);
              else items.push(truncatedMarker(childInfo.type as "object" | "array", childInfo.count ?? 0));
            } catch {
              items.push(truncatedMarker(childInfo.type as "object" | "array", childInfo.count ?? 0));
            }
          } else {
            items.push({ __truncated__: true, __kind__: "object", __count__: 0 });
          }
        }
        const remaining = (ci.count ?? 0) - maxItems;
        if (remaining > 0) {
          items.push(truncatedMarker("array", remaining));
        }
        base[key] = items;
      } else {
        try {
          const expanded = await extractFromFile(
            basePath, "$", depth - 1,
            ci.offset, ci.endOffset, ci.count,
            undefined, limit,
          );
          if (expanded !== undefined) base[key] = expanded;
        } catch { /* keep marker */ }
      }
    }

    if (offset + limit < total) {
      base[RESERVED_MARKER_KEY] = truncatedMarker("object", total - offset - limit, offset + limit);
    }
    return NextResponse.json({ path: "$", depth, value: base });
  }
  console.info(`[json-level] index depth file fetch for ${id}, path=${jsonPath}, depth=${depth}, offset=${offset}, limit=${limit}`);
  let value: any;
  try {
    const rootInfo = index?.containers?.["$"] as { count?: number } | undefined;
    const rootKnownCount = rootInfo?.count != null ? rootInfo.count - (offset || 0) : undefined;
    value = await extractFromFile(basePath, jsonPath, depth, undefined, undefined, rootKnownCount, offset || undefined, limit);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Stored file is not valid JSON, or is truncated: ${err?.message ?? "parse error"}` },
      { status: 422 }
    );
  }

  if (value === undefined) {
    return NextResponse.json({ error: `Path '${jsonPath}' not found` }, { status: 404 });
  }

  return NextResponse.json({ path: jsonPath, depth, value });
}

async function rangeFetch(url: string, start: number, end?: number): Promise<string> {
  if (end == null) end = start + 1024 * 1024; // default 1MB range
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (!res.ok) throw new Error(`Range fetch failed with ${res.status}`);
  return res.text();
}

function idxHasDepth1(idx: any): boolean {
  return !!(idx?.depth1 && typeof idx.depth1 === "object");
}

function idxHasContainers(idx: any): boolean {
  return !!idx?.containers;
}
