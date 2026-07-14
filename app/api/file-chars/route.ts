import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { dataPath, isValidId, readMeta } from "../../lib/uploadStore";
import { getRemoteEntry } from "../../lib/remoteFileStore";

export const dynamic = "force-dynamic";

const MAX_LENGTH = 200_000;

function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end: start + length - 1 });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const start = Math.max(0, Number(searchParams.get("start")) || 0);
  const length = Math.max(1, Math.min(Number(searchParams.get("length")) || 4000, MAX_LENGTH));

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }

  // Check remote store first
  const remoteEntry = getRemoteEntry(id);
  if (remoteEntry) {
    try {
      const res = await fetch(remoteEntry.url, {
        headers: { Range: `bytes=${start}-${start + length - 1}` },
      });

      if (!res.ok) {
        return NextResponse.json(
          { error: `Remote server responded with ${res.status}` },
          { status: 502 }
        );
      }

      const text = await res.text();
      const contentRange = res.headers.get("content-range");
      let totalBytes: number | null = null;
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) totalBytes = parseInt(match[1], 10);
      }

      return NextResponse.json({ start, text, totalBytes });
    } catch (err: any) {
      return NextResponse.json(
        { error: `Failed to fetch from remote: ${err.message ?? "unknown error"}` },
        { status: 502 }
      );
    }
  }

  // Fall back to local file
  const meta = await readMeta(id);

  let buf: Buffer;
  try {
    buf = await readRange(dataPath(id), start, length);
  } catch (e: any) {
    return NextResponse.json(
      {
        error: `No saved file for id '${id}' (${e?.code ?? "read failed"}). If this app is deployed across multiple serverless instances, routes may not share a local filesystem — this demo's disk-based storage assumes one persistent Node process (fine for 'next dev' or a self-hosted server, not guaranteed on Vercel-style serverless hosting).`,
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    start,
    text: buf.toString("utf8"),
    totalBytes: meta?.size ?? null,
  });
}
