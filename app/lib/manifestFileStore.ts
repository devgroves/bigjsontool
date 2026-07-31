import { manifestFilePath } from "./uploadStore";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** In-memory registry for files whose data lives behind the Fastify split-JSON
 *  server (see README: split_results/*.json served with ?path/&key/&value/&skip/&limit).
 *
 *  Instead of reading bytes off disk or Range-fetching a remote URL (see
 *  remoteFileStore.ts), a "manifest entry" resolves tree nodes by calling out
 *  to Fastify per-chunk, using master_manifest.json as the index that tells us
 *  which chunk file + local offset a given root array key / global index maps to.
 *
 *  Manifests are persisted to disk so json-level can recover them after restart. */

export interface ManifestChunk {
  chunk_id: number;
  file_name: string;
  item_count: number;
}

export interface ManifestEntry {
  /** Base URL targeting the job directory, e.g. http://localhost:4000/{jobId} */
  baseUrl: string;
  /** manifest.split_chunks — root array key -> ordered chunk list */
  chunks: Record<string, ManifestChunk[]>;
  /** Synthesized depth-1 view of the whole file: every root key becomes a
   *  truncated array marker with __count__ = sum of item_count across its
   *  chunks. Built once at registration time — no chunk fetch needed. */
  depth1Snapshot: Record<string, unknown>;
}

const entries = new Map<string, ManifestEntry>();

/** Try to load manifest from disk into the in-memory map. */
function loadManifestFromDisk(id: string): ManifestEntry | undefined {
  if (entries.has(id)) return entries.get(id);
  const fp = manifestFilePath(id);
  if (!existsSync(fp)) return undefined;
  try {
    const entry: ManifestEntry = JSON.parse(readFileSync(fp, "utf8"));
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
      const { unlinkSync } = require("node:fs");
      unlinkSync(fp);
    }
  } catch { /* ignore cleanup errors */ }
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

  const depth1Snapshot: Record<string, unknown> = {};
  for (const [key, chunkList] of Object.entries(chunks)) {
    const total = chunkList.reduce((sum, c) => sum + (c.item_count ?? 0), 0);
    depth1Snapshot[key] = { __truncated__: true, __kind__: "array", __count__: total };
  }

  const entry: ManifestEntry = { baseUrl, chunks, depth1Snapshot };
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
