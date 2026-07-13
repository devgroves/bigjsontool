import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createWriteStream, writeFileSync, readFileSync } from "node:fs";
import { ensureUploadDir, dataPath, writeMeta, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";

export const dynamic = "force-dynamic";

// Deterministic-ish fake data generator so the payload feels real
const FIRST_NAMES = ["Ava", "Liam", "Noah", "Emma", "Oliver", "Sophia", "Elijah", "Mia", "James", "Amelia"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
const CITIES = ["Bengaluru", "Austin", "Berlin", "Lisbon", "Toronto", "Nairobi", "Osaka", "Warsaw", "Santiago", "Auckland"];
const TAGS = ["backend", "frontend", "infra", "design", "data", "mobile", "ml", "security", "growth", "support"];

function pick<T>(arr: T[], seed: number) {
  return arr[seed % arr.length];
}

function buildRecord(i: number) {
  return {
    id: i,
    uuid: `rec-${i.toString(36)}-${(i * 2654435761) % 1e9}`,
    name: `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i * 7 + 3)}`,
    city: pick(CITIES, i * 3 + 1),
    active: i % 5 !== 0,
    score: Math.round(((i * 97) % 1000) / 10) / 10,
    tags: [pick(TAGS, i), pick(TAGS, i + 4)],
    createdAt: new Date(1700000000000 + i * 60000).toISOString(),
    meta: {
      loginCount: i % 250,
      lastIp: `10.${i % 256}.${(i * 3) % 256}.${(i * 7) % 256}`,
    },
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const count = Math.min(Number(searchParams.get("count")) || 50000, 10000000);
  const chunkSize = Math.min(Number(searchParams.get("chunkSize")) || 500, 5000);
  const delayMs = Math.min(Number(searchParams.get("delayMs")) || 20, 1000);

  await ensureUploadDir();
  const id = randomUUID();
  const fileStream = createWriteStream(dataPath(id));

  let lineCount = 0;
  let byteSize = 0;
  const encoder = new TextEncoder();

  const timestamp = new Date().toISOString();
  const header = `{"generatedAt":"${timestamp}","count":${count},"records":[`;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(header));
      fileStream.write(header);
      byteSize += Buffer.byteLength(header);
      lineCount += 1;

      for (let i = 0; i < count; i += chunkSize) {
        const end = Math.min(i + chunkSize, count);
        let piece = "";
        for (let j = i; j < end; j++) {
          piece += (j === 0 ? "" : ",\n") + JSON.stringify(buildRecord(j));
        }
        controller.enqueue(encoder.encode(piece));
        fileStream.write(piece);
        byteSize += Buffer.byteLength(piece);
        lineCount += end - i;

        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      const trailer = "]}";
      controller.enqueue(encoder.encode(trailer));
      byteSize += Buffer.byteLength(trailer);

      await new Promise<void>((resolve) => {
        fileStream.end(trailer, () => resolve());
      });

      await writeMeta(id, {
        name: "generated.json",
        size: byteSize,
        lineCount,
        uploadedAt: new Date().toISOString(),
      });

      // Build full index from the completed file so all path-based
      // requests (including depth>1 at root) can use direct byte-range
      // seeks instead of re-parsing the entire file.
      try {
        const fullBuf = readFileSync(dataPath(id));
        const index = buildIndex(fullBuf);
        writeFileSync(indexFilePath(id), JSON.stringify(index));
      } catch {
        // Non-critical — without an index the json-level route falls
        // back to a full scan (slower but still correct).
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-store",
      // The client reads this once the response body finishes, at which
      // point the on-disk file + metadata are guaranteed complete (see the
      // fileStream.end()/writeMeta ordering above).
      "X-File-Id": id,
    },
  });
}
