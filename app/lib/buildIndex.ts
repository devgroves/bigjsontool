// Streaming / chunked JSON indexer.
//
// The original implementation called `buf.toString("utf8")` on the entire
// upload up front, then did a single-pass scan over that JS string. That
// meant peak memory was O(file size) just to hold the decoded string (often
// ~2x the byte size for a UTF-16 JS string), on top of the original Buffer.
// For large files with limited memory that's the thing that breaks.
//
// This version scans raw bytes directly and never decodes the whole file
// to a string. It only UTF-8-decodes the specific byte ranges it actually
// needs (object keys, and root-level scalar values for the `depth1`
// preview) — and even those are capped so a single pathological huge
// string/number can't blow up memory either.
//
// It's fed data incrementally via `.feed(chunk)`, so it works either:
//   - streaming straight from disk: buildIndexFromStream(fs.createReadStream(path))
//   - or against an in-memory Buffer, chunked into fixed windows: buildIndex(buf)
// Either way, peak extra memory is roughly O(depth * width) for the
// containers/rootKeys/depth1 maps (same as before) + O(chunk size) +
// O(MAX_ACCUM) for whatever single scalar is currently open. NOT O(file size).
//
// Bonus fix: offsets are now real byte offsets (this.absPos counts bytes
// consumed), matching how route.ts seeks with byte-range reads. The old
// version indexed into a UTF-16 JS string, so for JSON containing raw
// (non-escaped) multi-byte UTF-8 characters, offsets could already be off
// by a little — same class of bug called out in route.ts's own comments.

import type { Readable } from "node:stream";

const MAX_CONTAINER_DEPTH = 3;
const MAX_ARRAY_ITEMS = 10;

// Cap on how many bytes of a single scalar (string or number) we'll
// decode/keep. Containers can be arbitrarily large; we don't care because
// we never buffer their contents — only scalar leaf values do that, and
// only when they're actually needed (see onStringStart/onNumberStart).
const MAX_ACCUM = 1 << 20; // 1MB per scalar

export interface ContainerInfo {
  offset: number;
  endOffset?: number;
  count?: number;
  type: "object" | "array";
}

export interface IndexData {
  /** Truncated depth=1 view of the root (scalar values + TruncatedMarkers
   *  for containers). Lets the initial tree render instantly. */
  depth1: any;
  /** Byte-offset map for containers within a practical scope
   *  (depth <= MAX_CONTAINER_DEPTH, first MAX_ARRAY_ITEMS items per array). */
  containers: Record<string, ContainerInfo>;
  /** All root-level containers (objects + arrays) — used as the primary
   *  byte-range seeking mechanism. */
  rootKeys?: Record<string, { offset: number; endOffset?: number; count?: number }>;
}

// ── byte constants (all JSON structural chars are ASCII) ───────────────────
const B_QUOTE = 0x22; // "
const B_BACKSLASH = 0x5c; // \
const B_LBRACE = 0x7b; // {
const B_RBRACE = 0x7d; // }
const B_LBRACKET = 0x5b; // [
const B_RBRACKET = 0x5d; // ]
const B_COLON = 0x3a; // :
const B_COMMA = 0x2c; // ,
const B_MINUS = 0x2d; // -
const B_t = 0x74;
const B_f = 0x66;
const B_n = 0x6e;

function isDigit(b: number) {
  return b >= 0x30 && b <= 0x39;
}
function isNumChar(b: number) {
  // digits, '.', 'e'/'E', '+'/'-'
  return isDigit(b) || b === 0x2e || b === 0x65 || b === 0x45 || b === 0x2b || b === 0x2d;
}
function isWs(b: number) {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

type Frame = {
  type: "object" | "array";
  path: string;
  count: number;
  currentKey: string | null;
  skipped: boolean;
};

type Mode = "DEFAULT" | "IN_STRING" | "AFTER_STRING" | "IN_NUMBER" | "IN_LITERAL";

class StreamingJsonIndexer {
  private absPos = 0; // absolute byte offset consumed so far — matches file byte offsets
  private stack: Frame[] = [];
  private containers: Record<string, ContainerInfo> = {};
  private rootKeys: Record<string, { offset: number; endOffset?: number; count?: number }> = {};
  private depth1: Record<string, any> = {};

  private mode: Mode = "DEFAULT";

  // Shared "current scalar span" bookkeeping. A span is a run of bytes in
  // the *current* chunk belonging to the in-progress string/number; it gets
  // flushed into the accumulator (if one is needed) whenever it's
  // interrupted — by an escape, a closing quote, or the end of the chunk.
  private spanStart = 0;

  // string state
  private escaping = false;
  private strNeedsContent = true;
  private strChunks: Buffer[] | null = null;
  private strBytes = 0;
  private strTruncated = false;

  // number state
  private numNeedsContent = false;
  private numChunks: Buffer[] | null = null;
  private numBytes = 0;

  // literal state (true/false/null)
  private literalKind: "true" | "false" | "null" = "null";
  private literalPos = 0;

  feed(chunk: Buffer) {
    const buf = chunk;
    const L = buf.length;

    // If we're mid-scalar from a previous chunk, the new span starts at 0.
    if (this.mode === "IN_STRING" || this.mode === "IN_NUMBER") this.spanStart = 0;

    let k = 0;
    while (k < L) {
      const b = buf[k];

      switch (this.mode) {
        case "IN_STRING": {
          if (this.escaping) {
            this.escaping = false;
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_BACKSLASH) {
            this.escaping = true;
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_QUOTE) {
            this.flushStrSpan(buf, k);
            this.mode = "AFTER_STRING";
            k++;
            this.absPos++;
            continue;
          }
          k++;
          this.absPos++;
          continue;
        }

        case "AFTER_STRING": {
          // Skip whitespace looking for ':' (key) vs. anything else (value).
          if (isWs(b)) {
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_COLON) {
            this.onStringIsKey();
            k++;
            this.absPos++;
            this.mode = "DEFAULT";
            continue;
          }
          this.onStringIsValue();
          this.mode = "DEFAULT";
          continue; // reprocess b as a fresh token
        }

        case "IN_NUMBER": {
          if (isNumChar(b)) {
            k++;
            this.absPos++;
            continue;
          }
          this.flushNumSpan(buf, k);
          this.onNumberEnd();
          this.mode = "DEFAULT";
          continue; // reprocess b
        }

        case "IN_LITERAL": {
          const word = this.literalKind;
          if (word.charCodeAt(this.literalPos) === b) {
            this.literalPos++;
            k++;
            this.absPos++;
            if (this.literalPos === word.length) {
              this.onLiteralEnd();
              this.mode = "DEFAULT";
            }
            continue;
          }
          // Malformed JSON — bail out of the literal defensively.
          this.onLiteralEnd();
          this.mode = "DEFAULT";
          continue;
        }

        case "DEFAULT":
        default: {
          if (isWs(b)) {
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_QUOTE) {
            this.onStringStart();
            k++;
            this.absPos++;
            this.spanStart = k;
            this.mode = "IN_STRING";
            continue;
          }
          if (b === B_LBRACE) {
            this.onContainerStart("object");
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_RBRACE) {
            this.onContainerEnd();
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_LBRACKET) {
            this.onContainerStart("array");
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_RBRACKET) {
            this.onContainerEnd();
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_COMMA || b === B_COLON) {
            k++;
            this.absPos++;
            continue;
          }
          if (b === B_MINUS || isDigit(b)) {
            this.onNumberStart();
            this.spanStart = k;
            this.mode = "IN_NUMBER";
            continue; // let IN_NUMBER consume this same byte
          }
          if (b === B_t || b === B_f || b === B_n) {
            this.onLiteralStart(b);
            this.mode = "IN_LITERAL";
            continue; // let IN_LITERAL consume this same byte
          }
          // Unknown byte — skip defensively.
          k++;
          this.absPos++;
          continue;
        }
      }
    }

    // Chunk ended mid-scalar: flush whatever span we have so far without
    // closing the scalar. The next feed() call picks up where we left off.
    if (this.mode === "IN_STRING") this.flushStrSpan(buf, L);
    else if (this.mode === "IN_NUMBER") this.flushNumSpan(buf, L);
  }

  finalize(): IndexData {
    return {
      depth1: Object.keys(this.depth1).length > 0 ? this.depth1 : null,
      containers: this.containers,
      rootKeys: Object.keys(this.rootKeys).length > 0 ? this.rootKeys : undefined,
    };
  }

  // ── containers ────────────────────────────────────────────────────────
  private onContainerStart(type: "object" | "array") {
    const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    let entryKey: string | number | null = null;
    if (parent) {
      if (parent.type === "object") {
        entryKey = parent.currentKey;
        parent.currentKey = null;
      } else {
        entryKey = parent.count;
      }
    }
    const fullPath = parent ? parent.path + "." + entryKey : "$";
    const depth = this.stack.length + 1;
    const inArray = !!(parent && parent.type === "array");
    const indexInArray = inArray && typeof entryKey === "number" ? (entryKey as number) : 0;
    const shouldRecord = depth <= MAX_CONTAINER_DEPTH && (!inArray || indexInArray < MAX_ARRAY_ITEMS);

    this.stack.push({ type, path: fullPath, count: 0, currentKey: null, skipped: !shouldRecord });

    if (shouldRecord) {
      this.containers[fullPath] = { offset: this.absPos, type };
    }

    if (parent && this.stack.length === 2 && typeof entryKey === "string") {
      this.rootKeys[entryKey] = { offset: this.absPos };
      this.depth1[entryKey] = { __truncated__: true, __kind__: type, __count__: 0 };
    }
  }

  private onContainerEnd() {
    if (this.stack.length === 0) return;
    const frame = this.stack.pop()!;
    if (!frame.skipped && this.containers[frame.path]) {
      this.containers[frame.path].endOffset = this.absPos;
      this.containers[frame.path].count = frame.count;
    }
    if (this.stack.length > 0) {
      this.stack[this.stack.length - 1].count++;
    }
    const parts = frame.path.split(".");
    if (parts.length === 2) {
      const keyName = parts[1];
      if (this.rootKeys[keyName]) {
        this.rootKeys[keyName].endOffset = this.absPos;
        this.rootKeys[keyName].count = frame.count;
      }
      if (this.depth1[keyName] && this.depth1[keyName].__truncated__) {
        this.depth1[keyName].__count__ = frame.count;
      }
    }
  }

  // ── strings ───────────────────────────────────────────────────────────
  private onStringStart() {
    const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    // We only ever need the decoded text of a string if it might become an
    // object key, or if it's a root-level scalar value feeding `depth1`.
    // Both cases require the parent to be an object (arrays never have
    // keys, and depth1 is only populated via parent.currentKey, which is
    // only ever set on object parents). So: skip decoding entirely for
    // strings inside arrays — this is the big win for e.g. huge string
    // arrays, since we never buffer their contents at all.
    this.strNeedsContent = !!(parent && parent.type === "object");
    this.strChunks = this.strNeedsContent ? [] : null;
    this.strBytes = 0;
    this.strTruncated = false;
  }

  private flushStrSpan(buf: Buffer, endExclusive: number) {
    if (!this.strNeedsContent || !this.strChunks) return;
    if (this.strBytes >= MAX_ACCUM) {
      this.strTruncated = true;
      return;
    }
    if (endExclusive <= this.spanStart) return;
    const span = buf.subarray(this.spanStart, endExclusive);
    const remaining = MAX_ACCUM - this.strBytes;
    const piece = span.length > remaining ? span.subarray(0, remaining) : span;
    if (piece.length) {
      this.strChunks.push(Buffer.from(piece)); // copy so it survives past this chunk
      this.strBytes += piece.length;
    }
    if (span.length > remaining) this.strTruncated = true;
  }

  private getStrVal(): string {
    if (!this.strNeedsContent || !this.strChunks) return "";
    const text = Buffer.concat(this.strChunks).toString("utf8");
    return this.strTruncated ? text + "…" : text;
  }

  private onStringIsKey() {
    if (this.stack.length > 0) {
      const parent = this.stack[this.stack.length - 1];
      if (parent.type === "object") parent.currentKey = this.getStrVal();
    }
  }

  private onStringIsValue() {
    if (this.stack.length > 0) {
      const parent = this.stack[this.stack.length - 1];
      parent.count++;
      if (this.stack.length === 1 && parent.currentKey) {
        this.depth1[parent.currentKey] = this.getStrVal();
        parent.currentKey = null;
      }
    }
  }

  // ── numbers ───────────────────────────────────────────────────────────
  private onNumberStart() {
    const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    // Only root-level scalar values feed depth1; nested numbers just need
    // to be walked over (parent.count is incremented in onNumberEnd
    // regardless), so skip buffering when we don't need the parsed value.
    this.numNeedsContent = !!(parent && this.stack.length === 1 && parent.currentKey);
    this.numChunks = this.numNeedsContent ? [] : null;
    this.numBytes = 0;
  }

  private flushNumSpan(buf: Buffer, endExclusive: number) {
    if (!this.numNeedsContent || !this.numChunks) return;
    if (endExclusive <= this.spanStart) return;
    if (this.numBytes >= MAX_ACCUM) return;
    const span = buf.subarray(this.spanStart, endExclusive);
    const remaining = MAX_ACCUM - this.numBytes;
    const piece = span.length > remaining ? span.subarray(0, remaining) : span;
    if (piece.length) {
      this.numChunks.push(Buffer.from(piece));
      this.numBytes += piece.length;
    }
  }

  private onNumberEnd() {
    if (this.stack.length > 0) {
      const parent = this.stack[this.stack.length - 1];
      parent.count++;
      if (this.stack.length === 1 && parent.currentKey && this.numChunks) {
        const numText = Buffer.concat(this.numChunks).toString("latin1"); // numbers are pure ASCII
        this.depth1[parent.currentKey] = parseFloat(numText);
        parent.currentKey = null;
      }
    }
  }

  // ── literals: true / false / null ────────────────────────────────────
  private onLiteralStart(b: number) {
    this.literalKind = b === B_t ? "true" : b === B_f ? "false" : "null";
    this.literalPos = 0;
  }

  private onLiteralEnd() {
    if (this.stack.length > 0) {
      const parent = this.stack[this.stack.length - 1];
      parent.count++;
      if (this.stack.length === 1 && parent.currentKey) {
        this.depth1[parent.currentKey] =
          this.literalKind === "true" ? true : this.literalKind === "false" ? false : null;
        parent.currentKey = null;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the index by streaming a Readable directly (e.g. fs.createReadStream
 * on the uploaded file). This never holds the whole file in memory — only
 * the current chunk plus whatever small scalar is currently being decoded.
 * Prefer this over `buildIndex` whenever you have a stream available
 * (reading straight from disk) instead of an already-fully-buffered upload.
 */
export async function buildIndexFromStream(
  stream: Readable,
  onProgress?: (bytesRead: number) => void,
): Promise<IndexData> {
  const indexer = new StreamingJsonIndexer();
  let bytesRead = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    indexer.feed(buf);
    bytesRead += buf.length;
    onProgress?.(bytesRead);
  }
  return indexer.finalize();
}

/**
 * Same signature/behavior as the original buildIndex, but internally feeds
 * the buffer through the streaming scanner in fixed-size windows instead of
 * doing one big `buf.toString("utf8")`. Use this when you already have the
 * full Buffer in memory (e.g. it was already read for another reason) but
 * still want bounded, incremental decoding rather than one giant UTF-8
 * decode of possibly-multi-GB data.
 */
export function buildIndex(buf: Buffer, chunkSize = 1 << 20 /* 1MB windows */): IndexData {
  console.info("Building index for upload", buf.length, "bytes (chunked, size", chunkSize, ")");
  const indexer = new StreamingJsonIndexer();
  for (let off = 0; off < buf.length; off += chunkSize) {
    indexer.feed(buf.subarray(off, Math.min(off + chunkSize, buf.length)));
  }
  return indexer.finalize();
}
