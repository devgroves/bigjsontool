import { manifestFilePath } from "./uploadStore";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

export type KeyKind = "array" | "object" | "scalar";

export interface ManifestChunk {
  chunk_id: number;
  file_name: string;
  item_count: number;
  size_bytes?: number;
  /** New splitter emits these per chunk (see pyjson-splitter README). */
  json_path?: string;
  value_type?: string;
  /** Global array range derived from json_path like "$.users[0:500]" — filled
   *  in at registration so locateChunk never has to hand-accumulate item_count. */
  start?: number;
  end?: number;
}

export interface ManifestEntry {
  /** Base URL targeting the job directory, e.g. http://localhost:4000/{jobId} */
  baseUrl: string;
  /** manifest.split_chunks — root array key -> ordered chunk list */
  chunks: Record<string, ManifestChunk[]>;
  /** Synthesized depth-1 view of the whole file: every root key becomes a
   *  kind-correct truncated marker (or scalar value) with __count__ =
   *  sum of item_count across its chunks. Built once at registration time. */
  depth1Snapshot: Record<string, unknown>;
  /** Per-root-key container type, sourced from the manifest's `value_type`
   *  (array/object) or the lazily-probed fallback for legacy manifests. */
  kinds: Record<string, KeyKind>;
}

const entries = new Map<string, ManifestEntry>();

/** Try to load manifest from disk into the in-memory map. Legacy manifests
 *  (split before the splitter emitted value_type) load with empty `kinds` and
 *  are lazily resolved via getKeyKind(). */
function loadManifestFromDisk(id: string): ManifestEntry | undefined {
  if (entries.has(id)) return entries.get(id);
  const fp = manifestFilePath(id);
  if (!existsSync(fp)) return undefined;
  try {
    const entry: ManifestEntry = JSON.parse(readFileSync(fp, "utf8"));
    entry.kinds = entry.kinds ?? {};
    entries.set(id, entry);
    return entry;
  } catch {
    return undefined;
  }
}

export function getManifestEntry(id: string): ManifestEntry | undefined {
  return entries.get(id) ?? loadManifestFromDisk(id);
}

export function dropManifestEntry(id: string): void {
  entries.delete(id);
  try {
    const fp = manifestFilePath(id);
    if (existsSync(fp)) {
      unlinkSync(fp);
    }
  } catch { /* ignore cleanup errors */ }
}

/** Map the splitter's `value_type` to a KeyKind. Unknown/absent values return
 *  undefined so legacy manifests fall back to lazy probing. */
function kindFromValueType(vt: string | undefined): KeyKind | undefined {
  if (!vt) return undefined;
  switch (vt) {
    case "array":
      return "array";
    case "object":
      return "object";
    case "str":
    case "int":
    case "float":
    case "bool":
    case "boolean":
    case "string":
    case "number":
    case "NoneType":
    case "null":
      return "scalar";
    default:
      return undefined;
  }
}

/** Parse a chunk's global array range out of a json_path like "$.users[0:500]".
 *  Falls back to null for object/scalar chunks and legacy manifests. */
function parseArrayRange(jsonPath: string | undefined): { start: number; end: number } | null {
  if (!jsonPath) return null;
  const m = jsonPath.match(/\[(\d+):(\d+)\]$/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

/** GET {baseUrl}/{fileName}?...params, per the Fastify query API in README.md.
 *  Fastify returns the resolved value directly as the JSON body. */
export async function fastifyGet(
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
  // Fastify wraps every single-path result in an outer array (e.g.
  // name query returns ["value"]). Unwrap the single-element wrapper so
  // callers see the actual value type.
  if (Array.isArray(body) && body.length === 1) return body[0];
  return body;
}

/** Resolve a root key's container type: prefers the manifest's `value_type`
 *  (stored in entry.kinds), otherwise lazily probes the first chunk via Fastify
 *  and caches the result. Used for legacy manifests that predate value_type. */
export async function getKeyKind(entry: ManifestEntry, key: string): Promise<KeyKind> {
  const known = entry.kinds?.[key];
  if (known) return known;
  const chunkList = entry.chunks?.[key];
  const chunk = chunkList?.[0];
  if (!chunk) return "scalar";

  try {
    const probe = await fastifyGet(entry, chunk.file_name, { path: key, skip: 0, limit: 1 });
    const kind: KeyKind = Array.isArray(probe)
      ? "array"
      : probe !== null && typeof probe === "object"
      ? "object"
      : "scalar";
    entry.kinds = entry.kinds ?? {};
    entry.kinds[key] = kind;

    // Patch depth1Snapshot so root depth-1 views self-heal after first use.
    if (kind === "scalar") {
      entry.depth1Snapshot[key] = probe;
    } else {
      const total = (chunkList ?? []).reduce((s, c) => s + (c.item_count ?? 0), 0);
      entry.depth1Snapshot[key] = { __truncated__: true, __kind__: kind, __count__: total };
    }
    return kind;
  } catch {
    entry.kinds = entry.kinds ?? {};
    entry.kinds[key] = "array";
    return "array";
  }
}

/** Fetch master_manifest.json from the Fastify server and register `id` as a
 *  manifest-backed file.
 *
 *  `fastifyBaseUrl` is the Fastify server origin (e.g. http://localhost:4000).
 *  `fastifyJobId` is the pyjson-splitter job UUID — the chunk directory name
 *  under SHARED_PROCESS_DIR.  The two are joined so that fastifyGet() later
 *  constructs URLs like  {fastifyBaseUrl}/{fastifyJobId}/{chunk_file}. */
export async function registerManifestEntry(
  id: string,
  fastifyBaseUrl: string,
  fastifyJobId: string,
): Promise<ManifestEntry> {
  const baseUrl = `${fastifyBaseUrl.replace(/\/$/, "")}/${fastifyJobId}`;
  const url = `${baseUrl}/master_manifest`;
  const startMs = Date.now();
  console.log(`[manifestFileStore] >>> fetching manifest: ${url}`);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    console.error(`[manifestFileStore] <<< manifest fetch error after ${elapsed}ms: ${url}`, err?.message);
    throw err;
  }

  const elapsed = Date.now() - startMs;
  console.log(`[manifestFileStore] <<< manifest responded ${res.status} in ${elapsed}ms: ${url}`);

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "unable to read body");
    console.warn(`[manifestFileStore] response body: ${errorBody}`);
    throw new Error(`Failed to load master_manifest from ${url}: ${res.status}`);
  }
  const manifest = await res.json();
  console.log(`[manifestFileStore] manifest keys: ${Object.keys(manifest).join(", ")}`);
  const chunks = manifest?.split_chunks as Record<string, ManifestChunk[]> | undefined;
  if (!chunks || typeof chunks !== "object") {
    throw new Error("master_manifest.json missing 'split_chunks'");
  }
  console.log(`[manifestFileStore] split_chunks keys: ${Object.keys(chunks).join(", ")}`);

  const kinds: Record<string, KeyKind> = {};
  const depth1Snapshot: Record<string, unknown> = {};

  for (const [key, chunkList] of Object.entries(chunks)) {
    let total = 0;
    for (const c of chunkList) {
      total += (c.item_count ?? 0);
      const range = parseArrayRange(c.json_path);
      if (range) {
        c.start = range.start;
        c.end = range.end;
      }
    }

    const kind = kindFromValueType(chunkList[0]?.value_type);
    if (kind) {
      kinds[key] = kind;
      if (kind === "array") {
        depth1Snapshot[key] = { __truncated__: true, __kind__: "array", __count__: total };
      } else if (kind === "object") {
        depth1Snapshot[key] = { __truncated__: true, __kind__: "object", __count__: total };
      } else {
        // scalar — marker that loads the actual value on click
        depth1Snapshot[key] = { __truncated__: true, __kind__: "object", __count__: total || 1 };
      }
    } else {
      // Legacy manifest without value_type — keep old array assumption until
      // getKeyKind() lazily probes and corrects the kind.
      depth1Snapshot[key] = { __truncated__: true, __kind__: "array", __count__: total };
    }
  }

  const entry: ManifestEntry = { baseUrl, chunks, depth1Snapshot, kinds };
  entries.set(id, entry);

  // Persist to disk so json-level can recover after server restart
  try {
    writeFileSync(manifestFilePath(id), JSON.stringify(entry));
    console.log(`[manifestFileStore] persisted manifest to ${manifestFilePath(id)}`);
  } catch (err: any) {
    console.warn(`[manifestFileStore] failed to persist manifest: ${err?.message}`);
  }

  return entry;
}
