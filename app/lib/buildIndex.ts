// Only record containers at depth ≤ 3 and within the first
// MAX_PREVIEW_SIZE items of any array.  This keeps the index small
// (~30 entries for typical files) while covering every node the
// tree view can expand.  Deeper / further items are reached via the
// existing nav-mode navigation within a rootKey's byte-range.
const MAX_CONTAINER_DEPTH = 3;
const MAX_ARRAY_ITEMS = 10;

export interface ContainerInfo {
  offset: number;
  endOffset?: number;
  count?: number;
  type: "object" | "array";
}

export interface IndexData {
  /** Truncated depth=1 view of the root (scalar values + TruncatedMarkers
   *  for containers).  Lets the initial tree render instantly. */
  depth1: any;
  /** Byte-offset map for containers within a practical scope
   *  (depth ≤ MAX_CONTAINER_DEPTH, first MAX_ARRAY_ITEMS items per array).
   *  The json-level route uses these to seek directly without re-scanning. */
  containers: Record<string, ContainerInfo>;
  /** All root-level containers (objects + arrays) — used as the primary
   *  byte-range seeking mechanism.  */
  rootKeys?: Record<string, { offset: number; endOffset?: number; count?: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single‑pass character scanner.
//
// Walks the raw JSON text byte‑by‑byte and records:
//   • byte offsets for containers within scope (depth ≤ 3, first 10 items)
//   • root‑level scalar values (for the depth‑1 snapshot)
//   • all root-level containers in rootKeys (for byte-range seeking)
//
// Memory: O(containers) ≈ O(depth — NOT O(file size).  Safe for multi‑GB files.
// ─────────────────────────────────────────────────────────────────────────────

export function buildIndex(buf: Buffer): IndexData {
  console.info("Building index for upload", buf.length, "bytes");
  const text = buf.toString("utf8");
  console.info("Building index for upload", buf.length, "bytes — text length", text.length);
  const L = text.length;

  const containers: Record<string, ContainerInfo> = {};
  const rootKeys: Record<string, { offset: number; endOffset?: number; count?: number }> = {};
  const depth1: Record<string, any> = {};

  // Stack of frames tracking current position in the JSON tree.
  const stack: {
    type: "object" | "array";
    path: string;
    count: number;
    currentKey: string | null;
    /** True if we have skipped recording containers in this subtree
     *  (depth exceeded or too many array items). */
    skipped: boolean;
  }[] = [];

  let inString = false;
  let i = 0;

  while (i < L) {
    const ch = text[i];

    // ────────── inside a string ─────────────────────────────────────────
    if (inString) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    // ────────── string start ────────────────────────────────────────────
    if (ch === '"') {
      const start = i + 1;
      let end = start;
      while (end < L && text[end] !== '"') {
        if (text[end] === '\\') end++;
        end++;
      }
      const strVal = text.slice(start, end);
      inString = false;
      i = end;

      // Check if this string is a key (followed by ':')
      let j = i + 1;
      while (j < L && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
      const isKey = j < L && text[j] === ':';

      if (isKey) {
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          if (parent.type === "object") parent.currentKey = strVal;
        }
      } else {
        // ── String value ──
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          parent.count++;
          if (stack.length === 1 && parent.currentKey) {
            depth1[parent.currentKey] = strVal;
            parent.currentKey = null;
          }
        }
      }
      i++;
      continue;
    }

    // ────────── object start ────────────────────────────────────────────
    if (ch === '{') {
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      let entryKey: string | number | null = null;
      if (parent) {
        if (parent.type === "object") { entryKey = parent.currentKey; parent.currentKey = null; }
        else { entryKey = parent.count; }
      }
      const fullPath = parent ? parent.path + "." + entryKey : "$";
      const depth = stack.length + 1; // depth of this new container (root=1)
      const inArray = parent && parent.type === "array";
      const indexInArray = inArray && typeof entryKey === "number" ? entryKey as number : 0;
      // Decide whether to record this container
      const shouldRecord = depth <= MAX_CONTAINER_DEPTH
        && (!inArray || indexInArray < MAX_ARRAY_ITEMS);

      stack.push({
        type: "object", path: fullPath, count: 0, currentKey: null,
        skipped: !shouldRecord,
      });

      if (shouldRecord) {
        containers[fullPath] = { offset: i, type: "object" };
      }

      // Record root-level containers (any depth) in rootKeys
      if (parent && stack.length === 2 && typeof entryKey === "string") {
        rootKeys[entryKey] = { offset: i };
        // Record TruncatedMarker in depth1
        depth1[entryKey] = { __truncated__: true, __kind__: "object", __count__: 0 };
      }
      i++;
      continue;
    }

    // ────────── object end ──────────────────────────────────────────────
    if (ch === '}') {
      if (stack.length > 0) {
        const frame = stack.pop()!;
        if (!frame.skipped && containers[frame.path]) {
          containers[frame.path].endOffset = i;
          containers[frame.path].count = frame.count;
        }
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          parent.count++;
        }
        // Update rootKeys endOffset + count
        if (frame.path.split(".").length === 2) {
          const keyName = frame.path.split(".").pop()!;
          if (rootKeys[keyName]) {
            rootKeys[keyName].endOffset = i;
            rootKeys[keyName].count = frame.count;
          }
          if (depth1[keyName] && depth1[keyName].__truncated__) {
            depth1[keyName].__count__ = frame.count;
          }
        }
      }
      i++;
      continue;
    }

    // ────────── array start ─────────────────────────────────────────────
    if (ch === '[') {
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      let entryKey: string | number | null = null;
      if (parent) {
        if (parent.type === "object") { entryKey = parent.currentKey; parent.currentKey = null; }
        else { entryKey = parent.count; }
      }
      const fullPath = parent ? parent.path + "." + entryKey : "$";
      const depth = stack.length + 1;
      const inArray = parent && parent.type === "array";
      const indexInArray = inArray && typeof entryKey === "number" ? entryKey as number : 0;
      const shouldRecord = depth <= MAX_CONTAINER_DEPTH
        && (!inArray || indexInArray < MAX_ARRAY_ITEMS);

      stack.push({
        type: "array", path: fullPath, count: 0, currentKey: null,
        skipped: !shouldRecord,
      });

      if (shouldRecord) {
        containers[fullPath] = { offset: i, type: "array" };
      }

      // Record root-level arrays in rootKeys
      if (parent && stack.length === 2 && typeof entryKey === "string") {
        rootKeys[entryKey] = { offset: i };
        depth1[entryKey] = { __truncated__: true, __kind__: "array", __count__: 0 };
      }
      i++;
      continue;
    }

    // ────────── array end ───────────────────────────────────────────────
    if (ch === ']') {
      if (stack.length > 0) {
        const frame = stack.pop()!;
        if (!frame.skipped && containers[frame.path]) {
          containers[frame.path].endOffset = i;
          containers[frame.path].count = frame.count;
        }
        if (stack.length > 0) {
          stack[stack.length - 1].count++;
        }
        if (frame.path.split(".").length === 2) {
          const keyName = frame.path.split(".").pop()!;
          if (rootKeys[keyName]) {
            rootKeys[keyName].endOffset = i;
            rootKeys[keyName].count = frame.count;
          }
          if (depth1[keyName] && depth1[keyName].__truncated__) {
            depth1[keyName].__count__ = frame.count;
          }
        }
      }
      i++;
      continue;
    }

    // ────────── commas and colons ───────────────────────────────────────
    if (ch === ',' || ch === ':') { i++; continue; }

    // ────────── number ──────────────────────────────────────────────────
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const numStart = i;
      i++;
      while (i < L && /[0-9.eE+\-]/.test(text[i])) i++;
      const numVal = parseFloat(text.slice(numStart, i));
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        parent.count++;
        if (stack.length === 1 && parent.currentKey) {
          depth1[parent.currentKey] = numVal;
          parent.currentKey = null;
        }
      }
      continue;
    }

    // ────────── true / false / null ─────────────────────────────────────
    if (ch === 't' && text.startsWith("true", i)) {
      i += 4;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        parent.count++;
        if (stack.length === 1 && parent.currentKey) {
          depth1[parent.currentKey] = true;
          parent.currentKey = null;
        }
      }
      continue;
    }
    if (ch === 'f' && text.startsWith("false", i)) {
      i += 5;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        parent.count++;
        if (stack.length === 1 && parent.currentKey) {
          depth1[parent.currentKey] = false;
          parent.currentKey = null;
        }
      }
      continue;
    }
    if (ch === 'n' && text.startsWith("null", i)) {
      i += 4;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        parent.count++;
        if (stack.length === 1 && parent.currentKey) {
          depth1[parent.currentKey] = null;
          parent.currentKey = null;
        }
      }
      continue;
    }

    // ────────── skip other (whitespace) ──────────────────────────────────
    i++;
  }

  return {
    depth1: Object.keys(depth1).length > 0 ? depth1 : null,
    containers,
    rootKeys: Object.keys(rootKeys).length > 0 ? rootKeys : undefined,
  };
}
