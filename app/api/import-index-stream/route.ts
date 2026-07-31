import { NextRequest } from "next/server";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { dataPath, isValidId, indexFilePath } from "../../lib/uploadStore";
import { buildIndexFromStream } from "../../lib/buildIndex";
import { getManifestEntry, registerManifestEntry } from "../../lib/manifestFileStore";
import { SPLITTER_URL, FASTIFY_URL, SHARED_PROCESS_DIR } from "../../lib/splitConfig";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const inFlight = new Map<string, Promise<any>>();

function sseLine(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── SSE parsing helper for pyjson-splitter response ────────────────────────

interface SplitterEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Read an SSE stream from a fetch Response and yield parsed events. */
async function* readSplitterSSE(res: Response): AsyncGenerator<SplitterEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        try {
          const data = JSON.parse(raw);
          yield { event: currentEvent, data };
        } catch {
          // malformed data line — skip
        }
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          yield { event: currentEvent, data };
        } catch { /* skip */ }
      }
    }
  }
}

// ── Split approach: call pyjson-splitter then register manifest ─────────────

async function trySplitAndRegister(
  id: string,
  send: (event: string, data: unknown) => void,
): Promise<boolean> {
  console.info(`[import-index-stream] attempting to split and register manifest for id '${id}'`);
  const inputPath = dataPath(id);
  const splitterUrl = `${SPLITTER_URL}/split`;
  const splitBody = {
    input_file: inputPath,
    output_dir: SHARED_PROCESS_DIR,
    job_uuid: id,
    quick: true,
  };
  console.log(`[import-index-stream] hitting splitter: POST ${splitterUrl}`, JSON.stringify(splitBody));

  const splitStartMs = Date.now();
  let splitRes: Response;
  try {
    splitRes = await fetch(splitterUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(splitBody),
    });
  } catch (err: any) {
    console.error(`[import-index-stream] splitter fetch error after ${Date.now() - splitStartMs}ms:`, err?.message);
    throw err;
  }

  const splitElapsed = Date.now() - splitStartMs;
  console.log(`[import-index-stream] splitter responded ${splitRes.status} in ${splitElapsed}ms`);

  if (!splitRes.ok) {
    const errorBody = await splitRes.text().catch(() => "unable to read body");
    console.warn(`[import-index-stream] pyjson-splitter returned ${splitRes.status}, body: ${errorBody}`);
    return false;
  }

  let splitJobId: string | null = null;

  for await (const evt of readSplitterSSE(splitRes)) {
    console.log(`[import-index-stream] splitter event: ${evt.event}`, JSON.stringify(evt.data));
    if (evt.event === "job_created") {
      splitJobId = (evt.data.job_id as string) ?? null;
      send("progress", { phase: "split", percent: 0, job_id: splitJobId });
    } else if (evt.event === "key_start") {
      send("progress", { phase: "split", key: evt.data.key });
    } else if (evt.event === "key_done") {
      send("progress", { phase: "split", key: evt.data.key, done: true });
    } else if (evt.event === "job_done") {
      send("progress", {
        phase: "split",
        percent: 100,
        total_files: evt.data.total_files,
        total_items: evt.data.total_items,
      });
    } else if (evt.event === "error") {
      console.warn("[import-index-stream] splitter error:", evt.data);
      return false;
    }
  }

  if (!splitJobId) {
    console.warn("[import-index-stream] no job_id received from splitter");
    return false;
  }

  // Register the manifest entry so json-level queries go through Fastify
  try {
    const entry = await registerManifestEntry(id, FASTIFY_URL, splitJobId);
    send("progress", { phase: "manifest", percent: 100 });
    send("done", { depth1: entry.depth1Snapshot ?? null });
    return true;
  } catch (err: any) {
    console.warn("[import-index-stream] manifest registration failed:", err?.message);
    return false;
  }
}

// ── Fallback: local byte-offset index (original behaviour) ─────────────────

async function buildLocalIndex(
  id: string,
  send: (event: string, data: unknown) => void,
): Promise<void> {
  const basePath = dataPath(id);
  const ip = indexFilePath(id);
  const totalBytes = statSync(basePath).size;
  let lastSent = 0;
  const SEND_EVERY = 2 * 1024 * 1024;

  const buildPromise = buildIndexFromStream(createReadStream(basePath), (bytesRead) => {
    if (bytesRead - lastSent >= SEND_EVERY || bytesRead === totalBytes) {
      lastSent = bytesRead;
      send("progress", {
        phase: "index",
        bytesRead,
        totalBytes,
        percent: totalBytes ? Math.min(100, Math.round((bytesRead / totalBytes) * 100)) : null,
      });
    }
  }).then((index) => {
    writeFileSync(ip, JSON.stringify(index));
    return index;
  });

  inFlight.set(id, buildPromise);
  buildPromise.finally(() => inFlight.delete(id));

  const index = await buildPromise;
  send("done", { depth1: index.depth1 ?? null });
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseLine(event, data)));
      const heartbeat = setInterval(() => send("heartbeat", { t: Date.now() }), 15000);

      try {
        if (!id || !isValidId(id)) {
          send("error", { error: "Missing or invalid 'id'" });
          return;
        }

        // Short-circuit: manifest already registered (reconnect / duplicate request)
        if (getManifestEntry(id)) {
          const entry = getManifestEntry(id)!;
          send("progress", { percent: 100 });
          send("done", { depth1: entry.depth1Snapshot ?? null });
          return;
        }

        const basePath = dataPath(id);
        if (!existsSync(basePath)) {
          send("error", { error: `No saved file for id '${id}'.` });
          return;
        }

        // ── Primary: split via pyjson-splitter + register manifest ──────
        let splitOk = false;
        let splitterReachable = true;
        try {
          splitOk = await trySplitAndRegister(id, send);
        } catch (err: any) {
          // Connection error — splitter is down/unreachable
          splitterReachable = false;
          console.warn("[import-index-stream] splitter unreachable:", err?.message);
        }

        if (splitOk) return; // done event already sent by trySplitAndRegister

        // Splitter was reachable but returned an error — do NOT fall back to
        // local index. Report the failure to the client.
        if (splitterReachable) {
          send("error", { error: "Splitter returned an error. Check splitter server logs." });
          return;
        }

        // ── Fallback: splitter unreachable — build local byte-offset index ──
        console.warn("[import-index-stream] falling back to local index build");
        await buildLocalIndex(id, send);
      } catch (err: any) {
        send("error", { error: err?.message ?? "Failed to build index" });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
