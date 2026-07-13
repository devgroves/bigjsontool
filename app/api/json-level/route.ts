import { NextRequest, NextResponse } from "next/server";
import { createReadStream, readFileSync, existsSync, writeFileSync } from "node:fs";
import { parserStream } from "stream-json";
import { dataPath, isValidId, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";

export const dynamic = "force-dynamic";

function truncatedMarker(kind: "object" | "array", count: number) {
  return { __truncated__: true, __kind__: kind, __count__: count };
}

// Arrays that grow past this size are collapsed into a truncated marker
// mid-flight (the frame flips from "build" to "skip" and discards further
// items). This prevents OOM when depth=2 materialises an array with
// hundreds of thousands of entries (e.g. a 1 GB file with 500 K+ records).
// When exceeded, the first MAX_PREVIEW_SIZE items are kept and a
// TruncatedMarker is appended so the user sees real data immediately.
const MAX_PREVIEW_SIZE = 10;

// With packValues+streamValues the parser emits only complete tokens
// (keyValue, stringValue, numberValue, start/endObject, start/endArray,
// trueValue, falseValue, nullValue) — no intermediate startKey/stringChunk
// etc. This cuts the event count by ~70% and avoids extra dispatch overhead.
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

// ---------------------------------------------------------------------------
// Stack-based state machine — replaces the previous generator approach.
//
// Instead of a generator that yields for every token (high context-switch
// overhead), we maintain a single stack of frames. Each token arrives in the
// "data" event handler and is dispatched immediately to the top frame.
// Frames know their mode ("build", "skip", or "nav") and handle tokens
// directly without pausing/resuming generators.
//
// In "build" mode the frame accumulates the depth-limited result tree.
// In "skip" mode it counts children (depth exceeded) and discards contents.
// In "nav" mode it walks the JSON tree looking for a specific key/index path.
// ---------------------------------------------------------------------------

type FrameMode = "build" | "skip" | "nav";

interface Frame {
  mode: FrameMode;
  isArray: boolean;
  depth: number;          // remaining depth (build) or -1 (skip/nav)
  result: any;            // accumulated object/array (build mode)
  count: number;          // child count (skip mode)
  key: string | null;     // current key for object frame
  target: string | null;  // key/index we are looking for (nav mode)
  navRest: string[];      // remaining path segments after target (nav mode)
  navIndex: number;       // current array index (nav mode)
  arrayOffset: number;    // items to skip before building (pagination)
}

function extractFromFile(
  filePath: string,
  jsonPath: string,
  depth: number,
  startOffset?: number,
  endOffset?: number,
  knownCount?: number,
  arrayOffset?: number,
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
      fileStream.destroy();
    }

    function pushFrame(mode: FrameMode, isArray: boolean, frameDepth: number,
                       target: string | null, navRest: string[],
                       arrayOffset = 0) {
      stack.push({
        mode,
        isArray,
        depth: frameDepth,
        result: mode === "build" ? (isArray ? [] : {}) : null,
        count: 0,
        key: null,
        target,
        navRest,
        navIndex: -1,
        arrayOffset,
      });
    }

    function popFrame(eventName: string): any {
      const frame = stack.pop()!;
      if (frame.mode === "skip") {
        if (frame.result && frame.count > 0) {
          const remaining = frame.count - (Array.isArray(frame.result) ? frame.result.length : 0);
          if (remaining > 0) {
            (frame.result as any[]).push(
              truncatedMarker(eventName === "endArray" ? "array" : "object", remaining)
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

      // --- stack empty — root token ---
      if (stack.length === 0) {
        if (segments.length > 0) {
          // Navigation mode — need to find the path
          if (event.name === "startObject" || event.name === "startArray") {
            pushFrame("nav", event.name === "startArray", -1, segments[0], segments.slice(1));
          } else {
            finish(undefined); // root is scalar, path won't match
          }
        } else {
          // Building from root — pass arrayOffset for pagination
          if (event.name === "startObject" || event.name === "startArray") {
            const ao = event.name === "startArray" ? (arrayOffset ?? 0) : 0;
            pushFrame("build", event.name === "startArray", depth, null, [], ao);
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

    // -------- NAVIGATION --------
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
              const aoArr = event.name === "startArray" ? (arrayOffset ?? 0) : 0;
              if (frame.navRest.length === 0) {
                pushFrame("build", event.name === "startArray", depth, null, [], aoArr);
              } else {
                pushFrame("nav", event.name === "startArray", -1, frame.navRest[0], frame.navRest.slice(1));
              }
            } else {
              skipContainer(event);
            }
            return;
          }
          default: {
            // scalar array element
            frame.navIndex++;
            if (String(frame.navIndex) === frame.target) {
              if (frame.navRest.length === 0) {
                finish(scalarFromEvent(event));
              } else {
                finish(undefined); // scalar can't have children
              }
            }
            return;
          }
        }
      } else {
        // Navigating inside an object — keys come via keyValue
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
              const aoObj = event.name === "startArray" ? (arrayOffset ?? 0) : 0;
              if (frame.navRest.length === 0) {
                pushFrame("build", event.name === "startArray", depth, null, [], aoObj);
              } else {
                pushFrame("nav", event.name === "startArray", -1, frame.navRest[0], frame.navRest.slice(1));
              }
            } else {
              skipContainer(event);
            }
            return;
          }
          default: {
            // scalar value for an object key
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

    // -------- BUILD / SKIP --------
    function processBuildOrSkip(event: Token, frame: Frame) {
      switch (event.name) {
        case "keyValue": {
          frame.key = event.value;
          return;
        }
        case "startObject":
        case "startArray": {
          const isArr = event.name === "startArray";
          // When the parent array has an arrayOffset > 0 we skip
          // building that item's children entirely.
          if (frame.mode === "skip" || frame.depth - 1 <= 0 || frame.arrayOffset > 0) {
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
              // Pagination: skip items without adding to result
              if (parent.arrayOffset > 0) {
                parent.arrayOffset--;
                return;
              }
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
          // scalar
          const val = scalarFromEvent(event);
          if (frame.mode === "build") {
            if (frame.isArray) {
              // Pagination: skip items without adding to result
              if (frame.arrayOffset > 0) {
                frame.arrayOffset--;
                return;
              }
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

    const fileStream = startOffset != null
      ? createReadStream(filePath, { start: startOffset, end: endOffset })
      : createReadStream(filePath);
    const tokenStream = parserStream({ packValues: true, streamValues: false });
    fileStream.pipe(tokenStream);

    tokenStream.on("data", processToken);
    tokenStream.on("end", () => finish(undefined));
    tokenStream.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    fileStream.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

/** Minimal validity check.  A corrupted index from the earlier inString bug
 *  produces depth1 string/number values where truncated markers should be,
 *  causing the root-expansion loop to silently do nothing and fall through
 *  to the slow path.  We detect that pattern here and force a rebuild. */
function isValidIndex(idx: Record<string, any>): boolean {
  if (!idx?.depth1 || typeof idx.depth1 !== "object") return false;
  // depth1 has proper truncated markers → valid
  const hasMarker = Object.values(idx.depth1).some(
    (v: any) => v && typeof v === "object" && v.__truncated__ != null,
  );
  if (hasMarker) return true;

  const depth1Keys = Object.keys(idx.depth1);
  if (depth1Keys.length === 0) return false;

  const containerCount = idx.containers ? Object.keys(idx.containers).length : 0;
  // Only root container ($) and no rootKeys → likely corrupted inString output
  if (containerCount === 1 && !idx.rootKeys) return false;
  // Has non-root containers but no truncated markers → corrupted
  if (containerCount > 1) return false;
  // Scalar-only file with no containers → valid
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
  // Rebuild the index on demand from the data file.
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

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }

  const basePath = dataPath(id);
  if (!existsSync(basePath)) {
    return NextResponse.json(
      { error: `No saved file for id '${id}'.` },
      { status: 404 }
    );
  }

  // ----- Pre-computed index (load or rebuild) -----
  const index = loadOrBuildIndex(id, basePath);

  // depth=1 at root → instant from the depth1 snapshot
  if (index?.depth1 && jsonPath === "$" && depth === 1) {
    return NextResponse.json({ path: "$", depth: 1, value: index.depth1 });
  }

  // Helper: resolve any path using the containers map or rootKeys.
  // 1. If the exact path is in containers → direct byte-range seek (no nav).
  // 2. If not, walk up to the deepest recorded ancestor and navigate from
  //    that byte range — avoids scanning the whole file.
  // 3. Fall back to rootKeys-based navigation (root-level byte range).
  async function resolvePath(path: string): Promise<any | undefined> {
    if (!index) return undefined;
    const segs = path.replace(/^\$\.?/, "").split(".").filter(Boolean);

    // (a) Exact match in containers
    if (index.containers?.[path]) {
      const ci = index.containers[path];
      if (ci.offset != null) {
        try {
          return await extractFromFile(
            basePath, "$", depth,
            ci.offset, ci.endOffset, ci.count,
            offset || undefined,
          );
        } catch { /* fall through */ }
      }
    }

    // (b) Ancestor walk-up: find deepest recorded container ancestor
    if (index.containers && segs.length > 0) {
      for (let i = segs.length - 1; i >= 0; i--) {
        const ancestorPath = (i === 0 ? "$" : "$." + segs.slice(0, i).join("."));
        const anc = index.containers[ancestorPath];
        if (anc?.offset != null) {
          const subPath = segs.slice(i).join(".");
          try {
            return await extractFromFile(
              basePath, subPath, depth,
              anc.offset, anc.endOffset, anc.count,
              offset || undefined,
            );
          } catch { return undefined; }
        }
      }
    }

    // (c) rootKeys navigation (root-level containers not in containers map)
    if (index.rootKeys && segs.length > 0) {
      const topKey = segs[0];
      const keyInfo = index.rootKeys[topKey];
      if (keyInfo?.offset != null) {
        const subPath = segs.length > 1 ? segs.slice(1).join(".") : "$";
        try {
          return await extractFromFile(
            basePath, subPath, depth,
            keyInfo.offset, keyInfo.endOffset, keyInfo.count,
            offset || undefined,
          );
        } catch { return undefined; }
      }
    }

    return undefined;
  }

  // Try path resolution (containers → ancestor → rootKeys) for non-root paths.
  if (jsonPath !== "$") {
    const val = await resolvePath(jsonPath);
    if (val !== undefined) {
      return NextResponse.json({ path: jsonPath, depth, value: val });
    }
  }

  // depth>1 at root → expand each root-level container by one level via
  // per-child byte-range seeks.  This avoids parsing the entire container
  // (e.g. the whole records array) — we seek directly to each child's
  // container entry in the index and build only that child.
  if (index?.depth1 && index?.containers && jsonPath === "$" && depth > 1) {
    const cm = index.containers as Record<string, { offset: number; endOffset?: number; count?: number; type: string }>;
    const base = JSON.parse(JSON.stringify(index.depth1));
    let anyExpanded = false;

    for (const [key, marker] of Object.entries(base)) {
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
              );
              if (child !== undefined) items.push(child);
              else items.push(truncatedMarker(childInfo.type as "object" | "array", childInfo.count ?? 0));
            } catch {
              items.push(truncatedMarker(childInfo.type as "object" | "array", childInfo.count ?? 0));
            }
          } else {
            // Child not in index — insert placeholder; the tree view will
            // lazy-load it on expand via resolvePath → ancestor walk-up.
            items.push({ __truncated__: true, __kind__: "object", __count__: 0 });
          }
        }
        const remaining = (ci.count ?? 0) - maxItems;
        if (remaining > 0) {
          items.push(truncatedMarker("array", remaining));
        }
        base[key] = items;
        anyExpanded = true;
      } else {
        // Root-level object container — single seek, expand one level
        try {
          const expanded = await extractFromFile(
            basePath, "$", depth - 1,
            ci.offset, ci.endOffset, ci.count,
          );
          if (expanded !== undefined) {
            base[key] = expanded;
            anyExpanded = true;
          }
        } catch { /* keep marker */ }
      }
    }

    if (anyExpanded) {
      return NextResponse.json({ path: "$", depth, value: base });
    }
  }

  // ----- Slow path: full file scan (no index or path not resolved) -----
  let value: any;
  try {
    value = await extractFromFile(basePath, jsonPath, depth, undefined, undefined, undefined, offset || undefined);
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
