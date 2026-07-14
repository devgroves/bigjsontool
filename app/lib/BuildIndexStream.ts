import { Transform } from "node:stream";
import type { ContainerInfo, IndexData } from "./buildIndex";

const MAX_CONTAINER_DEPTH = 3;
const MAX_ARRAY_ITEMS = 10;

interface Frame {
  type: "object" | "array";
  path: string;
  count: number;
  currentKey: string | null;
  skipped: boolean;
}

export class BuildIndexStream extends Transform {
  private byteOffset = 0;
  private inString = false;
  private stringContent = "";
  private buffer = "";
  private emittedDepth1 = false;

  private stack: Frame[] = [];
  private containers: Record<string, ContainerInfo> = {};
  private depth1: Record<string, any> = {};
  private rootKeys: Record<string, { offset: number; endOffset?: number; count?: number }> = {};

  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false });
  }

  _transform(chunk: Buffer, _enc: string, callback: Function) {
    const text = chunk.toString("utf8");
    this.buffer += text;
    const consumed = this.processBuffer();
    this.buffer = this.buffer.slice(consumed);
    this.byteOffset += consumed;

    const snapshot = this.getDepth1Snapshot();
    if (snapshot && !this.emittedDepth1) {
      this.emittedDepth1 = true;
      this.emit("depth1", snapshot);
    }

    callback();
  }

  _flush(callback: Function) {
    if (this.buffer.length > 0) {
      this.processBuffer();
    }
    if (!this.emittedDepth1) {
      this.emit("depth1", this.getDepth1Snapshot());
      this.emittedDepth1 = true;
    }
    this.emit("complete", this.getIndex());
    callback();
  }

  private processBuffer(): number {
    const text = this.buffer;
    const L = text.length;
    let i = 0;

    while (i < L) {
      const ch = text[i];

      if (this.inString) {
        let end = i;
        while (end < L && text[end] !== '"') {
          if (text[end] === "\\") end++;
          end++;
        }
        if (end < L) {
          this.stringContent += text.slice(i, end);
          this.inString = false;
          const strVal = this.stringContent;
          this.stringContent = "";

          let j = end + 1;
          while (j < L && this.isWhitespace(text[j])) j++;
          const isKey = j < L && text[j] === ":";

          if (isKey) {
            if (this.stack.length > 0) {
              const parent = this.stack[this.stack.length - 1];
              if (parent.type === "object") parent.currentKey = strVal;
            }
          } else {
            if (this.stack.length > 0) {
              const parent = this.stack[this.stack.length - 1];
              parent.count++;
              if (this.stack.length === 1 && parent.currentKey) {
                this.depth1[parent.currentKey] = strVal;
                parent.currentKey = null;
              }
            }
          }
          i = end + 1;
          continue;
        } else {
          this.stringContent += text.slice(i);
          return L;
        }
      }

      switch (ch) {
        case '"': {
          const start = i + 1;
          let end = start;
          while (end < L && text[end] !== '"') {
            if (text[end] === "\\") end++;
            end++;
          }
          if (end >= L) {
            this.inString = true;
            this.stringContent = text.slice(start);
            return i;
          }
          const strVal = text.slice(start, end);

          let j = end + 1;
          while (j < L && this.isWhitespace(text[j])) j++;
          const isKey = j < L && text[j] === ":";

          if (isKey) {
            if (this.stack.length > 0) {
              const parent = this.stack[this.stack.length - 1];
              if (parent.type === "object") parent.currentKey = strVal;
            }
          } else {
            if (this.stack.length > 0) {
              const parent = this.stack[this.stack.length - 1];
              parent.count++;
              if (this.stack.length === 1 && parent.currentKey) {
                this.depth1[parent.currentKey] = strVal;
                parent.currentKey = null;
              }
            }
          }
          i = end + 1;
          continue;
        }

        case "{": {
          const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
          let entryKey: string | number | null = null;
          if (parent) {
            if (parent.type === "object") { entryKey = parent.currentKey; parent.currentKey = null; }
            else { entryKey = parent.count; }
          }
          const fullPath = parent ? `${parent.path}.${entryKey}` : "$";
          const depth = this.stack.length + 1;
          const inArray = !!parent && parent.type === "array";
          const indexInArray = inArray && typeof entryKey === "number" ? entryKey as number : 0;
          const shouldRecord = depth <= MAX_CONTAINER_DEPTH
            && (!inArray || indexInArray < MAX_ARRAY_ITEMS);

          this.stack.push({
            type: "object", path: fullPath, count: 0, currentKey: null,
            skipped: !shouldRecord,
          });

          if (shouldRecord) {
            this.containers[fullPath] = { offset: this.byteOffset + i, type: "object" };
          }

          if (parent && this.stack.length === 2 && typeof entryKey === "string") {
            this.rootKeys[entryKey] = { offset: this.byteOffset + i };
            this.depth1[entryKey] = { __truncated__: true, __kind__: "object", __count__: 0 };
          }
          i++;
          continue;
        }

        case "}": {
          if (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            if (!frame.skipped && this.containers[frame.path]) {
              this.containers[frame.path].endOffset = this.byteOffset + i;
              this.containers[frame.path].count = frame.count;
            }
            if (this.stack.length > 0) {
              const p = this.stack[this.stack.length - 1];
              p.count++;
            }
            if (frame.path.split(".").length === 2) {
              const keyName = frame.path.split(".").pop()!;
              if (this.rootKeys[keyName]) {
                this.rootKeys[keyName].endOffset = this.byteOffset + i;
                this.rootKeys[keyName].count = frame.count;
              }
              if (this.depth1[keyName] && this.depth1[keyName].__truncated__) {
                this.depth1[keyName].__count__ = frame.count;
              }
            }
          }
          i++;
          continue;
        }

        case "[": {
          const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
          let entryKey: string | number | null = null;
          if (parent) {
            if (parent.type === "object") { entryKey = parent.currentKey; parent.currentKey = null; }
            else { entryKey = parent.count; }
          }
          const fullPath = parent ? `${parent.path}.${entryKey}` : "$";
          const depth = this.stack.length + 1;
          const inArray = !!parent && parent.type === "array";
          const indexInArray = inArray && typeof entryKey === "number" ? entryKey as number : 0;
          const shouldRecord = depth <= MAX_CONTAINER_DEPTH
            && (!inArray || indexInArray < MAX_ARRAY_ITEMS);

          this.stack.push({
            type: "array", path: fullPath, count: 0, currentKey: null,
            skipped: !shouldRecord,
          });

          if (shouldRecord) {
            this.containers[fullPath] = { offset: this.byteOffset + i, type: "array" };
          }

          if (parent && this.stack.length === 2 && typeof entryKey === "string") {
            this.rootKeys[entryKey] = { offset: this.byteOffset + i };
            this.depth1[entryKey] = { __truncated__: true, __kind__: "array", __count__: 0 };
          }
          i++;
          continue;
        }

        case "]": {
          if (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            if (!frame.skipped && this.containers[frame.path]) {
              this.containers[frame.path].endOffset = this.byteOffset + i;
              this.containers[frame.path].count = frame.count;
            }
            if (this.stack.length > 0) {
              this.stack[this.stack.length - 1].count++;
            }
            if (frame.path.split(".").length === 2) {
              const keyName = frame.path.split(".").pop()!;
              if (this.rootKeys[keyName]) {
                this.rootKeys[keyName].endOffset = this.byteOffset + i;
                this.rootKeys[keyName].count = frame.count;
              }
              if (this.depth1[keyName] && this.depth1[keyName].__truncated__) {
                this.depth1[keyName].__count__ = frame.count;
              }
            }
          }
          i++;
          continue;
        }

        case ',':
        case ':':
          i++;
          continue;

        default: {
          if (ch === '-' || (ch >= '0' && ch <= '9')) {
            const numStart = i;
            i++;
            while (i < L && /[0-9.eE+\-]/.test(text[i])) i++;
            const numVal = parseFloat(text.slice(numStart, i));
            if (this.stack.length > 0) {
              const p = this.stack[this.stack.length - 1];
              p.count++;
              if (this.stack.length === 1 && p.currentKey) {
                this.depth1[p.currentKey] = numVal;
                p.currentKey = null;
              }
            }
            continue;
          }
          if (ch === 't' && text.startsWith("true", i)) {
            i += 4;
            if (this.stack.length > 0) {
              const p = this.stack[this.stack.length - 1];
              p.count++;
              if (this.stack.length === 1 && p.currentKey) {
                this.depth1[p.currentKey] = true;
                p.currentKey = null;
              }
            }
            continue;
          }
          if (ch === 'f' && text.startsWith("false", i)) {
            i += 5;
            if (this.stack.length > 0) {
              const p = this.stack[this.stack.length - 1];
              p.count++;
              if (this.stack.length === 1 && p.currentKey) {
                this.depth1[p.currentKey] = false;
                p.currentKey = null;
              }
            }
            continue;
          }
          if (ch === 'n' && text.startsWith("null", i)) {
            i += 4;
            if (this.stack.length > 0) {
              const p = this.stack[this.stack.length - 1];
              p.count++;
              if (this.stack.length === 1 && p.currentKey) {
                this.depth1[p.currentKey] = null;
                p.currentKey = null;
              }
            }
            continue;
          }
          i++;
        }
      }
    }

    return L;
  }

  private isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  }

  private getDepth1Snapshot(): any {
    if (Object.keys(this.depth1).length > 0) return this.depth1;
    return null;
  }

  private getIndex(): IndexData {
    return {
      depth1: Object.keys(this.depth1).length > 0 ? { ...this.depth1 } : null,
      containers: { ...this.containers },
      rootKeys: Object.keys(this.rootKeys).length > 0 ? { ...this.rootKeys } : undefined,
    };
  }
}
