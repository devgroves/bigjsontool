import { NextRequest } from "next/server";
import { createReadStream, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dataPath, isValidId, indexFilePath } from "../../lib/uploadStore";
import { buildIndexFromStream } from "../../lib/buildIndex";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // needs fs — not available on the edge runtime

// Very small in-memory guard against two requests for the same id racing
// each other into a duplicate full build. Not persisted across server
// restarts/instances — fine for this purpose, since worst case on a miss
// is just a redundant (but still correct) rebuild.
const inFlight = new Map<string, Promise<any>>();

function sseLine(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseLine(event, data)));

      // Heartbeat so proxies/load balancers that kill idle connections
      // don't drop this one while the build is still running.
      const heartbeat = setInterval(() => send("heartbeat", { t: Date.now() }), 15000);

      try {
        if (!id || !isValidId(id)) {
          send("error", { error: "Missing or invalid 'id'" });
          return;
        }

        const basePath = dataPath(id);
        if (!existsSync(basePath)) {
          send("error", { error: `No saved file for id '${id}'.` });
          return;
        }

        const ip = indexFilePath(id);

        // Already built (e.g. a reconnect, or another tab triggered it) —
        // short-circuit instantly instead of rebuilding.
        if (existsSync(ip)) {
          try {
            const parsed = JSON.parse(readFileSync(ip, "utf8"));
            send("progress", { percent: 100 });
            send("done", { depth1: parsed.depth1 ?? null });
            return;
          } catch {
            // corrupt index file — fall through and rebuild below
          }
        }

        let buildPromise = inFlight.get(id);
        if (!buildPromise) {
          const totalBytes = statSync(basePath).size;
          let lastSent = 0;
          const SEND_EVERY = 2 * 1024 * 1024; // ~every 2MB of progress

          buildPromise = buildIndexFromStream(createReadStream(basePath), (bytesRead) => {
            if (bytesRead - lastSent >= SEND_EVERY || bytesRead === totalBytes) {
              lastSent = bytesRead;
              send("progress", {
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
        }

        const index = await buildPromise;
        send("done", { depth1: index.depth1 ?? null });
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
      "X-Accel-Buffering": "no", // stop nginx buffering the whole stream before flushing
    },
  });
}
