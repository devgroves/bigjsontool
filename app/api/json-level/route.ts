import { NextRequest, NextResponse } from "next/server";
import { createReadStream, readFileSync, existsSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { parserStream } from "stream-json";
import { dataPath, isValidId, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";
import { getRemoteEntry } from "../../lib/remoteFileStore";

export const dynamic = "force-dynamic";

function truncatedMarker(kind: "object" | "array", count: number) {
  return { __truncated__: true, __kind__: kind, __count__: count };
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
  arrayOffset: number;
}

function parseJsonStream(
  readable: NodeJS.ReadableStream,
  jsonPath: string,
  depth: number,
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
      (readable as any).destroy?.();
    }

    function pushFrame(mode: FrameMode, isArray: boolean, frameDepth: number,
                       target: string | null, navRest: string[],
                       ao = 0) {
      stack.push({
        mode, isArray, depth: frameDepth,
        result: mode === "build" ? (isArray ? [] : {}) : null,
        count: 0, key: null, target, navRest, navIndex: -1, arrayOffset: ao,
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

      if (stack.length === 0) {
        if (segments.length > 0) {
          if (event.name === "startObject" || event.name === "startArray") {
            pushFrame("nav", event.name === "startArray", -1, segments[0], segments.slice(1));
          } else {
            finish(undefined);
          }
        } else {
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
          const val = scalarFromEvent(event);
          if (frame.mode === "build") {
            if (frame.isArray) {
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
): Promise<any> {
  const fileStream = startOffset != null
    ? createReadStream(filePath, { start: startOffset, end: endOffset })
    : createReadStream(filePath);
  return parseJsonStream(fileStream, jsonPath, depth, knownCount, arrayOffset);
}

function extractFromText(
  text: string,
  jsonPath: string,
  depth: number,
  knownCount?: number,
  arrayOffset?: number,
): Promise<any> {
  const textStream = Readable.from([text]);
  return parseJsonStream(textStream, jsonPath, depth, knownCount, arrayOffset);
}

/** Minimal validity check.  A corrupted index from the earlier inString bug
 *  produces depth1 string/number values where truncated markers should be,
 *  causing the root-expansion loop to silently do nothing and fall through
 *  to the slow path.  We detect that pattern here and force a rebuild. */
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

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const jsonPath = searchParams.get("path") || "$";
  const depth = Math.max(0, Math.min(Number(searchParams.get("depth")) || 1, 12));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }

  // ── Remote entry (in-memory, no disk file) ───────────────────────────
  const remoteEntry = getRemoteEntry(id);
  if (remoteEntry) {
    const re = remoteEntry;
    if (jsonPath === "$" && depth === 1) {
      if (re.depth1Snapshot) {
        return NextResponse.json({ path: "$", depth: 1, value: re.depth1Snapshot });
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
            return await extractFromText(text, "$", depth, (ci.count ?? 0) - offset, offset || undefined);
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
              return await extractFromText(text, subPath, depth, (anc.count ?? 0) - offset, offset || undefined);
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
            return await extractFromText(text, subPath, depth, (keyInfo.count ?? 0) - offset, offset || undefined);
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

    // depth>1 at root — expand root containers via per-child Range-fetches
    if (idxHasDepth1(index) && idxHasContainers(index) && jsonPath === "$" && depth > 1) {
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
                const text = await rangeFetch(re.url, childInfo.offset, childInfo.endOffset);
                const child = await extractFromText(text, "$", depth - 1, childInfo.count);
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
          anyExpanded = true;
        } else {
          try {
            const text = await rangeFetch(re.url, ci.offset, ci.endOffset);
            const expanded = await extractFromText(text, "$", depth - 1, ci.count);
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

  if (index?.depth1 && jsonPath === "$" && depth === 1) {
    return NextResponse.json({ path: "$", depth: 1, value: index.depth1 });
  }

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
            offset || undefined,
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
              offset || undefined,
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
            offset || undefined,
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
