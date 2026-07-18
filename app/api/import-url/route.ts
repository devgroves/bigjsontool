import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ensureUploadDir, dataPath, writeMeta } from "../../lib/uploadStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Expected JSON body with a 'url' field" },
      { status: 400 }
    );
  }

  const url = body.url?.trim();
  if (!url) {
    return NextResponse.json(
      { error: "Missing 'url' in request body" },
      { status: 400 }
    );
  }

  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!["http:", "https:"].includes(urlObj.protocol)) {
    return NextResponse.json(
      { error: "Only http and https URLs are supported" },
      { status: 400 }
    );
  }

  let remoteResponse: Response;
  try {
    remoteResponse = await fetch(url, {
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to fetch URL: ${err.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  if (!remoteResponse.ok) {
    return NextResponse.json(
      {
        error: `Remote server responded with ${remoteResponse.status} ${remoteResponse.statusText}`,
      },
      { status: 502 }
    );
  }

  if (!remoteResponse.body) {
    return NextResponse.json(
      { error: "Remote server returned no body" },
      { status: 502 }
    );
  }

  const id = randomUUID();
  const fileName = urlObj.pathname.split("/").pop() || "remote.json";
  const contentLength = remoteResponse.headers.get("content-length");
  const fileSize = contentLength ? parseInt(contentLength, 10) : 0;

  // Read the full response body into a buffer
  let buf: Buffer;
  try {
    const chunks: Uint8Array[] = [];
    const reader = remoteResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    buf = Buffer.concat(chunks);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to read remote response: ${err.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  // Save to disk and write metadata
  await ensureUploadDir();
  const dp = dataPath(id);
  await writeFile(dp, buf);
  await writeMeta(id, {
    name: fileName,
    size: buf.length,
    lineCount: 0,
    uploadedAt: new Date().toISOString(),
  });

  // NOTE: index building used to happen synchronously right here
  // (buildIndex(buf) + writeFileSync). For large files that single-request
  // scan was slow enough to trip gateway/proxy timeouts on THIS response.
  // It's now a separate step: the client calls GET /api/import-index-stream
  // (SSE) with this id right after receiving the response below, and that
  // route builds + persists the index while streaming progress back.

  return NextResponse.json({ id, name: fileName, size: buf.length });
}
