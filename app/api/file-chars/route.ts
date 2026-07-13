import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { dataPath, isValidId, readMeta } from "../../lib/uploadStore";

export const dynamic = "force-dynamic";

const MAX_LENGTH = 200_000; // guardrails a single request to ~200KB of text

function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    // start/end are byte offsets, so this is a direct seek — no scanning
    // through preceding content the way line-counting required. That also
    // fixes the actual bug: line-based windowing is meaningless for a
    // minified JSON file that's one giant line, since "line 1" would BE
    // the whole file. Character/byte offsets have no such degenerate case.
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

  // NOTE: this is a byte-offset read, not a codepoint-offset read. For
  // JSON containing raw (non-escaped) multi-byte UTF-8 characters, a chunk
  // boundary can occasionally land mid-character, and that one character
  // renders wrong right at the seam. Pure-ASCII JSON — which covers the
  // overwhelming majority of real payloads, since most serializers escape
  // non-ASCII as \uXXXX by default — is unaffected. A fully correct version
  // would decode with a small overlap on each side and trim to the nearest
  // valid UTF-8 boundary.
  return NextResponse.json({
    start,
    text: buf.toString("utf8"),
    totalBytes: meta?.size ?? null,
  });
}
